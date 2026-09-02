# Launch and pricing

## Fixed launch terms

- Total supply: **6,942,000** tokens.
- New target market cap: **$2,000**.
- Initial token price: `2000 / 6,942,000`, approximately **$0.0002881014**.
- Initial allocation: **90% permanent Uniswap v3 liquidity / 10% token-deck inventory**.
- Pool pair: launched token / RAMEN.
- Pool fee tier: **1%**.

The $2,000 target became active for future launches at Robinhood block `52219736`. Earlier tokens retain their historical launch basis in the indexer.

## Live RAMEN conversion

The system never hardcodes a RAMEN-denominated launch price. The backend reads RAMEN/USD from the configured RAMEN/WETH market, calculates how much RAMEN equals one target-priced token, converts the ratio to Uniswap v3 `sqrtPriceX96`, and chooses a one-sided tick range. The response includes a deadline two minutes in the future.

Because the external market can move between quote and mining, the quote is intentionally short-lived. A new request gets a new RAMEN conversion while preserving the same target USD market cap.

## Quote authorization

The signature binds chain ID, launcher, creator, predicted token, CREATE2 salt, RAMEN, the launcher's legacy domain constant, square-root price, tick range, and deadline. This prevents replay on a different chain, launcher, creator, or token. Each creator nonce changes after a successful launch.

## Atomic first buys

A creator can launch without buying, or atomically buy in the same transaction:

- Native ETH follows `ETH -> RAMEN` through the v2 router, then `RAMEN -> token` through the in-app router.
- RAMEN is transferred from the creator and routed directly to the token market.

The market and both inventory decks are registered before the buy executes, letting the creator be the first purchaser without a separate transaction race. Minimum-output parameters protect the creator from unacceptable execution.

## Subsequent swaps

Buyers can pay in ETH or RAMEN. Sellers provide the launched token. Frontend quotes show the expected route and output; required ERC-20 approvals are sent only when current allowance is insufficient, and the application waits for approval confirmation before submitting the swap.
