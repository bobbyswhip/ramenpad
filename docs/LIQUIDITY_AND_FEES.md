# Liquidity and fees

## Permanent liquidity

Every launch mints its Uniswap v3 position NFT directly to `RamenLiquidityLocker`. The locker exposes collection and accounting methods but no function that transfers the NFT or removes liquidity. If a one-sided mint leaves unusable launch-token dust, that remainder is sent to the burn address rather than the creator.

The frontend links each market to the common locker and its specific position ID so users can independently inspect custody.

## LP fee split

For either asset collected from a position:

| Recipient | Share |
| --- | ---: |
| Token launcher | 69% |
| `ramenDev` | 15.5% |
| Protocol `owner` | 15.5% |

Integer division remainder is retained in the protocol-owner portion so the complete collected amount is accounted for.

Creator fees accumulate per LP token ID and asset. Only the launcher recorded for that position can withdraw them. Calling `claimFees` harvests first, so the claim includes fees not previously collected by the keeper.

## Protocol automation

Protocol LP fees are deposited into beneficiary positions in the internal decks:

- Launched-token fees enter the token deck.
- RAMEN fees enter the RAMEN deck.

If a deck deposit temporarily fails, the locker records the dev and owner amounts separately and emits `ProtocolFeesDeferred`; anyone can retry the flush. This isolates launcher claims from protocol automation failures.

## Routed inventory fills

For a buy, the token deck provides token output and accrues RAMEN yield. For a sell, the RAMEN deck provides RAMEN output and accrues token yield. The normal v3 leg establishes a real execution rate before any inventory fill. Default inventory participation is 20%; the owner-controlled allowed range is 1%–30%.

Insufficient inventory does not make the route unusable. The router preserves a one-token reserve and sends the remainder through v3.

## Churn

After routed fills, protocol yield is automatically moved into the opposite principal deck:

- RAMEN earned by a beneficiary's token-deck position becomes RAMEN-deck principal.
- Token earned by a beneficiary's RAMEN-deck position becomes token-deck principal.

This compounds `ramenDev` and owner positions without requiring them to monitor every launched market. Public `churnProtocol` remains available as a recovery/maintenance entry point.

When either current role wallet connects, the Profile page exposes its token-deck and RAMEN-deck principal and pending yield for every market. Each position can be withdrawn in full to that wallet. A withdrawal removes the current shares and pays their accrued yield; future protocol fee harvests will credit new shares again because the 31% protocol routing policy remains automatic.

## KPIs

The backend separately indexes gross harvested fees, launcher-earned amounts, launcher claims, pending launcher balances, protocol-earned amounts, and successful protocol deck deposits. The API exposes per-token and protocol-wide totals for the frontend.
