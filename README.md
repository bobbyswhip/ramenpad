# RamenPad

RamenPad is a fixed-terms token launcher for Robinhood Chain (chain ID 4663). Every launch:

- Creates a plain, non-mintable ERC-20 with exactly **6,942,000 tokens**.
- Opens at approximately **$0.0002881/token**, or **$2,000 market cap**, using the live RAMEN/USD price for every new quote.
- Pairs against **RAMEN** (`0xe013e34F03F42d49E836d59CF6353B897c337777`) on Uniswap v3.
- Puts **90%** into a one-sided 1% fee-tier position with no LP withdrawal path.
- Seeds **10%** into the token's OTC deck, split **69% ramen_dev / 31% owner**.
- Routes in-app swaps through Uniswap v3 for realized price discovery and fills 20% OTC when inventory permits. The owner can set this from 1%-30%; inventory shortfalls return to v3.
- Accrues **69%** of LP fees for the token launcher to claim. The other 31% is split equally between `ramen_dev()` and `owner()` and deposited directly into their OTC positions.
- Supports an optional RAMEN or native-ETH first buy in the same transaction as the launch.

## Project layout

- `contracts/` — launcher, fixed-supply token, permanent LP locker, deploy scripts, unit tests, and live-fork tests.
- `frontend/` — Vite/React launch and explore UI, wallet network switching, fee claims, and live buy tape.
- `backend/ramenpad/` — signed $2,000 quotes, image uploads, PostgreSQL indexer, REST API, and Socket.IO feed.
- `docs/` — architecture, contract, pricing, fee-flow, operations, and security documentation.
- `scripts/deploy.ps1` — decrypts the local deployer keystore only for the Foundry process.

Start with the [documentation index](docs/README.md). The project is available under the [MIT License](LICENSE).

## Local development

```powershell
npm install
npm run lint
npm run dev:backend
npm run dev
```

The backend needs PostgreSQL and the values in `.env.example`. The frontend defaults to the public Robinhood deployment and live API; `VITE_RAMENPAD_LAUNCHER_ADDRESS`, `VITE_RAMENPAD_ETH_ROUTER_ADDRESS`, and `VITE_API_URL` can override them at build time.

## Verification

```powershell
forge test -vvv
$env:RUN_FORK_TESTS='true'
forge test --match-contract RamenPadRobinhoodForkTest -vvv
npm test
npm run build
```

The fork test deploys the complete bundle against Robinhood mainnet state, performs an atomic launch and first buy through the real v3 router, harvests real fees, verifies protocol compounding, and claims launcher fees without broadcasting a transaction.

## Deployment order

1. Fund the saved RamenPad owner/deployer address with Robinhood Chain ETH. Fund the gas-only keeper separately or from the deployer after deployment.
2. Run `./scripts/deploy.ps1`. Pass `-RamenDev 0x...` to use a dev address other than the owner at genesis.
3. Record the launcher address and deployment block in the backend and frontend env files.
4. Deploy the `backend/ramenpad` service and its nginx routes.
5. Confirm `/health/ramenpad`, request a quote, and perform a small test launch before opening the UI.

The production quote signer and permissionless gas-only keeper are separate hot keys with no ownership authority. The owner/deployer and keeper keystores and passwords are under the git-ignored `secrets/` directory with a user-only Windows ACL.

## OTC and fee flow

- A TOKEN deck holds launched tokens and earns RAMEN from routed buys.
- A RAMEN deck holds RAMEN and earns TOKEN from routed sells.
- Protocol earnings are automatically cross-deposited into the opposite deck after OTC fills, so dev/owner positions compound without manual per-token claims.
- LP harvesting is decoupled from routed swaps. A bounded round-robin keeper checks at most 25 positions every 10 minutes and broadcasts only when the combined collectible token units exceed 1,000. Launchers can still force a harvest by claiming at any time.
- Launcher fee balances stay in the permanent locker until the launcher calls `claimFees`.
- Per-token and protocol-wide fee KPIs separately track gross earned fees, launcher claims, pending launcher balances, and protocol amounts actually deposited into OTC decks.

RAMEN currently taxes transfers involving its designated v2 main pool. The atomic ETH path measures the RAMEN actually received after that tax. The live fork test also confirms the newly created v3 pool can route swaps successfully.

## Trust and pricing notes

USD does not exist natively in the RAMEN/token pool. The backend derives RAMEN/USD from the referenced RAMEN/WETH market and signs a short-lived initial-price quote. The contract verifies that quote against a rotatable signer. A signer compromise can authorize a bad initial price, but cannot unlock LP or take protocol ownership. Before mainnet use, add monitoring and obtain an independent smart-contract review.

Robinhood network and Uniswap deployment references:

- https://docs.robinhood.com/chain/connecting/
- https://github.com/Uniswap/contracts/blob/main/deployments/4663.md

## Robinhood deployment

- Launcher: `0xC89f3837895b3e02c54F254eD73D580016Bbd3E7`
- Permanent liquidity locker: `0x6232e26bEa0283d15dFde673ADA0cc993bC7B90F`
- OTC router/decks: `0x76B480be19abe121907Aaa5028F52462C8F2F8b5`
- Atomic ETH buy router: `0x04231d4EBa71Fd75C3e124E9b332BBB445FA076e`
- Deployment block: `52,185,716`

The exact addresses, deployment transactions, roles, and external dependencies are recorded in `deployment/addresses.json`. The deployed contracts have Sourcify exact-match verification.
