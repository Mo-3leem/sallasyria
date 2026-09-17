import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppEnv } from "../src/env.js";
import { errorHandler } from "../src/http/errors.js";
import {
  MAX_VALIDATION_DETAILS,
  toValidationDetails,
} from "../src/http/validate.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function login(body: string, headers: Record<string, string> = JSON_HEADERS) {
  return createApp().request("/auth/login", {
    method: "POST",
    headers,
    body,
  });
}

interface FailBody {
  ok: false;
  error: { code: string; message: string; details?: { field: string; message: string }[] };
}

describe("validation error responses", () => {
  it("schema failure returns code + safe field details", async () => {
    const res = await login(JSON.stringify({ phone: 42, password: "x" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as FailBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("Request body is invalid.");
    expect(body.error.details).toEqual([{ field: "phone", message: "Expected string." }]);
  });

  it("short strings map to a fixed message without echoing the value", async () => {
    const res = await login(JSON.stringify({ phone: "", password: "x" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as FailBody;
    expect(body.error.details).toEqual([{ field: "phone", message: "Too short." }]);
  });

  it("malformed JSON is distinguished from schema errors", async () => {
    const bad = await login(`{"phone": "+963991234567",`);
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as FailBody;
    expect(badBody).toEqual({
      ok: false,
      error: { code: "malformed_json", message: "Request body is not valid JSON." },
    });

    const invalid = await login(JSON.stringify({ phone: 42, password: "x" }));
    const invalidBody = (await invalid.json()) as FailBody;
    expect(invalidBody.error.code).toBe("validation_failed");
    expect(invalidBody.error.code).not.toBe(badBody.error.code);
  });

  it("never exposes Zod internals, patterns, or received values", async () => {
    const res = await login(
      JSON.stringify({ phone: 42, password: ["not", "a", "string"], extra: "ignored" })
    );
    const text = await res.text();
    for (const banned of [
      "ZodError",
      "invalid_type",
      "invalid_value",
      "invalid_union",
      "too_small",
      "required",
      "received",
      "_zod",
      "$Zod",
      "expected one of",
      "must match pattern",
    ]) {
      expect(text, `leaked Zod internals: ${banned}`).not.toContain(banned);
    }
    const body = JSON.parse(text) as FailBody;
    expect(body.error.details?.length).toBeGreaterThan(0);
    for (const d of body.error.details ?? []) {
      expect(typeof d.field).toBe("string");
      expect(typeof d.message).toBe("string");
    }
  });

  it("does not echo sensitive user input back in error responses", async () => {
    const secret = "Sup3rS3cret-MARKER-9zq4";
    const res = await login(JSON.stringify({ phone: 42, password: secret }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("Sup3rS3cret");
  });
});

describe("errorHandler hardening", () => {
  function probeApp(err: Error) {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.get("/boom", () => {
      throw err;
    });
    return app;
  }

  it("HTTPException with hostile message text is never forwarded", async () => {
    const res = await probeApp(
      new HTTPException(400, { message: "Malformed FormData request. ENOENT: '/etc/passwd' D1_ERROR xx" })
    ).request("/boom");
    expect(res.status).toBe(400);
    const body = (await res.json()) as FailBody;
    expect(body).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "Invalid request." },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain("passwd");
    expect(text).not.toContain("D1_ERROR");
  });

  it("unexpected HTTPException statuses collapse to a safe 400", async () => {
    const res = await probeApp(
      new HTTPException(415, { message: "Unsupported Media Type" })
    ).request("/boom");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "Invalid request." },
    });
  });

  it("unknown errors stay a generic 500 with no stack, SQL, or paths", async () => {
    const err = new Error("D1_ERROR: no such table: users at db/query.ts:42:7");
    err.stack = "Error: boom\n    at secretHandler (/app/src/routes/x.ts:1:1)";
    const res = await probeApp(err).request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { code: "internal", message: "Something went wrong." },
    });
    for (const banned of ["D1_ERROR", "secretHandler", "routes/x", ".ts", "at secretHandler", "no such table"]) {
      expect(text, `leaked internals: ${banned}`).not.toContain(banned);
    }
  });
});

describe("toValidationDetails", () => {
  it("caps details at MAX_VALIDATION_DETAILS", () => {
    const issues = Array.from({ length: MAX_VALIDATION_DETAILS + 5 }, (_, i) => ({
      code: "invalid_type",
      expected: "string",
      path: [`field${i}`],
    }));
    const details = toValidationDetails({ issues }, "json");
    expect(details).toHaveLength(MAX_VALIDATION_DETAILS);
  });

  it("returns undefined for non-Zod failures so callers mislabel nothing", () => {
    expect(toValidationDetails(new SyntaxError("Unexpected end"), "json")).toBeUndefined();
    expect(toValidationDetails(null, "json")).toBeUndefined();
    expect(toValidationDetails({ success: false }, "json")).toBeUndefined();
  });

  it("never echoes unknown keys, regex patterns, or custom messages", () => {
    const evilKey = " attacker_controlled_key_with_s3cret ";
    const details = toValidationDetails(
      {
        issues: [
          { code: "unrecognized_keys", keys: [evilKey], path: [] },
          { code: "invalid_format", format: "regex", pattern: "^(?=.*S3CRET).*$", path: ["slug"] },
          { code: "custom", message: `meow ${evilKey}`, params: { secret: 1 }, path: ["phone"] },
          { code: "invalid_union", errors: [[{ code: "whatever", path: ["x"] }]], path: ["choice"] },
        ],
      },
      "json"
    );
    const text = JSON.stringify(details);
    expect(text).not.toContain("attacker_controlled");
    expect(text).not.toContain("S3CRET");
    expect(text).not.toContain("meow");
    expect(text).not.toContain("whatever");
    expect(details).toEqual([
      { field: "body", message: "Unknown field." },
      { field: "slug", message: "Invalid format." },
      { field: "phone", message: "Invalid value." },
      { field: "choice", message: "Invalid value." },
    ]);
  });

  it("maps formats and origins to friendly fixed messages", () => {
    const details = toValidationDetails(
      {
        issues: [
          { code: "invalid_format", format: "email", path: ["email"] },
          { code: "invalid_format", format: "url", path: ["url"] },
          { code: "invalid_format", format: "uuid", path: ["id"] },
          { code: "too_big", origin: "string", path: ["name"] },
          { code: "too_small", origin: "array", path: ["items"] },
          { code: "invalid_value", path: ["role"] },
        ],
      },
      "json"
    );
    expect(details).toEqual([
      { field: "email", message: "Invalid email address." },
      { field: "url", message: "Invalid URL." },
      { field: "id", message: "Invalid ID format." },
      { field: "name", message: "Too long." },
      { field: "items", message: "Too few items." },
      { field: "role", message: "Invalid value." },
    ]);
  });

  it("falls back to the request root when a path is empty", () => {
    expect(toValidationDetails({ issues: [{ code: "custom", path: [] }] }, "json")).toEqual([
      { field: "body", message: "Invalid value." },
    ]);
    expect(toValidationDetails({ issues: [{ code: "custom", path: [] }] }, "query")).toEqual([
      { field: "query", message: "Invalid value." },
    ]);
  });
});
