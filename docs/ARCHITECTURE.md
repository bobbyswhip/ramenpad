# Architecture

## Components

RamenPad has four layers:

1. **Launcher contracts** create fixed-supply tokens, initialize Uniswap v3 markets, lock LP NFTs, seed internal inventory, and optionally perform an atomic first buy.
2. **Trading contracts** route RAMEN or ETH buys and token sells. A configurable fraction can be filled against deposited inventory while the rest executes against Uniswap v3.
3. **Backend services** calculate short-lived live-price quotes, sign them, index launches/trades/fees into PostgreSQL, serve REST and Socket.IO data, and run a bounded keeper.
4. **Frontend** provides launch, discovery, buy/sell, fee claim, creator profile, token image, balance, and protocol KPI views.

## End-to-end launch

1. The frontend asks the backend for a quote using the creator, name, and symbol.
2. The backend predicts the CREATE2 token address, reads live RAMEN/USD, derives the v3 square-root price for the target launch market cap, and signs a two-minute quote.
3. `RamenLauncher` validates metadata, expiry, predicted address, signer, tick range, and initialized pool price.
4. A `RamenToken` mints exactly 6,942,000 tokens to the launcher.
5. Ninety percent is supplied as one-sided Uniswap v3 liquidity. The resulting NFT is minted directly to `RamenLiquidityLocker`.
6. Ten percent seeds the token-side deck in `RamenOTC` for `ramenDev` and protocol owner positions at a 69/31 split.
7. The launcher records and emits the market. An optional RAMEN or ETH first buy executes before the transaction ends.
8. The indexer consumes the events and makes the market visible in the live frontend.

## Deployed dependencies

The Robinhood Chain addresses and deployment transactions are recorded in [`deployment/addresses.json`](../deployment/addresses.json). RamenPad integrates with the chain's Uniswap v2 router for ETH-to-RAMEN conversion and Uniswap v3 position manager/router for launched-token markets.

## Important boundary

USD pricing is off-chain because the launched-token pool contains RAMEN, not dollars. The backend signer authorizes the initial v3 price; contracts enforce that exact signed price. After launch, pool execution determines the live token/RAMEN price.
