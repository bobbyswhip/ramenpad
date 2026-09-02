import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeEventLog, encodeFunctionData, formatUnits, parseEther, parseUnits } from "viem";
import { getConfig, getKpis, getQuote, getTokens, getTrades, subscribeLive, tokenImageUpdateMessage, updateTokenImage, uploadImage } from "./api";
import { erc20Abi, ethRouterAbi, launcherAbi, lockerAbi, otcAbi, quoterAbi, v2RouterAbi } from "./abi";
import { ETH_ROUTER, LAUNCHER, RAMEN, RAMEN_IMAGE, RAMEN_PAIR, TARGET_MARKET_CAP, TARGET_TOKEN_PRICE, TOTAL_SUPPLY, V2_ROUTER, V3_QUOTER, WETH, robinhood } from "./config";
import type { ProtocolKpis, TokenSummary, Trade } from "./types";
import { connectWallet, publicClient, shortAddress } from "./wallet";
import "./styles.css";

type Tab = "launch" | "explore" | "profile";
type PayAsset = "ETH" | "RAMEN";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

type ConnectedWallet = Awaited<ReturnType<typeof connectWallet>>;
type CreatorClaimable = { token: string; ramen: string; status: "loading" | "ready" | "error" };

async function ensureAllowance(
  wallet: ConnectedWallet,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
  onStatus: (message: string) => void,
) {
  const allowance = await publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [wallet.account, spender],
  });
  if (allowance >= amount) return false;
  onStatus("Approval needed — confirm it once in your wallet…");
  const hash = await wallet.client.writeContract({
    address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount],
  });
  onStatus("Waiting for approval confirmation…");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Approval transaction failed");
  return true;
}

function tokenAmount(value?: string) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? compact.format(amount) : "0";
}

function timeAgo(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return "NOW";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}M AGO`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}H AGO`;
  return `${Math.floor(elapsed / 86_400_000)}D AGO`;
}

function balanceShare(balance: string, percent: number) {
  try {
    return formatUnits(parseUnits(balance || "0", 18) * BigInt(percent) / 100n, 18);
  } catch { return "0"; }
}

function BuyBalance({ asset, balance, onFill }: { asset: string; balance: string; onFill: (amount: string) => void }) {
  return <div className="buy-balance">
    <span>AVAILABLE <b>{Number(balance || 0).toLocaleString(undefined, { maximumFractionDigits: asset === "ETH" ? 6 : 3 })} {asset}</b></span>
    <div>{[25, 50, 75].map((percent) => <button type="button" key={percent} onClick={() => onFill(balanceShare(balance, percent))}>{percent}%</button>)}</div>
  </div>;
}

function LiveTape({ trades }: { trades: Trade[] }) {
  return (
    <div className="tape" aria-label="Live trades">
      <div className="tape-label"><i /> LIVE RAMEN BUYS</div>
      <div className="tape-track">
        {trades.length === 0 ? <span>Waiting for the first bowl…</span> : trades.slice(0, 12).map((trade) => (
          <a key={trade.id} href={`${robinhood.blockExplorers.default.url}/tx/${trade.txHash}`} target="_blank" rel="noreferrer" className={trade.side}>
            {trade.side === "buy" ? "▲" : "▼"} {money.format(trade.usdValue)} ${trade.symbol}
          </a>
        ))}
      </div>
    </div>
  );
}

function KpiStrip({ kpis }: { kpis?: ProtocolKpis }) {
  return (
    <div className="kpi-strip">
      <div><small>TOTAL FEES</small><b>{money.format(kpis?.totalFeeUsd || 0)}</b></div>
      <div><small>PROTOCOL EARNED</small><b>{money.format(kpis?.protocolFeeUsd || 0)}</b></div>
      <div><small>LAUNCHERS EARNED</small><b>{money.format(kpis?.launcherFeeUsd || 0)}</b></div>
      <div><small>HARVESTS</small><b>{kpis?.harvestCount || 0}</b></div>
    </div>
  );
}

function LaunchForm({ account, connect, onLaunched, payAsset, onPayAssetChange, ethBalance, ramenBalance }: {
  account?: `0x${string}`;
  connect: () => Promise<void>;
  onLaunched: (token: TokenSummary) => void;
  payAsset: PayAsset;
  onPayAssetChange: (asset: PayAsset) => void;
  ethBalance: string;
  ramenBalance: string;
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState<File>();
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [firstBuy, setFirstBuy] = useState("");
  const [firstBuySlippage, setFirstBuySlippage] = useState("10");

  const valid = name.trim().length > 0 && name.trim().length <= 32 && symbol.trim().length > 0 && symbol.trim().length <= 10;

  async function launch() {
    if (!account) { await connect(); return; }
    if (!LAUNCHER) { setStatus("Launcher address is not configured yet."); return; }
    const launcherAddress = LAUNCHER;
    if (!valid || busy) return;
    setBusy(true);
    try {
      setStatus("Locking in the $2,000 launch quote…");
      const imageUrl = image ? (await uploadImage(image)).imageUrl : "";
      const quote = await getQuote({ creator: account, name: name.trim(), symbol: symbol.trim().toUpperCase() });
      const wallet = await connectWallet();
      setStatus("Confirm the launch in your wallet…");
      const priceQuote = {
        sqrtPriceX96: BigInt(quote.quote.sqrtPriceX96),
        tickLower: quote.quote.tickLower,
        tickUpper: quote.quote.tickUpper,
        deadline: BigInt(quote.quote.deadline),
      };
      const firstBuyIn = firstBuy.trim()
        ? (payAsset === "ETH" ? parseEther(firstBuy) : parseUnits(firstBuy, 18))
        : 0n;
      let hash: `0x${string}`;
      if (firstBuyIn > 0n) {
        const slippage = Math.min(50, Math.max(0.5, Number(firstBuySlippage) || 10));
        let estimatedRamen = Number(firstBuy);
        if (payAsset === "ETH") {
          const amounts = await publicClient.readContract({
            address: V2_ROUTER, abi: v2RouterAbi, functionName: "getAmountsOut",
            args: [firstBuyIn, [WETH, RAMEN]],
          });
          estimatedRamen = Number(formatUnits(amounts[1] * 98n / 100n, 18));
        }
        const expectedTokens = estimatedRamen * quote.ramenUsd / quote.targetTokenUsd;
        const minTokenOut = parseUnits((expectedTokens * (1 - slippage / 100)).toFixed(18), 18);
        if (payAsset === "ETH") {
          setStatus("Confirm launch + ETH first buy in one transaction…");
          hash = await wallet.client.writeContract({
            address: launcherAddress, abi: launcherAbi, functionName: "launchAndBuy",
            args: [name.trim(), symbol.trim().toUpperCase(), imageUrl, priceQuote, quote.signature, 0n, minTokenOut],
            value: firstBuyIn,
          });
        } else {
          await ensureAllowance(wallet, RAMEN, launcherAddress, firstBuyIn, setStatus);
          setStatus("Confirm launch + first buy in one transaction…");
          hash = await wallet.client.writeContract({
            address: launcherAddress, abi: launcherAbi, functionName: "launchAndBuyWithRamen",
            args: [name.trim(), symbol.trim().toUpperCase(), imageUrl, priceQuote, quote.signature, firstBuyIn, minTokenOut],
          });
        }
      } else {
        hash = await wallet.client.writeContract({
          address: launcherAddress,
          abi: launcherAbi,
          functionName: "launch",
          args: [name.trim(), symbol.trim().toUpperCase(), imageUrl, priceQuote, quote.signature],
        });
      }
      setStatus("Noodles are cooking onchain…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const log = receipt.logs.find((entry) => entry.address.toLowerCase() === launcherAddress.toLowerCase());
      if (!log) throw new Error("Launch confirmed, but the launch event was not found.");
      const decoded = decodeEventLog({ abi: launcherAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== "TokenLaunched") throw new Error("Unexpected launch event.");
      const args = decoded.args;
      const token: TokenSummary = {
        tokenAddress: args.token,
        poolAddress: args.pool,
        launcher: args.launcher,
        positionTokenId: args.positionTokenId.toString(),
        name: args.name,
        symbol: args.symbol,
        imageUrl: args.imageUrl,
        launchedAt: new Date().toISOString(),
        marketCapUsd: TARGET_MARKET_CAP,
      };
      onLaunched(token);
      setStatus(`$${token.symbol} is live. LP #${token.positionTokenId} is permanently locked.`);
      setName(""); setSymbol(""); setImage(undefined); setPreview(""); setFirstBuy("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Launch failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="launch-grid">
      <div className="launch-copy">
        <div className="eyebrow">FIXED RECIPE · ROBINHOOD CHAIN</div>
        <h1>Cook up a coin.<br /><em>Serve it with RAMEN.</em></h1>
        <p>One transaction creates your token, opens its Uniswap v3 market, and locks every strand of liquidity forever.</p>
        <div className="recipe-strip">
          <div><b>{compact.format(TOTAL_SUPPLY)}</b><span>fixed supply</span></div>
          <div><b>{money.format(TARGET_MARKET_CAP)}</b><span>launch market cap</span></div>
          <div><b>69 / 31</b><span>creator / protocol fees</span></div>
        </div>
        <a className="ramen-pair" href={`https://dexscreener.com/robinhood/${RAMEN_PAIR}`} target="_blank" rel="noreferrer">
          <span className="bowl">🍜</span>
          <span><small>Every pool is paired with</small><strong>RAMEN</strong></span>
          <span>↗</span>
        </a>
      </div>

      <div className="launch-card">
        <div className="card-top"><span>NEW FLAVOR</span><span>01</span></div>
        <label>Token artwork <small>optional · 2 MB max</small></label>
        <label className="image-picker">
          {preview ? <img src={preview} alt="Token preview" /> : <span>＋<small>DROP LOGO</small></span>}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) { setStatus("Artwork must be 2 MB or smaller."); return; }
            setImage(file); setPreview(URL.createObjectURL(file));
          }} />
        </label>
        <div className="field-row">
          <div><label htmlFor="name">Name</label><input id="name" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="Spicy Miso" /></div>
          <div><label htmlFor="symbol">Ticker</label><input id="symbol" maxLength={10} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/\s/g, ""))} placeholder="MISO" /></div>
        </div>
        <div className="terms">
          <div><span>Supply</span><b>6,942,000</b></div>
          <div><span>Start price</span><b>${TARGET_TOKEN_PRICE.toFixed(7)}</b></div>
          <div><span>DEX / fee tier</span><b>Uniswap v3 · 1%</b></div>
          <div><span>Liquidity</span><b className="locked">Locked forever</b></div>
        </div>
        <div className="first-buy">
          <div><label htmlFor="first-buy">Atomic first buy <small>optional</small></label><div className="asset-input"><input id="first-buy" inputMode="decimal" value={firstBuy} onChange={(e) => setFirstBuy(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" /><button type="button" onClick={() => onPayAssetChange(payAsset === "ETH" ? "RAMEN" : "ETH")}>{payAsset}</button></div><BuyBalance asset={payAsset} balance={payAsset === "ETH" ? ethBalance : ramenBalance} onFill={setFirstBuy} /></div>
          <div><label htmlFor="first-slippage">Max slippage</label><input id="first-slippage" inputMode="decimal" value={firstBuySlippage} onChange={(e) => setFirstBuySlippage(e.target.value.replace(/[^0-9.]/g, ""))} /><i>%</i></div>
        </div>
        <button className="launch-button" disabled={busy || (!!account && !valid)} onClick={launch}>
          {busy ? "COOKING…" : account ? "LAUNCH TOKEN" : "CONNECT WALLET"}<span>→</span>
        </button>
        {status && <p className="status">{status}</p>}
        <p className="fineprint">Launching creates an irreversible fixed-supply token and permanent liquidity. Live RAMEN-priced quotes expire after 2 minutes.</p>
      </div>
    </section>
  );
}

function SwapBox({ token, account, onNotice, payAsset, onPayAssetChange, ethBalance, ramenBalance, tokenBalance, onBalancesChanged }: {
  token: TokenSummary;
  account?: `0x${string}`;
  onNotice: (message: string) => void;
  payAsset: PayAsset;
  onPayAssetChange: (asset: PayAsset) => void;
  ethBalance: string;
  ramenBalance: string;
  tokenBalance: string;
  onBalancesChanged: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [busy, setBusy] = useState(false);
  const [quotedOut, setQuotedOut] = useState<bigint>();
  const [quotedRamen, setQuotedRamen] = useState<bigint>();
  const [quoteState, setQuoteState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    setQuotedOut(undefined); setQuotedRamen(undefined);
    if (!amount || Number(amount) <= 0) { setQuoteState("idle"); return; }
    let cancelled = false;
    setQuoteState("loading");
    const timer = window.setTimeout(async () => {
      try {
        let swapIn = parseUnits(amount, 18);
        if (side === "buy" && payAsset === "ETH") {
          swapIn = parseEther(amount);
          const amounts = await publicClient.readContract({
            address: V2_ROUTER, abi: v2RouterAbi, functionName: "getAmountsOut",
            args: [swapIn, [WETH, RAMEN]],
          });
          // RAMEN currently applies 2% on transfers out of its designated v2 pool.
          swapIn = amounts[1] * 98n / 100n;
          if (!cancelled) setQuotedRamen(swapIn);
        }
        const quote = await publicClient.simulateContract({
          address: V3_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
          args: [{
            tokenIn: side === "buy" ? RAMEN : token.tokenAddress,
            tokenOut: side === "buy" ? token.tokenAddress : RAMEN,
            amountIn: swapIn, fee: 10_000, sqrtPriceLimitX96: 0n,
          }],
        });
        if (!cancelled) { setQuotedOut(quote.result[0]); setQuoteState("ready"); }
      } catch {
        if (!cancelled) setQuoteState("error");
      }
    }, 450);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [amount, payAsset, side, token.tokenAddress]);

  const slipBps = BigInt(Math.round(Math.min(50, Math.max(0.1, Number(slippage) || 1)) * 100));
  const minOut = quotedOut ? quotedOut * (10_000n - slipBps) / 10_000n : 0n;

  async function swap() {
    if (!account) { onNotice("Connect your wallet to swap."); return; }
    if (!LAUNCHER || !amount || Number(amount) <= 0 || !quotedOut || busy) return;
    setBusy(true);
    try {
      const wallet = await connectWallet();
      const otcAddress = await publicClient.readContract({
        address: LAUNCHER, abi: launcherAbi, functionName: "otc",
      });
      let hash: `0x${string}`;
      if (side === "buy" && payAsset === "ETH") {
        onNotice(`Confirm one-step ETH → RAMEN → ${token.symbol} buy…`);
        hash = await wallet.client.writeContract({
          address: ETH_ROUTER, abi: ethRouterAbi, functionName: "buyWithEth",
          args: [token.tokenAddress, minOut, account, BigInt(Math.floor(Date.now() / 1000) + 600)],
          value: parseEther(amount),
        });
      } else {
        const amountIn = parseUnits(amount, 18);
        const tokenIn = side === "buy" ? RAMEN : token.tokenAddress;
        await ensureAllowance(wallet, tokenIn, otcAddress, amountIn, onNotice);
        onNotice(`Confirm ${side}: minimum ${Number(formatUnits(minOut, 18)).toLocaleString()} ${side === "buy" ? token.symbol : "RAMEN"}…`);
        hash = side === "buy"
          ? await wallet.client.writeContract({
              address: otcAddress, abi: otcAbi, functionName: "buy",
              args: [token.tokenAddress, amountIn, minOut, account],
            })
          : await wallet.client.writeContract({
              address: otcAddress, abi: otcAbi, functionName: "sell",
              args: [token.tokenAddress, amountIn, minOut, account],
            });
      }
      onNotice("Transaction sent — waiting for confirmation…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Trade transaction failed");
      onNotice(`${side === "buy" ? "Buy" : "Sell"} confirmed.`);
      onBalancesChanged();
      setAmount("");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Swap failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="trade-panel">
      <div className="trade-head"><div className="swap-tabs">
        <button className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>BUY</button>
        <button className={side === "sell" ? "active" : ""} onClick={() => setSide("sell")}>SELL</button>
      </div><span>LIVE QUOTE</span></div>
      {side === "buy" && <div className="pay-toggle">
        <button className={payAsset === "ETH" ? "active" : ""} onClick={() => onPayAssetChange("ETH")}>PAY ETH</button>
        <button className={payAsset === "RAMEN" ? "active" : ""} onClick={() => onPayAssetChange("RAMEN")}>PAY RAMEN</button>
      </div>
      }
      <BuyBalance asset={side === "sell" ? token.symbol : payAsset} balance={side === "sell" ? tokenBalance : payAsset === "ETH" ? ethBalance : ramenBalance} onFill={setAmount} />
      <div className="trade-input"><small>YOU PAY</small><div><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" /><b>{side === "sell" ? token.symbol : payAsset}</b></div></div>
      <div className="quote-card">
        <div><span>YOU RECEIVE</span><b>{quoteState === "loading" ? "Quoting…" : quotedOut ? `${Number(formatUnits(quotedOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${side === "buy" ? token.symbol : "RAMEN"}` : "—"}</b></div>
        {side === "buy" && payAsset === "ETH" && quotedRamen && <div><span>ROUTE</span><b>ETH → {Number(formatUnits(quotedRamen, 18)).toLocaleString(undefined, { maximumFractionDigits: 3 })} RAMEN → {token.symbol}</b></div>}
        <div><span>MINIMUM RECEIVED</span><b>{minOut ? Number(formatUnits(minOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}</b></div>
        {quoteState === "error" && <p>Quote unavailable for this amount.</p>}
      </div>
      <div className="trade-controls"><label>MAX SLIPPAGE <span><input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ""))} />%</span></label>
      <button className="swap-submit" disabled={busy || !amount || quoteState !== "ready"} onClick={swap}>{busy ? "CONFIRMING…" : account ? `${side === "buy" ? "BUY" : "SELL"} ${token.symbol}` : "CONNECT TO TRADE"}</button></div>
    </div>
  );
}

function TokenCard({ token, account, claim, onNotice, locker, claimable, payAsset, onPayAssetChange, ethBalance, ramenBalance, tokenBalance, onBalancesChanged }: {
  token: TokenSummary;
  account?: `0x${string}`;
  claim: (token: TokenSummary) => void;
  onNotice: (message: string) => void;
  locker?: `0x${string}`;
  claimable?: CreatorClaimable;
  payAsset: PayAsset;
  onPayAssetChange: (asset: PayAsset) => void;
  ethBalance: string;
  ramenBalance: string;
  tokenBalance: string;
  onBalancesChanged: () => void;
}) {
  const isLauncher = account?.toLowerCase() === token.launcher.toLowerCase();
  const readyToken = claimable?.status === "ready" ? claimable.token : token.launcherTokenPending;
  const readyRamen = claimable?.status === "ready" ? claimable.ramen : token.launcherRamenPending;
  return (
    <article className="token-card">
      <div className="token-art">{token.imageUrl ? <img src={token.imageUrl} alt="" /> : <span>🍜</span>}</div>
      <div className="token-main">
        <div><h3>{token.name}</h3><span>${token.symbol}</span></div>
        <div className="token-stats">
          <span><small>MARKET CAP</small>{money.format(token.marketCapUsd || TARGET_MARKET_CAP)}</span>
          <span><small>VOLUME</small>{money.format(token.volumeUsd || 0)}</span>
          <span><small>PRICE</small>${(token.priceUsd || TARGET_TOKEN_PRICE).toPrecision(4)}</span>
          <span><small>HARVESTED FEES</small>{money.format(token.totalFeeUsd || 0)}</span>
        </div>
        <div className="fee-kpis">
          <span>Launcher harvested <b>{money.format(token.launcherFeeUsd || 0)}</b></span>
          <span>Protocol harvested <b>{money.format(token.protocolFeeUsd || 0)}</b></span>
          <span>{token.harvestCount || 0} harvests</span>
        </div>
        <div className="token-actions">
          <a href={`https://dexscreener.com/robinhood/${token.poolAddress}`} target="_blank" rel="noreferrer">DEXSCREENER ↗</a>
          <a href={`${robinhood.blockExplorers.default.url}/address/${token.tokenAddress}`} target="_blank" rel="noreferrer">CONTRACT ↗</a>
          {locker && <a className="locker-link" href={`${robinhood.blockExplorers.default.url}/address/${locker}`} target="_blank" rel="noreferrer">🔒 LP #{token.positionTokenId} LOCKED FOREVER ↗</a>}
        </div>
        {isLauncher && <div className="creator-fee-panel">
          <div><small>YOUR CREATOR FEES</small><strong>{claimable?.status === "ready" ? "Exact on-chain claim" : "Checking on-chain claim"}</strong>
            <span>{claimable?.status === "loading" || !claimable ? "Checking current LP fees…" : `${tokenAmount(readyToken)} ${token.symbol} + ${tokenAmount(readyRamen)} RAMEN ready${claimable.status === "error" ? " (last indexed)" : ""}`}</span>
          </div>
          <button onClick={() => claim(token)}>CLAIM FEES</button>
        </div>}
        <SwapBox token={token} account={account} onNotice={onNotice} payAsset={payAsset} onPayAssetChange={onPayAssetChange} ethBalance={ethBalance} ramenBalance={ramenBalance} tokenBalance={tokenBalance} onBalancesChanged={onBalancesChanged} />
      </div>
    </article>
  );
}

function MiniToken({ token, badge, detail, onSelect }: { token: TokenSummary; badge: string; detail: string; onSelect: (token: TokenSummary) => void }) {
  return <button type="button" className="mini-token" onClick={() => onSelect(token)}>
    <div className="mini-art">{token.imageUrl ? <img src={token.imageUrl} alt="" /> : "🍜"}</div>
    <div><small>{badge}</small><strong>{token.name}</strong><span>${token.symbol} · {detail}</span></div><i>→</i>
  </button>;
}

function HomeDiscovery({ tokens, trades, onSelect }: { tokens: TokenSummary[]; trades: Trade[]; onSelect: (token: TokenSummary) => void }) {
  const top = [...tokens].sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0)).slice(0, 3);
  const recentBuyTokens: Array<{ token: TokenSummary; trade: Trade }> = [];
  const seen = new Set<string>();
  for (const trade of trades) {
    if (trade.side !== "buy" || seen.has(trade.tokenAddress.toLowerCase())) continue;
    const token = tokens.find((item) => item.tokenAddress.toLowerCase() === trade.tokenAddress.toLowerCase());
    if (!token) continue;
    seen.add(trade.tokenAddress.toLowerCase());
    recentBuyTokens.push({ token, trade });
    if (recentBuyTokens.length === 10) break;
  }
  return <section className="home-discovery">
    <div className="discovery-block"><div className="section-title"><div><span>LEADING THE MENU</span><h2>Top 3 tokens</h2></div><b>BY VOLUME</b></div>
      <div className="top-grid">{top.length ? top.map((token, index) => <MiniToken key={token.tokenAddress} token={token} badge={`#${index + 1} TOP TOKEN`} detail={`${money.format(token.volumeUsd || 0)} volume`} onSelect={onSelect} />) : <p className="discovery-empty">The leaderboard starts after the first launch.</p>}</div>
    </div>
    <div className="discovery-block"><div className="section-title"><div><span>BUY ACTIVITY</span><h2>Hot new tokens</h2></div><b>10 MOST RECENT</b></div>
      <div className="hot-list">{recentBuyTokens.length ? recentBuyTokens.map(({ token, trade }) => <MiniToken key={token.tokenAddress} token={token} badge="JUST BOUGHT" detail={`${money.format(trade.usdValue)} latest buy`} onSelect={onSelect} />) : <p className="discovery-empty">Recent buys will appear here live.</p>}</div>
    </div>
  </section>;
}

function DiscoveryToken({ token, label, onSelect }: { token: TokenSummary; label?: string; onSelect: (token: TokenSummary) => void }) {
  return <button type="button" className="discovery-token" onClick={() => onSelect(token)}>
    <div className="discovery-token-art">{token.imageUrl ? <img src={token.imageUrl} alt="" /> : <span>R</span>}</div>
    <div className="discovery-token-name">{label && <small>{label}</small>}<strong>{token.name}</strong><span>${token.symbol} · {shortAddress(token.tokenAddress)}</span></div>
    <div className="discovery-token-stat"><small>PRICE</small><b>${(token.priceUsd || TARGET_TOKEN_PRICE).toPrecision(4)}</b></div>
    <div className="discovery-token-stat"><small>MARKET CAP</small><b>{money.format(token.marketCapUsd || TARGET_MARKET_CAP)}</b></div>
    <div className="discovery-token-stat"><small>VOLUME</small><b>{money.format(token.volumeUsd || 0)}</b></div>
    <i>VIEW / BUY →</i>
  </button>;
}

function ExploreMiniToken({ token, badge, detail, onSelect }: { token: TokenSummary; badge: string; detail: string; onSelect: (token: TokenSummary) => void }) {
  return <button type="button" className="mini-token" onClick={() => onSelect(token)}>
    <div className="mini-art">{token.imageUrl ? <img src={token.imageUrl} alt="" /> : <span>R</span>}</div>
    <div><small>{badge}</small><strong>{token.name}</strong><span>${token.symbol} · {detail}</span></div><i>→</i>
  </button>;
}

function ExploreDashboard({ tokens, trades, kpis, onSelect }: {
  tokens: TokenSummary[];
  trades: Trade[];
  kpis?: ProtocolKpis;
  onSelect: (token: TokenSummary) => void;
}) {
  const [search, setSearch] = useState("");
  const tokenByAddress = useMemo(() => new Map(tokens.map((token) => [token.tokenAddress.toLowerCase(), token])), [tokens]);
  const top = useMemo(() => [...tokens].sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0)).slice(0, 5), [tokens]);
  const newest = useMemo(() => [...tokens].sort((a, b) => new Date(b.launchedAt).getTime() - new Date(a.launchedAt).getTime()).slice(0, 6), [tokens]);
  const hot = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ token: TokenSummary; trade: Trade }> = [];
    for (const trade of trades) {
      if (trade.side !== "buy") continue;
      const key = trade.tokenAddress.toLowerCase();
      const token = tokenByAddress.get(key);
      if (!token || seen.has(key)) continue;
      seen.add(key);
      result.push({ token, trade });
      if (result.length === 10) break;
    }
    return result;
  }, [tokenByAddress, trades]);
  const results = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [...tokens].sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0));
    return tokens.filter((token) => token.name.toLowerCase().includes(query)
      || token.symbol.toLowerCase().includes(query)
      || token.tokenAddress.toLowerCase().includes(query));
  }, [search, tokens]);

  return <section className="explore explore-dashboard">
    <div className="explore-head"><div><span className="eyebrow">LIVE FROM THE KITCHEN</span><h2>Explore tokens</h2><p>Markets, buys and fresh launches update here as they happen.</p></div><b className="live-count"><i /> LIVE · {tokens.length} FLAVORS</b></div>
    <KpiStrip kpis={kpis} />
    <label className="token-search"><span>SEARCH</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Token name, $SYMBOL or 0x address" /><kbd>{results.length} FOUND</kbd></label>
    {search.trim() ? <div className="explore-results"><div className="market-section-title"><div><small>SEARCH RESULTS</small><h3>Matching tokens</h3></div></div>
      <div className="discovery-token-list">{results.length ? results.map((token) => <DiscoveryToken key={token.tokenAddress} token={token} onSelect={onSelect} />) : <div className="empty">No token matches that search.</div>}</div>
    </div> : <>
      <div className="explore-market-grid">
        <div className="market-panel market-panel-wide"><div className="market-section-title"><div><small>LEADERBOARD</small><h3>Top tokens</h3></div><b>BY VOLUME</b></div>
          <div className="discovery-token-list">{top.length ? top.map((token, index) => <DiscoveryToken key={token.tokenAddress} token={token} label={`#${index + 1}`} onSelect={onSelect} />) : <div className="empty">The leaderboard starts after the first launch.</div>}</div>
        </div>
        <aside className="activity-panel"><div className="market-section-title"><div><small>MARKET TAPE</small><h3>Recent activity</h3></div><b className="live-count"><i /> LIVE</b></div>
          <div className="activity-list">{trades.slice(0, 12).map((trade) => {
            const token = tokenByAddress.get(trade.tokenAddress.toLowerCase());
            if (!token) return null;
            return <button type="button" key={trade.id} onClick={() => onSelect(token)}><span className={trade.side}>{trade.side === "buy" ? "BUY" : "SELL"}</span><strong>${trade.symbol}</strong><b>{money.format(trade.usdValue)}</b><small>{timeAgo(trade.blockTime)}</small></button>;
          })}{!trades.length && <div className="activity-empty">Waiting for the next trade...</div>}</div>
        </aside>
      </div>
      <div className="market-row"><div className="market-panel"><div className="market-section-title"><div><small>BUY ACTIVITY</small><h3>Hot right now</h3></div><b>RECENT BUYS</b></div>
        <div className="market-tiles">{hot.length ? hot.map(({ token, trade }) => <ExploreMiniToken key={token.tokenAddress} token={token} badge={`${money.format(trade.usdValue)} BUY`} detail={timeAgo(trade.blockTime)} onSelect={onSelect} />) : <div className="empty">Recent buys will appear here live.</div>}</div>
      </div>
      <div className="market-panel"><div className="market-section-title"><div><small>JUST SERVED</small><h3>New launches</h3></div><b>LATEST</b></div>
        <div className="market-tiles">{newest.length ? newest.map((token) => <ExploreMiniToken key={token.tokenAddress} token={token} badge="NEW TOKEN" detail={timeAgo(token.launchedAt)} onSelect={onSelect} />) : <div className="empty">Fresh launches will appear here.</div>}</div>
      </div></div>
      <div className="explore-results"><div className="market-section-title"><div><small>FULL MENU</small><h3>All tokens</h3></div><b>{tokens.length} TOTAL</b></div>
        <div className="discovery-token-list">{results.length ? results.map((token) => <DiscoveryToken key={token.tokenAddress} token={token} onSelect={onSelect} />) : <div className="empty">No bowls on the counter yet. Launch the first token.</div>}</div>
      </div>
    </>}
  </section>;
}

function ProfilePage({ account, connect, tokens, claim, claimAll, updateImage, busy, claimables }: {
  account?: `0x${string}`;
  connect: () => Promise<void>;
  tokens: TokenSummary[];
  claim: (token: TokenSummary) => void;
  claimAll: (tokens: TokenSummary[]) => void;
  updateImage: (token: TokenSummary, file: File) => void;
  busy: boolean;
  claimables: Record<string, CreatorClaimable>;
}) {
  const owned = account ? tokens.filter((token) => token.launcher.toLowerCase() === account.toLowerCase()) : [];
  return <section className="profile-page">
    <div className="profile-hero"><div><span className="eyebrow">CREATOR DASHBOARD</span><h1>Your launches</h1><p>Manage artwork and collect the 69% creator share from every token you deployed.</p></div>
      {!account ? <button onClick={connect}>CONNECT WALLET</button> : <div className="profile-total"><small>TOKENS DEPLOYED</small><b>{owned.length}</b><span>{shortAddress(account)}</span></div>}
    </div>
    {account && <div className="claim-all-bar"><div><small>ALL CREATOR FEES</small><strong>{money.format(owned.reduce((sum, token) => sum + (token.launcherFeeUsd || 0), 0))} lifetime earned</strong></div><button disabled={busy || !owned.length} onClick={() => claimAll(owned)}>{busy ? "CLAIMING…" : `CLAIM ALL (${owned.length})`}</button></div>}
    <div className="profile-list">{account && owned.length ? owned.map((token) => {
      const current = claimables[token.tokenAddress.toLowerCase()];
      const readyToken = current?.status === "ready" ? current.token : token.launcherTokenPending;
      const readyRamen = current?.status === "ready" ? current.ramen : token.launcherRamenPending;
      return <article className="profile-token" key={token.tokenAddress}>
      <div className="profile-token-art">{token.imageUrl ? <img src={token.imageUrl} alt="" /> : "🍜"}<label>CHANGE IMAGE<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) updateImage(token, file); }} /></label></div>
      <div><small>${token.symbol}</small><h3>{token.name}</h3><span>LP #{token.positionTokenId} · locked forever</span></div>
      <div className="profile-fees"><small>{current?.status === "error" ? "LAST INDEXED" : "READY TO CLAIM"}</small><b>{current?.status === "loading" || !current ? "Checking…" : `${tokenAmount(readyToken)} ${token.symbol}`}</b><b>{current?.status === "loading" || !current ? "" : `${tokenAmount(readyRamen)} RAMEN`}</b></div>
      <button disabled={busy} onClick={() => claim(token)}>CLAIM</button>
    </article>}) : account ? <div className="empty">No tokens deployed from this wallet yet.</div> : null}</div>
  </section>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("launch");
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string>();
  const [account, setAccount] = useState<`0x${string}`>();
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const [trades, setTrades] = useState<Trade[]>([]);
  const [kpis, setKpis] = useState<ProtocolKpis>();
  const [locker, setLocker] = useState<`0x${string}`>();
  const [notice, setNotice] = useState("");
  const [ethBalance, setEthBalance] = useState("0");
  const [ramenBalance, setRamenBalance] = useState("0");
  const [tokenBalances, setTokenBalances] = useState<Record<string, string>>({});
  const [balanceRefresh, setBalanceRefresh] = useState(0);
  const [balancesReady, setBalancesReady] = useState(false);
  const [payAsset, setPayAsset] = useState<PayAsset>("ETH");
  const [paymentPinned, setPaymentPinned] = useState(false);
  const [ramenUsd, setRamenUsd] = useState(0);
  const [ethUsd, setEthUsd] = useState(0);
  const [claimingAll, setClaimingAll] = useState(false);
  const [claimables, setClaimables] = useState<Record<string, CreatorClaimable>>({});
  const [claimableRefresh, setClaimableRefresh] = useState(0);
  const [dark, setDark] = useState(() => localStorage.getItem("ramenpad-theme") === "dark");
  const ownedClaimKey = useMemo(() => account ? tokens
    .filter((token) => token.launcher.toLowerCase() === account.toLowerCase())
    .map((token) => `${token.tokenAddress.toLowerCase()}:${token.positionTokenId}`)
    .join("|") : "", [account, tokens]);
  const tokenBalanceKey = useMemo(() => tokens.map((token) => token.tokenAddress.toLowerCase()).sort().join("|"), [tokens]);
  const selectedToken = useMemo(() => selectedTokenAddress
    ? tokens.find((token) => token.tokenAddress.toLowerCase() === selectedTokenAddress.toLowerCase())
    : undefined, [selectedTokenAddress, tokens]);

  const openToken = useCallback((token: TokenSummary) => {
    setSelectedTokenAddress(token.tokenAddress);
    setTab("explore");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const refreshBalances = useCallback(async (walletAddress?: `0x${string}`) => {
    if (!walletAddress) { setEthBalance("0"); setRamenBalance("0"); setBalancesReady(false); return; }
    const [eth, ramen] = await Promise.all([
      publicClient.getBalance({ address: walletAddress }),
      publicClient.readContract({ address: RAMEN, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] }),
    ]);
    setEthBalance(formatUnits(eth, 18));
    setRamenBalance(formatUnits(ramen, 18));
    setBalancesReady(true);
  }, []);

  const connect = useCallback(async () => {
    try {
      const wallet = await connectWallet();
      setAccount((current) => {
        if (current?.toLowerCase() !== wallet.account.toLowerCase()) setPaymentPinned(false);
        return wallet.account;
      });
      const [, config] = await Promise.all([refreshBalances(wallet.account), getConfig()]);
      if (config.ramenUsd) setRamenUsd(config.ramenUsd);
      if (config.ethUsd) setEthUsd(config.ethUsd);
      setNotice("");
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "Wallet connection failed"); }
  }, [refreshBalances]);

  const choosePayAsset = useCallback((asset: PayAsset) => {
    setPayAsset(asset);
    setPaymentPinned(true);
  }, []);

  const refreshTradingBalances = useCallback(() => {
    if (account) void refreshBalances(account);
    setBalanceRefresh((current) => current + 1);
  }, [account, refreshBalances]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("ramenpad-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    if (!window.ethereum) return;
    void window.ethereum.request({ method: "eth_accounts" }).then((accounts) => {
      const existing = (accounts as `0x${string}`[])[0];
      if (!existing) return;
      setAccount(existing);
      setPaymentPinned(false);
      void refreshBalances(existing);
    }).catch(() => {});
  }, [refreshBalances]);

  useEffect(() => {
    if (!account) return;
    void refreshBalances(account);
    const timer = window.setInterval(() => void refreshBalances(account), 15_000);
    return () => window.clearInterval(timer);
  }, [account, refreshBalances]);

  useEffect(() => {
    if (!account || !tokenBalanceKey) { setTokenBalances({}); return; }
    let cancelled = false;
    const listedTokens = [...tokensRef.current];
    const refresh = async () => {
      try {
        const results = await publicClient.multicall({
          allowFailure: true,
          contracts: listedTokens.map((token) => ({
            address: token.tokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [account] as const,
          })),
        });
        if (cancelled) return;
        const next: Record<string, string> = {};
        results.forEach((result, index) => {
          if (result.status === "success") next[listedTokens[index].tokenAddress.toLowerCase()] = formatUnits(result.result, 18);
        });
        setTokenBalances(next);
      } catch { /* keep the last successful balances */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [account, tokenBalanceKey, balanceRefresh]);

  useEffect(() => {
    if (!account || !balancesReady || paymentPinned || !ramenUsd || !ethUsd) return;
    const ethValueUsd = Number(ethBalance || 0) * ethUsd;
    const ramenValueUsd = Number(ramenBalance || 0) * ramenUsd;
    setPayAsset(ethValueUsd >= ramenValueUsd ? "ETH" : "RAMEN");
    setPaymentPinned(true);
  }, [account, balancesReady, ethBalance, ethUsd, paymentPinned, ramenBalance, ramenUsd]);

  useEffect(() => {
    if (!account || !locker || !ownedClaimKey) { setClaimables({}); return; }
    const owned = tokensRef.current.filter((token) => token.launcher.toLowerCase() === account.toLowerCase());
    let cancelled = false;
    const refresh = async () => {
      setClaimables((current) => {
        const next: Record<string, CreatorClaimable> = {};
        for (const token of owned) {
          const key = token.tokenAddress.toLowerCase();
          next[key] = current[key] || { token: "0", ramen: "0", status: "loading" };
        }
        return next;
      });
      const results = await Promise.allSettled(owned.map(async (token) => {
        const simulation = await publicClient.simulateContract({
          account,
          address: locker,
          abi: lockerAbi,
          functionName: "claimFees",
          args: [BigInt(token.positionTokenId)],
        });
        const [amount0, amount1] = simulation.result;
        const tokenIs0 = BigInt(token.tokenAddress) < BigInt(RAMEN);
        return {
          key: token.tokenAddress.toLowerCase(),
          token: formatUnits(tokenIs0 ? amount0 : amount1, 18),
          ramen: formatUnits(tokenIs0 ? amount1 : amount0, 18),
        };
      }));
      if (cancelled) return;
      setClaimables((current) => {
        const next: Record<string, CreatorClaimable> = {};
        results.forEach((result, index) => {
          const key = owned[index].tokenAddress.toLowerCase();
          next[key] = result.status === "fulfilled"
            ? { ...result.value, status: "ready" }
            : { token: current[key]?.token || "0", ramen: current[key]?.ramen || "0", status: "error" };
        });
        return next;
      });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [account, locker, ownedClaimKey, claimableRefresh]);

  useEffect(() => {
    const refreshFees = () => Promise.all([getTokens(), getKpis()]).then(([tokenData, kpiData]) => {
      setTokens(tokenData.tokens); setKpis(kpiData.kpis);
    });
    Promise.all([getTokens(), getTrades(), getKpis(), getConfig()]).then(([tokenData, tradeData, kpiData, config]) => {
      setTokens(tokenData.tokens); setTrades(tradeData.trades); setKpis(kpiData.kpis);
      if (config.locker) setLocker(config.locker);
      if (config.ramenUsd) setRamenUsd(config.ramenUsd);
      if (config.ethUsd) setEthUsd(config.ethUsd);
    }).catch(() => {});
    return subscribeLive(
      (trade) => {
        setTrades((current) => [trade, ...current.filter((item) => item.id !== trade.id)].slice(0, 100));
        setTokens((current) => current.map((token) => token.tokenAddress.toLowerCase() === trade.tokenAddress.toLowerCase()
          ? { ...token, priceUsd: trade.priceUsd, marketCapUsd: trade.marketCapUsd, volumeUsd: (token.volumeUsd || 0) + trade.usdValue }
          : token));
      },
      (token) => setTokens((current) => [token, ...current.filter((item) => item.tokenAddress !== token.tokenAddress)]),
      () => { void refreshFees(); },
    );
  }, []);

  const buys = useMemo(() => trades.filter((trade) => trade.side === "buy"), [trades]);

  async function claim(token: TokenSummary) {
    if (!LAUNCHER) return;
    try {
      const wallet = await connectWallet();
      const locker = await publicClient.readContract({ address: LAUNCHER, abi: launcherAbi, functionName: "locker" });
      setNotice(`Claiming fees from LP #${token.positionTokenId}…`);
      const hash = await wallet.client.writeContract({
        address: locker,
        abi: lockerAbi,
        functionName: "claimFees",
        args: [BigInt(token.positionTokenId)],
      });
      setNotice("Claim sent — waiting for confirmation…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Fee claim failed");
      setNotice("Creator fees claimed successfully.");
      const refreshed = await getTokens();
      setTokens(refreshed.tokens);
      setClaimableRefresh((current) => current + 1);
      await refreshBalances(wallet.account);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Fee claim failed"); }
  }

  async function claimAll(owned: TokenSummary[]) {
    if (!locker || !owned.length || claimingAll) return;
    setClaimingAll(true);
    try {
      const wallet = await connectWallet();
      const calls = owned.map((token) => ({
        to: locker,
        data: encodeFunctionData({ abi: lockerAbi, functionName: "claimFees", args: [BigInt(token.positionTokenId)] }),
      }));
      try {
        setNotice(`Confirm batch claim for ${owned.length} tokens…`);
        const { id } = await wallet.client.sendCalls({ calls });
        const result = await wallet.client.waitForCallsStatus({ id });
        if (result.status === "failure") throw new Error("Batch claim reverted");
      } catch (batchError) {
        if ((batchError as { code?: number }).code === 4001) throw batchError;
        for (let index = 0; index < owned.length; index += 1) {
          setNotice(`Wallet batching unavailable. Claiming ${index + 1} of ${owned.length}…`);
          const hash = await wallet.client.writeContract({
            address: locker, abi: lockerAbi, functionName: "claimFees",
            args: [BigInt(owned[index].positionTokenId)],
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`Claim ${index + 1} failed`, { cause: batchError });
        }
      }
      setNotice(`All creator fee claims confirmed for ${owned.length} tokens.`);
      const refreshed = await getTokens(); setTokens(refreshed.tokens);
      setClaimableRefresh((current) => current + 1);
      await refreshBalances(wallet.account);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Claim all failed"); }
    finally { setClaimingAll(false); }
  }

  async function changeTokenImage(token: TokenSummary, file: File) {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("Artwork must be 2 MB or smaller");
      const wallet = await connectWallet();
      if (wallet.account.toLowerCase() !== token.launcher.toLowerCase()) throw new Error("Only the token launcher can update this image");
      setNotice(`Uploading new artwork for $${token.symbol}…`);
      const { imageUrl } = await uploadImage(file);
      const timestamp = Date.now();
      const signature = await wallet.client.signMessage({
        message: tokenImageUpdateMessage(token.tokenAddress, imageUrl, timestamp),
      });
      await updateTokenImage(token.tokenAddress, { imageUrl, timestamp, signature });
      setTokens((current) => current.map((item) => item.tokenAddress === token.tokenAddress ? { ...item, imageUrl } : item));
      setNotice(`$${token.symbol} artwork updated.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Image update failed"); }
  }

  return (
    <div className="shell">
      <header>
        <button className="brand" onClick={() => setTab("launch")}><span>ラ</span> RAMENPAD<small>ROBINHOOD</small></button>
        <nav>
          <button className={tab === "launch" ? "active" : ""} onClick={() => setTab("launch")}>LAUNCH</button>
          <button className={tab === "explore" ? "active" : ""} onClick={() => { setSelectedTokenAddress(undefined); setTab("explore"); }}>EXPLORE</button>
          <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>PROFILE</button>
          <a href={`https://dexscreener.com/robinhood/${RAMEN_PAIR}`} target="_blank" rel="noreferrer">$RAMEN ↗</a>
        </nav>
        <button className="wallet" onClick={connect}>{account ? shortAddress(account) : "CONNECT"}<i /></button>
      </header>
      <LiveTape trades={buys} />
      <main>
        {tab === "launch" ? <><LaunchForm account={account} connect={connect} onLaunched={(token) => { setTokens((list) => [token, ...list]); openToken(token); }} payAsset={payAsset} onPayAssetChange={choosePayAsset} ethBalance={ethBalance} ramenBalance={ramenBalance} /><HomeDiscovery tokens={tokens} trades={trades} onSelect={openToken} /></> : tab === "explore" ? (
          selectedToken ? <section className="explore token-detail-page">
            <button type="button" className="back-to-explore" onClick={() => setSelectedTokenAddress(undefined)}>← BACK TO LIVE EXPLORE</button>
            <div className="token-detail-heading"><div><span className="eyebrow">TOKEN MARKET</span><h2>{selectedToken.name}</h2><p>Live market data, quotes and permanently locked liquidity.</p></div><b>${selectedToken.symbol}</b></div>
            <TokenCard token={selectedToken} account={account} claim={claim} onNotice={setNotice} locker={locker} claimable={claimables[selectedToken.tokenAddress.toLowerCase()]} payAsset={payAsset} onPayAssetChange={choosePayAsset} ethBalance={ethBalance} ramenBalance={ramenBalance} tokenBalance={tokenBalances[selectedToken.tokenAddress.toLowerCase()] || "0"} onBalancesChanged={refreshTradingBalances} />
          </section> : <ExploreDashboard tokens={tokens} trades={trades} kpis={kpis} onSelect={openToken} />
        ) : <ProfilePage account={account} connect={connect} tokens={tokens} claim={claim} claimAll={claimAll} updateImage={changeTokenImage} busy={claimingAll} claimables={claimables} />}
      </main>
      {notice && <button className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      <footer><div className="wallet-balances">
        <button className={payAsset === "RAMEN" ? "active" : ""} onClick={() => choosePayAsset("RAMEN")} title="Use RAMEN as the default buy asset"><img src={RAMEN_IMAGE} alt="RAMEN" /><small>YOUR RAMEN</small><b>{account ? Number(ramenBalance).toLocaleString(undefined, { maximumFractionDigits: 3 }) : "—"}</b></button>
        <button className={payAsset === "ETH" ? "active" : ""} onClick={() => choosePayAsset("ETH")} title="Use ETH as the default buy asset"><i>Ξ</i><small>YOUR ETH</small><b>{account ? Number(ethBalance).toLocaleString(undefined, { maximumFractionDigits: 5 }) : "—"}</b></button>
      </div><div className="footer-actions"><span>BUYING WITH <b>{payAsset}</b>{ramenUsd ? ` · RAMEN $${ramenUsd.toFixed(8)}` : ""}</span><button className="theme-toggle" onClick={() => setDark((current) => !current)}>{dark ? "☀ LIGHT" : "◐ DARK"}</button></div></footer>
    </div>
  );
}
