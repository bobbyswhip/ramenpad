export const launcherAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "imageUrl", type: "string" },
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
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
      { name: "positionTokenId", type: "uint256" },
    ],
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
    name: "otc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "launchAndBuyWithRamen",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "imageUrl", type: "string" },
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
      { name: "signature", type: "bytes" },
      { name: "ramenIn", type: "uint256" },
      { name: "minTokenOut", type: "uint256" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
      { name: "positionTokenId", type: "uint256" },
      { name: "tokenOut", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "launchAndBuy",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "imageUrl", type: "string" },
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
      { name: "signature", type: "bytes" },
      { name: "minRamenOut", type: "uint256" },
      { name: "minTokenOut", type: "uint256" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
      { name: "positionTokenId", type: "uint256" },
      { name: "tokenOut", type: "uint256" },
    ],
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
] as const;

export const erc20Abi = [
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "totalSupply", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const v2RouterAbi = [
  {
    type: "function", name: "getAmountsOut", stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function", name: "swapExactETHForTokensSupportingFeeOnTransferTokens", stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "swapExactTokensForETHSupportingFeeOnTransferTokens", stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const ethRouterAbi = [{
  type: "function", name: "buyWithEth", stateMutability: "payable",
  inputs: [
    { name: "token", type: "address" },
    { name: "minTokenOut", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [{ name: "ramenIn", type: "uint256" }, { name: "tokenOut", type: "uint256" }],
}] as const;

export const otcAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "ramenIn", type: "uint256" },
      { name: "minTokenOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "tokenOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "tokenIn", type: "uint256" },
      { name: "minRamenOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "ramenOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "positionInfo",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "side", type: "uint8" },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [
      { name: "shares", type: "uint256" },
      { name: "principal", type: "uint256" },
      { name: "pendingYield", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "withdrawToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "principal", type: "uint256" }, { name: "ramenYield", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdrawRamen",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "principal", type: "uint256" }, { name: "tokenYield", type: "uint256" }],
  },
] as const;

export const quoterAbi = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
  }],
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" },
    { name: "gasEstimate", type: "uint256" },
  ],
}] as const;

export const lockerAbi = [
  {
    type: "function",
    name: "claimFees",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;
