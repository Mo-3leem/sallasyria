// Admin account management integration suite: merchant/customer search,
// view, edit, password reset, and constrained deletes, plus the full
// authorization matrix. Real workerd + real local D1. Fixtures use
// user_verify_b9_* (covered by scripts/clean-verify.mjs).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18882;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PASS = "AdminAcct-Strong-1";
const ADMIN_PHONE = "+963900000831";
const ADMIN_EMAIL = "b9admin@example.com";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b9test-"));
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
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

let jarAdmin = "";
let jarMerchantB = "";

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
  assertCleanVerify("b9 reset");
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9_admin', '${ADMIN_PHONE}', '${ADMIN_EMAIL}', 'B9 Admin', '${h}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9_ma', '+963900000832', 'b9ma@example.com', 'B9 Merchant A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9_mb', '+963900000833', 'b9mb@example.com', 'B9 Merchant B', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9_md', '+963900000835', 'b9md@example.com', 'B9 Merchant D', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9_admin2', '+963900000836', 'b9admin2@example.com', 'B9 Admin 2', '${h}', 'admin');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b9_sa', 'user_verify_b9_ma', 'b9-store-a', 'B9 Store A');`,
    `INSERT INTO customers (id, store_id, name, phone, email) VALUES ('cust_verify_b9_a1', 'store_verify_b9_sa', 'Cust A1', '+963900000841', 'b9a1@example.com');`,
    `INSERT INTO customers (id, store_id, name, phone, email) VALUES ('cust_verify_b9_a2', 'store_verify_b9_sa', 'Cust A2', '+963900000842', 'b9a2@example.com');`,
    `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('ord_verify_b9_1', 'store_verify_b9_sa', 'cust_verify_b9_a2', 1, 'Cust A2', '+963900000842', 'Standard', 'Damascus', 'Street 1');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9_me', '+963900000837', 'b9me@example.com', 'B9 Merchant E', '${h}', 'merchant');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b9_se1', 'user_verify_b9_me', 'b9-store-e1', 'B9 Store E1');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b9_se2', 'user_verify_b9_me', 'b9-store-e2', 'B9 Store E2');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b9_se3', 'user_verify_b9_me', 'b9-store-e3', 'B9 Store E3');`,
    `INSERT INTO customers (id, store_id, name, phone, email) VALUES ('cust_verify_b9_e1', 'store_verify_b9_se2', 'Cust E1', '+963900000843', 'b9e1@example.com');`,
    `INSERT INTO orders (id, store_id, customer_id, order_number, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address) VALUES ('ord_verify_b9_e1', 'store_verify_b9_se2', 'cust_verify_b9_e1', 1, 'Cust E1', '+963900000843', 'Standard', 'Damascus', 'Street 1');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b9_e', 'b9e-plan', 'B9E Plan');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b9_e3', 'store_verify_b9_se3', 'plan_verify_b9_e', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B9 seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id LIKE 'user_verify_b9_%';`);

  async function loginCookie(email: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`B9 setup login failed for ${email}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarAdmin = await loginCookie(ADMIN_EMAIL);
  jarMerchantB = await loginCookie("b9mb@example.com");
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b9 end");
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

const MERCHANTS = "/admin/merchants";
const M_A = `${MERCHANTS}/user_verify_b9_ma`;
const M_B = `${MERCHANTS}/user_verify_b9_mb`;
const M_D = `${MERCHANTS}/user_verify_b9_md`;
const CUST = "/admin/stores/store_verify_b9_sa/customers";
const C_A1 = `${CUST}/cust_verify_b9_a1`;
const C_A2 = `${CUST}/cust_verify_b9_a2`;
const M_E = `${MERCHANTS}/user_verify_b9_me`;
const SE1 = `${M_E}/stores/store_verify_b9_se1`;
const SE2 = `${M_E}/stores/store_verify_b9_se2`;
const SE3 = `${M_E}/stores/store_verify_b9_se3`;

describe("admin accounts authorization matrix", () => {
  const probes: [string, RequestInit][] = [
    [MERCHANTS, {}],
    [M_A, {}],
    [`${MERCHANTS}/user_verify_b9_ma`, { method: "PATCH", body: JSON.stringify({ name: "X" }) }],
    [`${MERCHANTS}/user_verify_b9_mb`, { method: "DELETE" }],
    [CUST, {}],
    [C_A1, {}],
    [C_A1, { method: "PATCH", body: JSON.stringify({ name: "X" }) }],
    [C_A1, { method: "DELETE" }],
    [SE1, { method: "DELETE" }],
  ];
  it("anonymous gets 401 on every management route", async () => {
    for (const [path, init] of probes) {
      const res = await api(path, init);
      expect(res.status, path).toBe(401);
    }
  });
  it("merchant gets 403 on every management route", async () => {
    for (const [path, init] of probes) {
      const res = await api(path, init, jarMerchantB);
      expect(res.status, path).toBe(403);
    }
  });
});

describe("admin merchants", () => {
  it("lists merchants without admins; searches by email and phone", async () => {
    const all = await api(MERCHANTS, {}, jarAdmin);
    expect(all.status).toBe(200);
    const list = (all.body as { data: { merchants: { id: string; role: string }[] } }).data.merchants;
    expect(list.some((m) => m.id === "user_verify_b9_ma")).toBe(true);
    expect(list.every((m) => m.role === "merchant")).toBe(true);

    const byEmail = await api(`${MERCHANTS}?q=${encodeURIComponent("b9ma@example.com")}`, {}, jarAdmin);
    expect(
      (byEmail.body as { data: { merchants: { id: string }[] } }).data.merchants.map((m) => m.id)
    ).toContain("user_verify_b9_ma");

    const byPhone = await api(`${MERCHANTS}?q=${encodeURIComponent("0900000832")}`, {}, jarAdmin);
    expect(
      (byPhone.body as { data: { merchants: { id: string }[] } }).data.merchants.map((m) => m.id)
    ).toContain("user_verify_b9_ma");

    const none = await api(`${MERCHANTS}?q=${encodeURIComponent("ghost@example.com")}`, {}, jarAdmin);
    expect((none.body as { data: { merchants: unknown[] } }).data.merchants).toEqual([]);
  });

  it("matches email/phone prefixes; middle substrings do not match", async () => {
    async function ids(q: string): Promise<string[]> {
      const res = await api(`${MERCHANTS}?q=${encodeURIComponent(q)}`, {}, jarAdmin);
      expect(res.status).toBe(200);
      return (res.body as { data: { merchants: { id: string }[] } }).data.merchants.map((m) => m.id);
    }
    // Email prefix, and case-insensitive prefix.
    expect(await ids("b9ma")).toContain("user_verify_b9_ma");
    expect(await ids("B9MA@EXAMPLE")).toContain("user_verify_b9_ma");
    // Phone prefix in canonical and national form.
    expect(await ids("+9639000008")).toContain("user_verify_b9_ma");
    expect(await ids("0900000832")).toContain("user_verify_b9_ma");
    // Middle-only substrings must NOT match ("000083" is too short to
    // normalize, so only the raw prefix applies — and it is not one).
    expect(await ids("ma@example")).not.toContain("user_verify_b9_ma");
    expect(await ids("example.com")).toEqual([]);
    expect(await ids("000083")).not.toContain("user_verify_b9_ma");
    // Literal wildcards match literally (no wildcard injection).
    expect(await ids("b9ma%")).toEqual([]);
    expect(await ids("%")).toEqual([]);
    // Unrelated fragment still matches nothing.
    expect(await ids("zzz-no-such-merchant")).toEqual([]);
  });

  it("gets a merchant with stores; admin rows and unknown ids 404", async () => {
    const res = await api(M_A, {}, jarAdmin);
    expect(res.status).toBe(200);
    const body = res.body as { data: { merchant: { id: string }; stores: { id: string }[] } };
    expect(body.data.merchant.id).toBe("user_verify_b9_ma");
    expect(body.data.stores.map((s) => s.id)).toContain("store_verify_b9_sa");

    expect((await api(`${MERCHANTS}/user_verify_b9_admin`, {}, jarAdmin)).status).toBe(404);
    expect((await api(`${MERCHANTS}/user_verify_nope`, {}, jarAdmin)).status).toBe(404);
  });

  it("edits allowed fields; duplicates 409; role is 400", async () => {
    const res = await api(M_A, {
      method: "PATCH",
      body: JSON.stringify({ name: "B9 Merchant A Edited", phone: "0900000839" }),
    }, jarAdmin);
    expect(res.status).toBe(200);
    expect((res.body as { data: { merchant: { name: string; phone: string } } }).data.merchant).toMatchObject({
      name: "B9 Merchant A Edited",
      phone: "+963900000839",
    });

    const dup = await api(M_A, {
      method: "PATCH",
      body: JSON.stringify({ phone: "+963900000833" }),
    }, jarAdmin);
    expect(dup.status).toBe(409);

    const role = await api(M_A, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    }, jarAdmin);
    expect(role.status).toBe(400);

    const back = await api(M_A, {
      method: "PATCH",
      body: JSON.stringify({ name: "B9 Merchant A", phone: "+963900000832" }),
    }, jarAdmin);
    expect(back.status).toBe(200);
  });

  it("resets a merchant password and revokes their sessions", async () => {
    const login = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "b9md@example.com", password: PASS }),
    });
    const jarD = cookieOf(login.headers.get("set-cookie"));
    const reset = await api(`/admin/users/user_verify_b9_md/password`, {
      method: "POST",
      body: JSON.stringify({ new_password: "Reset-Strong-9" }),
    }, jarAdmin);
    expect(reset.status).toBe(200);
    expect((await api("/auth/me", {}, jarD)).status).toBe(401);
    const relogin = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "b9md@example.com", password: "Reset-Strong-9" }),
    });
    expect(relogin.status).toBe(200);
  });
});

describe("admin customers", () => {
  it("lists and searches a merchant's customers", async () => {
    const all = await api(CUST, {}, jarAdmin);
    expect(all.status).toBe(200);
    expect(
      (all.body as { data: { customers: { id: string }[] } }).data.customers.map((c) => c.id).sort()
    ).toEqual(["cust_verify_b9_a1", "cust_verify_b9_a2"]);

    const byEmail = await api(`${CUST}?q=${encodeURIComponent("b9a2@example.com")}`, {}, jarAdmin);
    expect(
      (byEmail.body as { data: { customers: { id: string }[] } }).data.customers.map((c) => c.id)
    ).toEqual(["cust_verify_b9_a2"]);

    const unknownStore = await api("/admin/stores/store_verify_nope/customers", {}, jarAdmin);
    expect(unknownStore.status).toBe(404);
  });

  it("views and edits a customer", async () => {
    const get = await api(C_A1, {}, jarAdmin);
    expect(get.status).toBe(200);
    const upd = await api(C_A1, {
      method: "PATCH",
      body: JSON.stringify({ name: "Cust A1 Edited" }),
    }, jarAdmin);
    expect(upd.status).toBe(200);
    expect((upd.body as { data: { customer: { name: string } } }).data.customer.name).toBe("Cust A1 Edited");

    const dup = await api(C_A1, {
      method: "PATCH",
      body: JSON.stringify({ phone: "+963900000842" }),
    }, jarAdmin);
    expect(dup.status).toBe(409);
  });

  it("deletes an order-free customer; order history blocks deletion", async () => {
    const blocked = await api(C_A2, { method: "DELETE" }, jarAdmin);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({
      ok: false,
      error: { code: "customer_has_orders", message: expect.any(String) },
    });

    const del = await api(C_A1, { method: "DELETE" }, jarAdmin);
    expect(del.status).toBe(200);
    expect((await api(C_A1, {}, jarAdmin)).status).toBe(404);
  });
});

describe("admin merchant store deletion", () => {
  it("rejects cross-merchant and unknown stores with 404", async () => {
    // SA belongs to merchant A, not B: answering anything but 404 would leak.
    expect(
      (await api(`${MERCHANTS}/user_verify_b9_mb/stores/store_verify_b9_sa`, { method: "DELETE" }, jarAdmin)).status
    ).toBe(404);
    expect(
      (await api(`${M_E}/stores/store_verify_nope`, { method: "DELETE" }, jarAdmin)).status
    ).toBe(404);
    // SA must be untouched by the attempts above.
    expect((await api(`${M_E}/stores/store_verify_b9_sa`, { method: "DELETE" }, jarAdmin)).status).toBe(404);
  });

  it("blocks stores with orders and subscriptions with 409", async () => {
    const byOrders = await api(SE2, { method: "DELETE" }, jarAdmin);
    expect(byOrders.status).toBe(409);
    expect(byOrders.body).toEqual({
      ok: false,
      error: { code: "store_has_orders", message: expect.any(String) },
    });
    const bySub = await api(SE3, { method: "DELETE" }, jarAdmin);
    expect(bySub.status).toBe(409);
    expect(bySub.body).toEqual({
      ok: false,
      error: { code: "store_has_subscriptions", message: expect.any(String) },
    });
    // Neither store was touched.
    const detail = await api(M_E, {}, jarAdmin);
    expect(
      ((detail.body as { data: { stores: { id: string }[] } }).data.stores.map((s) => s.id).sort())
    ).toEqual(["store_verify_b9_se1", "store_verify_b9_se2", "store_verify_b9_se3"]);
  });

  it("deletes an empty store, then the merchant once storeless", async () => {
    const del = await api(SE1, { method: "DELETE" }, jarAdmin);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, data: { deleted: "store_verify_b9_se1" } });

    const detail = await api(M_E, {}, jarAdmin);
    expect(
      ((detail.body as { data: { stores: { id: string }[] } }).data.stores.map((s) => s.id).sort())
    ).toEqual(["store_verify_b9_se2", "store_verify_b9_se3"]);

    // Merchant still owns stores: still blocked.
    const blocked = await api(M_E, { method: "DELETE" }, jarAdmin);
    expect(blocked.status).toBe(409);
  });
});

describe("admin merchant deletion", () => {
  it("refuses other admins through merchant management and self-delete", async () => {
    expect((await api(`${MERCHANTS}/user_verify_b9_admin2`, {}, jarAdmin)).status).toBe(404);
    expect((await api(`${MERCHANTS}/user_verify_b9_admin2`, { method: "DELETE" }, jarAdmin)).status).toBe(404);
    const self = await api(`${MERCHANTS}/user_verify_b9_admin`, { method: "DELETE" }, jarAdmin);
    expect(self.status).toBe(403);
  });

  it("blocks deleting a merchant that owns stores", async () => {
    const res = await api(M_A, { method: "DELETE" }, jarAdmin);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "merchant_has_stores", message: expect.any(String) },
    });
    expect((await api(M_A, {}, jarAdmin)).status).toBe(200);
  });

  it("deletes a storeless merchant and revokes their sessions", async () => {
    const login = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "b9mb@example.com", password: PASS }),
    });
    const jarB = cookieOf(login.headers.get("set-cookie"));
    const del = await api(M_B, { method: "DELETE" }, jarAdmin);
    expect(del.status).toBe(200);
    expect((await api(M_B, {}, jarAdmin)).status).toBe(404);
    expect((await api("/auth/me", {}, jarB)).status).toBe(401);
  });
});
