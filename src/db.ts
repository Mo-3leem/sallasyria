import type { D1Database } from "@cloudflare/workers-types";
import type { Context } from "hono";
import type { AppEnv } from "./env.js";

// Single accessor for the D1 binding. All route/service code must go through
// here (and tenant-scoped helpers built on it in B3) so bindings stay
// centralized and mockable in tests.
export function getDb(c: Context<AppEnv>): D1Database {
  return c.env.DB;
}

// Conventions (binding, roadmap B1/B6):
// - Parameterized statements only: db.prepare("... WHERE id = ?").bind(id).
//   Never interpolate values into SQL strings.
// - Multi-statement atomic writes use db.batch([...]) — D1 executes the batch
//   as one implicit transaction (all-or-nothing). No BEGIN/COMMIT in app code,
//   no PRAGMAs, no busy_timeout.

export type DbErrorKind = "transient" | "constraint" | "unknown";

export interface ClassifiedDbError {
  kind: DbErrorKind;
  /** True ONLY for errors where no commit can have happened and a retry may
   *  succeed. Default-deny: anything unrecognized is NOT retryable. */
  retryable: boolean;
}

const TRANSIENT_PATTERNS = [
  /SQLITE_BUSY/i,
  /database is locked/i,
  /D1_(TIMEOUT|INTERNAL|TOO_MANY_REQUESTS)/i,
  /\btimed?\s?out\b|\btimeout\b/i,
  /ECONNRESET|EAI_AGAIN|fetch failed|network/i,
  /workerd.*(crashed|unavailable)|internal error/i,
];

const CONSTRAINT_PATTERNS = [
  /SQLITE_CONSTRAINT|UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed|NOT NULL constraint failed/i,
  /D1_CONSTRAINT/i,
];

// Classify a D1/transport failure for the B6 bounded-retry policy.
// B1 scope: classification only — no retry loop lives here.
export function classifyDbError(err: unknown): ClassifiedDbError {
  const text =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : JSON.stringify(err);
  if (CONSTRAINT_PATTERNS.some((re) => re.test(text))) {
    return { kind: "constraint", retryable: false };
  }
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) {
    return { kind: "transient", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}
