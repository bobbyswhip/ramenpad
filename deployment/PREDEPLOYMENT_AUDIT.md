# RamenPad pre-deployment audit

Date: 2026-09-01
Scope: Solidity launch/OTC/locker contracts, Robinhood Uniswap integration, backend keeper/indexer/API, fee KPI storage, and launcher-facing frontend flows.

## Result

The reviewed build had no known open critical or high-severity finding at its deployment gate. This is an internal engineering review rather than an independent third-party audit. After the review and fork test passed, the immutable bundle was deployed to Robinhood mainnet at block 52,185,716.

## Economic invariants verified

- Every token has an immutable 6,942,000-token supply with no post-deployment mint or owner hook.
- 90% is offered to the one-sided Uniswap v3 LP position and any unusable rounding remainder is burned; 10% seeds the TOKEN OTC deck.
- Initial OTC ownership is 69% `ramenDev()` and 31% `owner()`.
- Routed swaps use the same-transaction v3 execution rate for their OTC portion. The owner-controlled routing share is constrained to 1%-30% and starts at 20%.
- OTC inventory shortfalls fall back to v3 and retain a one-token reserve.
- TOKEN-deck RAMEN earnings and RAMEN-deck TOKEN earnings auto-churn for the current protocol beneficiaries.
- LP fees split 69% to the original token launcher and 15.5% each to the current `ramenDev()` and `owner()`.
- Launcher balances accrue in the locker and only the recorded launcher can claim them.
- Protocol LP fee deposits go directly to the appropriate TOKEN/RAMEN OTC deck. A failed OTC deposit is deferred and cannot block a launcher claim; it can be retried permissionlessly.
- The v3 position NFT is minted directly to the locker. The locker has no NFT transfer-out or liquidity-decrease path, so principal is locked permanently.
- RAMEN and native-ETH atomic first-buy paths execute after market registration in the launch transaction.

## Findings fixed during review

### Pool pre-initialization/front-running

Because the CREATE2 token address can be predicted, an attacker could have initialized the future v3 pool at a malicious price before launch. The launcher now reads `slot0()` immediately after pool creation/retrieval and requires the pool price to exactly match the backend-signed launch quote. A regression test proves a pre-initialized wrong-price pool is rejected.

### Launcher claims coupled to OTC availability

An OTC revert could previously revert fee harvesting and block the launcher's claim. Protocol amounts are now queued, attempted with `try/catch`, and retained as explicit pending dev/owner balances on failure. Launcher funds remain independently claimable.

### Excess keeper and swap-triggered RPC/transaction activity

Per-swap LP harvesting was removed. The keeper now runs every 600,000 ms, examines at most 25 positions per pass using a keyset round-robin cursor, and broadcasts only when combined collectible 18-decimal units are strictly greater than 1,000. This is configurable, while one minute remains the hard lower interval bound.

### Fee KPI accuracy

Gross protocol fee earnings are no longer presented as successful OTC deposits. The indexer separately records `FeesHarvested`, `LauncherFeesClaimed`, and `ProtocolFeesDeposited`, providing per-token and protocol-wide earned, claimed, pending, deposited, USD, and harvest-count KPIs.

### Empty harvest accounting and external-call hardening

Zero-fee collections no longer emit harvest events or call the OTC. OTC seed and protocol-deposit entry points now use the contract's reentrancy guard.

## Verification performed

- 11 local Solidity unit/regression tests passed.
- 1 full opt-in Robinhood mainnet fork test passed against the real v2 router, v3 position manager, and v3 swap router. It deployed the complete bundle, performed a native-ETH atomic first buy, exercised v3 plus OTC routing, harvested real LP fees, verified protocol churn, and paid the launcher claim.
- The deployed `RamenEthRouter` helper was exercised on the same fork through the complete ETH -> RAMEN -> launched-token route using the live Robinhood v2 and v3 deployments.
- Frontend tests: 1 passed.
- Backend tests: 4 passed.
- TypeScript production builds passed for frontend and backend.
- `forge fmt --check` passed.
- Production contract runtime sizes are below EIP-170: launcher 17,686 bytes, locker 6,066 bytes, OTC 10,540 bytes, token 1,881 bytes. Foundry's deploy-script helper itself exceeds EIP-170 but is never deployed as a contract.
- `npm audit --omit=dev` reported zero production dependency vulnerabilities.
- Slither was run and its machine-readable output is in `deployment/slither-report.json`. Reported reentrancy patterns are protected by the explicit guards and fixed trusted token set; low-level ERC-20 calls intentionally support tokens that return no boolean. The arithmetic-order warning is bounded by the fixed token supply and normal RAMEN input domain.
- The isolated live backend restarted cleanly, applied the KPI schema, and returned healthy zero-state `/health/ramenpad`, `/api/ramenpad/kpis`, and `/api/ramenpad/config` responses.
- The deployed launcher, permanent locker, OTC contracts, and ETH buy router received Sourcify `exact_match` source verification.
- Every launch quote fetches the current RAMEN/USD price, derives the pool price needed for a $2,000 market cap across 6,942,000 tokens, and expires after two minutes. RAMEN itself is never assigned a hardcoded USD price.
- The $2,000 target activates at block `52219736`. Earlier launches retain the legacy $6,942 indexing basis, so historical records remain stable after reindexing.

## Residual risks and operating assumptions

- The quote signer and RAMEN/USD source are trusted for initial pricing. A compromised signer can authorize a bad starting price, though it cannot withdraw LP or become owner.
- Same-transaction pool execution pricing is intentionally spot-based and can be influenced by MEV. User `minOut` protects the submitted trade; no TWAP circuit breaker is present.
- The keeper's 1,000 threshold adds nominal TOKEN and RAMEN units because both use 18 decimals; it is an activity threshold, not a USD threshold. Low-value fees may wait, while launchers can force collection through `claimFees` at any time.
- With batch size 25, a position is checked approximately every `ceil(tokenCount / 25) * 10 minutes` as the launchpad grows.
- Direct v3 trades do not route through OTC. They still accrue LP fees that the keeper or launcher can harvest.
- Role changes affect future protocol fee deposits and auto-churn. OTC shares already credited to a previous owner/dev remain owned by that address.
- Fee USD KPIs are reporting estimates using the indexed token price and cached RAMEN/USD price at processing time, not an on-chain historical USD oracle.
- Contracts are immutable. This makes the permanent lock credible but means defects require a new launch stack; locked positions cannot be migrated.
- The live RAMEN contract is external. If its transfer-tax/pool configuration changes after deployment, routing assumptions must be retested.

## Final deployment gate

The owner and keeper were funded, the saved encrypted owner key deployed the audited bytecode, addresses/block were recorded, and the indexer/keeper were enabled. Before opening the frontend publicly, perform one small production smoke launch and confirm the exact pool price, 90/10 allocation, locker NFT custody, OTC positions, fee events/KPIs, launcher claim, and explorer locker link.
