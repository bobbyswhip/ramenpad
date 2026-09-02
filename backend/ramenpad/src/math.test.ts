import { describe, expect, it } from "vitest";
import { RAMEN, TARGET_MARKET_CAP_USD, TARGET_TOKEN_USD, TOTAL_SUPPLY } from "./config.js";
import { bigintSqrt, buildPoolQuote, priceFromSqrt } from "./math.js";

describe("RamenPad launch quote math", () => {
  it("fixes launch market cap at $2,000", () => {
    expect(TARGET_MARKET_CAP_USD / TOTAL_SUPPLY).toBe(TARGET_TOKEN_USD);
    expect(TARGET_TOKEN_USD).toBeCloseTo(2_000 / 6_942_000, 15);
  });

  it("computes a reversible v3 price when launched token sorts before RAMEN", () => {
    const token = "0x0000000000000000000000000000000000000001";
    const quote = buildPoolQuote(token, 0.00005);
    const price = priceFromSqrt(quote.sqrtPriceX96, quote.tokenIsToken0, 0.00005);
    expect(price.priceUsd).toBeCloseTo(TARGET_TOKEN_USD, 12);
    expect(quote.tickLower).toBeLessThan(quote.tickUpper);
  });

  it("computes a reversible v3 price when launched token sorts after RAMEN", () => {
    const token = "0xffffffffffffffffffffffffffffffffffffffff";
    expect(BigInt(token)).toBeGreaterThan(BigInt(RAMEN));
    const quote = buildPoolQuote(token, 0.00005);
    const price = priceFromSqrt(quote.sqrtPriceX96, quote.tokenIsToken0, 0.00005);
    expect(price.priceUsd).toBeCloseTo(TARGET_TOKEN_USD, 12);
    expect(quote.tickLower).toBeLessThan(quote.tickUpper);
  });

  it("takes integer square roots", () => {
    expect(bigintSqrt(0n)).toBe(0n);
    expect(bigintSqrt(1n)).toBe(1n);
    expect(bigintSqrt(16n)).toBe(4n);
    expect(bigintSqrt(17n)).toBe(4n);
  });
});
