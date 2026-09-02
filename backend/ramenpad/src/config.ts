import { defineChain, http, createPublicClient, type Address, type Hex } from "viem";

export const CHAIN_ID = 4663;
export const RAMEN = "0xe013e34F03F42d49E836d59CF6353B897c337777" as Address;
export const RAMEN_V2_PAIR = "0xB14C07152b5dfe31c6E3fF3Df1eF0D29b5Db8238" as Address;
export const TOTAL_SUPPLY = 6_942_000;
export const LEGACY_TARGET_MARKET_CAP_USD = 6_942;
export const TARGET_MARKET_CAP_USD = 2_000;
export const TARGET_TOKEN_USD = TARGET_MARKET_CAP_USD / TOTAL_SUPPLY;
export const TARGET_2000_ACTIVATION_BLOCK = BigInt(
  process.env.RAMENPAD_TARGET_2000_ACTIVATION_BLOCK || "52219736",
);
export const TICK_SPACING = 200;

export const robinhood = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"] } },
});

export const publicClient = createPublicClient({ chain: robinhood, transport: http(robinhood.rpcUrls.default.http[0]) });

export function requiredAddress(name: string): Address {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a valid address`);
  return value as Address;
}

export function requiredPrivateKey(name: string): Hex {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte hex private key`);
  return value as Hex;
}
