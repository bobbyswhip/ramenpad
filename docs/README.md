# RamenPad documentation

RamenPad is an open-source fixed-terms launcher and trading interface for Robinhood Chain. These documents describe both the deployed protocol and its supporting off-chain services.

- [Architecture](ARCHITECTURE.md) — system boundaries and an end-to-end launch.
- [Contracts](CONTRACTS.md) — every contract, interface, permission, and public operation.
- [Launch and pricing](LAUNCH_AND_PRICING.md) — supply allocation, live-price quotes, atomic buys, and slippage.
- [Liquidity and fees](LIQUIDITY_AND_FEES.md) — permanent LP custody, fee splits, internal decks, and churn.
- [Operations and security](OPERATIONS_AND_SECURITY.md) — roles, keeper, indexer, deployment, testing, and trust assumptions.
- [Blockaid false-positive report](BLOCKAID_FALSE_POSITIVE_REPORT.md) — scanner-trigger analysis, fund-flow audit, verification evidence, and reclassification request.

The source of truth is the Solidity under [`contracts/src`](../contracts/src). Documentation is explanatory and does not replace reviewing deployed bytecode or obtaining an independent audit.
