import { describe, expect, it } from "vitest";
import { AppError } from "../src/http/errors.js";
import { retryTransient } from "../src/lib/retry.js";
import { canonicalJson, sha256Hex } from "../src/services/checkout.js";

describe("canonicalJson", () => {
  it("is stable across key order, whitespace, and undefined fields", () => {
    const a = { z: 1, a: { y: [1, 2], x: null }, m: undefined };
    const b = { a: { x: null, y: [1, 2] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,2]},"z":1}');
  });

  it("hashes deterministically to 64-hex", async () => {
    const h = await sha256Hex(canonicalJson({ b: 2, a: 1 }));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(canonicalJson({ a: 1, b: 2 }))).toBe(h);
    expect(await sha256Hex(canonicalJson({ a: 1, b: 3 }))).not.toBe(h);
  });
});

describe("retryTransient", () => {
  it("returns through after transient failures", async () => {
    let calls = 0;
    const out = await retryTransient(
      () => {
        calls++;
        if (calls < 3) throw new Error("SQLITE_BUSY: database is locked");
        return Promise.resolve("done");
      },
      { attempts: 3, baseMs: 1 }
    );
    expect(out).toBe("done");
    expect(calls).toBe(3);
  });

  it("exhausts then rethrows the last transient error", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        () => {
          calls++;
          throw new Error("D1_TIMEOUT: try again");
        },
        { attempts: 3, baseMs: 1 }
      )
    ).rejects.toThrow("D1_TIMEOUT");
    expect(calls).toBe(3);
  });

  it("never retries constraint or business errors", async () => {
    let calls = 0;
    await expect(
      retryTransient(() => {
        calls++;
        throw new Error("UNIQUE constraint failed: orders.id");
      })
    ).rejects.toThrow("UNIQUE");
    expect(calls).toBe(1);

    let appCalls = 0;
    await expect(
      retryTransient(() => {
        appCalls++;
        throw new AppError("product_unavailable", 409, "gone");
      })
    ).rejects.toMatchObject({ code: "product_unavailable" });
    expect(appCalls).toBe(1);
  });
});
