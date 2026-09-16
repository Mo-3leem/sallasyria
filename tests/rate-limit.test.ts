import { describe, expect, it } from "vitest";
import {
  checkLoginRateLimit,
  LOGIN_RATE_LIMIT,
  resetLoginRateLimit,
} from "../src/lib/rate-limit.js";

describe("login rate limiting", () => {
  it("allows up to the cap, then blocks", () => {
    const key = `test-cap-${Date.now()}`;
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      expect(checkLoginRateLimit(key, 1_000_000)).toBe(true);
    }
    expect(checkLoginRateLimit(key, 1_000_000)).toBe(false);
  });

  it("resets after the window passes", () => {
    const key = `test-window-${Date.now()}`;
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      checkLoginRateLimit(key, 1_000_000);
    }
    expect(checkLoginRateLimit(key, 1_000_000)).toBe(false);
    expect(checkLoginRateLimit(key, 1_000_000 + LOGIN_RATE_LIMIT.windowMs + 1)).toBe(true);
  });

  it("isolates keys and supports explicit reset", () => {
    const a = `test-iso-a-${Date.now()}`;
    const b = `test-iso-b-${Date.now()}`;
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      checkLoginRateLimit(a, 2_000_000);
    }
    expect(checkLoginRateLimit(a, 2_000_000)).toBe(false);
    expect(checkLoginRateLimit(b, 2_000_000)).toBe(true);
    resetLoginRateLimit(a);
    expect(checkLoginRateLimit(a, 2_000_000)).toBe(true);
  });
});
