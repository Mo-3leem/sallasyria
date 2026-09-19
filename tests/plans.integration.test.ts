// Plans integration suite: admin CRUD + public catalog + subscription
// interplay + plan-limit enforcement. Real workerd + real local D1.
// Fixtures use user_verify_pl_*/store_verify_pl_* (covered by
// scripts/clean-verify.mjs); created plans use unique pl-* codes per run and
// are removed explicitly (the shared cleanup knows no plan prefix).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18887;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const ADMIN_PHONE = "+963900001201";
const MERCHANT_PHONE = "+963900001202";
const PASS = "Plans-Strong-1";
const RUN = Date.now().toString(36);
const code = (n: string) => `pl-${n}-${RUN}`;

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-pltest-"));
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
    return { ok: false, error: String(e.stderr ?? e.message ?? err) };
  }
}

function qrows(res: { result?: unknown[] }): Record<string, unknown>[] {
  const first = res.result?.[0] as { results?: Record<string, unknown>[] } | undefined;
  return first?.results ?? [];
}

function qval(sql: string): unknown {
  const r = d1(sql);
  if (!r.ok) throw new Error(`plans d1 failed: ${r.error}`);
  const rows = qrows(r);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
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

let server: ChildProcess | null = null;
let serverOutput = "";

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Connection: "close",
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

let jarAdmin = "";
let jarMerchant = "";
let premiumId = "";

function cleanTestPlans(): void {
  // Subscriptions first (plan RESTRICT), then the plans themselves. Scoped
  // to this file's pl-* codes, excluding the seeded 'pl-plan' fixture.
  d1(`DELETE FROM subscriptions WHERE plan_id IN (SELECT id FROM plans WHERE code LIKE 'pl-%' AND code != 'pl-plan');`);
  d1(`DELETE FROM plans WHERE code LIKE 'pl-%' AND code != 'pl-plan';`);
}

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

  assertCleanVerify("plans reset");
  cleanTestPlans();
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pl_admin', '${ADMIN_PHONE}', 'pladmin@example.com', 'PL Admin', '${h}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pl_m', '${MERCHANT_PHONE}', 'plm@example.com', 'PL Merchant', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_pl', 'pl-plan', 'PL Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_pl_a', 'user_verify_pl_m', 'pl-store-a', 'PL Store A');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_pl_b', 'user_verify_pl_m', 'pl-store-b', 'PL Store B');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_pl_a', 'store_verify_pl_a', 'plan_verify_pl', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`plans seed failed: ${r.error}`);
  }
  async function loginCookie(phone: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ phone, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`plans setup login failed for ${phone}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarAdmin = await loginCookie(ADMIN_PHONE);
  jarMerchant = await loginCookie(MERCHANT_PHONE);
}, 180_000);

afterAll(async () => {
  cleanTestPlans();
  if (server && server.exitCode === null) {
    try {
      if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill("SIGTERM");
    } catch { /* best effort */ }
  }
  server = null;
  assertCleanVerify("plans cleanup");
}, 120_000);

describe("admin plan CRUD", () => {
  it("creates a plan with server-generated id", async () => {
    const res = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: code("premium"), name: "Premium", price_monthly: 250000, price_yearly: 2500000, max_products: 500 }),
    }, jarAdmin);
    expect(res.status).toBe(201);
    const plan = (res.body as { data: { plan: Record<string, unknown> } }).data.plan;
    expect(plan.code).toBe(code("premium"));
    expect(plan.name).toBe("Premium");
    expect(plan.price_monthly).toBe(250000);
    expect(plan.price_yearly).toBe(2500000);
    expect(plan.max_products).toBe(500);
    expect(typeof plan.id).toBe("string");
    premiumId = plan.id as string;
  });

  it("lists plans including the created one", async () => {
    const res = await api("/admin/plans", {}, jarAdmin);
    expect(res.status).toBe(200);
    const plans = (res.body as { data: { plans: { code: string }[] } }).data.plans;
    expect(plans.map((p) => p.code)).toContain(code("premium"));
  });

  it("gets one plan; unknown id is 404", async () => {
    const res = await api(`/admin/plans/${premiumId}`, {}, jarAdmin);
    expect(res.status).toBe(200);
    expect((res.body as { data: { plan: { id: string } } }).data.plan.id).toBe(premiumId);
    const missing = await api("/admin/plans/no-such-plan", {}, jarAdmin);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      ok: false,
      error: { code: "plan_not_found", message: expect.any(String) },
    });
  });

  it("duplicate code is 409 plan_code_taken", async () => {
    const res = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: code("premium"), name: "Clone", price_monthly: 1, price_yearly: 1 }),
    }, jarAdmin);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "plan_code_taken", message: expect.any(String) },
    });
  });

  it("invalid bodies are 400 validation envelopes", async () => {
    for (const body of [
      { code: "Bad Code!!", name: "X" },
      { code: code("neg"), name: "X", price_monthly: -1 },
      { code: code("zero"), name: "X", max_products: 0 },
      { name: "NoCode" },
    ]) {
      const res = await api("/admin/plans", { method: "POST", body: JSON.stringify(body) }, jarAdmin);
      expect(res.status).toBe(400);
      expect((res.body as { ok: boolean; error: { code: string } }).error.code).toBe("validation_failed");
    }
  });

  it("code and id are immutable on update", async () => {
    for (const body of [{ code: "new-code" }, { id: "forged" }]) {
      const res = await api(`/admin/plans/${premiumId}`, { method: "PATCH", body: JSON.stringify(body) }, jarAdmin);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "immutable_field", message: expect.any(String) },
      });
    }
  });

  it("updates whitelisted fields; unknown plan is 404", async () => {
    const res = await api(`/admin/plans/${premiumId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Premium Plus", price_monthly: 300000, max_products: null }),
    }, jarAdmin);
    expect(res.status).toBe(200);
    const plan = (res.body as { data: { plan: Record<string, unknown> } }).data.plan;
    expect(plan.name).toBe("Premium Plus");
    expect(plan.price_monthly).toBe(300000);
    expect(plan.max_products).toBeNull();
    expect(plan.code).toBe(code("premium"));
    const missing = await api("/admin/plans/no-such-plan", { method: "PATCH", body: JSON.stringify({ name: "X" }) }, jarAdmin);
    expect(missing.status).toBe(404);
  });

  it("non-admin and anonymous callers are rejected", async () => {
    expect((await api("/admin/plans", {}, jarMerchant)).status).toBe(403);
    expect((await api("/admin/plans")).status).toBe(401);
    expect((await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: code("nope"), name: "Nope" }),
    }, jarMerchant)).status).toBe(403);
  });
}, 90_000);

describe("plan delete + subscription interplay", () => {
  it("deletes an unreferenced plan; second delete is 404", async () => {
    const created = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: code("doomed"), name: "Doomed" }),
    }, jarAdmin);
    expect(created.status).toBe(201);
    const id = (created.body as { data: { plan: { id: string } } }).data.plan.id;
    const del = await api(`/admin/plans/${id}`, { method: "DELETE" }, jarAdmin);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, data: { deleted: id } });
    expect((await api(`/admin/plans/${id}`, { method: "DELETE" }, jarAdmin)).status).toBe(404);
  });

  it("referenced plan is 409 with count; subscription price untouched by plan edits", async () => {
    const created = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: code("refd"), name: "Referenced", price_monthly: 1000, price_yearly: 10000 }),
    }, jarAdmin);
    const id = (created.body as { data: { plan: { id: string } } }).data.plan.id;
    const ins = d1(
      `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at) VALUES ('sub_verify_pl_ref', 'store_verify_pl_b', '${id}', 'active', 'monthly', 1000, '2026-01-01T00:00:00Z');`
    );
    if (!ins.ok) throw new Error(`ref subscription failed: ${ins.error}`);
    const del = await api(`/admin/plans/${id}`, { method: "DELETE" }, jarAdmin);
    expect(del.status).toBe(409);
    expect(del.body).toEqual({
      ok: false,
      error: { code: "plan_in_use", message: expect.stringContaining("1 subscription(s)") },
    });
    // Plan price edits never rewrite the subscription's own price_amount.
    const upd = await api(`/admin/plans/${id}`, { method: "PATCH", body: JSON.stringify({ price_monthly: 9999 }) }, jarAdmin);
    expect(upd.status).toBe(200);
    expect(qval(`SELECT price_amount FROM subscriptions WHERE id = 'sub_verify_pl_ref';`)).toBe(1000);
    // Cleanup: cancel the subscription, then the plan deletes cleanly.
    const subs = qrows(d1(`SELECT id FROM subscriptions WHERE plan_id = '${id}';`));
    expect(subs.map((s) => s.id)).toContain("sub_verify_pl_ref");
    const cancelled = d1(`DELETE FROM subscriptions WHERE id = 'sub_verify_pl_ref';`);
    if (!cancelled.ok) throw new Error(`ref cleanup failed: ${cancelled.error}`);
    expect((await api(`/admin/plans/${id}`, { method: "DELETE" }, jarAdmin)).status).toBe(200);
  });
}, 90_000);

describe("public plan catalog", () => {
  it("GET /plans needs no auth and exposes public fields only", async () => {
    const res = await api("/plans");
    expect(res.status).toBe(200);
    const plans = (res.body as { data: { plans: Record<string, unknown>[] } }).data.plans;
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(Object.keys(p).sort()).toEqual(
        ["code", "id", "max_products", "name", "price_monthly", "price_yearly"]
      );
    }
    expect(plans.map((p) => p.code)).toContain(code("premium"));
  });

  it("max_products null survives create and read paths", async () => {
    const res = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: code("opennull"), name: "OpenNull", max_products: null }),
    }, jarAdmin);
    expect(res.status).toBe(201);
    expect((res.body as { data: { plan: { max_products: unknown } } }).data.plan.max_products).toBeNull();
    const id = (res.body as { data: { plan: { id: string } } }).data.plan.id;
    expect(qval(`SELECT max_products FROM plans WHERE id = '${id}';`)).toBeNull();
    const pub = await api("/plans");
    const found = ((pub.body as { data: { plans: { code: string; max_products: unknown }[] } }).data.plans)
      .find((p) => p.code === code("opennull"));
    expect(found?.max_products).toBeNull();
  });
}, 90_000);

describe("plan-limit enforcement on the new plans", () => {
  it("max_products=1 allows one product, rejects the second with 409", async () => {
    const created = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: code("solo"), name: "Solo", max_products: 1 }),
    }, jarAdmin);
    expect(created.status).toBe(201);
    const planId = (created.body as { data: { plan: { id: string } } }).data.plan.id;
    const sub = d1(
      `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at) VALUES ('sub_verify_pl_solo', 'store_verify_pl_b', '${planId}', 'active', 'monthly', '2026-01-01T00:00:00Z');`
    );
    if (!sub.ok) throw new Error(`solo subscription failed: ${sub.error}`);
    const first = await api("/stores/store_verify_pl_b/products", {
      method: "POST",
      body: JSON.stringify({ name: "Solo One", slug: "pl-solo-one", price: 1000 }),
    }, jarMerchant);
    expect(first.status).toBe(201);
    const second = await api("/stores/store_verify_pl_b/products", {
      method: "POST",
      body: JSON.stringify({ name: "Solo Two", slug: "pl-solo-two", price: 1000 }),
    }, jarMerchant);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      ok: false,
      error: { code: "plan_limit", message: expect.any(String) },
    });
    const gone = d1(`DELETE FROM subscriptions WHERE id = 'sub_verify_pl_solo';`);
    if (!gone.ok) throw new Error(`solo cleanup failed: ${gone.error}`);
  });
}, 90_000);
