import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type { ValidationFieldError } from "./validate.js";

// Single response envelope for the whole API (roadmap B1). Success:
//   { "ok": true, "data": ... }
// Failure:
//   { "ok": false, "error": { "code": "snake_case", "message": "..." } }
// Validation failures additionally carry a capped, fixed-message list:
//   { "ok": false, "error": { "code": "validation_failed", "message": "...",
//                             "details": [{ "field": "...", "message": "..." }] } }
// `message`, `code`, and every detail are client-safe by construction — never
// pass raw Error text, SQL, stack traces, Zod internals, or user values here
// (see src/http/errors.ts and src/http/validate.ts).

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: ValidationFieldError[];
}

export function ok<T, S extends 200 | 201 = 200>(c: Context<AppEnv>, data: T, status: S = 200 as S) {
  return c.json({ ok: true as const, data }, status);
}

export function fail<
  S extends 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503 = 500,
>(
  c: Context<AppEnv>,
  code: string,
  message: string,
  status: S = 500 as S,
  details?: ValidationFieldError[]
) {
  // `details` is emitted only when present and non-empty, so every
  // non-validation error keeps its exact historical shape.
  const error: ApiErrorBody =
    details && details.length > 0 ? { code, message, details } : { code, message };
  const body: { ok: false; error: ApiErrorBody } = { ok: false, error };
  return c.json(body, status);
}
