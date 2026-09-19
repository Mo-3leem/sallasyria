import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";

function envWithDb(firstImpl: () => Promise<unknown>): Env {
  return {
    DB: {
      prepare: () => ({ first: firstImpl }),
    },
  } as unknown as Env;
}

describe("app wiring", () => {
  it("GET /health is public and uses the success envelope", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { status: "up" } });
  });

  it("unknown routes return the failure envelope, not HTML", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "not_found", message: "Route does not exist." },
    });
  });

  it("removed dev-only purge route is a plain 404", async () => {
    // Regression: POST /admin/maintenance/purge was deleted entirely (no
    // route, no docs). It must fall through to notFound like any unknown
    // path — never an auth-gated or method-specific response.
    for (const method of ["POST", "GET"]) {
      const res = await createApp().request("/admin/maintenance/purge", { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        ok: false,
        error: { code: "not_found", message: "Route does not exist." },
      });
    }
  });

  it("attaches a request id to every response", async () => {
    const res = await createApp().request("/health");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("GET /ready reports db up when D1 answers", async () => {
    const app = createApp();
    const res = await app.request(
      "/ready",
      {},
      envWithDb(async () => ({ ok: 1 }))
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { status: "ready", db: "up" },
    });
  });

  it("GET /ready returns generic 503 without leaking the DB error", async () => {
    const app = createApp();
    const res = await app.request(
      "/ready",
      {},
      envWithDb(async () => {
        throw new Error("D1_INTERNAL: file is encrypted or is not a database");
      })
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: { code: "db_unavailable", message: "Database is not reachable." },
    });
    expect(JSON.stringify(body)).not.toContain("encrypted");
  });
});
