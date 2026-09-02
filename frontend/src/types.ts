export interface TokenSummary {
  tokenAddress: `0x${string}`;
  poolAddress: `0x${string}`;
  launcher: `0x${string}`;
  positionTokenId: string;
  name: string;
  symbol: string;
  imageUrl?: string;
  launchedAt: string;
  priceUsd?: number;
  marketCapUsd?: number;
  volumeUsd?: number;
  totalFeeUsd?: number;
  launcherFeeUsd?: number;
  protocolFeeUsd?: number;
  harvestCount?: number;
  launcherTokenPending?: string;
  launcherRamenPending?: string;
  protocolTokenDeposited?: string;
  protocolRamenDeposited?: string;
  marketType?: "launch" | "ramen";
}

export interface ProtocolKpis {
  tokenCount: number;
  totalFeeUsd: number;
  launcherFeeUsd: number;
  protocolFeeUsd: number;
  harvestCount: number;
  protocolTokenDeposited: string;
  protocolRamenDeposited: string;
}

export interface RamenpadConfig {
  chainId: number;
  launcher: `0x${string}` | null;
  locker: `0x${string}` | null;
  otc: `0x${string}` | null;
  ethRouter?: `0x${string}` | null;
  ramenUsd?: number;
  ethUsd?: number;
  ramenMarketCapUsd?: number;
  ramenVolumeUsd?: number;
}

export interface TokenUpdate {
  tokenAddress: `0x${string}`;
  priceUsd: number;
  marketCapUsd: number;
  volumeDeltaUsd: number;
}

export interface MarketUpdate {
  ramenUsd: number;
  ethUsd: number;
  ramenMarketCapUsd?: number;
  ramenVolumeUsd?: number;
}

export interface Trade {
  id: string;
  tokenAddress: `0x${string}`;
  poolAddress: `0x${string}`;
  symbol: string;
  side: "buy" | "sell";
  trader: `0x${string}`;
  tokenAmount: string;
  ramenAmount: string;
  usdValue: number;
  priceUsd: number;
  marketCapUsd: number;
  txHash: `0x${string}`;
  blockTime: string;
}

export interface LaunchQuote {
  predictedToken: `0x${string}`;
  ramenUsd: number;
  targetTokenUsd: number;
  quote: {
    sqrtPriceX96: string;
    tickLower: number;
    tickUpper: number;
    deadline: string;
  };
  signature: `0x${string}`;
}
