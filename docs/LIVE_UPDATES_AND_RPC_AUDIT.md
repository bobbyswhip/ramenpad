# Live updates and RPC audit

Date: 2026-09-02

## Delivery model

RamenPad uses a durable two-stage live-data pipeline:

1. The backend polls confirmed Robinhood blocks every 15 seconds, indexes through head minus two blocks, and stores an idempotent cursor in PostgreSQL. Failures back off exponentially to 120 seconds.
2. The backend immediately pushes indexed launches, trades, terminal pool prices, RAMEN-market repricing, and fee events to browsers over Socket.IO WebSocket (with HTTP long-poll fallback).

The block poller is intentional. It can recover every missed log after a restart or provider interruption; a bare RPC WebSocket subscription cannot provide that guarantee by itself. Browser reconnects now trigger a complete API snapshot resync, closing any delivery gap while the tab was offline.

## Price correctness changes

- Every Uniswap v3 pool `Swap` persists the terminal `sqrtPriceX96`, including the underlying pool leg of an internally routed trade. Internally routed events remain the single volume/trade record, so volume is not double-counted.
- Each token stores its RAMEN-denominated pool price separately from USD price.
- The backend checks the external RAMEN/USD market every 30 seconds. A RAMEN price move reprices every launched token and emits `ramenpad:market`, even when no launchpad pool trades.
- RAMEN itself is a first-class Explore/home listing. Its market page quotes and executes fee-on-transfer-aware ETH to RAMEN and RAMEN to ETH swaps through the existing v2 pair.

## RPC policy

Frontend reads never contain paid credentials. They use ordered public endpoints:

1. `https://robinhood-rpc.publicnode.com`
2. `https://rpc.mainnet.chain.robinhood.com`

Backend reads use ordered failover without latency ranking, so a paid request cannot race and win against a healthy free provider:

1. `ROBINHOOD_FREE_RPC_URLS` (comma-separated)
2. `ROBINHOOD_RPC_URL` (legacy single free endpoint)
3. `ROBINHOOD_PAID_RPC_URLS` (comma-separated, optional and last)

Confirmed historical catch-up uses the capability-specific `ROBINHOOD_LOG_RPC_URLS` path because tokenless PublicNode rejects archive `eth_getLogs` requests. Each query combines the launcher, locker, and swapper addresses, while pool swaps are grouped in batches of up to 100 addresses. Failed log queries use bounded exponential retries and never advance the cursor.

Free-only catch-up processes one 1,000-block range per tick; this is safely faster than chain growth without producing a burst of per-address requests. Paid-backed indexing defaults to twenty 1,000-block ranges per tick. `RAMENPAD_INDEXER_BLOCK_RANGE` and `RAMENPAD_INDEXER_RANGES_PER_TICK` can override either mode.

The cursor is committed only after every watched contract in a range has been processed successfully. Launch, trade, and fee rows use conflict-safe event identities, so service restarts resume from the next uncommitted block without gaps or duplicates.

`GET /health/ramenpad` reports `launchReady=false` until startup catch-up reaches the confirmed head, and after any indexing failure. The launch form checks this non-cacheable endpoint immediately before asking the wallet to submit. That pauses UI-originated launches during backend deploys while the durable cursor remains the recovery guarantee for direct contract calls and transactions already in flight.

The health endpoint exposes aggregate success/failure counters by free or paid tier, never URLs or keys. A paid Robinhood Alchemy URL must be supplied explicitly; unrelated-chain Alchemy credentials must not be reused.

## Browser request budget

- Native ETH and RAMEN wallet balances: two public RPC reads every 15 seconds while connected.
- Launched-token balance: one read for only the currently expanded token every 15 seconds. The previous all-token multicall was removed.
- Creator claim simulation: only the expanded token owned by the connected launcher, or owned tokens while the Profile page is open, every 30 seconds. Hidden pages no longer simulate every position.
- Quotes: input-driven with a 450 ms debounce.
- Immutable launcher dependencies are configured once instead of reread before every swap/claim. The backend also memoizes its immutable launcher contract reads.

This keeps authenticated/premium RPC credentials off the browser and ensures normal indexing consumes the free tier first. Paid service is failover capacity, not the steady-state path.
