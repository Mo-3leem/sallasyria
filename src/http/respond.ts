import type { Context } from "hono";
import type { AppEnv } from "../env.js";

// Single response envelope for the whole API (roadmap B1). Success:
//   { "ok": true, "data": ... }
// Failure:
//   { "ok": false, "error": { "code": "snake_case", "message": "..." } }
// `message` is client-safe by construction — never pass raw Error text,
// SQL, or stack traces here (see src/http/errors.ts).

export interface ApiErrorBody {
  code: string;
  message: string;
}

export function ok<T>(c: Context<AppEnv>, data: T, status: 200 | 201 = 200) {
  return c.json({ ok: true as const, data }, status);
}

export function fail(
  c: Context<AppEnv>,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503 = 500
) {
  const body: { ok: false; error: ApiErrorBody } = {
    ok: false,
    error: { code, message },
  };
  return c.json(body, status);
}
