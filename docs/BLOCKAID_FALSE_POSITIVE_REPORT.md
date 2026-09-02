# Blockaid false-positive and mistake report

- **Project:** RamenPad
- **Network:** Robinhood Chain, chain ID 4663
- **Report date:** 2026-09-02
- **Submission type:** Mistake / false-positive review and developer verification
- **Public source:** <https://github.com/bobbyswhip/ramenpad>
**Blockaid report portal:** <https://report.blockaid.io/>

## 1. Executive summary

Blockaid-enabled wallets are reportedly classifying one or more RamenPad contracts as malicious. We believe this is a false positive caused by a combination of novel-chain deployment, token creation, ERC-20 approvals and `transferFrom`, low-level safe-token compatibility calls, routed swaps, one-sided liquidity creation, fee sharing, and permanent LP custody.

The reviewed RamenPad contracts do **not** contain a wallet drainer, arbitrary-call executor, hidden mint, transfer blacklist, sell restriction, proxy upgrade, delegatecall, administrator sweep, or mechanism that transfers assets from an address other than the transaction sender. User-facing swaps take an explicit input amount and enforce an end-to-end minimum output supplied by the user.

This report does not claim that the system is risk-free. RamenPad has documented oracle, MEV, external-dependency, administrator, and immutability risks. Those risks are materially different from malicious intent or wallet-draining behavior and are listed in Section 12.

We request that Blockaid review and reclassify the four protocol contracts in Section 2, remove any malicious-address inheritance derived solely from their interactions, and verify the project through Blockaid's developer-review process.

## 2. Contracts in scope

| Component | Address | Runtime code hash |
| --- | --- | --- |
| `RamenLauncher` | `0xC89f3837895b3e02c54F254eD73D580016Bbd3E7` | `0xe8d0cbf6b69eae2515668a69c22bec4059bd2308ed33a41499e68ce223915dcb` |
| `RamenLiquidityLocker` | `0x6232e26bEa0283d15dFde673ADA0cc993bC7B90F` | `0x8965d1976ace6b2b30811311261981fa739d30f0e9e86019e820b845f74413ee` |
| `RamenOTC` / in-app router | `0x76B480be19abe121907Aaa5028F52462C8F2F8b5` | `0xd6e9eee713967a4f67339d49d2ce359bb3ef1d58107bdacef8a0a95ffa89c3d8` |
| `RamenEthRouter` | `0x04231d4EBa71Fd75C3e124E9b332BBB445FA076e` | `0xd5f0071cb80f1ab28bdc46defccc83da359f39493c586ae91ee33d80c0ce1c14` |

Deployment block: `52185716`. Deployment transactions and external dependency addresses are recorded in [`deployment/addresses.json`](../deployment/addresses.json).

All four addresses have Sourcify `exact_match` creation and runtime verification:

- <https://sourcify.dev/server/v2/contract/4663/0xc89f3837895b3e02c54f254ed73d580016bbd3e7>
- <https://sourcify.dev/server/v2/contract/4663/0x6232e26bea0283d15dfde673ada0cc993bc7b90f>
- <https://sourcify.dev/server/v2/contract/4663/0x76b480be19abe121907aaa5028f52462c8f2f8b5>
- <https://sourcify.dev/server/v2/contract/4663/0x04231d4eba71fd75c3e124e9b332bbb445fa076e>

## 3. Classification details still needed from Blockaid

The wallet warning alone does not expose which Blockaid model or evidence produced the verdict. To identify the exact false-positive rule, the review request should include or ask Blockaid to return:

- The flagged address or URL.
- Whether the verdict came from transaction, token, address, or dApp scanning.
- The exact transaction calldata and function selector.
- Transaction hash, if broadcast, or simulation ID, if not broadcast.
- Blockaid verdict, reason code, features, and related malicious entities.
- Wallet/integration showing the warning and timestamp.
- Whether the flag is attached to the protocol contract, a newly launched token, RAMEN, an external Uniswap dependency, or the frontend domain.

The likely triggers in Section 9 are evidence-based hypotheses, not claims about Blockaid's private detection rules.

## 4. Protocol purpose and transaction flow

RamenPad is a fixed-terms token launcher and trading interface. Every launch:

1. Deploys a plain fixed-supply ERC-20 with 6,942,000 tokens.
2. Creates a token/RAMEN Uniswap v3 pool at a backend-signed, short-lived initial price.
3. Supplies 90% of the token supply as one-sided liquidity.
4. Mints the LP NFT directly to a permanent locker with no transfer-out or liquidity-removal method.
5. Seeds 10% into an internal token-inventory deck.
6. Optionally performs a creator first buy in the same transaction.

The internal router executes a normal Uniswap v3 leg to obtain an execution rate. Up to 20% of a swap can then be filled against deposited inventory at that observed rate. Insufficient inventory falls back to v3. The owner can adjust the inventory portion only between 1% and 30%.

## 5. What each user-facing transaction can move

### `RamenLauncher.launch`

- Does not request token approval from the user.
- Does not transfer existing user assets.
- Deploys a new `RamenToken` and allocates only that newly created supply.
- Records `msg.sender` as the token launcher and future creator-fee claimant.

### `RamenLauncher.launchAndBuy`

- Spends only `msg.value` deliberately attached by the caller.
- Routes `ETH -> RAMEN -> launched token`.
- Sends purchased tokens to `msg.sender`.
- Uses caller-provided minimum outputs.

### `RamenLauncher.launchAndBuyWithRamen`

- Calls `transferFrom` only against `msg.sender` for the explicit `ramenIn` amount.
- Requires a prior RAMEN allowance for that amount.
- Sends purchased tokens to `msg.sender`.
- Cannot name an unrelated victim as the source address.

### `RamenOTC.buy`

- Transfers exactly `ramenIn` from `msg.sender`.
- Sends at least `minTokenOut` to the caller-selected recipient or reverts atomically.
- Cannot spend tokens belonging to another wallet unless that wallet itself is `msg.sender`.

### `RamenOTC.sell`

- Transfers exactly `tokenIn` from `msg.sender`.
- Sends at least `minRamenOut` to the caller-selected recipient or reverts atomically.
- Contains no sell blacklist, per-address tax, or honeypot branch.

### `RamenEthRouter.buyWithEth`

- Spends only the ETH supplied as `msg.value`.
- Measures the actual RAMEN received before routing it.
- Sends launched-token output to the explicit recipient.
- Holds no owner or administrator role.

### Inventory deposits and withdrawals

- `depositToken` and `depositRamen` transfer only from `msg.sender`.
- Shares are credited to the explicit beneficiary.
- `withdrawToken`, `withdrawRamen`, and yield claims debit only `positions[..., msg.sender]`.
- A caller may redirect their own withdrawal to another recipient but cannot debit somebody else's shares.

### Creator fee claim

- `claimFees` can only be called by the launcher permanently recorded for that LP position.
- The recipient is fixed to that launcher; there is no arbitrary recipient parameter.
- Protocol administrators cannot claim the creator's 69% balance.

## 6. Approval behavior

The frontend reads current allowance before requesting an approval. If allowance is already sufficient, it skips approval. If approval is needed, it approves only the exact amount about to be used and waits for confirmation before submitting the swap.

The contracts use `_forceApprove` only for contract-owned intermediate balances sent to known immutable protocol dependencies. The sequence is:

1. Try setting the required allowance.
2. If a non-standard token rejects changing a nonzero allowance, set it to zero.
3. Set the required allowance.

This is an ERC-20 compatibility pattern. It is not an arbitrary approval of the user's wallet. Contract approvals are granted only from the balance held by the calling protocol contract.

## 7. Negative-capability review

The scoped Solidity contains none of the following common drainer or malicious-token capabilities:

| Capability | Present? | Evidence |
| --- | --- | --- |
| `delegatecall` or upgradeable proxy | No | No delegatecall opcode path or implementation setter exists. |
| Arbitrary target/call-data execution | No | Low-level calls encode only ERC-20 `transfer`, `transferFrom`, or `approve`. |
| `selfdestruct` | No | No self-destruct path exists. |
| Administrator wallet sweep | No | No generic token, ETH, or NFT rescue/sweep function exists. |
| LP withdrawal | No | Locker has no NFT transfer-out, `decreaseLiquidity`, or principal withdrawal method. |
| Hidden mint | No | `RamenToken` mints once in its constructor and has no mint function. |
| Token blacklist/whitelist | No | `RamenToken` transfer logic is uniform for all nonzero recipients. |
| Sell restriction | No | Standard transfer logic and tested router sells are available. |
| Transfer tax | No | Launched `RamenToken` has no tax logic. RAMEN is an external asset. |
| User permit/signature capture | No | No EIP-2612, Permit2, `setApprovalForAll`, or arbitrary user signature is requested. |
| Approval to owner/dev EOA | No | User approvals target the launcher or router used for the requested action. |
| Source address supplied by attacker | No | Every user debit uses `msg.sender` as `from`. |
| Owner-controlled fee percentage | Limited | Owner can change routing participation from 1% to 30%, not the 69/31 LP-fee split. |

## 8. Permission and trust matrix

| Actor | Can do | Cannot do |
| --- | --- | --- |
| Protocol owner | Rotate quote signer, rotate `ramenDev`, set inventory route from 1%–30%, begin two-step ownership transfer | Mint launched tokens, sweep users, claim creator fees, unlock LP, upgrade contracts |
| Pending owner | Accept an explicitly initiated ownership transfer | Exercise owner powers before acceptance |
| Quote signer | Authorize short-lived initial pool price/tick quotes | Transfer user funds, withdraw LP, change roles, trade for users |
| `ramenDev` | Own and withdraw only deck shares credited to that address | Use owner functions, take creator claims, unlock LP |
| Keeper | Call public `harvest` functions and pay gas | Move principal, redirect fees, change roles |
| Token launcher | Claim the 69% creator share for their own recorded LP position | Administer token transfers, mint, unlock LP, claim another launcher's fees |
| Any user | Launch, buy, sell, deposit, withdraw their own shares, permissionlessly harvest/flush | Debit another user's tokens or shares |

On-chain role snapshot at the report date:

- Owner: `0x18d7C1AD00D336C9BFC304fE828Da9fE29656c31`
- `ramenDev`: `0x85abE8E3bed0d4891ba201Af1e212FE50bb65a26`
- Quote signer: `0x4FC9E72d298fE5E8cBE563dD4A42b4dBC0710800`
- Keeper: `0xd62b96627773c9D8bC55827532d0445461814479`
- Internal routing portion: `2000` basis points, or 20%

The locker and internal router resolve owner and dev dynamically from the launcher. They do not have separate hidden administrators.

## 9. Likely false-positive triggers and explanations

| Scanner-sensitive behavior | Legitimate purpose | Constraining control |
| --- | --- | --- |
| Factory deploys new ERC-20 contracts with CREATE2 | Deterministic address allows a signed pool quote before deployment | Salt binds creator nonce, name, and symbol; deployed bytecode is fixed `RamenToken` creation code |
| New token starts with concentrated, one-sided liquidity | Fixed launch mechanics place 90% into v3 | Pool price must equal signed quote; LP NFT is minted to permanent locker |
| 10% supply is sent to a protocol contract | Seeds inventory-assisted routing | Shares are transparently split 69/31 and recorded in withdrawable positions |
| `transferFrom` appears in routers | Pulls the exact input the caller chose for buy/sell/deposit | Source is always `msg.sender`; end-to-end minimum output applies |
| Low-level `.call` is used on tokens | Safely supports tokens that return no boolean | Calldata is statically encoded to only three ERC-20 selectors; no arbitrary target data |
| Approval is reset to zero and set again | Compatibility with non-standard ERC-20 allowance behavior | Approval comes from protocol-owned balances and goes to immutable routers/contracts |
| Intermediate Uniswap leg uses zero minimum output | Combined v3/inventory route cannot know the split output until execution | Public `buy`/`sell` checks caller's final `minOut`; any failure reverts every intermediate transfer |
| ETH router's v2 leg uses zero RAMEN minimum | RAMEN received can differ due to external RAMEN transfer behavior | Actual received balance is measured; final launched-token `minTokenOut` protects the complete transaction |
| Backend signature checked with `ecrecover` | Authorizes a two-minute initial-price quote | Signature binds chain, launcher, creator, predicted token, salt, RAMEN, price, ticks, and deadline |
| Tokens are sent to `0x...dEaD` | Burns only unusable launch-token rounding remainder after one-sided mint | No user-owned assets are burned; source is launcher-held newly minted supply |
| Locker receives NFTs but exposes no NFT exit | Makes permanent liquidity verifiable | Only Uniswap position manager NFTs are accepted; fee collection remains available |
| Contract distributes revenue to owner/dev | Implements disclosed protocol economics | LP split is immutable at 69% creator / 15.5% dev / 15.5% owner |
| Project is new on a new chain | Limited reputation/history can trigger conservative models | Public source, deterministic transactions, exact-match verification, tests, and on-chain state are supplied |

The most important technical distinction is between **intermediate minimums** and **final minimums**. RamenPad permits an internal pool leg to return any amount, then computes the aggregate v3 plus inventory output. The public function compares that aggregate against the user's `minTokenOut` or `minRamenOut`. If the final result is insufficient, Solidity reverts the entire transaction, including transfers and swaps.

## 10. Permanent locker analysis

The locker's apparent inability to return the NFT is intentional and is not a custody trap for a user's pre-existing NFT:

- The launcher mints a new Uniswap v3 NFT directly to the locker during token creation.
- The token launcher never owns or transfers that NFT.
- `onERC721Received` rejects NFTs not sent by the configured Uniswap v3 position manager.
- Only the configured launcher can register a position.
- There is no `transferFrom`/`safeTransferFrom` call for NFTs and no `decreaseLiquidity` call.
- Fee collection does not reduce liquidity principal.

For the first live RamenPad market, MISO position NFT `951587` is owned by the locker address on-chain. This is consistent with the documented permanent lock.

## 11. Fee-flow analysis

Uniswap v3 fees collected by the locker are split per asset:

| Recipient | Percentage | Delivery |
| --- | ---: | --- |
| Original token launcher | 69% | Accrues in `claimable`; only launcher may claim |
| Current `ramenDev` | 15.5% | Deposited as that beneficiary's deck shares |
| Current protocol owner | 15.5% | Deposited as that beneficiary's deck shares |

If a protocol deck deposit fails, the locker restores the exact pending dev/owner accounting and emits `ProtocolFeesDeferred`. Creator balances remain claimable, and anyone can retry `flushProtocolFees`. This avoids using external integration failure to trap a creator's funds.

The protocol does not silently route the user's swap principal to owner or dev. Beneficiary revenue comes from the disclosed initial 10% allocation, LP fees, and yield earned by owned deck shares.

## 12. Real risks and limitations

The following are genuine risks and should remain visible even after a malicious classification is removed.

### R-01: Signed initial-price trust

The backend quote signer controls the initial `sqrtPriceX96` it signs. A compromised signer could authorize a bad launch price until the owner rotates it. The signer cannot unlock LP, mint later, or debit a wallet.

### R-02: Spot execution and MEV

Inventory fills use a same-transaction v3 execution rate rather than TWAP. Pool state and transaction ordering can influence the rate. Caller-provided final minimum output is the primary protection; there is no on-chain TWAP circuit breaker.

### R-03: Zero intermediate minimums

Internal v2/v3 legs use zero minimums and rely on final output enforcement. This preserves atomic protection but can allow worse intermediate execution within a final tolerance. Users should use a narrow, nonzero final minimum.

### R-04: External dependencies

The system depends on the deployed RAMEN token and Robinhood's Uniswap v2/v3 contracts. Changes or defects in those external contracts can affect routing.

### R-05: Immutable deployment

The contracts are not upgradeable. This prevents an administrator from replacing code with a drainer but also means bugs require a new stack. Locked liquidity cannot migrate.

### R-06: Administrator roles

The owner may rotate the quote signer and dev wallet and adjust inventory participation from 1% to 30%. These powers are visible and event-emitting, but the owner is currently an EOA rather than a timelock or multisig.

### R-07: Existing deck positions survive role rotation

Changing owner or dev affects future credits and churn. Shares already credited to an old beneficiary remain owned by that address until it withdraws or transfers value through normal deposit/withdraw flows.

### R-08: Off-chain availability

Launch quote generation, image hosting, indexed KPIs, and live discovery depend on backend services. A backend outage can stop new signed launches or stale the UI, but cannot change deployed contract balances.

### R-09: USD display dependency

USD market cap depends on RAMEN/USD. A RAMEN price change alters displayed token USD value even when token/RAMEN is nearly unchanged.

### R-10: No independent audit warranty

The current review, tests, Slither output, and this report are internal engineering evidence, not an independent third-party security certification.

## 13. Verification evidence

- 11 Solidity unit/regression tests pass.
- 1 Robinhood mainnet fork test passes against the real Uniswap dependencies.
- The fork flow covers deployment, atomic ETH first buy, v3 plus internal routing, LP fee harvest, protocol churn, and creator claim without broadcasting.
- Frontend and backend TypeScript tests pass.
- Frontend ESLint passes with zero warnings.
- Frontend and backend production builds pass.
- Public GitHub Actions runs the application and contract suites on every push.
- Slither machine-readable output is committed at [`deployment/slither-report.json`](../deployment/slither-report.json).
- The predeployment engineering review is committed at [`deployment/PREDEPLOYMENT_AUDIT.md`](../deployment/PREDEPLOYMENT_AUDIT.md).
- All four deployed protocol contracts are Sourcify exact matches.
- Deployed contracts have nonempty runtime code and stable code hashes listed in Section 2.
- The live MISO LP NFT is held by the documented locker.
- No repository secret, keystore, Foundry broadcast, backend environment, or Vercel credential is committed.

## 14. Requested Blockaid remediation

Please perform the following:

1. Re-simulate representative calls to `launch`, `launchAndBuy`, `launchAndBuyWithRamen`, `buy`, `sell`, `buyWithEth`, `claimFees`, and approval using the verified ABIs.
2. Confirm that token debits always originate from `msg.sender` and never from a caller-supplied victim.
3. Confirm that the frontend requests exact-amount approvals and waits for approval confirmation.
4. Confirm that public swap entry points enforce aggregate final minimum output.
5. Confirm that no generic call, delegatecall, proxy upgrade, administrator sweep, hidden mint, transfer tax, blacklist, or sell restriction exists.
6. Reclassify the four scoped addresses as benign protocol contracts.
7. Remove malicious association from legitimate RamenPad-launched tokens if it derives solely from interaction with these contracts.
8. Review the legitimate frontend domain separately for dApp verification once the production URL is supplied.
9. Return the original verdict reason codes so the project can make any safe scanner-compatibility improvement that does not weaken transaction protection.

Blockaid's official Robinhood materials state that its Robinhood Chain coverage scans transactions and tokens for risky approvals, untrusted spenders, impersonation, rugpulls, honeypots, and spam. Those protections are valuable. RamenPad is requesting a manual correction because its transparent launch/router mechanics appear to overlap with those behavioral categories without implementing the malicious capabilities they are intended to catch.

## 15. Suggested portal submission summary

> RamenPad is an open-source fixed-supply token launcher on Robinhood Chain. One or more of our exact-match verified contracts are being flagged as malicious. The contracts have no arbitrary call/delegatecall, proxy upgrade, admin sweep, hidden mint, blacklist, tax, sell restriction, or ability to debit a caller-supplied victim. User transfers always debit `msg.sender`, approvals are exact amount, and routed swaps enforce a caller-supplied final minimum output. The likely false-positive features are CREATE2 token deployment, one-sided permanent liquidity, ERC-20 `transferFrom`, compatibility `forceApprove`, fee sharing, and zero minimums on intermediate swap legs protected by aggregate final `minOut`. Please review addresses and code hashes in the attached report, provide the original reason codes, and reclassify the protocol and legitimate launched tokens.

## 16. Reviewer references

- Contract documentation: [`CONTRACTS.md`](CONTRACTS.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Launch pricing: [`LAUNCH_AND_PRICING.md`](LAUNCH_AND_PRICING.md)
- Liquidity and fees: [`LIQUIDITY_AND_FEES.md`](LIQUIDITY_AND_FEES.md)
- Operations and security: [`OPERATIONS_AND_SECURITY.md`](OPERATIONS_AND_SECURITY.md)
- Blockaid support portal: <https://report.blockaid.io/>
- Blockaid Robinhood Chain overview: <https://blockaid.io/robinhood>
- Blockaid Robinhood Chain transaction/token scanning announcement: <https://blockaid.io/blog/blockaid-brings-real-time-transaction-protection-to-robinhood-chain>

## 17. Conclusion

The available source, exact-match verification, deployed state, tested transaction flows, and capability review do not support a malicious-contract classification for the four RamenPad protocol addresses. The contracts perform disclosed launch, swap, inventory, fee-distribution, and permanent-lock functions. Their scanner-sensitive patterns are constrained to the caller's explicit assets and protocol-owned intermediate balances.

The appropriate classification is a novel DeFi launcher/router with documented economic and administrator risks—not a wallet drainer, malicious token, honeypot, or arbitrary approval stealer.
