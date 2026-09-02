export const launcherAbi = [
  {
    type: "function",
    name: "predictNextTokenAddress",
    stateMutability: "view",
    inputs: [
      { name: "launcher", type: "address" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "nonce", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "launchQuoteDigest",
    stateMutability: "view",
    inputs: [
      { name: "launcher", type: "address" },
      { name: "token", type: "address" },
      { name: "salt", type: "bytes32" },
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "sqrtPriceX96", type: "uint160" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "quoteSigner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { name: "launchId", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "launcher", type: "address", indexed: true },
      { name: "pool", type: "address", indexed: false },
      { name: "positionTokenId", type: "uint256", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "imageUrl", type: "string", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
    ],
  },
  {
    type: "function",
    name: "otc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "locker",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ramenDev",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "launchCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allTokensLength",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allTokens",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const tokenLaunchedEvent = launcherAbi[3];

export const lockerAbi = [{
  type: "function",
  name: "harvest",
  stateMutability: "nonpayable",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [
    { name: "amount0", type: "uint256" },
    { name: "amount1", type: "uint256" },
  ],
}] as const;

export const feesHarvestedEvent = {
  type: "event",
  name: "FeesHarvested",
  inputs: [
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "creatorAmount0", type: "uint256", indexed: false },
    { name: "creatorAmount1", type: "uint256", indexed: false },
    { name: "devAmount0", type: "uint256", indexed: false },
    { name: "devAmount1", type: "uint256", indexed: false },
    { name: "ownerAmount0", type: "uint256", indexed: false },
    { name: "ownerAmount1", type: "uint256", indexed: false },
  ],
} as const;

export const launcherFeesClaimedEvent = {
  type: "event",
  name: "LauncherFeesClaimed",
  inputs: [
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "launcher", type: "address", indexed: true },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
} as const;

export const protocolFeesDepositedEvent = {
  type: "event",
  name: "ProtocolFeesDeposited",
  inputs: [
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "devAmount", type: "uint256", indexed: false },
    { name: "ownerAmount", type: "uint256", indexed: false },
  ],
} as const;

export const otcSwapEvent = {
  type: "event",
  name: "OtcSwap",
  inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "trader", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "isBuy", type: "bool", indexed: false },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "poolAmountIn", type: "uint256", indexed: false },
    { name: "otcAmountIn", type: "uint256", indexed: false },
    { name: "otcAmountOut", type: "uint256", indexed: false },
  ],
} as const;

export const swapEvent = {
  type: "event",
  name: "Swap",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
} as const;
