import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { errorHandler } from "../src/http/errors.js";
import { ok } from "../src/http/respond.js";
import { hashSessionToken } from "../src/lib/session.js";
import {
  currentUser,
  requireAuth,
  requireRole,
} from "../src/middleware/auth.js";

// Minimal in-memory D1 stand-in: serves ONE canned session JOIN row (or null)
// matched on the bound token hash, and records UPDATE calls (last_used_at
// touches). It proves middleware branching; real FK/SQL semantics are proven
// separately against local D1 by the integration suite.
interface Canned {
  hash: string;
  row: Record<string, unknown> | null;
  touched: string[];
}

function fakeDb(canned: Canned) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("FROM sessions")) {
            return args[0] === canned.hash ? canned.row : null;
          }
          return null;
        },
        run: async () => {
          canned.touched.push(String(args[1] ?? args[0]));
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
}

function probeApp(canned: Canned) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get("/private", requireAuth, (c) =>
    ok(c, { user: currentUser(c) })
  );
  app.get("/admin", requireRole("admin"), (c) => ok(c, { admin: true }));
  return { app, env: { DB: fakeDb(canned) } as unknown as AppEnv };
}

const LIVE_ROW = {
  sid: "sess-1",
  revoked_at: null,
  expires_at: "2099-01-01T00:00:00Z",
  last_used_at: null,
  uid: "user-1",
  role: "merchant",
  phone: "+963900000001",
  email: null,
  name: "Merchant",
  email_verified: 1,
  is_active: 1,
};

const KNOWN_HASH = "known-hash-hex";

describe("requireAuth", () => {
  it("rejects missing cookie with generic 401", async () => {
    const { app, env } = probeApp({ hash: KNOWN_HASH, row: LIVE_ROW, touched: [] });
    const res = await app.request("/private", {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "Authentication required." },
    });
  });

  it("rejects unknown token hash with the identical 401", async () => {
    const { app, env } = probeApp({ hash: "other-hash", row: LIVE_ROW, touched: [] });
    const res = await app.request(
      "/private",
      { headers: { Cookie: "ss_session=whatever" } },
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "Authentication required." },
    });
  });

  it("rejects revoked / expired / disabled rows with the same 401", async () => {
    for (const row of [
      { ...LIVE_ROW, revoked_at: "2026-09-15T00:00:00Z" },
      { ...LIVE_ROW, expires_at: "2020-01-01T00:00:00Z" },
      { ...LIVE_ROW, is_active: 0 },
    ]) {
      const { app, env } = probeApp({ hash: KNOWN_HASH, row, touched: [] });
      const res = await app.request(
        "/private",
        { headers: { Cookie: "ss_session=whatever" } },
        env
      );
      expect(res.status).toBe(401);
    }
  });

  it("admits a live session, sets the user, and touches last_used_at", async () => {
    const realHash = await hashSessionToken("live-token");
    const canned = { hash: realHash, row: LIVE_ROW, touched: [] as string[] };
    const { app, env } = probeApp(canned);
    const res = await app.request(
      "/private",
      { headers: { Cookie: "ss_session=live-token" } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { user: { id: string; role: string } } };
    expect(body.data.user).toMatchObject({ id: "user-1", role: "merchant", email_verified: 1 });
    expect(body.data.user).not.toHaveProperty("password_hash");
    expect(canned.touched).toEqual(["sess-1"]);
  });

  it("skips the last_used_at write when recently touched", async () => {
    const realHash = await hashSessionToken("fresh-token");
    const row = { ...LIVE_ROW, last_used_at: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    const canned = { hash: realHash, row, touched: [] as string[] };
    const { app, env } = probeApp(canned);
    const res = await app.request(
      "/private",
      { headers: { Cookie: "ss_session=fresh-token" } },
      env
    );
    expect(res.status).toBe(200);
    expect(canned.touched).toHaveLength(0);
  });
});

describe("requireRole", () => {
  it("returns 401 without a session and 403 for non-admin", async () => {
    const { app, env } = probeApp({ hash: KNOWN_HASH, row: LIVE_ROW, touched: [] });
    const anon = await app.request("/admin", {}, env);
    expect(anon.status).toBe(401);

    const realHash = await hashSessionToken("merchant-token");
    const authed = probeApp({ hash: realHash, row: LIVE_ROW, touched: [] });
    const denied = await authed.app.request(
      "/admin",
      { headers: { Cookie: "ss_session=merchant-token" } },
      authed.env
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Admin privileges required." },
    });
  });

  it("admits admins", async () => {
    const realHash = await hashSessionToken("admin-token");
    const { app, env } = probeApp({
      hash: realHash,
      row: { ...LIVE_ROW, role: "admin" },
      touched: [],
    });
    const res = await app.request(
      "/admin",
      { headers: { Cookie: "ss_session=admin-token" } },
      env
    );
    expect(res.status).toBe(200);
  });
});
