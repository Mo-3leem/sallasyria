// B10 integration suite: merchant self-delete, merchant store deletion,
// and writable store status. Real workerd + real local D1. Fixtures use
// user_verify_b10_* / store_verify_b10_* (covered by scripts/clean-verify.mjs);
// API-created trial stores use bill-style explicit cleanup by slug prefix.
// Each flood-sensitive test uses dedicated fixtures so no test depends on
// quota left over by siblings.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18904;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PASS = "B10-Strong-1";
const USERS = [
  { id: "user_verify_b10_a", phone: "+963900001961", email: "b10a@example.com" },
  { id: "user_verify_b10_b", phone: "+963900001962", email: "b10b@example.com" },
  { id: "user_verify_b10_c", phone: "+963900001963", email: "b10c@example.com" },
  { id: "user_verify_b10_d", phone: "+963900001964", email: "b10d@example.com" },
  { id: "user_verify_b10_e", phone: "+963900001965", email: "b10e@example.com" },
  { id: "user_verify_b10_f", phone: "+963900001966", email: "b10f@example.com" },
  { id: "user_verify_b10_g", phone: "+963900001967", email: "b10g@example.com" },
  { id: "user_verify_b10_h", phone: "+963900001968", email: "b10h@example.com" },
  { id: "user_verify_b10_admin", phone: "+963900001969", email: "b10admin@example.com", role: "admin" },
] as const;

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b10test-"));
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
    return { ok, result: parsed, error: ok ? undefined : JSON.stringify(parsed) };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return { ok: false, result: undefined, error: String(e.stderr ?? e.message ?? err) };
  }
}

function qrows(res: { result?: unknown[] }): Record<string, unknown>[] {
  const first = res.result?.[0] as { results?: Record<string, unknown>[] } | undefined;
  return first?.results ?? [];
}

function qval(sql: string): string {
  const rows = qrows(d1(sql));
  return String(rows[0] ? Object.values(rows[0]!)[0] : "");
}

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const headers: Record<string, string> = {
    Connection: "close",
    ...(cookies ? { Cookie: cookies } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body, headers: res.headers };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

async function loginJar(email: string, password: string): Promise<string> {
  const res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`b10 setup login failed for ${email}: ${res.status}`);
  return cookieOf(res.headers.get("set-cookie"));
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {});
  await waitForHealthy(BASE, () => server, () => serverOutput);

  const h = hashPassword(PASS);
  assertCleanVerify("b10 reset");
  for (const u of USERS) {
    const role = (u as { role?: string }).role ?? "merchant";
    const r = d1(
      `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('${u.id}', '${u.phone}', '${u.email}', 'B10', '${h}', '${role}');`
    );
    if (!r.ok) throw new Error(`b10 seed user failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id LIKE 'user_verify_b10%';`);
  const seed = [
    `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products) VALUES ('plan_verify_b10', 'b10-plan', 'B10 Plan', 50000, 500000, 100);`,
    // A owns: sA1 (empty, deletable), sA2 (order-blocked), sA3 (foreign-probe target).
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b10_a1', 'user_verify_b10_a', 'b10-a1', 'B10 A1');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b10_a2', 'user_verify_b10_a', 'b10-a2', 'B10 A2');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b10_a3', 'user_verify_b10_a', 'b10-a3', 'B10 A3');`,
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('cust_verify_b10_a2', 'store_verify_b10_a2', 'B10 Cust', '+963900001971');`,
    `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('order_verify_b10_a2', 'store_verify_b10_a2', 'cust_verify_b10_a2', 1001, 'B10 Cust', '+963900001971', 'Standard', 'Damascus', 'Street 1');`,
    // C owns sC (status/mutation/checkout lab): published, active sub, product, shipping, customer+order.
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b10_c', 'user_verify_b10_c', 'b10-c', 'B10 C');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b10_c', 'store_verify_b10_c', 'plan_verify_b10', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b10_c', 'store_verify_b10_c', 'B10 Prod', 'b10-prod', 1000);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('ship_verify_b10_c', 'store_verify_b10_c', 'Damascus', 'Standard', 5000);`,
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('cust_verify_b10_c', 'store_verify_b10_c', 'B10 Cust C', '+963900001972');`,
    `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('order_verify_b10_c', 'store_verify_b10_c', 'cust_verify_b10_c', 1001, 'B10 Cust C', '+963900001972', 'Standard', 'Damascus', 'Street 1');`,
    // C owns sE (subscription-free recovery lab).
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b10_e', 'user_verify_b10_c', 'b10-e', 'B10 E');`,
    // D owns sD (cross-tenant target).
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('store_verify_b10_d', 'user_verify_b10_d', 'b10-d', 'B10 D', 1);`,
    // H owns sH (status-limiter lab): no subscription needed, POST status is ungated.
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b10_h', 'user_verify_b10_h', 'b10-h', 'B10 H');`,
    // One live email token for B (cascade proof).
    `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ('tok_verify_b10_b', 'user_verify_b10_b', 'verify', 'b10b-hash', '2099-01-01T00:00:00Z');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`b10 seed failed: ${r.error}`);
  }
  // Publish sC (storefront/checkout lab starts active+published).
  d1(`UPDATE stores SET is_published = 1 WHERE id = 'store_verify_b10_c';`);
}, 180_000);

afterAll(async () => {
  try {
    // API-created trial stores carry random ids: remove by slug prefix first.
    d1(`DELETE FROM subscriptions WHERE store_id IN (SELECT id FROM stores WHERE slug LIKE 'b10-trial%');`);
    d1(`DELETE FROM stores WHERE slug LIKE 'b10-trial%';`);
    assertCleanVerify("b10 end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 60_000);

describe("B10 merchant self-delete", () => {
  it("storeless merchant deletes: sessions/tokens cascade, cookie and login die", async () => {
    const jar = await loginJar("b10b@example.com", PASS);
    const res = await api("/auth/me", {
      method: "DELETE",
      body: JSON.stringify({ current_password: PASS }),
    }, jar);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { deleted: "user_verify_b10_b" } });
    // Cookie dead, login dead, rows gone.
    expect((await api("/auth/me", {}, jar)).status).toBe(401);
    expect((await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "b10b@example.com", password: PASS }),
    })).status).toBe(401);
    expect(qval(`SELECT COUNT(*) AS n FROM users WHERE id = 'user_verify_b10_b';`)).toBe("0");
    expect(qval(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'user_verify_b10_b';`)).toBe("0");
    expect(qval(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = 'user_verify_b10_b';`)).toBe("0");
  }, 120_000);

  it("wrong password 401s without deleting; owner of stores 409s; admin 403s; anon 401s", async () => {
    const jarG = await loginJar("b10g@example.com", PASS);
    const wrong = await api("/auth/me", {
      method: "DELETE",
      body: JSON.stringify({ current_password: "Wrong-Pass-9" }),
    }, jarG);
    expect(wrong.status).toBe(401);
    expect(qval(`SELECT COUNT(*) AS n FROM users WHERE id = 'user_verify_b10_g';`)).toBe("1");

    const jarA = await loginJar("b10a@example.com", PASS);
    const blocked = await api("/auth/me", {
      method: "DELETE",
      body: JSON.stringify({ current_password: PASS }),
    }, jarA);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({
      ok: false,
      error: { code: "merchant_has_stores", message: expect.any(String) },
    });
    // The message must not promise a store transfer: no such feature exists,
    // and blocked stores keep blocking until they are gone.
    expect((blocked.body as { error: { message: string } }).error.message).not.toMatch(/transfer/i);
    expect(qval(`SELECT COUNT(*) AS n FROM users WHERE id = 'user_verify_b10_a';`)).toBe("1");

    const jarAdmin = await loginJar("b10admin@example.com", PASS);
    const adminTry = await api("/auth/me", {
      method: "DELETE",
      body: JSON.stringify({ current_password: PASS }),
    }, jarAdmin);
    expect(adminTry.status).toBe(403);

    const anon = await api("/auth/me", {
      method: "DELETE",
      body: JSON.stringify({ current_password: PASS }),
    });
    expect(anon.status).toBe(401);
  }, 120_000);

  it("self-delete is rate-limited per user; concurrent deletes resolve to one winner", async () => {
    const jarE = await loginJar("b10e@example.com", PASS);
    for (let i = 0; i < 5; i++) {
      const r = await api("/auth/me", {
        method: "DELETE",
        body: JSON.stringify({ current_password: "Wrong-Pass-9" }),
      }, jarE);
      expect(r.status).toBe(401);
    }
    const limited = await api("/auth/me", {
      method: "DELETE",
      body: JSON.stringify({ current_password: "Wrong-Pass-9" }),
    }, jarE);
    expect(limited.status).toBe(429);
    expect(qval(`SELECT COUNT(*) AS n FROM users WHERE id = 'user_verify_b10_e';`)).toBe("1");

    const jarF = await loginJar("b10f@example.com", PASS);
    const del = (j: string) => api("/auth/me", {
      method: "DELETE",
      body: JSON.stringify({ current_password: PASS }),
    }, j);
    const [r1, r2] = await Promise.all([del(jarF), del(jarF)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    expect(qval(`SELECT COUNT(*) AS n FROM users WHERE id = 'user_verify_b10_f';`)).toBe("0");
  }, 180_000);
});

describe("B10 merchant store deletion", () => {
  it("own empty store deletes; foreign/unknown 404; anon 401", async () => {
    const jarA = await loginJar("b10a@example.com", PASS);
    const del = await api("/stores/store_verify_b10_a1", { method: "DELETE" }, jarA);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, data: { deleted: "store_verify_b10_a1" } });
    expect((await api("/stores/store_verify_b10_a1", {}, jarA)).status).toBe(404);
    expect(qval(`SELECT COUNT(*) AS n FROM stores WHERE id = 'store_verify_b10_a1';`)).toBe("0");

    const jarD = await loginJar("b10d@example.com", PASS);
    // D probes A's store: identical 404, store intact.
    expect((await api("/stores/store_verify_b10_a3", { method: "DELETE" }, jarD)).status).toBe(404);
    expect(qval(`SELECT COUNT(*) AS n FROM stores WHERE id = 'store_verify_b10_a3';`)).toBe("1");
    expect((await api("/stores/store_verify_b10_nope", { method: "DELETE" }, jarD)).status).toBe(404);
    expect((await api("/stores/store_verify_b10_a3", { method: "DELETE" })).status).toBe(401);
  }, 120_000);

  it("order-blocked and subscription-blocked stores 409; limiter trips on the 11th attempt", async () => {
    const jarA = await loginJar("b10a@example.com", PASS);
    const orderBlocked = await api("/stores/store_verify_b10_a2", { method: "DELETE" }, jarA);
    expect(orderBlocked.status).toBe(409);
    expect(orderBlocked.body).toEqual({
      ok: false,
      error: { code: "store_has_orders", message: expect.any(String) },
    });

    // API-created store carries an auto-granted trial subscription row.
    const created = await api("/stores", {
      method: "POST",
      body: JSON.stringify({ name: "B10 Trial", slug: "b10-trial" }),
    }, jarA);
    expect(created.status).toBe(201);
    const trialId = (created.body as { data: { store: { id: string } } }).data.store.id;
    const subBlocked = await api(`/stores/${trialId}`, { method: "DELETE" }, jarA);
    expect(subBlocked.status).toBe(409);
    expect(subBlocked.body).toEqual({
      ok: false,
      error: { code: "store_has_subscriptions", message: expect.any(String) },
    });
    // Seven more blocked attempts (10 units total with the a1 delete, the
    // order-blocked attempt, and the trial attempt above), then the 11th
    // request is rate-limited.
    for (let i = 0; i < 7; i++) {
      const r = await api(`/stores/${trialId}`, { method: "DELETE" }, jarA);
      expect(r.status).toBe(409);
    }
    const limited = await api(`/stores/${trialId}`, { method: "DELETE" }, jarA);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
    // Blocked stores survive everything above.
    expect(qval(`SELECT COUNT(*) AS n FROM stores WHERE id = 'store_verify_b10_a2';`)).toBe("1");
    expect(qval(`SELECT COUNT(*) AS n FROM stores WHERE id = '${trialId}';`)).toBe("1");
  }, 180_000);
});

describe("B10 store status", () => {
  it("PATCH cycles active/paused/archived; invalid 400s; foreign 404s; anon 401s", async () => {
    const jarC = await loginJar("b10c@example.com", PASS);
    const A = "/stores/store_verify_b10_c";
    for (const s of ["paused", "archived", "active"] as const) {
      const res = await api(A, {
        method: "PATCH",
        body: JSON.stringify({ status: s }),
      }, jarC);
      expect(res.status).toBe(200);
      expect((res.body as { data: { store: { status: string } } }).data.store.status).toBe(s);
    }
    const bad = await api(A, {
      method: "PATCH",
      body: JSON.stringify({ status: "deleted" }),
    }, jarC);
    expect(bad.status).toBe(400);

    const jarD = await loginJar("b10d@example.com", PASS);
    expect((await api(A, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    }, jarD)).status).toBe(404);
    expect((await api(A, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    })).status).toBe(401);
    // Status untouched by the foreign/anon attempts above.
    expect(qval(`SELECT status AS s FROM stores WHERE id = 'store_verify_b10_c';`)).toBe("active");
  }, 120_000);

  it("POST status recovers without subscription; PATCH stays subscription-gated", async () => {
    const jarC = await loginJar("b10c@example.com", PASS);
    const E = "/stores/store_verify_b10_e";
    // sE has no subscription row at all.
    const viaPost = await api(`${E}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "paused" }),
    }, jarC);
    expect(viaPost.status).toBe(200);
    expect((viaPost.body as { data: { store: { status: string } } }).data.store.status).toBe("paused");
    const viaPatch = await api(E, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    }, jarC);
    expect(viaPatch.status).toBe(403);
    // Recovery through the dedicated endpoint always works.
    const resume = await api(`${E}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    }, jarC);
    expect(resume.status).toBe(200);
    expect((resume.body as { data: { store: { status: string } } }).data.store.status).toBe("active");
    // Foreign/anon on the status endpoint: 404/401, no leak.
    const jarD = await loginJar("b10d@example.com", PASS);
    expect((await api(`${E}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "paused" }),
    }, jarD)).status).toBe(404);
    expect((await api(`${E}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "paused" }),
    })).status).toBe(401);
  }, 120_000);

  it("paused/archived hide the storefront; active+published serves; draft hides", async () => {
    const jarC = await loginJar("b10c@example.com", PASS);
    const A = "/stores/store_verify_b10_c";
    const slug = "/stores/by-slug/b10-c";
    // Active + published: visible.
    expect((await api(slug)).status).toBe(200);
    for (const s of ["paused", "archived"] as const) {
      expect((await api(`${A}/status`, {
        method: "POST",
        body: JSON.stringify({ status: s }),
      }, jarC)).status).toBe(200);
      expect((await api(slug)).status).toBe(404);
      expect((await api(`/stores/store_verify_b10_c/catalog/products`)).status).toBe(404);
    }
    // Resume, then unpublish: draft hides too.
    expect((await api(`${A}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    }, jarC)).status).toBe(200);
    expect((await api(slug)).status).toBe(200);
    expect((await api(`${A}/publish`, {
      method: "POST",
      body: JSON.stringify({ is_published: 0 }),
    }, jarC)).status).toBe(200);
    expect((await api(slug)).status).toBe(404);
    // Restore published for the tests below.
    expect((await api(`${A}/publish`, {
      method: "POST",
      body: JSON.stringify({ is_published: 1 }),
    }, jarC)).status).toBe(200);
  }, 180_000);

  it("paused/archived block checkout and mutations; orders history stays readable", async () => {
    const jarC = await loginJar("b10c@example.com", PASS);
    const A = "/stores/store_verify_b10_c";
    const checkoutBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
      customer: { name: "B10", phone: "+963900001972" },
      shipping: {
        recipient_name: "B10",
        phone: "+963900001972",
        governorate: "Damascus",
        address_line: "Street 1",
      },
      payment: { method: "cod" },
      ...extra,
    });
    for (const s of ["paused", "archived"] as const) {
      expect((await api(`${A}/status`, {
        method: "POST",
        body: JSON.stringify({ status: s }),
      }, jarC)).status).toBe(200);
      // Checkout blocked (valid items body: gate fires before business rules).
      const co = await api(`/stores/store_verify_b10_c/checkout`, {
        method: "POST",
        body: checkoutBody({ items: [{ product_id: "prod_verify_b10_c", quantity: 1 }] }),
      }, jarC);
      expect(co.status).toBe(409);
      expect(co.body).toEqual({
        ok: false,
        error: { code: "store_not_active", message: expect.any(String) },
      });
      // Merchant content mutation blocked.
      const prod = await api(`/stores/store_verify_b10_c/products`, {
        method: "POST",
        body: JSON.stringify({ name: "Blocked", slug: "b10-blocked", price: 100 }),
      }, jarC);
      expect(prod.status).toBe(409);
      expect(prod.body).toEqual({
        ok: false,
        error: { code: "store_not_active", message: expect.any(String) },
      });
      // Orders history still readable; order transitions still gated as mutations.
      expect((await api(`/stores/store_verify_b10_c/orders`, {}, jarC)).status).toBe(200);
      const transition = await api(`/stores/store_verify_b10_c/orders/order_verify_b10_c/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "confirmed" }),
      }, jarC);
      expect(transition.status).toBe(409);
    }
    // Resume: mutation works again, history intact.
    expect((await api(`${A}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    }, jarC)).status).toBe(200);
    const prod = await api(`/stores/store_verify_b10_c/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Resumed", slug: "b10-resumed", price: 100 }),
    }, jarC);
    expect(prod.status).toBe(201);
    expect(qval(`SELECT COUNT(*) AS n FROM orders WHERE id = 'order_verify_b10_c';`)).toBe("1");
  }, 180_000);

  it("status writes trip the per-user limiter at 31 requests per hour", async () => {
    const jarH = await loginJar("b10h@example.com", PASS);
    for (let i = 0; i < 30; i++) {
      const res = await api("/stores/store_verify_b10_h/status", {
        method: "POST",
        body: JSON.stringify({ status: i % 2 === 0 ? "paused" : "active" }),
      }, jarH);
      expect(res.status, `flip ${i + 1}`).toBe(200);
    }
    const limited = await api("/stores/store_verify_b10_h/status", {
      method: "POST",
      body: JSON.stringify({ status: "paused" }),
    }, jarH);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
    // Per-key isolation, expiry, and reset are covered deterministically in
    // tests/rate-limit.test.ts (status-change bucket row).
  }, 180_000);
});
