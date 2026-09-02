import { io } from "socket.io-client";
import { API_URL } from "./config";
import type { LaunchQuote, ProtocolKpis, RamenpadConfig, TokenSummary, Trade } from "./types";

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
  return `RamenPad image update\nChain: 4663\nToken: ${token}\nImage: ${imageUrl}\nTimestamp: ${timestamp}`;
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
) {
  const socketBase = API_URL.replace(/\/api\/ramenpad$/, "");
  const socket = io(socketBase, { path: "/ramenpad/socket.io", transports: ["websocket", "polling"] });
  socket.on("ramenpad:trade", onTrade);
  socket.on("ramenpad:launch", onLaunch);
  if (onFees) socket.on("ramenpad:fees", onFees);
  return () => { socket.disconnect(); };
}
