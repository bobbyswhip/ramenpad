import { createPublicClient, createWalletClient, custom } from "viem";
import { robinhood, transport } from "./config";

declare global {
  interface Window { ethereum?: { request(args: { method: string; params?: unknown[] | object }): Promise<unknown> } }
}
export const publicClient = createPublicClient({ chain: robinhood, transport });

export async function connectWallet() {
  if (!window.ethereum) throw new Error("Install Robinhood Wallet, MetaMask, or another EVM wallet.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as `0x${string}`[];
  if (!accounts[0]) throw new Error("No wallet account returned.");
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1237" }] });
  } catch (error: unknown) {
    const code = (error as { code?: number })?.code;
    if (code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x1237",
        chainName: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
        blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
      }],
    });
  }
  return {
    account: accounts[0],
    client: createWalletClient({ account: accounts[0], chain: robinhood, transport: custom(window.ethereum) }),
  };
}

export function shortAddress(address?: string) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}
