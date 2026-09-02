import { defineChain, fallback, http } from "viem";

export const PUBLIC_RPC_URLS = [
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.mainnet.chain.robinhood.com",
] as const;

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [...PUBLIC_RPC_URLS] },
  },
  blockExplorers: {
    default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11", blockCreated: 1 },
  },
});

export const transport = fallback(
  PUBLIC_RPC_URLS.map((url, index) => http(url, { key: `ramenpad-browser-free-${index}` })),
  { rank: false, retryCount: 0 },
);
export const API_URL = (import.meta.env.VITE_API_URL || "https://api.yougotcoined.com/api/ramenpad").replace(/\/$/, "");
export const LAUNCHER = (import.meta.env.VITE_RAMENPAD_LAUNCHER_ADDRESS || "0xC89f3837895b3e02c54F254eD73D580016Bbd3E7") as `0x${string}`;
export const ETH_ROUTER = (import.meta.env.VITE_RAMENPAD_ETH_ROUTER_ADDRESS || "0x04231d4EBa71Fd75C3e124E9b332BBB445FA076e") as `0x${string}`;
export const OTC = (import.meta.env.VITE_RAMENPAD_OTC_ADDRESS || "0x76B480be19abe121907Aaa5028F52462C8F2F8b5") as `0x${string}`;
export const RAMEN = "0xe013e34F03F42d49E836d59CF6353B897c337777" as const;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
export const V2_ROUTER = "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba" as const;
export const RAMEN_PAIR = "0xB14C07152b5dfe31c6E3fF3Df1eF0D29b5Db8238" as const;
export const RAMEN_IMAGE = "https://cdn.dexscreener.com/cms/images/2nwIaHBUoilWGWrS?width=160&height=160&quality=95&format=auto";
export const V3_QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as const;
export const TOTAL_SUPPLY = 6_942_000;
export const TARGET_MARKET_CAP = 2_000;
export const TARGET_TOKEN_PRICE = TARGET_MARKET_CAP / TOTAL_SUPPLY;
