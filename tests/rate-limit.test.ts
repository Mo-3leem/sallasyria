import { describe, expect, it } from "vitest";
import {
  checkLoginRateLimit,
  checkRegisterRateLimit,
  checkResendPubAccountLimit,
  loginFailCount,
  loginFailKey,
  LOGIN_FAIL_CHALLENGE_AFTER,
  loginRateLimitKey,
  LOGIN_RATE_LIMIT,
  recordLoginFailure,
  registerRateLimitKey,
  resetLoginFailures,
  resetLoginRateLimit,
  resetRegisterRateLimit,
  resetResendPubAccountLimit,
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

describe("public resend account limiting", () => {
  it("allows five per hour per address hash, then blocks", () => {
    const hash = `test-resend-acct-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkResendPubAccountLimit(hash)).toBe(true);
    }
    expect(checkResendPubAccountLimit(hash)).toBe(false);
  });

  it("isolates address hashes and supports explicit reset", () => {
    const a = `test-resend-iso-a-${Date.now()}`;
    const b = `test-resend-iso-b-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      checkResendPubAccountLimit(a);
    }
    expect(checkResendPubAccountLimit(a)).toBe(false);
    expect(checkResendPubAccountLimit(b)).toBe(true);
    resetResendPubAccountLimit(a);
    expect(checkResendPubAccountLimit(a)).toBe(true);
  });
});

describe("login failure counter (brute-force escalation)", () => {
  it("starts at zero and thresholds at five", () => {
    expect(LOGIN_FAIL_CHALLENGE_AFTER).toBe(5);
    const key = loginFailKey(`counter-user-${Date.now()}@example.com`);
    expect(loginFailCount(key)).toBe(0);
  });

  it("increments per failure and resets on success", () => {
    const key = loginFailKey(`counter-reset-${Date.now()}@example.com`);
    recordLoginFailure(key);
    recordLoginFailure(key);
    expect(loginFailCount(key)).toBe(2);
    resetLoginFailures(key);
    expect(loginFailCount(key)).toBe(0);
  });

  it("isolates identities and never touches the login bucket", () => {
    const stamp = Date.now();
    const a = loginFailKey(`counter-iso-a-${stamp}@example.com`);
    const b = loginFailKey(`counter-iso-b-${stamp}@example.com`);
    for (let i = 0; i < LOGIN_FAIL_CHALLENGE_AFTER; i++) {
      recordLoginFailure(a);
    }
    expect(loginFailCount(a)).toBe(LOGIN_FAIL_CHALLENGE_AFTER);
    expect(loginFailCount(b)).toBe(0);
    // Same identity string in the login bucket is a different namespace.
    expect(checkLoginRateLimit(`login:127.0.0.1:counter-iso-a-${stamp}@example.com`, 4_000_000)).toBe(true);
    resetLoginFailures(a);
    expect(loginFailCount(a)).toBe(0);
  });
});
