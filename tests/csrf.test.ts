import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { errorHandler } from "../src/http/errors.js";
import { ok } from "../src/http/respond.js";
import { csrfMw } from "../src/middleware/csrf.js";

// CSRF origin gate matrix (fast, no server). Companion to SameSite=None:
// with Lax the browser refused cross-site cookies implicitly; with None
// every cookie-authed mutation must prove a trustworthy origin instead.
function probeApp(env: Record<string, string> = {}, base = "http://localhost") {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use(csrfMw);
  app.post("/mutate", (c) => ok(c, { did: true }));
  app.get("/read", (c) => ok(c, { did: true }));
  return {
    call: (method: string, headers: Record<string, string> = {}) =>
      app.request(`${base}/mutate`, { method, headers }, env as never),
    read: (headers: Record<string, string> = {}) =>
      app.request(`${base}/read`, { method: "GET", headers }, env as never),
  };
}

const FRONTEND = "https://sallasyria-7qx.pages.dev";

describe("csrf origin gate", () => {
  it("leaves safe methods alone even with evil origins", async () => {
    const { read } = probeApp();
    const res = await read({ Origin: "https://evil.com" });
    expect(res.status).toBe(200);
  });

  it("allows mutations with no origin signal (curl/tests/apps)", async () => {
    const { call } = probeApp();
    expect((await call("POST")).status).toBe(200);
  });

  it("allows same-host origins (same-origin deployment)", async () => {
    // Host is derived from the request URL, so a same-host Origin is
    // trusted without any configuration.
    const { call } = probeApp({}, "https://sallasyria.sallasyria.workers.dev");
    const res = await call("POST", {
      Origin: "https://sallasyria.sallasyria.workers.dev",
    });
    expect(res.status).toBe(200);
  });

  it("allows configured frontend origins in production", async () => {
    const { call } = probeApp({
      FRONTEND_URL: FRONTEND,
      ENVIRONMENT: "production",
    });
    expect((await call("POST", { Origin: FRONTEND })).status).toBe(200);
    expect(
      (
        await call("POST", {
          Origin: "https://fix-x.sallasyria-7qx.pages.dev",
        })
      ).status
    ).toBe(200);
  });

  it("rejects forged origins with an identical 403", async () => {
    const { call } = probeApp({
      FRONTEND_URL: FRONTEND,
      ENVIRONMENT: "production",
    });
    for (const bad of [
      "https://evil.com",
      "http://sallasyria-7qx.pages.dev",
      "https://sallasyria-7qx.pages.dev.evil.com",
    ]) {
      const res = await call("POST", { Origin: bad });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        ok: false,
        error: { code: "csrf_origin_rejected", message: expect.any(String) },
      });
    }
  });

  it("falls back to Referer when Origin is absent", async () => {
    // Cross-host Referer matching a configured origin is trusted (same
    // originAllowed logic as the Origin path).
    const { call } = probeApp(
      {
        FRONTEND_URL: FRONTEND,
        ENVIRONMENT: "production",
      },
      "https://sallasyria.sallasyria.workers.dev"
    );
    expect(
      (await call("POST", { Referer: `${FRONTEND}/app` })).status
    ).toBe(200);
    const evil = probeApp(
      { FRONTEND_URL: FRONTEND, ENVIRONMENT: "production" },
      "https://sallasyria.sallasyria.workers.dev"
    );
    expect(
      (await evil.call("POST", { Referer: "https://evil.com/form" })).status
    ).toBe(403);
  });

  it("keeps the dev localhost fallback outside production", async () => {
    // Real dev shape: frontend :3000 calling the API on a different host.
    // Same-host rule cannot cover it, so the explicit fallback must.
    const dev = probeApp({}, "http://127.0.0.1:8787");
    expect(
      (await dev.call("POST", { Origin: "http://localhost:3000" })).status
    ).toBe(200);
    const prod = probeApp(
      { ENVIRONMENT: "production" },
      "http://127.0.0.1:8787"
    );
    expect(
      (await prod.call("POST", { Origin: "http://localhost:3000" })).status
    ).toBe(403);
  });

  it("lets OPTIONS preflights through untouched", async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use(csrfMw);
    app.post("/mutate", (c) => ok(c, { did: true }));
    const res = await app.request(
      "/mutate",
      {
        method: "OPTIONS",
        headers: { Origin: "https://evil.com" },
      },
      {} as never
    );
    // No route answers OPTIONS here; what matters is the CSRF layer did
    // not 403 it (falls through to the 404 handler instead).
    expect(res.status).toBe(404);
  });
});
