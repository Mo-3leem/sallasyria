import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { AppError, errorHandler } from "../src/http/errors.js";
import { ok } from "../src/http/respond.js";
import { z, zBodyValidator } from "../src/http/validate.js";

function probeApp(mode: "app-error" | "raw-error") {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get("/boom", () => {
    if (mode === "app-error") {
      throw new AppError("probe_conflict", 409, "Probe conflict.");
    }
    throw new Error("SELECT * FROM secrets WHERE leak = 'everything'");
  });
  return app;
}

describe("error handling", () => {
  it("AppError keeps its code/status/message", () => {
    const err = new AppError("probe_conflict", 409, "Probe conflict.");
    expect(err.code).toBe("probe_conflict");
    expect(err.status).toBe(409);
  });

  it("maps AppError to the failure envelope", async () => {
    const res = await probeApp("app-error").request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "probe_conflict", message: "Probe conflict." },
    });
  });

  it("sanitizes unknown errors to a generic 500", async () => {
    const res = await probeApp("raw-error").request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("SELECT");
    expect(JSON.stringify(body)).not.toContain("secrets");
  });

  it("validation failures use the envelope, never raw ZodError JSON", async () => {
    // Regression: @hono/zod-validator's default failure mode returns its own
    // {success:false,error:{name,message}} shape, bypassing errorHandler.
    // zBodyValidator must convert it to the standard envelope instead.
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.post("/v", zBodyValidator(z.object({ name: z.string().min(1) })), (c) =>
      ok(c, {})
    );
    const res = await app.request("/v", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "validation_failed", message: "Invalid request body." },
    });
  });
});
