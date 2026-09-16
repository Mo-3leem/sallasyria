import { describe, expect, it } from "vitest";
import {
  dummyHash,
  hashPassword,
  verifyPassword,
} from "../src/lib/password.js";

describe("password hashing", () => {
  it("round-trips a correct password", () => {
    expect(verifyPassword("Correct-Horse-9x!", hashPassword("Correct-Horse-9x!"))).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("wrong-password", hashPassword("Correct-Horse-9x!"))).toBe(false);
  });

  it("uses unique salts (same password hashes differently)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("emits the versioned s1 format", () => {
    const parts = hashPassword("x1!").split("$");
    expect(parts[0]).toBe("s1");
    expect(parts).toHaveLength(6);
  });

  it("fail-closes on malformed/foreign hashes", () => {
    for (const bad of [
      "",
      "not-a-hash",
      "s1$1$2",
      "s9$16384$8$1$abcd$efgh",
      "s1$nope$8$1$abcd$efgh",
      "plaintext-password",
    ]) {
      expect(verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("rejects empty and oversize passwords without hashing", () => {
    const stored = hashPassword("ok-password-1");
    expect(verifyPassword("", stored)).toBe(false);
    expect(verifyPassword("x".repeat(257), stored)).toBe(false);
  });

  it("dummy hash is well-formed but matches nothing useful", () => {
    const d = dummyHash();
    expect(d.startsWith("s1$")).toBe(true);
    expect(verifyPassword("whatever", d)).toBe(false);
    expect(dummyHash()).toBe(d); // stable per isolate
  });
});
