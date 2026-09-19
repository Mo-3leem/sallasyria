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

export async function verifyTurnstileToken(
  secret: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
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
    const ok = await verifyTurnstileToken(secret, token, fetchImpl);
    if (!ok) {
      throw new AppError("turnstile_failed", 403, "Bot verification failed.");
    }
    await next();
  };
}
