import { describe, expect, it } from "vitest";
import { isUuidv7, uuidv7 } from "../src/lib/ids.js";

describe("uuidv7", () => {
  it("produces valid v7 ids", () => {
    expect(isUuidv7(uuidv7())).toBe(true);
  });

  it("embeds version nibble 7 and RFC variant bits", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
  });

  it("embeds the provided timestamp (sortable by creation time)", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it("does not collide in practice", () => {
    const seen = new Set(Array.from({ length: 500 }, () => uuidv7()));
    expect(seen.size).toBe(500);
  });

  it("rejects non-v7 strings", () => {
    expect(isUuidv7("not-an-id")).toBe(false);
    expect(isUuidv7("")).toBe(false);
    // v4-shaped (version nibble 4) must not pass as v7
    expect(isUuidv7("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });
});
