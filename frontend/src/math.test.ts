import { describe, expect, it } from "vitest";
import { TARGET_MARKET_CAP, TOTAL_SUPPLY } from "./config";

describe("fixed launch terms", () => {
  it("starts each token at exactly $2,000 market cap", () => {
    expect(TARGET_MARKET_CAP).toBe(2_000);
    expect(TARGET_MARKET_CAP / TOTAL_SUPPLY).toBeCloseTo(2_000 / 6_942_000, 15);
  });
});
