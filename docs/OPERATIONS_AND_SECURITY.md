# Operations and security

## Roles

- **Owner/deployer:** owns protocol configuration after deployment, can rotate quote signer and `ramenDev`, and can change the inventory-routing percentage. Ownership transfer is two-step.
- **`ramenDev`:** receives 69% of the initial token-deck allocation and half of the protocol's 31% LP fee share.
- **Quote signer:** signs short-lived launch prices. It has no ownership or withdrawal permission.
- **Keeper:** a gas-only wallet calling public harvest methods. It has no special contract permission.
- **Token launcher:** owns no token admin power, but exclusively controls the 69% creator-fee claim for that token's LP position.

## Keeper policy

The keeper uses a bounded round-robin scan so RPC use grows predictably. The production starting policy is a 10-minute interval, at most 25 positions per pass, and no automatic harvest unless combined collectible token units exceed 1,000. A creator claim can harvest its position immediately without waiting for the keeper.

## Indexer

The backend owns a separate PostgreSQL `ramenpad` schema. It indexes launch events, v3 swaps, routed swaps, LP harvests, creator claims, and protocol deposits with idempotent transaction/log keys. A two-block confirmation delay reduces shallow-reorg risk. Socket.IO publishes live launch, trade, token, and fee updates.

The public Robinhood RPC can rate-limit historical log scans. The indexer uses consolidated system-log requests, bounded pool batches, a 15-second baseline, and exponential backoff up to 120 seconds. A dedicated provider is recommended for larger scale.

## Building and testing

```sh
npm install
npm run lint
npm test
npm run build
forge build
forge test -vvv
```

The optional live fork suite needs `ROBINHOOD_RPC_URL` and `RUN_FORK_TESTS=true`. It deploys the full bundle against forked Robinhood state and tests launch, first buy, fee harvest, protocol churn, and creator claim without broadcasting.

## Deployment

Deployment scripts read addresses and the deployer private key from environment variables. Never commit `.env`, `secrets/`, Foundry broadcasts, Vercel state, database credentials, SSH keys, or keystores. The repository `.gitignore` excludes these categories.

The frontend is a static Vite build. Root `vercel.json` installs the workspace, builds only the frontend, and publishes `frontend/dist`. Public contract and API addresses may be passed as `VITE_*` build variables.

## Trust assumptions and risks

- LP principal is permanently locked by the absence of an exit method; fees remain collectible.
- The owner can rotate the quote signer, dev beneficiary, and routing percentage within the 1%–30% range, but cannot mint launched tokens or withdraw locked LP principal.
- A compromised quote signer can authorize a bad initial price until rotated. Short expiry limits quote lifetime but is not an oracle guarantee.
- Market value displayed in USD depends on the RAMEN reference market. A movement in RAMEN/USD changes token USD market cap even if token/RAMEN barely moves.
- Uniswap routers, position manager, RAMEN behavior, RPC services, the backend database, and frontend hosting are external dependencies.
- Internal fills use the observed pool-leg rate and zero minimum at the contract's internal v3 leg; callers must set end-to-end minimum output.
- The repository's tests and static-analysis report are not a substitute for an independent production audit.

## Public deployment

The deployed addresses and transactions live in [`deployment/addresses.json`](../deployment/addresses.json). Source verification status and the predeployment review are recorded under [`deployment`](../deployment).
