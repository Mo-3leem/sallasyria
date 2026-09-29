import type { Context } from "hono";

// In-memory sliding-window limiter for login abuse control (roadmap B2).
// Scope note: Workers isolates do not share memory, so this bounds abuse
// per isolate, not globally. That is sufficient for login-throttling at MVP
// scale (attackers face N independent windows, each strict); a global
// limiter (KV/DO) is a documented later hardening, not a B2 requirement.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const hits = new Map<string, number[]>();

// Identity-based keys use the CANONICAL identity (normalized email or
// normalized phone, see lib/email.ts and lib/phone.ts): without this,
// Test@Example.com / test@example.com (or 099... / +963... variants) would
// each get a fresh budget and brute force would walk straight through.
// Email and phone spellings of one account are separate buckets by design
// (same 10/10min budget each); the per-IP component still bounds attackers.
export function loginRateLimitKey(c: Context, identity: string): string {
  return `${clientIp(c)}:${identity}`;
}

// Generic sliding-window limiter factory for endpoint classes (roadmap B5).
// Same per-isolate caveat as the login limiter: strict locally, best-effort
// globally. Instances below document their class budgets.
export interface RateLimiter {
  check(key: string, nowMs?: number): boolean;
  reset(key: string): void;
}

export function createRateLimiter(opts: { maxAttempts: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(key: string, nowMs: number = Date.now()): boolean {
      const arr = hits.get(key) ?? [];
      const fresh = arr.filter((t) => nowMs - t < opts.windowMs);
      if (fresh.length >= opts.maxAttempts) {
        hits.set(key, fresh);
        return false;
      }
      fresh.push(nowMs);
      hits.set(key, fresh);
      return true;
    },
    reset(key: string): void {
      hits.delete(key);
    },
  };
}

// Public storefront mutations (buyer flows): generous but bounded —
// 60/min per client+store absorbs legitimate bursts, stops floods.
export const PUBLIC_MUTATION_LIMIT = { maxAttempts: 60, windowMs: 60_000 } as const;

const publicMutations = createRateLimiter({
  maxAttempts: PUBLIC_MUTATION_LIMIT.maxAttempts,
  windowMs: PUBLIC_MUTATION_LIMIT.windowMs,
});

export function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function checkPublicMutationLimit(c: Context, storeId: string): boolean {
  return publicMutations.check(`${clientIp(c)}:${storeId}`);
}

// Returns true when the attempt may proceed (and records it), false when the
// caller must answer 429. Counts ALL attempts per key (pass or fail) so
// guessing cannot stretch the window by mixing outcomes.
export function checkLoginRateLimit(key: string, nowMs: number = Date.now()): boolean {
  const arr = hits.get(key) ?? [];
  const fresh = arr.filter((t) => nowMs - t < WINDOW_MS);
  if (fresh.length >= MAX_ATTEMPTS) {
    hits.set(key, fresh);
    return false;
  }
  fresh.push(nowMs);
  hits.set(key, fresh);
  return true;
}

// Registration limiter: SEPARATE bucket from login (same window/threshold,
// own keyspace). Sharing one bucket let registration spam for a victim's
// identity consume that identity's login attempts and 429 the victim out.
// Key shape mirrors loginRateLimitKey with a static prefix so the two
// namespaces can never collide even for identical ip+identity pairs.
const registerHits = new Map<string, number[]>();

export function registerRateLimitKey(c: Context, email: string): string {
  return `register:${clientIp(c)}:${email}`;
}

export function checkRegisterRateLimit(key: string, nowMs: number = Date.now()): boolean {
  const arr = registerHits.get(key) ?? [];
  const fresh = arr.filter((t) => nowMs - t < WINDOW_MS);
  if (fresh.length >= MAX_ATTEMPTS) {
    registerHits.set(key, fresh);
    return false;
  }
  fresh.push(nowMs);
  registerHits.set(key, fresh);
  return true;
}

// Failed-login counter for brute-force escalation (roadmap B4). Separate
// namespace from the login bucket: this counts CONSECUTIVE wrong passwords
// per canonical identity (no IP component, so distributed guesses against
// one account accumulate), reset on any successful authentication. Unknown
// identities count identically, so the challenge reveals nothing about
// account existence. In-memory like the rest of this module; reaching the
// threshold only escalates to a Turnstile challenge — never a lockout.
export const LOGIN_FAIL_CHALLENGE_AFTER = 5;

const loginFailCounts = new Map<string, number>();

export function loginFailKey(identity: string): string {
  return `login-fail:${identity}`;
}

export function loginFailCount(key: string): number {
  return loginFailCounts.get(key) ?? 0;
}

export function recordLoginFailure(key: string): void {
  loginFailCounts.set(key, loginFailCount(key) + 1);
}

export function resetLoginFailures(key: string): void {
  loginFailCounts.delete(key);
}

// Test seam: reset one key (tests) — never exposed via HTTP.
export function resetLoginRateLimit(key: string): void {
  hits.delete(key);
}

// Public resend-verification buckets (roadmap B6): separate namespaces from
// the login bucket so resend floods can never 429 victims' logins (same
// reason the register bucket is split). BOTH buckets gate every public
// attempt, counted pass-or-fail:
//   - IP bucket (10/10min, existing helper): bounds single-source floods.
//   - Account bucket (5/hour, keyed by SHA-256 of the normalized email):
//     bounds targeted mail-bombing of one address across rotated IPs.
// The raw email is never a key and never logged; only its hash is stored.
const resendPubAccount = createRateLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000 });

export function checkResendPubAccountLimit(accountHash: string): boolean {
  return resendPubAccount.check(`resend-pub:acct:${accountHash}`);
}

// Test seam (mirrors the login/register seams; never exposed via HTTP).
export function resetResendPubAccountLimit(accountHash: string): void {
  resendPubAccount.reset(`resend-pub:acct:${accountHash}`);
}

// Test seam for the registration bucket (mirrors the login seam).
export function resetRegisterRateLimit(key: string): void {
  registerHits.delete(key);
}

export const LOGIN_RATE_LIMIT = { windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS } as const;
