import { cors } from "hono/cors";
import type { Context } from "hono";
import type { AppEnv, Env } from "../env.js";

// Local Next.js dev origin. Allowed ONLY outside production and ONLY when no
// FRONTEND_URL is configured (explicit config always wins). Production with
// FRONTEND_URL unset sends no CORS headers at all — unchanged behavior.
const DEV_FRONTEND_ORIGIN = "http://localhost:3000";

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
      if (env.FRONTEND_URL && origin === env.FRONTEND_URL) {
        return origin;
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
