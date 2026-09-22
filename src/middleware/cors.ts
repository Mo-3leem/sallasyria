import { cors } from "hono/cors";
import type { Context } from "hono";
import type { AppEnv, Env } from "../env.js";

// Local Next.js dev origin. Allowed ONLY outside production and ONLY when no
// FRONTEND_URL is configured (explicit config always wins). Production with
// FRONTEND_URL unset sends no CORS headers at all — unchanged behavior.
const DEV_FRONTEND_ORIGIN = "http://localhost:3000";

// Origin normalization + matching rules (the silent-blocker fix):
// - Config values are trimmed and stripped of trailing slashes ONCE here,
//   so invisible whitespace or a pasted trailing slash in dashboards can
//   never silently break the exact match in production logins.
// - FRONTEND_URL accepts a comma-separated list: every entry is an allowed
//   origin (first = primary/canonical, rest = preview aliases).
// - Same-site preview subdomains are additionally accepted: an https
//   request whose host is dot-anchored under a configured host
//   (e.g. https://fix-x.sallasyria-7qx.pages.dev under
//   https://sallasyria-7qx.pages.dev). The leading-dot anchor is the whole
//   defense: suffix tricks like https://...pages.dev.evil.com do NOT end
//   with ".<configured-host>" and are rejected, as are http downgrades.
// - The request origin is normalized the same way before comparing
//   (browsers never send trailing slashes; this only forgives synthetic
//   or pasted variants). The echoed value is the normalized request
//   origin — never "*", which browsers reject alongside credentials.
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function allowedOrigins(env: Partial<Env>): string[] {
  const raw = env.FRONTEND_URL ?? "";
  return raw
    .split(",")
    .map(normalizeOrigin)
    .filter((o) => o.length > 0);
}

export function originAllowed(origin: string, allowed: string[]): boolean {
  const request = normalizeOrigin(origin);
  for (const entry of allowed) {
    if (request === entry) return true;
    try {
      const want = new URL(entry);
      const got = new URL(request);
      if (got.protocol !== "https:") continue;
      if (got.host.endsWith(`.${want.host}`)) return true;
    } catch {
      // Unparsable entry: exact match above already failed — reject.
    }
  }
  return false;
}

// Cookie-credentialed CORS for the frontend. The origin callback echoes back
// exactly one trusted origin (never "*": browsers reject wildcard + cookies).
// hono/cors short-circuits OPTIONS preflights with 204 before any route or
// auth middleware runs, and mirrors Access-Control-Request-Headers so JSON,
// X-Idempotency-Key, and Turnstile headers pass preflight without an
// explicit allow-list.
export function corsMw() {
  return cors({
    origin: (origin: string, c: Context<AppEnv>) => {
      // c.env is unpopulated when the app serves env-less requests
      // (unit tests calling app.request() without bindings) — treat as
      // development defaults instead of throwing.
      const env = (c.env ?? {}) as Partial<Env>;
      if (env.FRONTEND_URL && originAllowed(origin, allowedOrigins(env))) {
        return normalizeOrigin(origin);
      }
      if (
        (env.ENVIRONMENT ?? "development") !== "production" &&
        origin === DEV_FRONTEND_ORIGIN
      ) {
        return origin;
      }
      return null;
    },
    allowMethods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    maxAge: 86400,
  });
}
