// Single validation entry point (roadmap B1 decision, extended for OpenAPI
// docs): zod schemas + validation with the standard envelope on failure.
// Route code uses zBodyValidator (plain routes) or validationHook (OpenAPI
// routes, see below) — never zValidator directly — for two binding reasons:
//  1. The libraries' DEFAULT failure modes return raw ZodError JSON
//     ({success:false, error:{name,message}}), bypassing errorHandler and
//     breaking the envelope contract clients depend on.
//  2. Raw Zod internals (received values, patterns, nested errors) must not
//     reach clients. Both converters funnel through validationFailedError(),
//     which throws AppError carrying only schema-defined field paths plus
//     fixed allowlist messages, so errorHandler emits the standard
//     {ok:false,error:{code,message,details?}} envelope instead.
// Malformed JSON never reaches the hook (hono/validator throws HTTPException
// first); errorHandler maps that exact case to code "malformed_json" so
// clients can distinguish "unparseable" from "parseable but invalid".
//
// NOTE: `z` is re-exported from @hono/zod-openapi (zod v4 API plus the
// .openapi() metadata method). It is a strict superset for everything this
// codebase uses, so all existing schemas work unchanged while documented
// routes can attach examples/component names.
import { zValidator } from "@hono/zod-validator";
import { z } from "@hono/zod-openapi";
import { AppError } from "./errors.js";

export { z };

// One field-level validation failure. `field` is a dot-joined schema path
// (schema-defined names only — never client values) and `message` comes from
// a fixed allowlist below. Zod's own messages, received values, regex
// patterns, allowed-option lists, and nested union errors are NEVER surfaced:
// they can echo secrets, credentials, or implementation details.
export interface ValidationFieldError {
  field: string;
  message: string;
}

// Cap on details per response: keeps 400s concise and bounds work spent
// formatting hostile input (e.g. thousand-element arrays).
export const MAX_VALIDATION_DETAILS = 10;

// Cap on a single field path rendering (defensive; schema paths are short).
const MAX_FIELD_LENGTH = 200;

type IssueLike = {
  code?: unknown;
  path?: unknown;
  expected?: unknown;
  origin?: unknown;
  format?: unknown;
};

function isIssueLike(value: unknown): value is IssueLike {
  return typeof value === "object" && value !== null;
}

function rootFieldFor(target: string | undefined): string {
  switch (target) {
    case "json":
    case "form":
      return "body";
    case "query":
      return "query";
    case "param":
      return "path";
    case "header":
      return "header";
    case "cookie":
      return "cookie";
    default:
      return "request";
  }
}

function fieldPathOf(path: unknown, target: string | undefined): string {
  if (!Array.isArray(path) || path.length === 0) return rootFieldFor(target);
  const rendered = path
    .filter((seg) => typeof seg === "string" || typeof seg === "number")
    .map(String)
    .join(".");
  if (rendered.length === 0) return rootFieldFor(target);
  return rendered.slice(0, MAX_FIELD_LENGTH);
}

// Fixed message per Zod issue code. No interpolation of user-controlled data:
// - `expected` is echoed only when it is a bare type keyword (schema shape,
//   also visible in /doc); anything else falls back to a generic message.
// - formats map well-known names (email/url/...) to friendly text; regex and
//   unknown formats stay generic so patterns are never disclosed.
// - unrecognized_keys / invalid_key never name the offending key: keys are
//   client-controlled (could be secrets, tokens, or megabytes of junk).
// - invalid_union / invalid_element are not recursed into: nesting is
//   unbounded and adds no safe signal beyond "this value is wrong".
function messageForIssue(issue: IssueLike): string {
  switch (issue.code) {
    case "invalid_type": {
      const expected = issue.expected;
      if (typeof expected === "string" && /^[A-Za-z_]{1,20}$/.test(expected)) {
        return `Expected ${expected}.`;
      }
      return "Invalid type.";
    }
    case "too_small":
      if (issue.origin === "string") return "Too short.";
      if (issue.origin === "array") return "Too few items.";
      return "Too small.";
    case "too_big":
      if (issue.origin === "string") return "Too long.";
      if (issue.origin === "array") return "Too many items.";
      return "Too large.";
    case "invalid_format":
      switch (issue.format) {
        case "email":
          return "Invalid email address.";
        case "url":
        case "href":
          return "Invalid URL.";
        case "uuid":
          return "Invalid ID format.";
        case "datetime":
        case "date":
        case "time":
          return "Invalid date or time.";
        default:
          return "Invalid format.";
      }
    case "not_multiple_of":
      return "Invalid number.";
    case "unrecognized_keys":
      return "Unknown field.";
    case "invalid_key":
      return "Invalid entry.";
    case "invalid_element":
      return "Invalid list item.";
    case "invalid_union":
    case "invalid_value":
    case "custom":
    default:
      return "Invalid value.";
  }
}

function detailForIssue(
  issue: unknown,
  target: string | undefined
): ValidationFieldError | null {
  if (!isIssueLike(issue) || typeof issue.code !== "string") return null;
  if (issue.code === "unrecognized_keys" || issue.code === "invalid_key") {
    // Parent path only (issue.path points at the containing object) — the
    // unknown key itself is client-controlled and stays server-side.
    return { field: fieldPathOf(issue.path, target), message: messageForIssue(issue) };
  }
  return { field: fieldPathOf(issue.path, target), message: messageForIssue(issue) };
}

// Extracts safe field errors from a Zod-like failure. Returns undefined when
// the failure is NOT a schema mismatch (e.g. a JSON parse error), so callers
// can fall through to the malformed-body path instead of mislabeling it.
export function toValidationDetails(
  error: unknown,
  target?: string
): ValidationFieldError[] | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  const details: ValidationFieldError[] = [];
  for (const issue of issues) {
    if (details.length >= MAX_VALIDATION_DETAILS) break;
    const detail = detailForIssue(issue, target);
    if (detail) details.push(detail);
  }
  if (details.length === 0) {
    details.push({ field: rootFieldFor(target), message: "Invalid value." });
  }
  return details;
}

function messageForTarget(target: string | undefined): string {
  switch (target) {
    case "json":
    case "form":
      return "Request body is invalid.";
    case "query":
      return "Invalid query parameters.";
    case "param":
      return "Invalid path parameters.";
    case "header":
    case "cookie":
      return "Invalid request.";
    default:
      return "Request validation failed.";
  }
}

// Builds the single funnel error for a failed validation: schema mismatches
// carry safe field details; anything else (parse-level failures the hook
// could not classify) stays a generic 400 with no details.
export function validationFailedError(
  error: unknown,
  target?: string
): AppError {
  const details = toValidationDetails(error, target);
  if (details) {
    return new AppError("validation_failed", 400, messageForTarget(target), {
      details,
    });
  }
  return new AppError("malformed_body", 400, "Request body could not be read.");
}

export function zBodyValidator<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("json", schema, (result) => {
    if (!result.success) {
      throw validationFailedError(
        (result as { error?: unknown }).error,
        "json"
      );
    }
  });
}

// Failure hook for app.openapi(route, handler, validationHook): identical
// contract to zBodyValidator (same code, same message, same envelope),
// so OpenAPI-validated routes behave exactly like plain validated routes.
// Returns undefined on success (the hook type requires it in its union;
// throwing AppError is the failure path, handled by errorHandler).
// The hook fires per validation target (json/query/param/...); `target`
// selects the top-level message and the root field name, and is itself a
// fixed library string, never client input.
export function validationHook(
  result: { success: boolean; error?: unknown; target?: string },
  _c: unknown
): undefined {
  void _c;
  if (!result.success) {
    throw validationFailedError(result.error, result.target);
  }
  return undefined;
}

// Immutable-field guard (roadmap B3). Client bodies must never carry tenant
// ownership or identity: presence of ANY listed key is a 400 even when the
// value happens to match (fail-closed beats ignore-silently — a matching
// value today trains clients to send it, and a mismatching one tomorrow).
// Call with the RAW parsed body (c.req.valid() output is already stripped by
// zod, so checking it would prove nothing).
export function assertNoImmutableFields(
  raw: unknown,
  forbidden: readonly string[] = ["store_id", "id"]
): void {
  if (typeof raw !== "object" || raw === null) return;
  for (const key of forbidden) {
    if (key in raw) {
      throw new AppError(
        "immutable_field",
        400,
        `Field '${key}' cannot be set by clients.`
      );
    }
  }
}
