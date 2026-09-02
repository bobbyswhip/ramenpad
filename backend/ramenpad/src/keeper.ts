import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { launcherAbi, lockerAbi } from "./abi.js";
import { publicClient, requiredAddress, requiredPrivateKey, robinhood } from "./config.js";
import type { Database } from "./db.js";

export class RamenpadKeeper {
  private static readonly DECIMALS = 10n ** 18n;
  private stopped = false;
  private running = false;
  private timer?: NodeJS.Timeout;
  private locker?: Address;
  private lastTokenAddress = "";
  private readonly intervalMs = Math.max(60_000, Number(process.env.RAMENPAD_KEEPER_INTERVAL_MS) || 600_000);
  private readonly batchSize = Math.max(1, Math.min(100, Number(process.env.RAMENPAD_KEEPER_BATCH_SIZE) || 25));
  private readonly minHarvest = BigInt(process.env.RAMENPAD_KEEPER_MIN_HARVEST || "1000") * RamenpadKeeper.DECIMALS;
  private readonly account = privateKeyToAccount(requiredPrivateKey("RAMENPAD_KEEPER_PRIVATE_KEY"));
  private readonly wallet = createWalletClient({
    account: this.account,
    chain: robinhood,
    transport: http(robinhood.rpcUrls.default.http[0]),
  });

  constructor(private db: Database) {}

  async start() {
    const launcher = requiredAddress("RAMENPAD_LAUNCHER_ADDRESS");
    this.locker = await publicClient.readContract({ address: launcher, abi: launcherAbi, functionName: "locker" });
    console.log(
      `[ramenpad:keeper] ${this.account.address} / ${this.intervalMs / 60_000}m / batch ${this.batchSize} / minimum ${this.minHarvest / RamenpadKeeper.DECIMALS}`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running || this.stopped || !this.locker) return;
    this.running = true;
    try {
      let result = await this.db.query<{ token_address: string; position_token_id: string }>(`
        SELECT token_address, position_token_id::text FROM ramenpad.launches
        WHERE token_address > $1 ORDER BY token_address ASC LIMIT $2
      `, [this.lastTokenAddress, this.batchSize]);
      if (!result.rowCount && this.lastTokenAddress) {
        this.lastTokenAddress = "";
        result = await this.db.query<{ token_address: string; position_token_id: string }>(`
          SELECT token_address, position_token_id::text FROM ramenpad.launches
          ORDER BY token_address ASC LIMIT $1
        `, [this.batchSize]);
      }
      for (const row of result.rows) {
        if (this.stopped) break;
        this.lastTokenAddress = row.token_address;
        const tokenId = BigInt(row.position_token_id);
        const simulation = await publicClient.simulateContract({
          account: this.account,
          address: this.locker,
          abi: lockerAbi,
          functionName: "harvest",
          args: [tokenId],
        });
        const [amount0, amount1] = simulation.result;
        if (amount0 + amount1 <= this.minHarvest) continue;
        const hash = await this.wallet.writeContract(simulation.request);
        await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
        console.log(`[ramenpad:keeper] harvested LP #${tokenId}: ${hash}`);
      }
    } catch (error) {
      console.error("[ramenpad:keeper]", error);
    } finally {
      this.running = false;
    }
  }
}
