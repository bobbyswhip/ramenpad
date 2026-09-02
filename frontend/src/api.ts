import { io } from "socket.io-client";
import { getAddress } from "viem";
import { API_URL } from "./config";
import type { LaunchQuote, MarketUpdate, ProtocolKpis, RamenpadConfig, TokenSummary, TokenUpdate, Trade } from "./types";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export function getTokens() {
  return json<{ tokens: TokenSummary[] }>(`${API_URL}/tokens`);
}

export function getTrades() {
  return json<{ trades: Trade[] }>(`${API_URL}/trades?limit=50`);
}

export function getKpis() {
  return json<{ kpis: ProtocolKpis }>(`${API_URL}/kpis`);
}

export function getConfig() {
  return json<RamenpadConfig>(`${API_URL}/config`);
}

export async function requireLaunchReady() {
  const healthUrl = `${API_URL.replace(/\/api\/ramenpad$/, "")}/health/ramenpad`;
  const response = await fetch(healthUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const health = await response.json().catch(() => ({})) as { launchReady?: boolean };
  if (!response.ok || !health.launchReady) {
    throw new Error("Launches are briefly paused while the backend catches up. Please try again in a moment.");
  }
}

export function getQuote(input: { creator: string; name: string; symbol: string }) {
  return json<LaunchQuote>(`${API_URL}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function uploadImage(file: File) {
  const form = new FormData();
  form.append("image", file);
  return json<{ imageUrl: string }>(`${API_URL}/uploads`, { method: "POST", body: form });
}

export function tokenImageUpdateMessage(token: string, imageUrl: string, timestamp: number) {
  return `RamenPad image update\nChain: 4663\nToken: ${getAddress(token)}\nImage: ${imageUrl}\nTimestamp: ${timestamp}`;
}

export function updateTokenImage(token: string, input: { imageUrl: string; timestamp: number; signature: string }) {
  return json<{ tokenAddress: string; imageUrl: string }>(`${API_URL}/tokens/${token}/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function subscribeLive(
  onTrade: (trade: Trade) => void,
  onLaunch: (token: TokenSummary) => void,
  onFees?: () => void,
  onTokenUpdate?: (update: TokenUpdate) => void,
  onMarket?: (update: MarketUpdate) => void,
  onReconnect?: () => void,
) {
  const socketBase = API_URL.replace(/\/api\/ramenpad$/, "");
  const socket = io(socketBase, { path: "/ramenpad/socket.io", transports: ["websocket", "polling"] });
  socket.on("ramenpad:trade", onTrade);
  socket.on("ramenpad:launch", onLaunch);
  if (onFees) socket.on("ramenpad:fees", onFees);
  if (onTokenUpdate) socket.on("ramenpad:tokens:update", onTokenUpdate);
  if (onMarket) socket.on("ramenpad:market", onMarket);
  let connectedOnce = false;
  socket.on("connect", () => {
    if (connectedOnce) onReconnect?.();
    connectedOnce = true;
  });
  return () => { socket.disconnect(); };
}
