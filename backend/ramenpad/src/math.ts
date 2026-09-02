import type { Address } from "viem";
import { RAMEN, TARGET_TOKEN_USD, TICK_SPACING } from "./config.js";

const Q192 = 1n << 192n;
const ONE = 10n ** 18n;
const MAX_TICK = 887_272;

export function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("square root of a negative number");
  if (value < 2n) return value;
  let x0 = 1n << (BigInt(value.toString(2).length) + 1n >> 1n);
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) { x0 = x1; x1 = (x0 + value / x0) >> 1n; }
  return x0;
}

export function buildPoolQuote(predictedToken: Address, ramenUsd: number) {
  if (!Number.isFinite(ramenUsd) || ramenUsd <= 0) throw new Error("RAMEN/USD price is unavailable");
  const ramenPerToken = TARGET_TOKEN_USD / ramenUsd;
  const tokenIsToken0 = BigInt(predictedToken) < BigInt(RAMEN);
  const rawRatio = tokenIsToken0 ? ramenPerToken : 1 / ramenPerToken;
  if (!Number.isFinite(rawRatio) || rawRatio <= 0) throw new Error("Invalid pool ratio");

  const ratioX18 = BigInt(Math.floor(rawRatio * 1e18));
  const sqrtPriceX96 = bigintSqrt(ratioX18 * Q192 / ONE);
  const currentTick = Math.floor(Math.log(rawRatio) / Math.log(1.0001));
  const maxUsableTick = Math.floor(MAX_TICK / TICK_SPACING) * TICK_SPACING;

  // Keep the initial position entirely in the launched token. The pool itself is
  // initialized at the exact signed target launch price; the range starts at the next
  // usable boundary in the direction of the first RAMEN buy.
  const tickLower = tokenIsToken0
    ? (Math.floor(currentTick / TICK_SPACING) + 1) * TICK_SPACING
    : -maxUsableTick;
  const tickUpper = tokenIsToken0
    ? maxUsableTick
    : Math.floor(currentTick / TICK_SPACING) * TICK_SPACING;

  if (tickLower >= tickUpper) throw new Error("Computed tick range is invalid");
  return { sqrtPriceX96, tickLower, tickUpper, ramenPerToken, tokenIsToken0 };
}

export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsToken0: boolean, ramenUsd: number) {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = sqrt * sqrt;
  const ramenPerToken = tokenIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
  return { ramenPerToken, priceUsd: ramenPerToken * ramenUsd };
}
