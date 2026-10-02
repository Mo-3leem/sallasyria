import { describe, expect, it } from "vitest";
import {
  checkBillingIntentLimit,
  checkDocsLimit,
  checkEmailChangeLimit,
  checkForgotTargetLimit,
  checkLoginRateLimit,
  checkPreviewLimit,
  checkPublicFileLimit,
  checkPwChangeLimit,
  checkRegisterRateLimit,
  checkResendPubAccountLimit,
  checkSelfDeleteLimit,
  checkStatusChangeLimit,
  checkStoreDeleteLimit,
  checkUploadAvatarLimit,
  checkUploadProductLimit,
  checkWebhookIpLimit,
  loginFailKey,
  LOGIN_FAIL_CHALLENGE_AFTER,
  loginRateLimitKey,
  LOGIN_RATE_LIMIT,
  registerRateLimitKey,
  resetBillingIntentLimit,
  resetDocsLimit,
  resetEmailChangeLimit,
  resetLoginRateLimit,
  resetPreviewLimit,
  resetPublicFileLimit,
  resetPwChangeLimit,
  resetRegisterRateLimit,
  resetResendPubAccountLimit,
  resetSelfDeleteLimit,
  resetStatusChangeLimit,
  resetStoreDeleteLimit,
  resetUploadAvatarLimit,
  resetUploadProductLimit,
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

describe("login failure key and challenge threshold (brute-force escalation)", () => {
  it("threshold is five and keys stay namespaced per identity", () => {
    expect(LOGIN_FAIL_CHALLENGE_AFTER).toBe(5);
    // Key format is stable: the persistent throttle (login-throttle
    // service) and any log readers share this exact namespace.
    expect(loginFailKey("user@example.com")).toBe("login-fail:user@example.com");
    expect(loginFailKey("invalid-phone")).toBe("login-fail:invalid-phone");
  });

  it("isolates identities and never touches the login bucket", () => {
    const stamp = Date.now();
    const a = loginFailKey(`counter-iso-a-${stamp}@example.com`);
    const b = loginFailKey(`counter-iso-b-${stamp}@example.com`);
    expect(a).not.toBe(b);
    // Same identity string in the login bucket is a different namespace.
    expect(checkLoginRateLimit(`login:127.0.0.1:counter-iso-a-${stamp}@example.com`, 4_000_000)).toBe(true);
  });
});

describe("buyer forgot-password target limiting", () => {
  it("allows five per hour per target hash, then blocks", () => {
    const hash = `test-forgot-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkForgotTargetLimit(hash)).toBe(true);
    }
    expect(checkForgotTargetLimit(hash)).toBe(false);
  });

  it("isolates target hashes from each other and the login bucket", () => {
    const stamp = Date.now();
    const a = `test-forgot-iso-a-${stamp}`;
    const b = `test-forgot-iso-b-${stamp}`;
    for (let i = 0; i < 5; i++) {
      checkForgotTargetLimit(a);
    }
    expect(checkForgotTargetLimit(a)).toBe(false);
    expect(checkForgotTargetLimit(b)).toBe(true);
    expect(checkLoginRateLimit(`login:127.0.0.1:${a}`, 5_000_000)).toBe(true);
  });
});

describe("billing webhook IP limiting", () => {
  it("is generous: over a hundred rapid calls pass before any 429", () => {
    const ip = `203.0.113.9-${Date.now()}`;
    let allowed = 0;
    let tripped = false;
    for (let i = 0; i < 200 && !tripped; i++) {
      if (checkWebhookIpLimit(ip)) allowed++;
      else tripped = true;
    }
    // Generosity bound: legitimate retry bursts (tens of calls) never trip.
    expect(tripped).toBe(true);
    expect(allowed).toBeGreaterThanOrEqual(100);
  });

  it("trips eventually and isolates IPs", () => {
    const stamp = Date.now();
    const hot = `198.51.100.7-${stamp}`;
    for (let i = 0; i < 120; i++) {
      checkWebhookIpLimit(hot);
    }
    expect(checkWebhookIpLimit(hot)).toBe(false);
    expect(checkWebhookIpLimit(`192.0.2.44-${stamp}`)).toBe(true);
  });
});

describe("B7a public-surface limiting", () => {
  it("trips each bucket at its own cap, resets, and isolates namespaces", () => {
    const stamp = Date.now();
    const fileIp = `203.0.113.50-${stamp}`;
    const previewIp = `203.0.113.51-${stamp}`;
    const docsIp = `203.0.113.52-${stamp}`;
    for (let i = 0; i < 120; i++) {
      expect(checkPublicFileLimit(fileIp)).toBe(true);
    }
    expect(checkPublicFileLimit(fileIp)).toBe(false);
    for (let i = 0; i < 60; i++) {
      expect(checkPreviewLimit(previewIp)).toBe(true);
      expect(checkDocsLimit(docsIp)).toBe(true);
    }
    expect(checkPreviewLimit(previewIp)).toBe(false);
    expect(checkDocsLimit(docsIp)).toBe(false);
    // Distinct namespaces never share quota, and seams reopen them.
    expect(checkPublicFileLimit(previewIp)).toBe(true);
    resetPublicFileLimit(fileIp);
    resetPreviewLimit(previewIp);
    resetDocsLimit(docsIp);
    expect(checkPublicFileLimit(fileIp)).toBe(true);
    expect(checkPreviewLimit(previewIp)).toBe(true);
    expect(checkDocsLimit(docsIp)).toBe(true);
  });
});

describe("B7b authenticated-mutation limiting", () => {
  // Each bucket: exact cap trips, window expiry reopens (deterministic
  // nowMs), sibling keys/buckets stay isolated, reset seam reopens.
  // Unique TEST- keys so parallel suites never share a bucket.
  const buckets = [
    {
      name: "pw-change",
      cap: 10,
      windowMs: 10 * 60_000,
      check: checkPwChangeLimit,
      reset: resetPwChangeLimit,
    },
    {
      name: "email-change",
      cap: 5,
      windowMs: 60 * 60_000,
      check: checkEmailChangeLimit,
      reset: resetEmailChangeLimit,
    },
    {
      name: "billing-intent",
      cap: 10,
      windowMs: 60 * 60_000,
      check: checkBillingIntentLimit,
      reset: resetBillingIntentLimit,
    },
    {
      name: "upload-product",
      cap: 60,
      windowMs: 60 * 60_000,
      check: checkUploadProductLimit,
      reset: resetUploadProductLimit,
    },
    {
      name: "upload-avatar",
      cap: 20,
      windowMs: 60 * 60_000,
      check: checkUploadAvatarLimit,
      reset: resetUploadAvatarLimit,
    },
    {
      name: "self-delete",
      cap: 5,
      windowMs: 60 * 60_000,
      check: checkSelfDeleteLimit,
      reset: resetSelfDeleteLimit,
    },
    {
      name: "store-delete",
      cap: 10,
      windowMs: 60 * 60_000,
      check: checkStoreDeleteLimit,
      reset: resetStoreDeleteLimit,
    },
    {
      name: "status-change",
      cap: 30,
      windowMs: 60 * 60_000,
      check: checkStatusChangeLimit,
      reset: resetStatusChangeLimit,
    },
  ] as const;

  for (const b of buckets) {
    it(`${b.name} trips at cap, expires by window, isolates, resets`, () => {
      const stamp = Date.now();
      const key = `TEST-${b.name}-${stamp}`;
      const other = `TEST-${b.name}-other-${stamp}`;
      // Exactly at limit: all succeed.
      for (let i = 0; i < b.cap; i++) {
        expect(b.check(key)).toBe(true);
      }
      // Limit + 1: rejected.
      expect(b.check(key)).toBe(false);
      // A different key is unaffected.
      expect(b.check(other)).toBe(true);
      // Window expiry reopens deterministically (no sleeping).
      const t0 = Date.now();
      const expKey = `TEST-${b.name}-exp-${stamp}`;
      for (let i = 0; i < b.cap; i++) {
        expect(b.check(expKey, t0)).toBe(true);
      }
      expect(b.check(expKey, t0)).toBe(false);
      expect(b.check(expKey, t0 + b.windowMs + 1)).toBe(true);
      // Reset seam reopens the tripped bucket.
      b.reset(key);
      expect(b.check(key)).toBe(true);
      b.reset(other);
      b.reset(expKey);
    });
  }

  it("B7b buckets never share quota with each other", () => {
    const stamp = Date.now();
    const shared = `TEST-shared-${stamp}`;
    for (let i = 0; i < 10; i++) {
      expect(checkPwChangeLimit(shared)).toBe(true);
      expect(checkBillingIntentLimit(shared)).toBe(true);
    }
    expect(checkPwChangeLimit(shared)).toBe(false);
    expect(checkBillingIntentLimit(shared)).toBe(false);
    // Exhausted pw-change says nothing about the other B7b buckets.
    expect(checkEmailChangeLimit(shared)).toBe(true);
    expect(checkUploadProductLimit(shared)).toBe(true);
    expect(checkUploadAvatarLimit(shared)).toBe(true);
    resetPwChangeLimit(shared);
    resetBillingIntentLimit(shared);
    resetEmailChangeLimit(shared);
    resetUploadProductLimit(shared);
    resetUploadAvatarLimit(shared);
  });
});
