# Contracts

## `RamenToken`

The token template used for every launch. It is a minimal ERC-20 with 18 decimals and a fixed supply of 6,942,000 tokens. The entire supply is minted once in the constructor. There is no owner, mint function, burn authority, transfer tax, blacklist, or upgrade path.

## `RamenLauncher`

The launch coordinator and protocol role registry.

- Predicts tokens with CREATE2 using creator nonce, name, and symbol.
- Accepts only short-lived quotes signed by `quoteSigner`.
- Creates or finds the token/RAMEN 1% Uniswap v3 pool and rejects a pre-initialized pool whose `sqrtPriceX96` differs from the signed quote.
- Sends 90% of supply into one-sided v3 liquidity and 10% into the token deck.
- Mints the LP NFT directly to the permanent locker.
- Supports `launch`, `launchAndBuy` with native ETH, and `launchAndBuyWithRamen`.
- Records every token, pool, creator, LP token ID, and launch time.
- Lets `owner` rotate the quote signer and `ramenDev`, and uses two-step ownership transfer.

The deployed contract's `TARGET_MARKET_CAP_USD` value is a legacy field included in the signature domain. It does not calculate or enforce USD value. The signed `sqrtPriceX96` is the enforceable launch price; the backend currently targets $2,000 using live RAMEN/USD.

## `RamenLiquidityLocker`

Custodies every launch's Uniswap v3 position NFT. There is deliberately no LP-NFT transfer or liquidity-withdrawal function, so principal is locked for the lifetime of the contract.

- Only the launcher can register a position.
- Anyone can call `harvest` or `harvestForToken`.
- Harvested fees split 69% to the token launcher and 31% to protocol recipients.
- The protocol share splits equally: 15.5% to `ramenDev`, 15.5% to `owner`.
- Creator amounts accrue in `claimable`; only the recorded launcher can call `claimFees`.
- Protocol amounts are pushed into the appropriate internal decks. A failed deposit is deferred instead of blocking creator claims and can later be retried with `flushProtocolFees`.
- `onERC721Received` accepts NFTs only from the configured position manager.

## `RamenOTC`

The in-app RAMEN/token router and two-sided inventory accounting system. “Deck” is the implementation concept: a token deck contains launched tokens and earns RAMEN; a RAMEN deck contains RAMEN and earns launched tokens.

Each swap first executes a real Uniswap v3 pool leg to discover execution price. By default, up to 20% of input is filled against available deck inventory at that observed rate. If inventory is unavailable, the unfilled amount falls back to v3, so the swap still behaves like a normal market swap.

- `buy` accepts RAMEN and returns launched tokens.
- `sell` accepts launched tokens and returns RAMEN.
- Depositors receive proportional shares and can withdraw principal plus settled yield.
- The owner can set the routed inventory fraction from 1% to 30% with `setOtcBps`.
- Only the launcher registers markets and seeds initial token inventory.
- Only the locker deposits protocol LP fees.
- `churnProtocol` moves protocol-earned RAMEN into the RAMEN deck and protocol-earned launched tokens into the token deck, compounding both beneficiaries automatically.

The contract calls the launcher's live `owner()` and `ramenDev()` roles rather than keeping separate mutable administrator state.

## `RamenEthRouter`

A stateless convenience router for `ETH -> RAMEN -> launched token` in one transaction. It measures the RAMEN balance actually received from the v2 swap, which supports RAMEN's transfer behavior, then calls `RamenOTC.buy`. It holds no admin role and uses a reentrancy guard.

## Interfaces

- `IERC20` contains the ERC-20 operations used for safe low-level transfers and approvals.
- `INonfungiblePositionManager` contains the Uniswap v3 mint, collect, NFT position, and receiver types needed by launcher and locker.
- `ISwapRouter02` defines the v3 exact-input-single swap used by `RamenOTC`.
- `IUniswapV2Router02` defines ETH/RAMEN quoting and swaps used by launcher and ETH router.
- `IRamenRoles` exposes the launcher's `owner()` and `ramenDev()` roles to locker and router.

## Deployment scripts

`DeployRamenPad.s.sol` deploys OTC, locker, and launcher, then performs their one-time circular initialization. `DeployRamenEthRouter.s.sol` deploys the optional ETH convenience router after the core router address is known. Neither script embeds a private key; Foundry reads it from the process environment during broadcast.
