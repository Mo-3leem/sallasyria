import type { Context } from "hono";

// In-memory sliding-window limiter for login abuse control (roadmap B2).
// Scope note: Workers isolates do not share memory, so this bounds abuse
// per isolate, not globally. That is sufficient for login-throttling at MVP
// scale (attackers face N independent windows, each strict); a global
// limiter (KV/DO) is a documented later hardening, not a B2 requirement.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const hits = new Map<string, number[]>();

export function loginRateLimitKey(c: Context, phone: string): string {
  return `${clientIp(c)}:${phone}`;
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

// Test seam: reset one key (tests) — never exposed via HTTP.
export function resetLoginRateLimit(key: string): void {
  hits.delete(key);
}

export const LOGIN_RATE_LIMIT = { windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS } as const;
