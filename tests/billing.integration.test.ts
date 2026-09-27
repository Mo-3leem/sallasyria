// Billing integration suite: Phase 8 self-serve billing on the stub
// provider + trial grants. Real workerd + real local D1. Fixtures use
// user_verify_bill_* (covered by scripts/clean-verify.mjs); API-created
// stores get random ids and are deleted explicitly in afterAll.
// The dev server boots with TRIAL_PLAN_CODE=bill-plan so trials reference
// the fixture plan, never seed data.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { stubTokenFor } from "../src/lib/billing/stub.js";
import { realProvider } from "../src/lib/billing/real.js";
import { selectProvider } from "../src/lib/billing/registry.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";
import { AppError } from "../src/http/errors.js";

const PORT = 18889;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PASS = "Billing-Strong-1";
const MERCHANT_EMAIL = "billm@example.com";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-billtest-"));
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

function qval(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-billq-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const out = execFileSync(isWindows ? "npx.cmd" : "npx", ["wrangler", "d1", "execute", "sallasyria-db", "--local", "--json", "--file", file], {
    encoding: "utf8",
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
  });
  const parsed = JSON.parse(out) as { results: Record<string, unknown>[] }[];
  return String(parsed[0]?.results[0] ? Object.values(parsed[0].results[0])[0] : "");
}



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
  return { status: res.status, body, headers: res.headers };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

let jarMerchant = "";

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    env: { ...process.env, TRIAL_PLAN_CODE: "bill-plan" },
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("billing reset");
  const h = hashPassword(PASS);
  for (const sql of [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_bill', '+963990001501', '${MERCHANT_EMAIL}', 'Bill Merchant', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products) VALUES ('plan_verify_bill', 'bill-plan', 'Bill Plan', 50000, 500000, 100);`,
    // Trial-plan fixture for POST /stores auto-grant (TRIAL_PLAN_CODE
    // defaults to "basic", which lives only in seed.mjs). Uses seed.mjs's
    // own identity/values so the seed determinism suite (wipes `seed-%`
    // first) and reruns (ON CONFLICT) stay green. Outside the
    // assertCleanVerify prefixes, so it is never wiped mid-run.
    `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products) VALUES ('seed-plan-basic', 'basic', 'Basic', 50000, 500000, 100) ON CONFLICT(code) DO NOTHING;`,
  ]) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`billing seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_bill';`);
  const login = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: MERCHANT_EMAIL, password: PASS }),
  });
  if (login.status !== 200) throw new Error("billing setup login failed");
  jarMerchant = cookieOf(login.headers.get("set-cookie"));
}, 180_000);

afterAll(async () => {
  // Explicit teardown: API-created stores carry random ids outside the
  // assertCleanVerify prefixes, so remove everything by slug/user prefix.
  d1(`DELETE FROM billing_intents WHERE store_id IN (SELECT id FROM stores WHERE slug LIKE 'bill-%');`);
  d1(`DELETE FROM subscriptions WHERE store_id IN (SELECT id FROM stores WHERE slug LIKE 'bill-%');`);
  d1(`DELETE FROM stores WHERE slug LIKE 'bill-%';`);
  d1(`DELETE FROM users WHERE id = 'user_verify_bill';`);
  d1(`DELETE FROM plans WHERE id = 'plan_verify_bill';`);
    stopDevServer(server);
    server = null;
  assertCleanVerify("billing cleanup");
}, 120_000);

describe("billing provider units (no server)", () => {
  it("stub webhook token is dev-only", async () => {
    const token = await stubTokenFor("intent_abc");
    const req = new Request("http://x/billing/webhook/stub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent_id: "intent_abc", stub_token: token }),
    });
    const okRes = await (await import("../src/lib/billing/stub.js")).stubProvider.verifyWebhook(req, { ENVIRONMENT: "development" } as never);
    expect(okRes.intentId).toBe("intent_abc");
    expect(okRes.success).toBe(true);
    await expect(
      (await import("../src/lib/billing/stub.js")).stubProvider.verifyWebhook(req, { ENVIRONMENT: "production" } as never)
    ).rejects.toMatchObject({ status: 400 });
    const bad = new Request("http://x/billing/webhook/stub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent_id: "intent_abc", stub_token: "forged" }),
    });
    await expect(
      (await import("../src/lib/billing/stub.js")).stubProvider.verifyWebhook(bad, { ENVIRONMENT: "development" } as never)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("real adapter fails closed without keys; unknown provider 404s", async () => {
    const empty = {};
    await expect(
      realProvider.createIntent(
        {
          intentId: "x", storeId: "s", storeName: "n", planId: "p",
          planName: "pn", billingPeriod: "monthly", amount: 1,
          currency: "SYP", returnUrl: "r", cancelUrl: "c",
        },
        empty as never
      )
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      realProvider.verifyWebhook(new Request("http://x/", { method: "POST", body: "{}" }), empty as never)
    ).rejects.toMatchObject({ status: 503 });
    try {
      selectProvider("nope");
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).status).toBe(404);
    }
  });
});

describe("trial on store creation", () => {
  it("POST /stores grants a 14-day trialing period covering writes", async () => {
    const created = await api("/stores", {
      method: "POST",
      body: JSON.stringify({ name: "Bill Store", slug: "bill-store" }),
    }, jarMerchant);
    expect(created.status).toBe(201);
    const trial = (created.body as { data: { trial: { status: string; ends_at: string } | null } }).data.trial;
    expect(trial).not.toBeNull();
    expect(trial?.status).toBe("trialing");
    expect(Date.parse(trial?.ends_at ?? "")).toBeGreaterThan(Date.now());
    // Gate coverage proven: a merchant write succeeds on the trial.
    const renamed = await api(`/stores/${(created.body as { data: { store: { id: string } } }).data.store.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Bill Store Renamed" }),
    }, jarMerchant);
    expect(renamed.status).toBe(200);
  }, 90_000);

  it("expired trial blocks merchant writes", async () => {
    const created = await api("/stores", {
      method: "POST",
      body: JSON.stringify({ name: "Bill Expiry", slug: "bill-expiry" }),
    }, jarMerchant);
    expect(created.status).toBe(201);
    const storeId = (created.body as { data: { store: { id: string } } }).data.store.id;
    d1(`UPDATE subscriptions SET ends_at = '2020-01-01T00:00:00Z' WHERE store_id = '${storeId}';`);
    const blocked = await api(`/stores/${storeId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Nope" }),
    }, jarMerchant);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({
      ok: false,
      error: { code: "subscription_inactive", message: expect.any(String) },
    });
  }, 90_000);
});

describe("checkout intents + stub webhook", () => {
  it("rejects client money; replays idempotent keys; 422 on conflict", async () => {
    const stores = await api("/stores", {}, jarMerchant);
    const storeId = ((stores.body as { data: { stores: { id: string; slug: string }[] } }).data.stores)
      .find((s) => s.slug === "bill-store")!.id;

    const tampered = await api(`/stores/${storeId}/subscriptions/checkout`, {
      method: "POST",
      body: JSON.stringify({ plan_id: "plan_verify_bill", billing_period: "monthly", amount: 1 }),
    }, jarMerchant);
    expect(tampered.status).toBe(400);

    const first = await api(`/stores/${storeId}/subscriptions/checkout`, {
      method: "POST",
      headers: { "X-Idempotency-Key": "bill-key-1" },
      body: JSON.stringify({ plan_id: "plan_verify_bill", billing_period: "monthly" }),
    }, jarMerchant);
    expect(first.status).toBe(201);
    const intentId = (first.body as { data: { intent_id: string } }).data.intent_id;
    expect(
      (first.body as { data: { redirect_url: string } }).data.redirect_url
    ).toContain(encodeURIComponent(intentId));

    const replay = await api(`/stores/${storeId}/subscriptions/checkout`, {
      method: "POST",
      headers: { "X-Idempotency-Key": "bill-key-1" },
      body: JSON.stringify({ plan_id: "plan_verify_bill", billing_period: "monthly" }),
    }, jarMerchant);
    expect(replay.status).toBe(200);
    expect((replay.body as { data: { intent_id: string } }).data.intent_id).toBe(intentId);

    const conflict = await api(`/stores/${storeId}/subscriptions/checkout`, {
      method: "POST",
      headers: { "X-Idempotency-Key": "bill-key-1" },
      body: JSON.stringify({ plan_id: "plan_verify_bill", billing_period: "yearly" }),
    }, jarMerchant);
    expect(conflict.status).toBe(422);
  }, 120_000);

  it("stub success activates exactly once; replays collapse; bad signature 400s", async () => {
    const stores = await api("/stores", {}, jarMerchant);
    const storeId = ((stores.body as { data: { stores: { id: string; slug: string }[] } }).data.stores)
      .find((s) => s.slug === "bill-store")!.id;

    const mk = await api(`/stores/${storeId}/subscriptions/checkout`, {
      method: "POST",
      headers: { "X-Idempotency-Key": "bill-key-2" },
      body: JSON.stringify({ plan_id: "plan_verify_bill", billing_period: "monthly" }),
    }, jarMerchant);
    expect(mk.status).toBe(201);
    const intentId = (mk.body as { data: { intent_id: string } }).data.intent_id;

    const token = await stubTokenFor(intentId);
    const win = await api(`/billing/webhook/stub`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, stub_token: token }),
    });
    expect(win.status).toBe(200);
    expect(win.body).toEqual({ ok: true, data: { processed: true, activated: true, duplicate: false } });

    const again = await api(`/billing/webhook/stub`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, stub_token: token }),
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, data: { processed: false, activated: true, duplicate: true } });
    expect(qval(`SELECT COUNT(*) AS n FROM subscriptions WHERE store_id = '${storeId}' AND status = 'active';`)).toBe("1");

    // Second intent, same store: concurrent-style double delivery still yields one active.
    const mk2 = await api(`/stores/${storeId}/subscriptions/checkout`, {
      method: "POST",
      headers: { "X-Idempotency-Key": "bill-key-3" },
      body: JSON.stringify({ plan_id: "plan_verify_bill", billing_period: "monthly" }),
    }, jarMerchant);
    const intent2 = (mk2.body as { data: { intent_id: string } }).data.intent_id;
    const token2 = await stubTokenFor(intent2);
    const win2 = await api(`/billing/webhook/stub`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intent2, stub_token: token2 }),
    });
    expect(win2.status).toBe(200);
    expect(qval(`SELECT COUNT(*) AS n FROM subscriptions WHERE store_id = '${storeId}' AND status = 'active';`)).toBe("1");

    const forged = await api(`/billing/webhook/stub`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, stub_token: "forged.token" }),
    });
    expect(forged.status).toBe(400);
    expect(qval(`SELECT COUNT(*) AS n FROM subscriptions WHERE store_id = '${storeId}' AND status = 'active';`)).toBe("1");

    // Polling endpoint reflects the settled intent.
    const poll = await api(`/stores/${storeId}/billing/intents/${intentId}`, {}, jarMerchant);
    expect(poll.status).toBe(200);
    expect(((poll.body as { data: { intent: { status: string } } }).data.intent.status)).toBe("succeeded");
  }, 180_000);

  it("unknown provider path is 404", async () => {
    const res = await api(`/billing/webhook/nope`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  }, 60_000);
});
