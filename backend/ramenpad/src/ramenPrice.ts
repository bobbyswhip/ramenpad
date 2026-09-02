import { RAMEN_V2_PAIR } from "./config.js";

let cached: {
  ramenUsd: number;
  ethUsd: number;
  ramenMarketCapUsd?: number;
  ramenVolumeUsd?: number;
  at: number;
} | undefined;

export async function getMarketPrices() {
  if (cached && Date.now() - cached.at < 10_000) return cached;
  const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${RAMEN_V2_PAIR}`);
  if (!response.ok) throw new Error(`DexScreener price request failed (${response.status})`);
  const body = await response.json() as {
    pair?: {
      priceUsd?: string;
      priceNative?: string;
      marketCap?: number;
      fdv?: number;
      volume?: { h24?: number };
    };
  };
  const ramenUsd = Number(body.pair?.priceUsd);
  const ramenEth = Number(body.pair?.priceNative);
  if (!Number.isFinite(ramenUsd) || ramenUsd <= 0 || !Number.isFinite(ramenEth) || ramenEth <= 0) {
    throw new Error("DexScreener did not return valid RAMEN market prices");
  }
  const marketCap = Number(body.pair?.marketCap || body.pair?.fdv);
  const volume = Number(body.pair?.volume?.h24);
  cached = {
    ramenUsd,
    ethUsd: ramenUsd / ramenEth,
    ramenMarketCapUsd: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : undefined,
    ramenVolumeUsd: Number.isFinite(volume) && volume >= 0 ? volume : undefined,
    at: Date.now(),
  };
  return cached;
}

export async function getRamenUsd() {
  return (await getMarketPrices()).ramenUsd;
}
