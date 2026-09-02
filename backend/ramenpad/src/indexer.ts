import { decodeEventLog, formatUnits, getAddress, type Address, type Hex, type Log } from "viem";
import type { Server as SocketServer } from "socket.io";
import {
  feesHarvestedEvent,
  launcherAbi,
  launcherFeesClaimedEvent,
  otcSwapEvent,
  protocolFeesDepositedEvent,
  swapEvent,
  tokenLaunchedEvent,
} from "./abi.js";
import {
  LEGACY_TARGET_MARKET_CAP_USD,
  liveClient,
  logClient,
  PAID_RPC_URLS,
  paidClient,
  publicClient,
  RAMEN,
  requiredAddress,
  TARGET_2000_ACTIVATION_BLOCK,
  TARGET_MARKET_CAP_USD,
  TOTAL_SUPPLY,
} from "./config.js";
import type { Database } from "./db.js";
import { priceFromSqrt } from "./math.js";
import { getMarketPrices, getRamenUsd } from "./ramenPrice.js";

interface PoolRow {
  token_address: Address;
  pool_address: Address;
  token0: Address;
  token1: Address;
  symbol: string;
}

interface FeePoolRow extends PoolRow {
  position_token_id: string;
  price_usd: string;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withLogRetry<T>(request: () => Promise<T>) {
  let lastError: unknown;
  for (const waitMs of [0, 2_000, 5_000, 10_000]) {
    if (waitMs) await delay(waitMs);
    try {
      return await request();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function splitBlockRange(fromBlock: bigint, toBlock: bigint, size: bigint) {
  if (size <= 0n) throw new Error("Block range size must be positive");
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let from = fromBlock; from <= toBlock; from += size) {
    ranges.push({ fromBlock: from, toBlock: from + size - 1n < toBlock ? from + size - 1n : toBlock });
  }
  return ranges;
}

async function getLogsWithFallback<T>(
  fromBlock: bigint,
  toBlock: bigint,
  freeRequest: () => Promise<T[]>,
  paidRequest?: (from: bigint, to: bigint) => Promise<T[]>,
) {
  try {
    return await withLogRetry(freeRequest);
  } catch (freeError) {
    if (!paidRequest) throw freeError;
    console.warn("[ramenpad:indexer] free log RPC unavailable; using bounded paid fallback");
    const configuredRange = Number(process.env.RAMENPAD_PAID_LOG_BLOCK_RANGE);
    const paidRange = BigInt(Number.isFinite(configuredRange) && configuredRange > 0
      ? Math.floor(configuredRange)
      : 10);
    const logs: T[] = [];
    for (const range of splitBlockRange(fromBlock, toBlock, paidRange)) {
      logs.push(...await withLogRetry(() => paidRequest(range.fromBlock, range.toBlock)));
    }
    return logs;
  }
}

export class RamenpadIndexer {
  private stopped = false;
  private running = false;
  private pools = new Map<string, PoolRow>();
  private launcher = requiredAddress("RAMENPAD_LAUNCHER_ADDRESS");
  private otc?: Address;
  private locker?: Address;
  private timer?: NodeJS.Timeout;
  private marketTimer?: NodeJS.Timeout;
  private liveHealthTimer?: NodeJS.Timeout;
  private liveDrainTimer?: NodeJS.Timeout;
  private currentTick?: Promise<void>;
  private currentLiveRecovery?: Promise<void>;
  private poolRefresh: Promise<void> = Promise.resolve();
  private unwatchSystem?: () => void;
  private unwatchPools: Array<() => void> = [];
  private liveBuffer = new Map<string, Log>();
  private liveDraining = false;
  private blockTimes = new Map<bigint, Date>();
  private repricing = false;
  private lastRamenUsd = 0;
  private consecutiveFailures = 0;
  private caughtUp = false;
  private lastSuccessfulTickAt?: Date;
  private lastIndexedBlock?: bigint;
  private safeHead?: bigint;
  private wsConnected = false;
  private wsLastHealthyAt?: Date;
  private poolShardCount = 0;
  private readonly confirmationBlocks = BigInt(Math.max(2, Number(process.env.RAMENPAD_CONFIRMATION_BLOCKS) || 2));
  private readonly poolShardSize = Math.max(1, Number(process.env.RAMENPAD_WS_POOL_SHARD_SIZE) || 100);
  private readonly intervalMs = liveClient
    ? Math.max(60_000, Number(process.env.RAMENPAD_RECONCILE_INTERVAL_MS) || 600_000)
    : Math.max(5_000, Number(process.env.RAMENPAD_INDEXER_INTERVAL_MS) || 15_000);
  private readonly maxBackoffMs = Math.max(15_000, Number(process.env.RAMENPAD_INDEXER_MAX_BACKOFF_MS) || 120_000);

  constructor(private db: Database, private io: SocketServer) {}

  async start() {
    [this.otc, this.locker] = await Promise.all([
      publicClient.readContract({ address: this.launcher, abi: launcherAbi, functionName: "otc" }),
      publicClient.readContract({ address: this.launcher, abi: launcherAbi, functionName: "locker" }),
    ]);
    await this.loadPools();
    await this.repairLaunchTimestamps();
    await this.repairLaunchIds();
    if (liveClient) await this.startLiveSubscriptions();
    await this.runTick();
    await this.repriceMarkets();
    this.marketTimer = setInterval(() => void this.repriceMarkets(), 30_000);
    if (liveClient) this.liveHealthTimer = setInterval(() => void this.checkLiveHealth(), 30_000);
    this.schedule();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.marketTimer) clearInterval(this.marketTimer);
    if (this.liveHealthTimer) clearInterval(this.liveHealthTimer);
    if (this.liveDrainTimer) clearTimeout(this.liveDrainTimer);
    this.unwatchSystem?.();
    for (const unwatch of this.unwatchPools) unwatch();
    await this.currentTick;
    await this.currentLiveRecovery;
  }

  getStatus() {
    return {
      ready: this.caughtUp && (!liveClient || this.wsConnected) && !this.stopped && this.consecutiveFailures === 0,
      mode: liveClient ? "hybrid" : "polling",
      caughtUp: this.caughtUp,
      running: this.running,
      wsConfigured: Boolean(liveClient),
      wsConnected: this.wsConnected,
      wsLastHealthyAt: this.wsLastHealthyAt?.toISOString() || null,
      poolShardsReady: this.wsConnected ? this.poolShardCount : 0,
      poolShardsExpected: this.poolShardCount,
      liveQueueDepth: this.liveBuffer.size,
      lastSuccessfulTickAt: this.lastSuccessfulTickAt?.toISOString() || null,
      lastIndexedBlock: this.lastIndexedBlock?.toString() || null,
      safeHead: this.safeHead?.toString() || null,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async repriceMarkets() {
    if (this.repricing || this.stopped) return;
    this.repricing = true;
    try {
      const { ramenUsd, ethUsd, ramenMarketCapUsd, ramenVolumeUsd } = await getMarketPrices();
      if (ramenUsd === this.lastRamenUsd) return;
      await this.db.query(`
        UPDATE ramenpad.launches SET
          price_ramen=COALESCE(NULLIF(price_ramen,0),price_usd/$1),
          price_usd=COALESCE(NULLIF(price_ramen,0),price_usd/$1)*$1,
          market_cap_usd=COALESCE(NULLIF(price_ramen,0),price_usd/$1)*$1*$2
      `, [ramenUsd, TOTAL_SUPPLY]);
      this.lastRamenUsd = ramenUsd;
      this.io.emit("ramenpad:market", { ramenUsd, ethUsd, ramenMarketCapUsd, ramenVolumeUsd });
    } catch (error) {
      console.error("[ramenpad:market]", error);
    } finally {
      this.repricing = false;
    }
  }

  private runTick() {
    if (!this.currentTick) {
      this.currentTick = this.tick().finally(() => { this.currentTick = undefined; });
    }
    return this.currentTick;
  }

  private schedule() {
    if (this.stopped) return;
    const delay = !this.caughtUp
      ? 5_000
      : this.consecutiveFailures
      ? Math.min(15_000 * (2 ** this.consecutiveFailures), this.maxBackoffMs)
      : this.intervalMs;
    this.timer = setTimeout(async () => {
      await this.runTick();
      this.schedule();
    }, delay);
  }

  private async loadPools() {
    const result = await this.db.query<PoolRow>("SELECT token_address, pool_address, token0, token1, symbol FROM ramenpad.launches");
    for (const pool of result.rows) this.pools.set(pool.pool_address.toLowerCase(), pool);
  }

  private async repairLaunchTimestamps() {
    const result = await this.db.query<{ token_address: string; launch_block: string }>(`
      SELECT token_address, launch_block::text
      FROM ramenpad.launches
      WHERE launched_at < '2020-01-01'::timestamptz
    `);
    for (const launch of result.rows) {
      const block = await publicClient.getBlock({ blockNumber: BigInt(launch.launch_block) });
      await this.db.query(
        "UPDATE ramenpad.launches SET launched_at=$2 WHERE token_address=$1",
        [launch.token_address, new Date(Number(block.timestamp) * 1000)],
      );
    }
  }

  private async repairLaunchIds() {
    const missing = await this.db.query<{ token_address: string }>(
      "SELECT token_address FROM ramenpad.launches WHERE launch_id IS NULL",
    );
    if (!missing.rowCount) return;
    const missingTokens = new Set(missing.rows.map((row) => row.token_address.toLowerCase()));
    const length = await publicClient.readContract({
      address: this.launcher, abi: launcherAbi, functionName: "allTokensLength",
    });
    for (let index = 0n; index < length && missingTokens.size; index += 1n) {
      const token = await publicClient.readContract({
        address: this.launcher, abi: launcherAbi, functionName: "allTokens", args: [index],
      });
      if (!missingTokens.has(token.toLowerCase())) continue;
      await this.db.query(
        "UPDATE ramenpad.launches SET launch_id=$2 WHERE token_address=$1 AND launch_id IS NULL",
        [token.toLowerCase(), index.toString()],
      );
      missingTokens.delete(token.toLowerCase());
    }
  }

  private async auditLaunchRegistry() {
    const [chainCount, database] = await Promise.all([
      publicClient.readContract({ address: this.launcher, abi: launcherAbi, functionName: "launchCount" }),
      this.db.query<{ count: string }>("SELECT count(*)::text AS count FROM ramenpad.launches"),
    ]);
    if (BigInt(database.rows[0]?.count || 0) !== chainCount) {
      throw new Error("Onchain launch registry and indexed launch count differ");
    }
  }

  private liveError(error: Error) {
    if (this.stopped) return;
    this.wsConnected = false;
    console.error(`[ramenpad:ws] subscription degraded (${error.name || "Error"})`);
    void this.recoverLiveSubscriptions();
  }

  private receiveLiveLogs(logs: readonly Log[]) {
    if (this.stopped) return;
    this.wsConnected = true;
    this.wsLastHealthyAt = new Date();
    for (const log of logs) {
      if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
      const key = `${log.blockHash || "pending"}:${log.transactionHash}:${log.logIndex}`.toLowerCase();
      if (log.removed) {
        this.liveBuffer.delete(key);
        continue;
      }
      this.liveBuffer.set(key, log);
    }
    this.scheduleLiveDrain();
  }

  private scheduleLiveDrain(delayMs = 500) {
    if (this.liveDrainTimer || this.stopped) return;
    this.liveDrainTimer = setTimeout(() => {
      this.liveDrainTimer = undefined;
      void this.drainLiveBuffer();
    }, delayMs);
  }

  private async drainLiveBuffer() {
    if (this.liveDraining || this.stopped || !this.liveBuffer.size) return;
    this.liveDraining = true;
    try {
      const head = await publicClient.getBlockNumber();
      const safeHead = head > this.confirmationBlocks ? head - this.confirmationBlocks : head;
      const ready = [...this.liveBuffer.entries()]
        .filter(([, log]) => log.blockNumber !== null && log.blockNumber <= safeHead)
        .sort(([, left], [, right]) => Number((left.blockNumber || 0n) - (right.blockNumber || 0n))
          || Number((left.transactionIndex || 0) - (right.transactionIndex || 0))
          || Number((left.logIndex || 0) - (right.logIndex || 0)));
      for (const [key, log] of ready) {
        const address = log.address.toLowerCase();
        if (address === this.launcher.toLowerCase()
          || address === this.locker?.toLowerCase()
          || address === this.otc?.toLowerCase()) {
          await this.indexSystemLog(log);
        } else if (this.pools.has(address)) {
          await this.indexSwap(log as never);
        }
        this.liveBuffer.delete(key);
      }
      this.wsLastHealthyAt = new Date();
    } catch (error) {
      this.caughtUp = false;
      this.consecutiveFailures += 1;
      const name = error instanceof Error ? error.name : "Error";
      console.error(`[ramenpad:ws] live materialization failed (${name})`);
      void this.runTick();
    } finally {
      this.liveDraining = false;
      if (this.liveBuffer.size) this.scheduleLiveDrain(500);
    }
  }

  private async startLiveSubscriptions() {
    if (!liveClient || this.stopped) return;
    const chainId = await liveClient.getChainId();
    if (chainId !== 4663) throw new Error("WebSocket provider returned the wrong chain ID");
    const systemAddresses = [this.launcher, this.locker, this.otc].filter(Boolean) as Address[];
    const nextSystem = liveClient.watchEvent({
      address: systemAddresses,
      events: [tokenLaunchedEvent, feesHarvestedEvent, launcherFeesClaimedEvent, protocolFeesDepositedEvent, otcSwapEvent],
      strict: true,
      onLogs: (logs) => this.receiveLiveLogs(logs as Log[]),
      onError: (error) => this.liveError(error),
    });
    await this.replacePoolSubscriptions();
    await delay(500);
    const previousSystem = this.unwatchSystem;
    this.unwatchSystem = nextSystem;
    previousSystem?.();
    this.wsConnected = true;
    this.wsLastHealthyAt = new Date();
    console.log(`[ramenpad:ws] live subscriptions ready (${this.poolShardCount} pool shards)`);
  }

  private async replacePoolSubscriptions() {
    if (!liveClient || this.stopped) return;
    const addresses = [...this.pools.values()].map((pool) => pool.pool_address);
    const next: Array<() => void> = [];
    for (let index = 0; index < addresses.length; index += this.poolShardSize) {
      const batch = addresses.slice(index, index + this.poolShardSize);
      next.push(liveClient.watchEvent({
        address: batch,
        event: swapEvent,
        strict: true,
        onLogs: (logs) => this.receiveLiveLogs(logs as Log[]),
        onError: (error) => this.liveError(error),
      }));
    }
    await delay(250);
    const previous = this.unwatchPools;
    this.unwatchPools = next;
    this.poolShardCount = next.length;
    for (const unwatch of previous) unwatch();
  }

  private recoverLiveSubscriptions() {
    if (!liveClient || this.stopped) return Promise.resolve();
    if (!this.currentLiveRecovery) {
      this.currentLiveRecovery = (async () => {
        await delay(2_000);
        await this.startLiveSubscriptions();
        await this.runTick();
      })().catch((error) => {
        const name = error instanceof Error ? error.name : "Error";
        console.error(`[ramenpad:ws] reconnect failed (${name})`);
        if (!this.stopped) setTimeout(() => void this.recoverLiveSubscriptions(), 10_000);
      }).finally(() => { this.currentLiveRecovery = undefined; });
    }
    return this.currentLiveRecovery;
  }

  private async checkLiveHealth() {
    if (!liveClient || this.stopped) return;
    try {
      const chainId = await liveClient.getChainId();
      if (chainId !== 4663) throw new Error("wrong WebSocket chain ID");
      if (!this.wsConnected) await this.recoverLiveSubscriptions();
      else this.wsLastHealthyAt = new Date();
    } catch (error) {
      this.liveError(error instanceof Error ? error : new Error("WebSocket health check failed"));
    }
  }

  private async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const chainHead = await publicClient.getBlockNumber();
      const safeHead = chainHead > this.confirmationBlocks ? chainHead - this.confirmationBlocks : chainHead;
      this.safeHead = safeHead;
      const state = await this.db.query<{ block_number: string }>("SELECT block_number FROM ramenpad.indexer_state WHERE worker='main'");
      const configuredStart = BigInt(process.env.RAMENPAD_DEPLOYMENT_BLOCK || safeHead.toString());
      let from = state.rowCount ? BigInt(state.rows[0].block_number) + 1n : configuredStart;
      const configuredRange = Number(process.env.RAMENPAD_INDEXER_BLOCK_RANGE);
      const blockRange = BigInt(Number.isFinite(configuredRange) && configuredRange > 0
        ? Math.floor(configuredRange)
        : 1_000);
      const configuredRangesPerTick = Number(process.env.RAMENPAD_INDEXER_RANGES_PER_TICK);
      const rangesPerTick = Number.isFinite(configuredRangesPerTick) && configuredRangesPerTick > 0
        ? Math.floor(configuredRangesPerTick)
        : PAID_RPC_URLS.length ? 20 : 1;
      let rangesProcessed = 0;
      while (from <= safeHead && !this.stopped && rangesProcessed < rangesPerTick) {
        const to = from + blockRange - 1n < safeHead ? from + blockRange - 1n : safeHead;
        await this.indexRange(from, to);
        await this.db.query(`
          INSERT INTO ramenpad.indexer_state(worker, block_number) VALUES('main',$1)
          ON CONFLICT(worker) DO UPDATE SET block_number=EXCLUDED.block_number, updated_at=now()
        `, [to.toString()]);
        this.lastIndexedBlock = to;
        from = to + 1n;
        rangesProcessed += 1;
      }
      await this.auditLaunchRegistry();
      this.caughtUp = from > safeHead;
      this.lastSuccessfulTickAt = new Date();
      this.consecutiveFailures = 0;
    } catch (error) {
      this.caughtUp = false;
      this.consecutiveFailures += 1;
      console.error("[ramenpad:indexer]", error);
    } finally { this.running = false; }
  }

  private async indexRange(fromBlock: bigint, toBlock: bigint) {
    const systemAddresses = [this.launcher, this.locker, this.otc].filter(Boolean) as Address[];
    const paidLogs = paidClient;
    const systemLogs = await getLogsWithFallback(
      fromBlock,
      toBlock,
      () => logClient.getLogs({ address: systemAddresses, fromBlock, toBlock }),
      paidLogs ? (from, to) => paidLogs.getLogs({ address: systemAddresses, fromBlock: from, toBlock: to }) : undefined,
    );
    for (const log of systemLogs) await this.indexSystemLog(log);

    const addresses = [...this.pools.values()].map((pool) => pool.pool_address);
    for (let index = 0; index < addresses.length; index += 100) {
      const batch = addresses.slice(index, index + 100);
      const logs = await getLogsWithFallback(
        fromBlock,
        toBlock,
        () => logClient.getLogs({ address: batch, event: swapEvent, fromBlock, toBlock, strict: true }),
        paidLogs ? (from, to) => paidLogs.getLogs({
          address: batch, event: swapEvent, fromBlock: from, toBlock: to, strict: true,
        }) : undefined,
      );
      for (const log of logs) await this.indexSwap(log as never);
    }
  }

  private async indexSystemLog(log: Log) {
    const address = log.address.toLowerCase();
    if (address === this.launcher.toLowerCase()) {
      let decoded;
      try { decoded = decodeEventLog({ abi: launcherAbi, data: log.data, topics: log.topics }); }
      catch { return; }
      if (decoded.eventName === "TokenLaunched") await this.indexLaunch({ ...log, ...decoded } as never);
    } else if (this.locker && address === this.locker.toLowerCase()) {
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: [feesHarvestedEvent, launcherFeesClaimedEvent, protocolFeesDepositedEvent],
          data: log.data,
          topics: log.topics,
        });
      } catch { return; }
      if (decoded.eventName === "FeesHarvested") await this.indexFeeHarvest({ ...log, ...decoded } as never);
      else if (decoded.eventName === "LauncherFeesClaimed") await this.indexFeeClaim({ ...log, ...decoded } as never);
      else if (decoded.eventName === "ProtocolFeesDeposited") await this.indexProtocolFeeDeposit({ ...log, ...decoded } as never);
    } else if (this.otc && address === this.otc.toLowerCase()) {
      let decoded;
      try { decoded = decodeEventLog({ abi: [otcSwapEvent], data: log.data, topics: log.topics }); }
      catch { return; }
      if (decoded.eventName === "OtcSwap") await this.indexOtcSwap({ ...log, ...decoded } as never);
    }
  }

  private async blockTime(log: { blockNumber: bigint }) {
    const cached = this.blockTimes.get(log.blockNumber);
    if (cached) return cached;
    const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
    const value = new Date(Number(block.timestamp) * 1000);
    this.blockTimes.set(log.blockNumber, value);
    if (this.blockTimes.size > 512) {
      const oldest = this.blockTimes.keys().next().value;
      if (oldest !== undefined) this.blockTimes.delete(oldest);
    }
    return value;
  }

  private refreshPoolSubscription(pool: Address, launchBlock: bigint) {
    this.poolRefresh = this.poolRefresh.then(async () => {
      const paidLogs = paidClient;
      await this.replacePoolSubscriptions();
      const head = await publicClient.getBlockNumber();
      const safeHead = head > this.confirmationBlocks ? head - this.confirmationBlocks : head;
      if (launchBlock > safeHead) return;
      const logs = await getLogsWithFallback(
        launchBlock,
        safeHead,
        () => logClient.getLogs({ address: pool, event: swapEvent, fromBlock: launchBlock, toBlock: safeHead, strict: true }),
        paidLogs ? (from, to) => paidLogs.getLogs({
          address: pool, event: swapEvent, fromBlock: from, toBlock: to, strict: true,
        }) : undefined,
      );
      for (const swap of logs) await this.indexSwap(swap as never);
    }).catch((error) => {
      const name = error instanceof Error ? error.name : "Error";
      console.error(`[ramenpad:ws] pool subscription refresh failed (${name})`);
      this.wsConnected = false;
      void this.recoverLiveSubscriptions();
    });
    return this.poolRefresh;
  }

  private async indexLaunch(log: {
    args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint;
  }) {
    const args = log.args as {
      launchId: bigint; token: Address; launcher: Address; pool: Address; positionTokenId: bigint;
      name: string; symbol: string; imageUrl: string; sqrtPriceX96: bigint; tickLower: number; tickUpper: number;
    };
    const token = getAddress(args.token);
    const pool = getAddress(args.pool);
    const wasKnown = this.pools.has(pool.toLowerCase());
    const token0 = BigInt(token) < BigInt(RAMEN) ? token : RAMEN;
    const token1 = token0 === token ? RAMEN : token;
    const launchedAt = await this.blockTime(log);
    const targetMarketCapUsd = log.blockNumber >= TARGET_2000_ACTIVATION_BLOCK
      ? TARGET_MARKET_CAP_USD
      : LEGACY_TARGET_MARKET_CAP_USD;
    const ramenUsd = await getRamenUsd();
    const tokenIsToken0 = token0.toLowerCase() === token.toLowerCase();
    const launchPrice = priceFromSqrt(args.sqrtPriceX96, tokenIsToken0, ramenUsd);
    const launchPriceRamen = launchPrice.ramenPerToken;
    const launchPriceUsd = launchPrice.priceUsd || targetMarketCapUsd / TOTAL_SUPPLY;
    const launchMarketCapUsd = launchPriceUsd * TOTAL_SUPPLY;
    const result = await this.db.query(`
      INSERT INTO ramenpad.launches(
        token_address,pool_address,launcher,position_token_id,launch_id,name,symbol,image_url,token0,token1,
        sqrt_price_x96,tick_lower,tick_upper,launch_tx,launch_block,launched_at,price_ramen,price_usd,market_cap_usd
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT(token_address) DO NOTHING RETURNING *
    `, [
      token.toLowerCase(), pool.toLowerCase(), args.launcher.toLowerCase(), args.positionTokenId.toString(), args.launchId.toString(),
      args.name, args.symbol, args.imageUrl, token0.toLowerCase(), token1.toLowerCase(), args.sqrtPriceX96.toString(),
      args.tickLower, args.tickUpper, log.transactionHash.toLowerCase(), log.blockNumber.toString(), launchedAt,
      launchPriceRamen, launchPriceUsd, launchMarketCapUsd,
    ]);
    const row: PoolRow = { token_address: token, pool_address: pool, token0, token1, symbol: args.symbol };
    this.pools.set(pool.toLowerCase(), row);
    if (liveClient && !wasKnown) await this.refreshPoolSubscription(pool, log.blockNumber);
    if (result.rowCount) this.io.emit("ramenpad:launch", {
      tokenAddress: token, poolAddress: pool, launcher: args.launcher,
      positionTokenId: args.positionTokenId.toString(), name: args.name, symbol: args.symbol,
      imageUrl: args.imageUrl, launchedAt: launchedAt.toISOString(), priceUsd: launchPriceUsd,
      marketCapUsd: launchMarketCapUsd, volumeUsd: 0,
    });
  }

  private async indexSwap(log: {
    address: Address; args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint;
    logIndex: number;
  }) {
    const pool = this.pools.get(log.address.toLowerCase());
    if (!pool) return;
    const args = log.args as { recipient: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint };
    const routedPoolLeg = Boolean(this.otc && args.recipient.toLowerCase() === this.otc.toLowerCase());
    const tokenIsToken0 = pool.token0.toLowerCase() === pool.token_address.toLowerCase();
    const tokenDelta = tokenIsToken0 ? args.amount0 : args.amount1;
    const ramenDelta = tokenIsToken0 ? args.amount1 : args.amount0;
    const side = tokenDelta < 0n ? "buy" : "sell";
    const tokenAmount = formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, 18);
    const ramenAmount = formatUnits(ramenDelta < 0n ? -ramenDelta : ramenDelta, 18);
    const ramenUsd = await getRamenUsd();
    const { priceUsd, ramenPerToken } = priceFromSqrt(args.sqrtPriceX96, tokenIsToken0, ramenUsd);
    const marketCapUsd = priceUsd * TOTAL_SUPPLY;
    if (routedPoolLeg) {
      await this.db.query(`
        UPDATE ramenpad.launches SET sqrt_price_x96=$2, price_ramen=$3, price_usd=$4, market_cap_usd=$5
        WHERE token_address=$1
      `, [pool.token_address.toLowerCase(), args.sqrtPriceX96.toString(), ramenPerToken, priceUsd, marketCapUsd]);
      this.io.emit("ramenpad:tokens:update", {
        tokenAddress: pool.token_address, priceUsd, marketCapUsd, volumeDeltaUsd: 0,
      });
      return;
    }
    const usdValue = Number(ramenAmount) * ramenUsd;
    const blockTime = await this.blockTime(log);
    const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    const result = await this.db.query(`
      INSERT INTO ramenpad.trades(
        id,token_address,pool_address,side,trader,token_amount,ramen_amount,usd_value,price_usd,
        market_cap_usd,sqrt_price_x96,tx_hash,log_index,block_number,block_time
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(id) DO NOTHING RETURNING id
    `, [
      id, pool.token_address.toLowerCase(), pool.pool_address.toLowerCase(), side, args.recipient.toLowerCase(),
      tokenAmount, ramenAmount, usdValue, priceUsd, marketCapUsd, args.sqrtPriceX96.toString(),
      log.transactionHash.toLowerCase(), log.logIndex, log.blockNumber.toString(), blockTime,
    ]);
    if (!result.rowCount) return;
    await this.db.query(`
      UPDATE ramenpad.launches SET sqrt_price_x96=$2, price_ramen=$3, price_usd=$4,
        market_cap_usd=$5, volume_usd=volume_usd+$6
      WHERE token_address=$1
    `, [pool.token_address.toLowerCase(), args.sqrtPriceX96.toString(), ramenPerToken, priceUsd, marketCapUsd, usdValue]);
    this.io.emit("ramenpad:trade", {
      id, tokenAddress: pool.token_address, poolAddress: pool.pool_address, symbol: pool.symbol,
      side, trader: args.recipient, tokenAmount, ramenAmount, usdValue, priceUsd, marketCapUsd,
      txHash: log.transactionHash, blockTime: blockTime.toISOString(),
    });
    this.io.emit("ramenpad:tokens:update", { tokenAddress: pool.token_address, priceUsd, marketCapUsd, volumeDeltaUsd: usdValue });
  }

  private async indexOtcSwap(log: {
    args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint;
    logIndex: number;
  }) {
    const args = log.args as {
      token: Address; trader: Address; recipient: Address; isBuy: boolean; amountIn: bigint; amountOut: bigint;
    };
    const launchResult = await this.db.query<PoolRow>(
      "SELECT token_address, pool_address, token0, token1, symbol FROM ramenpad.launches WHERE token_address=$1",
      [args.token.toLowerCase()],
    );
    const pool = launchResult.rows[0];
    if (!pool) return;
    const tokenRaw = args.isBuy ? args.amountOut : args.amountIn;
    const ramenRaw = args.isBuy ? args.amountIn : args.amountOut;
    const tokenAmount = formatUnits(tokenRaw, 18);
    const ramenAmount = formatUnits(ramenRaw, 18);
    const ramenUsd = await getRamenUsd();
    const priceRamen = Number(tokenAmount) === 0 ? 0 : Number(ramenAmount) / Number(tokenAmount);
    const priceUsd = priceRamen * ramenUsd;
    const marketCapUsd = priceUsd * TOTAL_SUPPLY;
    const usdValue = Number(ramenAmount) * ramenUsd;
    const blockTime = await this.blockTime(log);
    const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    const result = await this.db.query(`
      INSERT INTO ramenpad.trades(
        id,token_address,pool_address,side,trader,token_amount,ramen_amount,usd_value,price_usd,
        market_cap_usd,sqrt_price_x96,tx_hash,log_index,block_number,block_time
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14)
      ON CONFLICT(id) DO NOTHING RETURNING id
    `, [
      id, pool.token_address.toLowerCase(), pool.pool_address.toLowerCase(), args.isBuy ? "buy" : "sell",
      args.recipient.toLowerCase(), tokenAmount, ramenAmount, usdValue, priceUsd, marketCapUsd,
      log.transactionHash.toLowerCase(), log.logIndex, log.blockNumber.toString(), blockTime,
    ]);
    if (!result.rowCount) return;
    await this.db.query(`
      UPDATE ramenpad.launches SET price_ramen=$2, price_usd=$3, market_cap_usd=$4, volume_usd=volume_usd+$5
      WHERE token_address=$1
    `, [pool.token_address.toLowerCase(), priceRamen, priceUsd, marketCapUsd, usdValue]);
    const trade = {
      id, tokenAddress: pool.token_address, poolAddress: pool.pool_address, symbol: pool.symbol,
      side: args.isBuy ? "buy" : "sell", trader: args.recipient, tokenAmount, ramenAmount,
      usdValue, priceUsd, marketCapUsd, txHash: log.transactionHash, blockTime: blockTime.toISOString(),
    };
    this.io.emit("ramenpad:trade", trade);
    this.io.emit("ramenpad:tokens:update", {
      tokenAddress: pool.token_address, priceUsd, marketCapUsd, volumeDeltaUsd: usdValue,
    });
  }

  private async feePool(tokenId: bigint) {
    const result = await this.db.query<FeePoolRow>(`
      SELECT token_address, pool_address, token0, token1, symbol, position_token_id::text, price_usd::text
      FROM ramenpad.launches WHERE position_token_id=$1
    `, [tokenId.toString()]);
    return result.rows[0];
  }

  private splitAssets(pool: FeePoolRow, amount0: bigint, amount1: bigint) {
    const tokenIs0 = pool.token0.toLowerCase() === pool.token_address.toLowerCase();
    return tokenIs0 ? [amount0, amount1] as const : [amount1, amount0] as const;
  }

  private async indexFeeHarvest(log: {
    args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint;
    logIndex: number;
  }) {
    const args = log.args as {
      tokenId: bigint; creatorAmount0: bigint; creatorAmount1: bigint;
      devAmount0: bigint; devAmount1: bigint; ownerAmount0: bigint; ownerAmount1: bigint;
    };
    const pool = await this.feePool(args.tokenId);
    if (!pool) return;
    const [launcherTokenRaw, launcherRamenRaw] = this.splitAssets(pool, args.creatorAmount0, args.creatorAmount1);
    const [devTokenRaw, devRamenRaw] = this.splitAssets(pool, args.devAmount0, args.devAmount1);
    const [ownerTokenRaw, ownerRamenRaw] = this.splitAssets(pool, args.ownerAmount0, args.ownerAmount1);
    const launcherToken = formatUnits(launcherTokenRaw, 18);
    const launcherRamen = formatUnits(launcherRamenRaw, 18);
    const devToken = formatUnits(devTokenRaw, 18);
    const devRamen = formatUnits(devRamenRaw, 18);
    const ownerToken = formatUnits(ownerTokenRaw, 18);
    const ownerRamen = formatUnits(ownerRamenRaw, 18);
    const ramenUsd = await getRamenUsd();
    const tokenUsd = Number(pool.price_usd);
    const launcherFeeUsd = Number(launcherToken) * tokenUsd + Number(launcherRamen) * ramenUsd;
    const protocolFeeUsd = (Number(devToken) + Number(ownerToken)) * tokenUsd
      + (Number(devRamen) + Number(ownerRamen)) * ramenUsd;
    const blockTime = await this.blockTime(log);
    const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    const result = await this.db.query(`
      INSERT INTO ramenpad.fee_harvests(
        id,token_address,position_token_id,launcher_token_amount,launcher_ramen_amount,
        dev_token_amount,dev_ramen_amount,owner_token_amount,owner_ramen_amount,
        total_fee_usd,launcher_fee_usd,protocol_fee_usd,tx_hash,log_index,block_number,block_time
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT(id) DO NOTHING RETURNING id
    `, [
      id, pool.token_address.toLowerCase(), args.tokenId.toString(), launcherToken, launcherRamen,
      devToken, devRamen, ownerToken, ownerRamen, launcherFeeUsd + protocolFeeUsd, launcherFeeUsd,
      protocolFeeUsd, log.transactionHash.toLowerCase(), log.logIndex, log.blockNumber.toString(), blockTime,
    ]);
    if (result.rowCount) this.io.emit("ramenpad:fees", {
      tokenAddress: pool.token_address,
      totalFeeUsd: launcherFeeUsd + protocolFeeUsd,
      launcherFeeUsd,
      protocolFeeUsd,
    });
  }

  private async indexFeeClaim(log: {
    args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint;
    logIndex: number;
  }) {
    const args = log.args as { tokenId: bigint; launcher: Address; amount0: bigint; amount1: bigint };
    const pool = await this.feePool(args.tokenId);
    if (!pool) return;
    const [tokenRaw, ramenRaw] = this.splitAssets(pool, args.amount0, args.amount1);
    const tokenAmount = formatUnits(tokenRaw, 18);
    const ramenAmount = formatUnits(ramenRaw, 18);
    const claimedUsd = Number(tokenAmount) * Number(pool.price_usd) + Number(ramenAmount) * await getRamenUsd();
    const blockTime = await this.blockTime(log);
    const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    await this.db.query(`
      INSERT INTO ramenpad.fee_claims(
        id,token_address,position_token_id,token_amount,ramen_amount,claimed_usd,
        tx_hash,log_index,block_number,block_time
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(id) DO NOTHING
    `, [
      id, pool.token_address.toLowerCase(), args.tokenId.toString(), tokenAmount, ramenAmount, claimedUsd,
      log.transactionHash.toLowerCase(), log.logIndex, log.blockNumber.toString(), blockTime,
    ]);
  }

  private async indexProtocolFeeDeposit(log: {
    args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint;
    logIndex: number;
  }) {
    const args = log.args as { tokenId: bigint; asset: Address; devAmount: bigint; ownerAmount: bigint };
    const pool = await this.feePool(args.tokenId);
    if (!pool) return;
    const asset = args.asset.toLowerCase();
    const isToken = asset === pool.token_address.toLowerCase();
    const isRamen = asset === RAMEN.toLowerCase();
    if (!isToken && !isRamen) return;
    const zero = "0";
    const devAmount = formatUnits(args.devAmount, 18);
    const ownerAmount = formatUnits(args.ownerAmount, 18);
    const blockTime = await this.blockTime(log);
    const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    await this.db.query(`
      INSERT INTO ramenpad.protocol_fee_deposits(
        id,token_address,position_token_id,asset,dev_token_amount,dev_ramen_amount,
        owner_token_amount,owner_ramen_amount,tx_hash,log_index,block_number,block_time
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(id) DO NOTHING
    `, [
      id, pool.token_address.toLowerCase(), args.tokenId.toString(), asset,
      isToken ? devAmount : zero, isRamen ? devAmount : zero,
      isToken ? ownerAmount : zero, isRamen ? ownerAmount : zero,
      log.transactionHash.toLowerCase(), log.logIndex, log.blockNumber.toString(), blockTime,
    ]);
  }
}
