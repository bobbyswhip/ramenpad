import { defineChain, fallback, http, createPublicClient, type Address, type Hex } from "viem";

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

function urls(value?: string) {
  return value?.split(",").map((url) => url.trim()).filter(Boolean) || [];
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export const FREE_RPC_URLS = unique([
  ...urls(process.env.ROBINHOOD_FREE_RPC_URLS),
  "https://robinhood-rpc.publicnode.com",
  process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.mainnet.chain.robinhood.com",
]);
export const PAID_RPC_URLS = unique([
  ...urls(process.env.ROBINHOOD_PAID_RPC_URLS),
  ...urls(process.env.ROBINHOOD_PAID_RPC_URL),
]).filter((url) => !FREE_RPC_URLS.includes(url));

export const robinhood = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [...FREE_RPC_URLS, ...PAID_RPC_URLS] } },
});

const rpcStats = {
  free: { success: 0, failure: 0 },
  paid: { success: 0, failure: 0 },
};
const transport = fallback([
  ...FREE_RPC_URLS.map((url, index) => http(url, { key: `ramenpad-free-${index}`, name: `RamenPad Free RPC ${index + 1}` })),
  ...PAID_RPC_URLS.map((url, index) => http(url, { key: `ramenpad-paid-${index}`, name: `RamenPad Paid RPC ${index + 1}` })),
], { rank: false, retryCount: 0 });
const logFreeRpcUrls = unique([
  ...urls(process.env.ROBINHOOD_LOG_RPC_URLS),
  process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.mainnet.chain.robinhood.com",
]);
const logTransport = fallback([
  ...logFreeRpcUrls.map((url, index) => http(url, { key: `ramenpad-log-free-${index}`, name: `RamenPad Log RPC ${index + 1}` })),
  ...PAID_RPC_URLS.map((url, index) => http(url, { key: `ramenpad-log-paid-${index}`, name: `RamenPad Paid Log RPC ${index + 1}` })),
], { rank: false, retryCount: 0 });

export const publicClient = createPublicClient({ chain: robinhood, transport });
export const logClient = createPublicClient({ chain: robinhood, transport: logTransport });
publicClient.transport.onResponse(({ status, transport: usedTransport }) => {
  const tier = usedTransport.config.key.includes("-paid-") ? "paid" : "free";
  rpcStats[tier][status === "success" ? "success" : "failure"] += 1;
});
logClient.transport.onResponse(({ status, transport: usedTransport }) => {
  const tier = usedTransport.config.key.includes("-paid-") ? "paid" : "free";
  rpcStats[tier][status === "success" ? "success" : "failure"] += 1;
});

export function getRpcStats() {
  return {
    freeProviders: FREE_RPC_URLS.length,
    paidProviders: PAID_RPC_URLS.length,
    free: { ...rpcStats.free },
    paid: { ...rpcStats.paid },
  };
}

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
