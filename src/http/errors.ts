import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { fail } from "./respond.js";
import type { ValidationFieldError } from "./validate.js";

// Application error: the ONLY way for route/service code to signal an
// expected failure (validation, auth, tenant, conflict...). `message` must
// already be client-safe when thrown; `details` (validation only) must come
// from toValidationDetails(), never from raw Zod output or user input.
export class AppError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503;
  readonly details?: ValidationFieldError[];

  constructor(
    code: string,
    status: AppError["status"],
    message: string,
    options?: ErrorOptions & { details?: ValidationFieldError[] }
  ) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = options?.details;
  }
}

// Exact library string hono/validator throws for unparseable JSON bodies
// (no user data in it — the original SyntaxError is discarded by hono).
// Matched by equality, never by substring, so a client cannot trigger this
// branch by smuggling the text into its own payload.
const HONO_MALFORMED_JSON_MESSAGE = "Malformed JSON in request body";

// Central error sink (wired as app.onError in src/app.ts):
// - AppError     -> envelope with its own code/status (+ safe details).
// - Hono HTTPException (body-parser 400s, media-type 415s, ...) -> envelope
//                  with a FIXED message per case. err.message is never
//                  forwarded: hono's form parser appends system error text
//                  that can leak paths and internals.
// - Everything else -> logged server-side, generic 500 to the client. Raw
//                  error text, SQL, and stacks NEVER leave the Worker.
export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof AppError) {
    return fail(c, err.code, err.message, err.status, err.details);
  }
  if (err instanceof HTTPException) {
    if (err.status === 400 && err.message === HONO_MALFORMED_JSON_MESSAGE) {
      return fail(c, "malformed_json", "Request body is not valid JSON.", 400);
    }
    return fail(c, "invalid_request", "Invalid request.", 400);
  }
  // Unknown: loud server-side (method + path only, per logging policy —
  // never query strings, headers, or bodies), quiet client-side.
  console.error(
    `unhandled_error ${c.req.method} ${new URL(c.req.url).pathname}: ${err.name}`
  );
  return fail(c, "internal", "Something went wrong.", 500);
}
