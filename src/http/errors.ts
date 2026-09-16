import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { fail } from "./respond.js";

// Application error: the ONLY way for route/service code to signal an
// expected failure (validation, auth, tenant, conflict...). `message` must
// already be client-safe when thrown.
export class AppError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503;

  constructor(
    code: string,
    status: AppError["status"],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

// Central error sink (wired as app.onError in src/app.ts):
// - AppError     -> envelope with its own code/status.
// - Hono HTTPException (thrown by zValidator 400s etc.) -> envelope; the
//                  validator message is client-safe, but we still return a
//                  stable code so clients never parse free text.
// - Everything else -> logged server-side, generic 500 to the client. Raw
//                  error text, SQL, and stacks NEVER leave the Worker.
export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof AppError) {
    return fail(c, err.code, err.message, err.status);
  }
  if (err instanceof HTTPException) {
    return fail(c, `http_${err.status}`, "Request failed validation.", 400);
  }
  // Unknown: loud server-side (method + path only, per logging policy —
  // never query strings, headers, or bodies), quiet client-side.
  console.error(
    `unhandled_error ${c.req.method} ${new URL(c.req.url).pathname}: ${err.name}`
  );
  return fail(c, "internal", "Something went wrong.", 500);
}
