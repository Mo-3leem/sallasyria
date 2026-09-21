import { describe, expect, it } from "vitest";
import { normalizeEmail } from "../src/lib/email.js";

describe("normalizeEmail", () => {
  it("lowercases and trims to one canonical identity", () => {
    expect(normalizeEmail("Test@Example.com")).toBe("test@example.com");
    expect(normalizeEmail("  test@example.com  ")).toBe("test@example.com");
    expect(normalizeEmail("TEST@EXAMPLE.COM")).toBe("test@example.com");
    expect(normalizeEmail("\tTest@Example.COM\n")).toBe("test@example.com");
  });

  it("leaves the local part otherwise untouched", () => {
    // No provider-specific folding: dots and plus-tags are preserved so
    // distinct mailboxes never merge.
    expect(normalizeEmail("First.Last+tag@Example.com")).toBe("first.last+tag@example.com");
  });

  it("rejects empty, overlong, and non-string input with 400", async () => {
    for (const bad of ["", "   ", "x".repeat(250) + "@example.com"]) {
      let code = "";
      try {
        normalizeEmail(bad);
      } catch (err) {
        code = (err as { code?: string }).code ?? "";
      }
      expect(code).toBe("invalid_email");
    }
    let code = "";
    try {
      normalizeEmail(42 as unknown as string);
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    expect(code).toBe("invalid_email");
  });
});
