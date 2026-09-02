import { describe, expect, it } from "vitest";
import { imageUpdateMessages } from "./router.js";

describe("imageUpdateMessages", () => {
  it("accepts legacy lowercase and canonical checksum signing payloads", () => {
    const token = "0xf0e29778bc974220a642d64ba7e07bec8dadc131";
    const messages = imageUpdateMessages(token, "https://example.com/miso.png", 1_788_363_004_507);

    expect(messages).toHaveLength(2);
    expect(messages).toContain(
      "RamenPad image update\nChain: 4663\nToken: 0xF0e29778BC974220a642D64bA7E07BeC8daDc131\nImage: https://example.com/miso.png\nTimestamp: 1788363004507",
    );
    expect(messages).toContain(
      "RamenPad image update\nChain: 4663\nToken: 0xf0e29778bc974220a642d64ba7e07bec8dadc131\nImage: https://example.com/miso.png\nTimestamp: 1788363004507",
    );
  });
});
