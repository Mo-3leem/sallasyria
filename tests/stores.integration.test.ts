// B3 integration suite: tenant isolation + subscription gate + store routes.
// Real workerd (wrangler dev) + real local D1. Fixtures use user_verify_b3_*
// (covered by scripts/clean-verify.mjs). Exactly three logins total so the
// per-key rate limiter is never a factor; cookies are reused per account.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18878;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const OWNER_A = "+963900000801";
const OWNER_B = "+963900000802";
const ADMIN = "+963900000803";
const PASS = "Stores-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b3test-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  try {
    const out = execFileSync(isWindows ? "npx.cmd" : "npx", ["wrangler", "d1", "execute", "sallasyria-db", "--local", "--json", "--file", file], {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
    });
    const parsed = JSON.parse(out);
    const ok = (parsed as { success: boolean }[]).every((r) => r.success);
    return { ok, error: ok ? undefined : JSON.stringify(parsed) };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return { ok: false, error: String(e.stderr ?? e.message ?? err) };
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`dev server never ready\n${serverOutput.slice(-3000)}`);
}

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

let jarA = "";
let jarB = "";
let jarAdmin = "";

beforeAll(async () => {
  server = spawn(isWindows ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    windowsHide: true,
  });
  server.stdout?.on("data", (d) => { serverOutput += String(d); });
  server.stderr?.on("data", (d) => { serverOutput += String(d); });
  await waitForHealth();

  const h = hashPassword(PASS);
  assertCleanVerify("b3 reset");
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b3_a', '${OWNER_A}', 'b3a@example.com', 'B3 Owner A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b3_b', '${OWNER_B}', 'b3b@example.com', 'B3 Owner B', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b3_admin', '${ADMIN}', 'b3admin@example.com', 'B3 Admin', '${h}', 'admin');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b3', 'b3-plan', 'B3 Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b3_a', 'user_verify_b3_a', 'b3-store-a', 'B3 Store A');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b3_expired', 'user_verify_b3_a', 'b3-store-expired', 'B3 Expired');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b3_b', 'user_verify_b3_b', 'b3-store-b', 'B3 Store B');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b3_trial', 'user_verify_b3_b', 'b3-store-trial', 'B3 Trial');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b3_a', 'store_verify_b3_a', 'plan_verify_b3', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b3_b', 'store_verify_b3_b', 'plan_verify_b3', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b3_expired', 'store_verify_b3_expired', 'plan_verify_b3', 'expired', 'monthly', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b3_trial', 'store_verify_b3_trial', 'plan_verify_b3', 'trialing', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B3 seed failed: ${r.error}`);
  }

  async function loginCookie(phone: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`B3 setup login failed for ${phone}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarA = await loginCookie(OWNER_A);
  jarB = await loginCookie(OWNER_B);
  jarAdmin = await loginCookie(ADMIN);
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b3 end");
  } finally {
    if (server && server.exitCode === null) {
      try {
        if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        else server.kill("SIGTERM");
      } catch { /* best effort */ }
    }
    server = null;
  }
}, 60_000);

describe("B3 store listing", () => {
  it("owner sees exactly their own stores, internal fields excluded", async () => {
    const res = await api("/stores", {}, jarA);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; data: { stores: Record<string, unknown>[] } };
    expect(body.data.stores.map((s) => s["id"]).sort()).toEqual(
      ["store_verify_b3_a", "store_verify_b3_expired"].sort()
    );
    for (const s of body.data.stores) {
      expect(Object.keys(s).sort()).toEqual(["currency", "id", "name", "slug", "status"]);
    }
    expect(JSON.stringify(body)).not.toContain("order_counter");
  });

  it("admin sees all stores; anonymous gets 401", async () => {
    const admin = await api("/stores", {}, jarAdmin);
    expect(admin.status).toBe(200);
    // Containment, not exact count: persistent seed demo data (scripts/seed.mjs,
    // by design never cleaned) also lists for admins. Exact-count would couple
    // this test to every other dataset in the database.
    const ids = ((admin.body as { data: { stores: { id: string }[] } }).data.stores).map((s) => s.id);
    for (const expected of [
      "store_verify_b3_a",
      "store_verify_b3_expired",
      "store_verify_b3_b",
      "store_verify_b3_trial",
    ]) {
      expect(ids).toContain(expected);
    }
    const anon = await api("/stores");
    expect(anon.status).toBe(401);
  });
});

describe("B3 single-store reads (no oracle)", () => {
  it("owner reads own store; expired store still readable", async () => {
    const own = await api("/stores/store_verify_b3_a", {}, jarA);
    expect(own.status).toBe(200);
    expect(((own.body as { data: { store: { name: string } } }).data.store.name)).toBe("B3 Store A");
    const expired = await api("/stores/store_verify_b3_expired", {}, jarA);
    expect(expired.status).toBe(200);
  });

  it("foreign and missing ids answer identically", async () => {
    const foreign = await api("/stores/store_verify_b3_b", {}, jarA);
    const missing = await api("/stores/store_verify_b3_nope", {}, jarA);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(foreign.body).toEqual({
      ok: false,
      error: { code: "store_not_found", message: "Store not found." },
    });
  });

  it("admin reads foreign store", async () => {
    const res = await api("/stores/store_verify_b3_b", {}, jarAdmin);
    expect(res.status).toBe(200);
  });
});

describe("B3 store updates + gate", () => {
  it("owner renames own store; updated_at refreshes", async () => {
    const res = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ name: "B3 Store A Renamed" }),
    }, jarA);
    expect(res.status).toBe(200);
    const store = (res.body as { data: { store: { name: string } } }).data.store;
    expect(store.name).toBe("B3 Store A Renamed");
  });

  it("cross-store update is 404, never applied", async () => {
    const res = await api("/stores/store_verify_b3_b", {
      method: "PATCH",
      body: JSON.stringify({ name: "Hijacked" }),
    }, jarA);
    expect(res.status).toBe(404);
    const check = await api("/stores/store_verify_b3_b", {}, jarB);
    expect(((check.body as { data: { store: { name: string } } }).data.store.name)).toBe("B3 Store B");
  });

  it("store_id and id in body are 400 even when matching", async () => {
    for (const [payload, key] of [
      [{ name: "X", store_id: "store_verify_b3_a" }, "store_id"],
      [{ name: "X", id: "store_verify_b3_a" }, "id"],
      [{ name: "X", store_id: "store_verify_b3_b" }, "store_id"],
    ] as const) {
      const res = await api("/stores/store_verify_b3_a", { method: "PATCH", body: JSON.stringify(payload) }, jarA);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "immutable_field", message: `Field '${key}' cannot be set by clients.` },
      });
    }
  });

  it("invalid name is 400 validation envelope", async () => {
    const res = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ name: "" }),
    }, jarA);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Request body is invalid.",
        details: [{ field: "name", message: "Too short." }],
      },
    });
  });

  it("expired store blocks merchant writes but not reads; trialing allows", async () => {
    const blocked = await api("/stores/store_verify_b3_expired", {
      method: "PATCH",
      body: JSON.stringify({ name: "Nope" }),
    }, jarA);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({
      ok: false,
      error: { code: "subscription_inactive", message: "Store subscription is not active." },
    });
    const trial = await api("/stores/store_verify_b3_trial", {
      method: "PATCH",
      body: JSON.stringify({ name: "B3 Trial Renamed" }),
    }, jarB);
    expect(trial.status).toBe(200);
  });

  it("admin bypasses the gate on expired stores", async () => {
    const res = await api("/stores/store_verify_b3_expired", {
      method: "PATCH",
      body: JSON.stringify({ name: "B3 Expired Managed" }),
    }, jarAdmin);
    expect(res.status).toBe(200);
  });

  it("anonymous PATCH is 401; oversized body is 413 envelope", async () => {
    const anon = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ name: "X" }),
    });
    expect(anon.status).toBe(401);
    const big = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ name: "X", pad: "y".repeat(2_000_000) }),
    }, jarA);
    expect(big.status).toBe(413);
    expect(big.body).toEqual({
      ok: false,
      error: { code: "body_too_large", message: "Request body too large." },
    });
  });
});

describe("B3 store settings update", () => {
  it("merchant renames own store", async () => {
    const res = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ name: "B3 Store A Renamed" }),
    }, jarA);
    expect(res.status).toBe(200);
    expect(((res.body as { data: { store: { name: string } } }).data.store.name)).toBe("B3 Store A Renamed");
  });

  it("merchant changes slug and currency together", async () => {
    const res = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ slug: "b3-store-a-new", currency: "USD" }),
    }, jarA);
    expect(res.status).toBe(200);
    const store = (res.body as { data: { store: { slug: string; currency: string; name: string } } }).data.store;
    expect(store.slug).toBe("b3-store-a-new");
    expect(store.currency).toBe("USD");
    expect(store.name).toBe("B3 Store A Renamed");
  });

  it("same slug is a no-op, not an error", async () => {
    const res = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ slug: "b3-store-a-new" }),
    }, jarA);
    expect(res.status).toBe(200);
    expect(((res.body as { data: { store: { slug: string } } }).data.store.slug)).toBe("b3-store-a-new");
  });

  it("duplicate slug is 409 and touches nothing", async () => {
    const res = await api("/stores/store_verify_b3_a", {
      method: "PATCH",
      body: JSON.stringify({ slug: "b3-store-b" }),
    }, jarA);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "slug_taken", message: "Slug is already in use." },
    });
    const check = await api("/stores/store_verify_b3_b", {}, jarB);
    expect(((check.body as { data: { store: { slug: string } } }).data.store.slug)).toBe("b3-store-b");
  });

  it("cross-merchant PATCH is 404 and modifies nothing", async () => {
    const res = await api("/stores/store_verify_b3_b", {
      method: "PATCH",
      body: JSON.stringify({ name: "Pwned" }),
    }, jarA);
    expect(res.status).toBe(404);
    const check = await api("/stores/store_verify_b3_b", {}, jarB);
    expect(((check.body as { data: { store: { name: string } } }).data.store.name)).toBe("B3 Store B");
  });

  it("admin updates any store per existing rules", async () => {
    const res = await api("/stores/store_verify_b3_b", {
      method: "PATCH",
      body: JSON.stringify({ name: "B3 Store B Managed", currency: "EUR" }),
    }, jarAdmin);
    expect(res.status).toBe(200);
    const store = (res.body as { data: { store: { name: string; currency: string } } }).data.store;
    expect(store.name).toBe("B3 Store B Managed");
    expect(store.currency).toBe("EUR");
  });

  it("all six immutable fields are 400", async () => {
    for (const [key, value] of [
      ["id", "forged"],
      ["owner_id", "user_verify_b3_b"],
      ["store_id", "store_verify_b3_b"],
      ["status", "archived"],
      ["order_counter", 1],
      ["created_at", "2020-01-01T00:00:00Z"],
    ] as const) {
      const res = await api("/stores/store_verify_b3_a", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      }, jarA);
      expect(res.status, `field ${key}`).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "immutable_field", message: expect.any(String) },
      });
    }
  });

  it("session survives store updates", async () => {
    const me = await api("/stores", {}, jarA);
    expect(me.status).toBe(200);
  });
});
