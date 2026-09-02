# RamenPad backend module

This is the isolated `ramenpad` API/indexer requested for the shared backend. It owns only the PostgreSQL `ramenpad` schema and the `/api/ramenpad`, `/ramenpad/uploads`, and `/ramenpad/socket.io` paths.

## What it indexes

- `TokenLaunched` events from the RamenPad launcher.
- `Swap` events from every registered Uniswap v3 pool.
- Aggregate `OtcSwap` events from the in-app router; underlying router pool legs are suppressed to avoid double-counting.
- Buy/sell direction, RAMEN and token amounts, live USD value, price, market cap, and volume.
- Gross LP fee earnings, launcher claims/pending balances, and successful protocol OTC deposits for per-token and protocol-wide KPIs.
- Durable progress in `ramenpad.indexer_state`, with two-block confirmation and idempotent log keys.

Socket events are `ramenpad:launch`, `ramenpad:trade`, `ramenpad:tokens:update`, `ramenpad:market`, and `ramenpad:fees`.

## Production configuration

Copy the root `.env.example` values into this service's untracked `.env`. Set:

- `RAMENPAD_LAUNCHER_ADDRESS` and the launcher's deployment block.
- `RAMENPAD_QUOTE_SIGNER_PRIVATE_KEY` from `secrets/.env.backend`.
- `RAMENPAD_KEEPER_PRIVATE_KEY` from `secrets/.env.backend`. This separate gas-only key has no admin role.
- `RAMENPAD_KEEPER_INTERVAL_MS=600000`, `RAMENPAD_KEEPER_BATCH_SIZE=25`, and `RAMENPAD_KEEPER_MIN_HARVEST=1000` for the bounded ten-minute keeper.
- `RAMENPAD_INDEXER_INTERVAL_MS=15000` and `RAMENPAD_INDEXER_MAX_BACKOFF_MS=120000` keep trade indexing responsive while backing off from public-RPC rate limits.
- A production `DATABASE_URL`. RPCs are tried in explicit order: comma-separated `ROBINHOOD_FREE_RPC_URLS`, the legacy single free `ROBINHOOD_RPC_URL`, then comma-separated `ROBINHOOD_PAID_RPC_URLS`. Keep paid Alchemy/QuickNode endpoints only in the final list.
- `PUBLIC_BASE_URL=https://api.yougotcoined.com` and the frontend CORS origin.

The signer and keeper are deliberately separate from the funded owner/deployer. The signer can authorize a two-minute live-price quote. The keeper checks a bounded round-robin batch and only calls the permissionless locker harvest when combined collectible 18-decimal units are strictly above the configured threshold. Neither can deploy, transfer ownership, withdraw protocol positions, or move LP principal.

`GET /health/ramenpad` reports free/paid provider counts plus successful and failed requests for each tier. It deliberately never exposes the configured URLs or API keys.

Build with `npm run build --workspace @ramenpad/backend`. The service and nginx snippets in `deploy/` are templates; adjust only the existing backend path if it differs on the server.
