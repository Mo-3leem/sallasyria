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

// Consecutive-failure threshold for Turnstile escalation (roadmap B4).
// The counting itself moved to the persistent D1 throttle
// (src/services/login-throttle.ts); this constant stays here because the
// login flow's challenge gate reads it from the rate-limit module.
export const LOGIN_FAIL_CHALLENGE_AFTER = 5;

export function loginFailKey(identity: string): string {
  return `login-fail:${identity}`;
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

// Buyer forgot-password target throttle (roadmap B3): same recovery-mail
// class as public resend (5/hour per target) — repeated reset mail to one
// address or phone is capped even across rotated IPs. Keyed by SHA-256 of
// the canonical target (trimmed + lowercased, mirroring lookup); the raw
// target is never a key and never logged.
const forgotTarget = createRateLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000 });

export function checkForgotTargetLimit(targetHash: string): boolean {
  return forgotTarget.check(`forgot-target:${targetHash}`);
}

// Billing webhook flood guard (roadmap B3): generous per-IP bucket —
// providers legitimately retry in bursts, so only abuse floods trip it
// (120/min sustained). HMAC verification stays the real boundary and
// idempotent settle makes replays converge; this just bounds junk traffic.
const webhookIp = createRateLimiter({ maxAttempts: 120, windowMs: 60_000 });

export function checkWebhookIpLimit(ip: string): boolean {
  return webhookIp.check(`webhook:${ip}`);
}

// Test seam (mirrors the login/register seams; never exposed via HTTP).
export function resetResendPubAccountLimit(accountHash: string): void {
  resendPubAccount.reset(`resend-pub:acct:${accountHash}`);
}

// B7a abuse-surface guards (roadmap B7a): generous per-IP buckets for
// expensive public reads that previously had no limiter at all. Each has a
// distinct namespace so unrelated surfaces never share quota:
//   - public-file (120/min): R2 egress on both bearer-URL file routes
//     (product images + avatars). Galleries burst dozens of images per page
//     load, so the budget mirrors the webhook flood guard's generosity.
//   - preview (60/min): token-gated preview fan-out (1 token lookup + 4
//     parallel catalog queries per hit).
//   - docs (60/min): OpenAPI document regenerated from route definitions on
//     every /doc hit.
// Static/cheap surfaces stay unthrottled on purpose: /health (load-balancer
// probing must never 429), /ready (single SELECT 1), /ui (static string),
// single-row catalog/shipping/plan reads.
const publicFile = createRateLimiter({ maxAttempts: 120, windowMs: 60_000 });
const previewHits = createRateLimiter({ maxAttempts: 60, windowMs: 60_000 });
const docsHits = createRateLimiter({ maxAttempts: 60, windowMs: 60_000 });

export function checkPublicFileLimit(ip: string): boolean {
  return publicFile.check(`public-file:${ip}`);
}

export function checkPreviewLimit(ip: string): boolean {
  return previewHits.check(`preview:${ip}`);
}

export function checkDocsLimit(ip: string): boolean {
  return docsHits.check(`docs:${ip}`);
}

// Test seams (mirrors the existing seams; never exposed via HTTP).
export function resetPublicFileLimit(ip: string): void {
  publicFile.reset(`public-file:${ip}`);
}

export function resetPreviewLimit(ip: string): void {
  previewHits.reset(`preview:${ip}`);
}

export function resetDocsLimit(ip: string): void {
  docsHits.reset(`docs:${ip}`);
}

// B7b authenticated-mutation guards (roadmap B7b): per-actor buckets for
// expensive authenticated writes that previously had no limiter at all.
// Unlike the B7a per-IP buckets, these key on the resource owner (user or
// store id), because the scarce resource here is identity, not source IP:
// NAT-shared offices must not cross-throttle, and attackers rotate IPs
// freely. Each has a distinct namespace so operations never share quota:
//   - pw-change (10/10min per user): 2x scrypt + session-revoke batch.
//   - email-change (5/hour per user): 2 mails + token churn per change.
//   - billing-intent (10/hour per store): external provider call + row.
//   - upload-product (60/hour per store): 5MB buffer + sanitize + R2 PUT.
//   - upload-avatar (20/hour per user): same cost class, own slot.
const pwChange = createRateLimiter({ maxAttempts: 10, windowMs: 10 * 60_000 });
const emailChange = createRateLimiter({ maxAttempts: 5, windowMs: 60 * 60_000 });
const billingIntent = createRateLimiter({ maxAttempts: 10, windowMs: 60 * 60_000 });
const uploadProduct = createRateLimiter({ maxAttempts: 60, windowMs: 60 * 60_000 });
const uploadAvatar = createRateLimiter({ maxAttempts: 20, windowMs: 60 * 60_000 });
// B10 destructive-operation guards (roadmap B10): per-user buckets for
// merchant self-delete (account removal) and merchant store deletion
// (hard delete with cascades). Generous enough for legitimate retries,
// strict enough to bound hammering of irreversible operations.
const selfDelete = createRateLimiter({ maxAttempts: 5, windowMs: 60 * 60_000 });
const storeDelete = createRateLimiter({ maxAttempts: 10, windowMs: 60 * 60_000 });
// Store-status guard (roadmap B10): per-user bucket for lifecycle writes
// (POST :storeId/status and status-bearing PATCH). Status is reversible,
// so the budget is generous — 30/hour leaves room for legitimate retries
// and UI double-submits — while still bounding audit-spam and
// storefront-flap loops. Reads are never limited.
const statusChange = createRateLimiter({ maxAttempts: 30, windowMs: 60 * 60_000 });

export function checkPwChangeLimit(userId: string, nowMs?: number): boolean {
  return pwChange.check(`pw-change:${userId}`, nowMs);
}

export function checkEmailChangeLimit(userId: string, nowMs?: number): boolean {
  return emailChange.check(`email-change:${userId}`, nowMs);
}

export function checkBillingIntentLimit(storeId: string, nowMs?: number): boolean {
  return billingIntent.check(`billing-intent:${storeId}`, nowMs);
}

export function checkUploadProductLimit(storeId: string, nowMs?: number): boolean {
  return uploadProduct.check(`upload-product:${storeId}`, nowMs);
}

export function checkUploadAvatarLimit(userId: string, nowMs?: number): boolean {
  return uploadAvatar.check(`upload-avatar:${userId}`, nowMs);
}

// Test seams (mirrors the existing seams; never exposed via HTTP).
export function resetPwChangeLimit(userId: string): void {
  pwChange.reset(`pw-change:${userId}`);
}

export function resetEmailChangeLimit(userId: string): void {
  emailChange.reset(`email-change:${userId}`);
}

export function resetBillingIntentLimit(storeId: string): void {
  billingIntent.reset(`billing-intent:${storeId}`);
}

export function resetUploadProductLimit(storeId: string): void {
  uploadProduct.reset(`upload-product:${storeId}`);
}

export function resetUploadAvatarLimit(userId: string): void {
  uploadAvatar.reset(`upload-avatar:${userId}`);
}

export function checkSelfDeleteLimit(userId: string, nowMs?: number): boolean {
  return selfDelete.check(`self-delete:${userId}`, nowMs);
}

export function checkStoreDeleteLimit(userId: string, nowMs?: number): boolean {
  return storeDelete.check(`store-delete:${userId}`, nowMs);
}

export function checkStatusChangeLimit(userId: string, nowMs?: number): boolean {
  return statusChange.check(`status-change:${userId}`, nowMs);
}

// Test seams (mirrors the existing seams; never exposed via HTTP).
export function resetSelfDeleteLimit(userId: string): void {
  selfDelete.reset(`self-delete:${userId}`);
}

export function resetStoreDeleteLimit(userId: string): void {
  storeDelete.reset(`store-delete:${userId}`);
}

// Test seams (mirrors the existing seams; never exposed via HTTP).
export function resetStatusChangeLimit(userId: string): void {
  statusChange.reset(`status-change:${userId}`);
}

// Test seam for the registration bucket (mirrors the login seam).
export function resetRegisterRateLimit(key: string): void {
  registerHits.delete(key);
}

export const LOGIN_RATE_LIMIT = { windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS } as const;
