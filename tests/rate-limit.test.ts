import { describe, expect, it } from "vitest";
import {
  checkLoginRateLimit,
  checkRegisterRateLimit,
  loginRateLimitKey,
  LOGIN_RATE_LIMIT,
  registerRateLimitKey,
  resetLoginRateLimit,
  resetRegisterRateLimit,
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

  it("register and login buckets never share attempts", () => {
    const stamp = Date.now();
    const fakeCtx = (ip: string) =>
      ({ req: { header: (n: string) => (n === "cf-connecting-ip" ? ip : null) } }) as Parameters<
        typeof registerRateLimitKey
      >[0];
    const email = `rl-${String(stamp).slice(-6)}@example.com`;
    const regKey = registerRateLimitKey(fakeCtx("10.9.9.9"), email);
    const loginKey = loginRateLimitKey(fakeCtx("10.9.9.9"), email);
    expect(regKey).not.toBe(loginKey);
    // Exhaust registration: login for the same ip+email stays allowed.
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      expect(checkRegisterRateLimit(regKey, 3_000_000)).toBe(true);
    }
    expect(checkRegisterRateLimit(regKey, 3_000_000)).toBe(false);
    expect(checkLoginRateLimit(loginKey, 3_000_000)).toBe(true);
    // And the reverse: exhausted login leaves registration open.
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      checkLoginRateLimit(loginKey, 3_000_001);
    }
    expect(checkLoginRateLimit(loginKey, 3_000_001)).toBe(false);
    expect(checkRegisterRateLimit(`other-${stamp}`, 3_000_001)).toBe(true);
    resetRegisterRateLimit(regKey);
    expect(checkRegisterRateLimit(regKey, 3_000_000)).toBe(true);
  });
});
