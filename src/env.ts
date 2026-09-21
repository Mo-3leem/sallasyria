import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

// Worker bindings. Additional bindings arrive only with their phase —
// never speculatively.
export interface Env {
  DB: D1Database;
  // R2 is REQUIRED in local dev (emulated) but TEMPORARILY ABSENT in the
  // production demo (account has no R2/billing — see wrangler.jsonc note).
  // Hence optional: every touchpoint guards with an explicit 503
  // storage_unavailable instead of crashing. Restore the binding and this
  // becomes required again.
  R2?: R2Bucket;
  ENVIRONMENT?: string;
  // Cloudflare Turnstile secret for public-mutation bot defense (B5).
  // Absent in development (documented bypass); required elsewhere.
  TURNSTILE_SECRET?: string;
  // SendGrid transactional email (verification, password reset, order
  // notifications). Absent = mail paths log-and-skip (emails never fail
  // business operations); required only where real delivery is wanted.
  // MAIL_FROM must be a verified sender. APP_URL builds email links and
  // must never be hardcoded per-environment in source.
  SENDGRID_API_KEY?: string;
  MAIL_FROM?: string;
  APP_URL?: string;
  // Bootstrap admin password (B7 seed only). While set, admin requests pay
  // one extra password check for rotation enforcement; unset it after every
  // admin has rotated (the value is a live credential until then).
  ADMIN_BOOTSTRAP_PASSWORD?: string;
  // HMAC secret for short-lived image URLs (B8). Absent outside development
  // = fail-closed 503 on upload/serve paths that need signing.
  URL_SIGNING_SECRET?: string;
}

// Authenticated identity shape (populated by B2 requireAuth). Lives here —
// not in middleware/auth.ts — so every module shares ONE context type and
// helper signatures never fight Hono generics.
export interface AuthUser {
  id: string;
  role: string;
  phone: string;
  email: string | null;
  name: string;
}

// Request-scoped values middleware may set. Fields are optional at the type
// level because routes run before/after auth; requireAuth guarantees user +
// sessionId are present downstream of it (currentUser casts accordingly), and
// resolveStore guarantees storeId downstream of it (storeScope casts).
export interface AppVariables {
  user?: AuthUser;
  sessionId?: string;
  storeId?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

// Centralized config read so route code never touches raw env values.
// Throws AppError-free plain Errors only at startup paths; request paths
// must use fail()/AppError instead (see src/http/).
export function appConfig(env: Env): { environment: string } {
  return { environment: env.ENVIRONMENT ?? "development" };
}

// Base URL used to build email links (verification, password reset). Never
// hardcoded per-environment in source: local default is wrangler's default
// dev origin, production comes from the APP_URL binding.
export function appUrl(env: Env): string {
  return env.APP_URL ?? "http://localhost:8787";
}
