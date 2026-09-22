import type { Context, Next } from "hono";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";
import { allowedOrigins, normalizeOrigin, originAllowed } from "./cors.js";

// Cross-site request forgery gate (companion to SameSite=None sessions).
//
// Why this exists: with SameSite=Lax the browser itself refused to send
// the session cookie on cross-site requests, which made CSRF impossible
// for cookie-authed mutations. SameSite=None (required for the split
// pages.dev -> workers.dev deployment) removes that implicit shield, so
// every state-changing request must now prove a trustworthy origin.
//
// Rule (mirrors the industry-standard "verify Origin when present"):
// - Safe methods (GET/HEAD/OPTIONS) and non-mutating traffic: untouched.
// - Mutating methods (POST/PATCH/PUT/DELETE) with an Origin header: its
//   host must equal the request host (same-origin callers, including the
//   documented /api/* same-origin deployment) or match the configured
//   frontend origins (same allow-list + preview-subdomain logic as CORS).
// - No Origin but a Referer header: the Referer's host is checked the
//   same way (covers form posts that strip Origin).
// - Neither header: allowed (curl, tests, mobile apps, and privacy modes
//   send none; CSRF vectors — form posts, fetch, navigation — always send
//   at least one in modern browsers, so attackers cannot hide here).
// Anything else is 403 csrf_origin_rejected: identical shape for every
// rejection (no oracle distinguishing missing config from forgery).
//
// Mount AFTER the CORS middleware: preflights (OPTIONS) are answered there
// and must never be origin-gated; actual credentialed calls arrive after.

const DEV_FRONTEND_ORIGIN = "http://localhost:3000";

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

// Referer carries a path (/app, /form) while Origin never does. Matching
// must run on origin-form (scheme + host) or every Referer check fails
// closed even for the configured frontend.
function originForm(value: string): string | null {
  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function isTrustedMutationOrigin(
  c: Context<AppEnv>,
  method: string
): boolean {
  if (!MUTATING.has(method.toUpperCase())) return true;
  const env = (c.env ?? {}) as AppEnv["Bindings"];
  let requestHost: string | null = null;
  try {
    requestHost = new URL(c.req.url).hostname.toLowerCase();
  } catch {
    return true; // Unparseable URL: fail open here; routing/auth still apply.
  }
  const origin = normalizeOrigin(c.req.header("Origin") ?? "");
  const referer = c.req.header("Referer") ?? "";
  // Same-origin callers (documented /api/* deployment + direct API use).
  if (origin !== "") {
    const host = hostOf(origin);
    if (host !== null && host === requestHost) return true;
  } else if (referer !== "") {
    const host = hostOf(referer);
    if (host !== null && host === requestHost) return true;
  } else {
    return true; // No origin signal at all: non-browser caller.
  }
  // Split deployment: configured frontend origins (exact, list, and
  // same-site preview subdomains — shared logic with the CORS layer).
  const probe = origin !== "" ? origin : originForm(referer) ?? "";
  if (probe !== "" && originAllowed(probe, allowedOrigins(env))) return true;
  // Dev fallback mirrors the CORS layer exactly.
  if (
    (env.ENVIRONMENT ?? "development") !== "production" &&
    normalizeOrigin(probe) === DEV_FRONTEND_ORIGIN
  ) {
    return true;
  }
  return false;
}

export async function csrfMw(c: Context<AppEnv>, next: Next): Promise<void> {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }
  if (!isTrustedMutationOrigin(c, c.req.method)) {
    throw new AppError(
      "csrf_origin_rejected",
      403,
      "Cross-origin request rejected."
    );
  }
  await next();
}
