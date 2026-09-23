import type { Context, Next } from "hono";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";

// Turnstile enforcement point for public mutations (roadmap B5).
// Design (explicit, no magic):
// - Token arrives in the X-Turnstile-Token header (never the body: keeps
//   validation schemas clean and the token out of logged payloads).
// - Verified server-side against Cloudflare siteverify with TURNSTILE_SECRET.
// - Secret absent + development env = documented dev bypass (local tests,
//   wrangler dev). Secret absent anywhere else = 503 fail-closed, never
//   fail-open: shipping a public mutation without bot defense by accident
//   must be loud, not silent.
// - fetchImpl is injectable so tests prove both verdicts without network.
export const TURNSTILE_HEADER = "X-Turnstile-Token";

export interface TurnstileVerdict {
  ok: boolean;
  codes: string[];
  hostname: string | null;
  challengeTs: string | null;
}

export async function verifyTurnstileToken(
  secret: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<TurnstileVerdict> {
  const failure = (codes: string[]): TurnstileVerdict => ({
    ok: false,
    codes,
    hostname: null,
    challengeTs: null,
  });
  try {
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
    });
    const data = (await res.json()) as {
      success?: boolean;
      "error-codes"?: unknown;
      hostname?: unknown;
      challenge_ts?: unknown;
    };
    if (data.success === true) {
      return { ok: true, codes: [], hostname: null, challengeTs: null };
    }
    const raw = Array.isArray(data["error-codes"]) ? data["error-codes"] : [];
    return {
      ok: false,
      codes: raw.filter((c): c is string => typeof c === "string"),
      hostname: typeof data.hostname === "string" ? data.hostname : null,
      challengeTs: typeof data.challenge_ts === "string" ? data.challenge_ts : null,
    };
  } catch {
    return failure(["verify_transport_error"]);
  }
}

// Token-age bucket over the siteverify challenge_ts echo (solve time).
// Opaque tokens carry no age themselves; this derives it without touching
// the token, the secret, or any identity. Buckets only, never timestamps.
export function tokenAgeBucket(challengeTs: string | null, nowMs: number = Date.now()): string {
  if (!challengeTs) return "unknown";
  const solved = Date.parse(challengeTs);
  if (Number.isNaN(solved)) return "unknown";
  const age = nowMs - solved;
  if (age < 0) return "future-clock-skew";
  if (age < 60_000) return "fresh-lt-60s";
  if (age < 300_000) return "aging-60s-300s";
  return "stale-gt-300s";
}

export function requireTurnstile(fetchImpl: typeof fetch = fetch) {
  return async (c: Context<AppEnv>, next: Next): Promise<void> => {
    const secret = c.env.TURNSTILE_SECRET;
    if (!secret) {
      if ((c.env.ENVIRONMENT ?? "development") === "development") {
        await next();
        return;
      }
      throw new AppError(
        "turnstile_misconfigured",
        503,
        "Bot verification is not configured."
      );
    }
    const token = c.req.header(TURNSTILE_HEADER);
    if (!token) {
      throw new AppError("turnstile_required", 400, "Bot verification token is required.");
    }
    // Fail fast on absurd input without calling siteverify: real tokens are
    // short opaque strings; an oversized value can only be a mistake or a
    // probe. Same 403 as a failed verification (no new oracle: length alone
    // reveals nothing about secrets or widget state).
    if (token.length > 2048) {
      throw new AppError("turnstile_failed", 403, "Bot verification failed.");
    }
    const verdict = await verifyTurnstileToken(secret, token, fetchImpl);
    if (!verdict.ok) {
      // TEMPORARY-DEBUG — REMOVE SAME DAY (buyer-Turnstile end-to-end hunt).
      // Logs the siteverify failure signature ONLY: error codes, responder
      // hostname echo, token-age bucket. NEVER token/secret/key values,
      // NEVER identity: the three fields below are the complete allow-list,
      // do not extend this object. Follow-up commit removes this block and
      // keeps a code-only counter.
      try {
        console.warn("[turnstile-debug] siteverify rejected", {
          codes: verdict.codes,
          hostname: verdict.hostname,
          token_age_bucket: tokenAgeBucket(verdict.challengeTs),
        });
      } catch {
        // Logging must never break authentication.
      }
      throw new AppError("turnstile_failed", 403, "Bot verification failed.");
    }
    await next();
  };
}
