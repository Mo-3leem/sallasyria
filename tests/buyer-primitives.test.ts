import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, Env } from "../src/env.js";
import { errorHandler } from "../src/http/errors.js";
import { ok } from "../src/http/respond.js";
import { GOVERNORATES, isGovernorate } from "../src/lib/governorates.js";
import { normalizePhone } from "../src/lib/phone.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { requireTurnstile } from "../src/middleware/turnstile.js";
import { AppError } from "../src/http/errors.js";

describe("normalizePhone", () => {
  it("canonicalizes Syrian formatting variants to one form", () => {
    for (const raw of [
      "+963991234567",
      "0991234567",
      "963991234567",
      "963 991 234 567",
      "(+963) 991-234-567",
      " 0991 234 567 ",
    ]) {
      expect(normalizePhone(raw)).toBe("+963991234567");
    }
  });

  it("folds Arabic-Indic digits", () => {
    expect(normalizePhone("٠٩٩١٢٣٤٥٦٧")).toBe("+963991234567");
    expect(normalizePhone("۰۹۹۱۲۳۴۵۶۷")).toBe("+963991234567");
  });

  it("rejects garbage with a 400 AppError (never stores raw)", () => {
    for (const bad of ["", "abc", "+1234", "+963", "+963991234567890123", "12"]) {
      try {
        normalizePhone(bad);
        expect.unreachable(`should have thrown for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).status).toBe(400);
      }
    }
  });
});

describe("governorates", () => {
  it("freezes exactly the 14 DDL values", () => {
    expect(GOVERNORATES).toHaveLength(14);
    expect(isGovernorate("Damascus")).toBe(true);
    expect(isGovernorate("damascus")).toBe(false);
    expect(isGovernorate("Not A Real Governorate")).toBe(false);
  });
});

describe("createRateLimiter", () => {
  it("caps per key per window, then recovers", () => {
    const lim = createRateLimiter({ maxAttempts: 2, windowMs: 1000 });
    expect(lim.check("k", 0)).toBe(true);
    expect(lim.check("k", 1)).toBe(true);
    expect(lim.check("k", 2)).toBe(false);
    expect(lim.check("other", 2)).toBe(true);
    expect(lim.check("k", 1001)).toBe(true);
    lim.reset("k");
    expect(lim.check("k", 1002)).toBe(true);
  });
});

describe("requireTurnstile", () => {
  function probeApp(env: Env, fetchImpl?: typeof fetch) {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.post("/pub", requireTurnstile(fetchImpl), (c) => ok(c, {}));
    return { app, env };
  }

  const baseEnv: Env = { DB: {} as Env["DB"], R2: {} as Env["R2"], ENVIRONMENT: "development" };

  it("dev-bypasses when no secret is configured", async () => {
    const { app, env } = probeApp(baseEnv);
    const res = await app.request("/pub", { method: "POST" }, env);
    expect(res.status).toBe(200);
  });

  it("fail-closes when secret is missing outside development", async () => {
    const { app } = probeApp(baseEnv);
    const res = await app.request(
      "/pub",
      { method: "POST" },
      { DB: {} as Env["DB"], ENVIRONMENT: "production" }
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "turnstile_misconfigured", message: expect.any(String) },
    });
  });

  it("requires a token and honors the verdict with stubbed fetch", async () => {
    const goodFetch = (async () =>
      new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const badFetch = (async () =>
      new Response(JSON.stringify({ success: false }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const env: Env = { DB: {} as Env["DB"], R2: {} as Env["R2"], ENVIRONMENT: "production", TURNSTILE_SECRET: "s3cr3t" };

    const { app: appGood } = probeApp(env, goodFetch);
    expect(
      (
        await appGood.request(
          "/pub",
          { method: "POST", headers: { "X-Turnstile-Token": "tok" } },
          env
        )
      ).status
    ).toBe(200);

    const { app: appMissing } = probeApp(env, goodFetch);
    expect((await appMissing.request("/pub", { method: "POST" }, env)).status).toBe(400);

    const { app: appBad } = probeApp(env, badFetch);
    const denied = await appBad.request(
      "/pub",
      { method: "POST", headers: { "X-Turnstile-Token": "tok" } },
      env
    );
    expect(denied.status).toBe(403);
  });
});
