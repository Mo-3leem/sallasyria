import type { Context, Next } from "hono";
import type { AppEnv, Env } from "../env.js";

// Global security response headers (roadmap B8). Deliberately narrow:
// values that are safe for every API surface, with path-scoped carve-outs
// only where a global value would break a legitimate flow. No CSP here —
// deferred (Next.js hydration inlines, Turnstile, Google Fonts, Font
// Awesome/jsdelivr, and the /ui inline Swagger script all need their own
// verification first).
//
// Lifecycle: headers are applied AFTER `await next()`, so normal responses,
// notFound, and onError responses are all covered — Hono invokes onError
// inside the dispatch below each middleware frame, so post-next code still
// runs for errors (locked by tests/security-headers.test.ts, including a
// forced-500 case).
const GLOBAL_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Frame-Options", "DENY"],
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  ],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
];

// Production-only HSTS. Deliberately WITHOUT includeSubDomains (unverified
// custom-domain footprint) and WITHOUT preload (irreversible, needs a
// domain-owner process). Never emitted outside production: local `wrangler
// dev` serves plain http, where HSTS would brick or warn.
const HSTS_VALUE = "max-age=31536000";

// Bearer-URL file routes serve cross-origin <img> bytes: CORP same-origin
// would break every storefront gallery, so these two routes get
// `cross-origin` instead. Segment match (not prefix): only the file-serving
// routes contain these segments. Their existing `Cache-Control: private`
// set by the handlers is preserved untouched.
function isPublicFileRoute(pathname: string): boolean {
  return (
    pathname.includes("/product-images/file/") ||
    pathname.includes("/auth/avatar/file/")
  );
}

function isProduction(c: Context<AppEnv>): boolean {
  const env = (c.env ?? {}) as Partial<Env>;
  return env.ENVIRONMENT === "production";
}

export function securityHeaders() {
  return async function securityHeadersMw(c: Context<AppEnv>, next: Next) {
    await next();
    for (const [name, value] of GLOBAL_HEADERS) {
      if (name === "Cross-Origin-Resource-Policy") {
        let pathname = "";
        try {
          pathname = new URL(c.req.url).pathname;
        } catch {
          // Unparseable URL: keep the strict default (fail closed).
        }
        c.res.headers.set(
          name,
          isPublicFileRoute(pathname) ? "cross-origin" : value
        );
        continue;
      }
      c.res.headers.set(name, value);
    }
    if (isProduction(c)) {
      c.res.headers.set("Strict-Transport-Security", HSTS_VALUE);
    }
  };
}
