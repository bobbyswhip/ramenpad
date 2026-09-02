import { describe, expect, it } from "vitest";
import { splitBlockRange } from "./indexer.js";

describe("splitBlockRange", () => {
  it("splits Alchemy fallback scans without gaps or overlap", () => {
    expect(splitBlockRange(100n, 125n, 10n)).toEqual([
      { fromBlock: 100n, toBlock: 109n },
      { fromBlock: 110n, toBlock: 119n },
      { fromBlock: 120n, toBlock: 125n },
    ]);
  });

  it("returns no ranges for an empty interval", () => {
    expect(splitBlockRange(10n, 9n, 10n)).toEqual([]);
  });

  it("rejects a non-positive range size", () => {
    expect(() => splitBlockRange(1n, 2n, 0n)).toThrow("positive");
  });
});
