// B7 integration suite: forced rotation, subscription admin, assisted reset,
// maintenance purge, seed idempotence. Real workerd + real local D1.
//
// BOOTSTRAP SECRET HANDLING (read carefully): this file writes a throwaway
// .dev.vars containing a TEST-ONLY bootstrap password BEFORE spawning the
// server (wrangler dev reads it at boot), and deletes it in afterAll with an
// existence assertion. The value is unique per run and never the real secret.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18884;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const BOOTSTRAP = `b7-bootstrap-${Date.now().toString(36)}`;
const BOOTSTRAP_PHONE = "+963900000851";
const MERCHANT_PHONE = "+963900000852";
const MERCHANT_PASS = "B7-Merchant-1";
const NEW_ADMIN_PASS = "B7-Rotated-Admin-1";
const DEV_VARS = join(process.cwd(), ".dev.vars");

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b7test-"));
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
  const doFetch = () =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(cookies ? { Cookie: cookies } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    // Local dev-server flakiness triage (not product behavior): if the
    // connection itself failed, determine whether the server is actually
    // dead and, if so, attach its recent output to the failure instead of
    // a bare ECONNRESET. A dead server here means the LOCAL harness lost
    // workerd — never a checkout/auth logic failure.
    let alive = false;
    for (let i = 0; i < 5 && !alive; i++) {
      try {
        const probe = await fetch(`${BASE}/health`);
        alive = probe.ok;
      } catch { /* still down */ }
      if (!alive) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!alive) {
      throw new Error(
        `dev server unreachable during ${path}: ${String(err)}\n--- server tail ---\n${serverOutput.slice(-3000)}`
      );
    }
    res = await doFetch();
  }
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

async function loginCookie(phone: string, password: string) {
  const res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone, password }),
  });
  if (res.status !== 200) throw new Error(`B7 setup login failed for ${phone}: ${res.status}`);
  return { jar: cookieOf(res.headers.get("set-cookie")), body: res.body };
}

let jarBootstrap = "";

beforeAll(async () => {
  if (existsSync(DEV_VARS)) {
    throw new Error("refusing to overwrite an existing .dev.vars (real secrets risk)");
  }
  writeFileSync(DEV_VARS, `ADMIN_BOOTSTRAP_PASSWORD=${BOOTSTRAP}\n`, "utf8");

  server = spawn(isWindows ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    windowsHide: true,
  });
  server.stdout?.on("data", (d) => { serverOutput += String(d); });
  server.stderr?.on("data", (d) => { serverOutput += String(d); });
  await waitForHealth();

  assertCleanVerify("b7 reset");
  const bHash = hashPassword(BOOTSTRAP);
  const mHash = hashPassword(MERCHANT_PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b7_admin', '${BOOTSTRAP_PHONE}', 'b7admin@example.com', 'B7 Bootstrap Admin', '${bHash}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b7_merchant', '${MERCHANT_PHONE}', 'b7m@example.com', 'B7 Merchant', '${mHash}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b7', 'b7-plan', 'B7 Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b7', 'user_verify_b7_merchant', 'b7-store', 'B7 Store');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at) VALUES ('sub_verify_b7_old', 'store_verify_b7', 'plan_verify_b7', 'expired', 'monthly', '2026-01-01T00:00:00Z');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B7 seed failed: ${r.error}`);
  }
  const login = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: BOOTSTRAP_PHONE, password: BOOTSTRAP }),
  });
  if (login.status !== 200) throw new Error(`B7 bootstrap login failed: ${login.status}`);
  jarBootstrap = cookieOf(login.headers.get("set-cookie"));
  const flag = (login.body as { data: { must_rotate?: boolean } }).data.must_rotate;
  if (flag !== true) throw new Error("B7 setup: expected must_rotate=true for bootstrap admin");
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b7 end");
  } finally {
    if (server && server.exitCode === null) {
      try {
        if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        else server.kill("SIGTERM");
      } catch { /* best effort */ }
    }
    server = null;
    if (existsSync(DEV_VARS)) rmSync(DEV_VARS, { force: true });
    if (existsSync(DEV_VARS)) throw new Error(".dev.vars was not removed");
  }
}, 60_000);

describe("B7 forced rotation", () => {
  it("bootstrap admin is flagged and gated everywhere but rotate/me/logout", async () => {
    const gated = await api("/stores", {}, jarBootstrap);
    expect(gated.status).toBe(403);
    expect(gated.body).toEqual({
      ok: false,
      error: { code: "credentials_rotation_required", message: expect.any(String) },
    });
    expect((await api("/auth/me", {}, jarBootstrap)).status).toBe(200);

    const weak = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: BOOTSTRAP, new_password: "short" }),
    }, jarBootstrap);
    expect(weak.status).toBe(400);

    const wrong = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "Wrong-1", new_password: NEW_ADMIN_PASS }),
    }, jarBootstrap);
    expect(wrong.status).toBe(401);

    const changed = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: BOOTSTRAP, new_password: NEW_ADMIN_PASS }),
    }, jarBootstrap);
    expect(changed.status).toBe(200);

    const relogin = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: BOOTSTRAP_PHONE, password: NEW_ADMIN_PASS }),
    });
    expect(relogin.status).toBe(200);
    expect((relogin.body as { data: { must_rotate?: boolean } }).data.must_rotate).toBe(false);
    jarBootstrap = cookieOf(relogin.headers.get("set-cookie"));

    // old bootstrap credential is dead
    const stale = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: BOOTSTRAP_PHONE, password: BOOTSTRAP }),
    });
    expect(stale.status).toBe(401);

    // gate cleared: admin reads now pass
    expect((await api("/stores", {}, jarBootstrap)).status).toBe(200);
  }, 120_000);

  it("rotation revokes the admin's other sessions", async () => {
    // fresh bootstrap-state admin pair: second login, rotate via first
    const second = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: BOOTSTRAP_PHONE, password: NEW_ADMIN_PASS }),
    });
    const jarSecond = cookieOf(second.headers.get("set-cookie"));
    // rotate again through the primary session (needs current password)
    const changed = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: NEW_ADMIN_PASS, new_password: "B7-Rotated-Again-2" }),
    }, jarBootstrap);
    expect(changed.status).toBe(200);
    expect((await api("/auth/me", {}, jarSecond)).status).toBe(401);
    expect((await api("/auth/me", {}, jarBootstrap)).status).toBe(200);
    // restore known password for later tests
    const restore = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "B7-Rotated-Again-2", new_password: NEW_ADMIN_PASS }),
    }, jarBootstrap);
    expect(restore.status).toBe(200);
  }, 120_000);
});

describe("B7 subscription admin", () => {
  it("merchant cannot touch admin endpoints", async () => {
    const mLogin = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: MERCHANT_PHONE, password: MERCHANT_PASS }),
    });
    const jarM = cookieOf(mLogin.headers.get("set-cookie"));
    expect((await api("/admin/subscriptions", {}, jarM)).status).toBe(403);
    expect((await api("/admin/subscriptions")).status).toBe(401);
  });

  it("activate -> double-activate 409 -> cancel -> renew keeps append-only history", async () => {
    const created = await api("/admin/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        store_id: "store_verify_b7", plan_id: "plan_verify_b7",
        billing_period: "monthly", price_amount: 50000, payment_reference: "TRX-B7-1",
      }),
    }, jarBootstrap);
    expect(created.status).toBe(201);
    const subId = ((created.body as { data: { subscription: { id: string } } }).data.subscription.id);
    expect(((created.body as { data: { subscription: { payment_reference: string } } }).data.subscription.payment_reference)).toBe("TRX-B7-1");

    const dup = await api("/admin/subscriptions", {
      method: "POST",
      body: JSON.stringify({ store_id: "store_verify_b7", plan_id: "plan_verify_b7", billing_period: "monthly" }),
    }, jarBootstrap);
    expect(dup.status).toBe(409);

    const ghost = await api("/admin/subscriptions", {
      method: "POST",
      body: JSON.stringify({ store_id: "no-such-store", plan_id: "plan_verify_b7", billing_period: "monthly" }),
    }, jarBootstrap);
    expect(ghost.status).toBe(404);

    const cancelled = await api(`/admin/subscriptions/${subId}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    }, jarBootstrap);
    expect(cancelled.status).toBe(200);
    expect(((cancelled.body as { data: { subscription: { status: string; cancelled_at: string } } }).data.subscription.status)).toBe("cancelled");

    const renewed = await api(`/admin/subscriptions/${subId}/renew`, {
      method: "POST",
      body: JSON.stringify({ billing_period: "yearly", payment_reference: "TRX-B7-2" }),
    }, jarBootstrap);
    expect(renewed.status).toBe(201);
    const newId = ((renewed.body as { data: { subscription: { id: string } } }).data.subscription.id);
    expect(newId).not.toBe(subId);

    const history = await api("/admin/subscriptions", {}, jarBootstrap);
    const rows = ((history.body as { data: { subscriptions: { id: string; status: string }[] } }).data.subscriptions)
      .filter((s) => ["sub_verify_b7_old", subId, newId].includes(s.id));
    expect(rows.map((s) => s.status).sort()).toEqual(["active", "cancelled", "expired"]);
  });

  it("cancel is idempotent; renew of missing is 404", async () => {
    const list = await api("/admin/subscriptions", {}, jarBootstrap);
    const rows = ((list.body as { data: { subscriptions: { id: string; status: string }[] } }).data.subscriptions);
    const cancelled = rows.find((s) => s.status === "cancelled");
    expect(cancelled).toBeTruthy();
    const again = await api(`/admin/subscriptions/${cancelled!.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    }, jarBootstrap);
    expect(again.status).toBe(200);
    expect((await api("/admin/subscriptions/no-such-sub/renew", {
      method: "POST",
      body: JSON.stringify({}),
    }, jarBootstrap)).status).toBe(404);
  });
});

describe("B7 assisted reset", () => {
  it("admin resets merchant password; old sessions die; ghost is 404", async () => {
    const m1 = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: MERCHANT_PHONE, password: MERCHANT_PASS }),
    });
    const m2 = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: MERCHANT_PHONE, password: MERCHANT_PASS }),
    });
    const jarM1 = cookieOf(m1.headers.get("set-cookie"));
    const jarM2 = cookieOf(m2.headers.get("set-cookie"));

    const reset = await api("/admin/users/user_verify_b7_merchant/password", {
      method: "POST",
      body: JSON.stringify({ new_password: "B7-Reset-1" }),
    }, jarBootstrap);
    expect(reset.status).toBe(200);

    expect((await api("/auth/me", {}, jarM1)).status).toBe(401);
    expect((await api("/auth/me", {}, jarM2)).status).toBe(401);
    const staleLogin = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: MERCHANT_PHONE, password: MERCHANT_PASS }),
    });
    expect(staleLogin.status).toBe(401);
    const freshLogin = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: MERCHANT_PHONE, password: "B7-Reset-1" }),
    });
    expect(freshLogin.status).toBe(200);

    const ghost = await api("/admin/users/no-such-user/password", {
      method: "POST",
      body: JSON.stringify({ new_password: "B7-Reset-2" }),
    }, jarBootstrap);
    expect(ghost.status).toBe(404);

    const merchantTry = await api("/admin/users/user_verify_b7_merchant/password", {
      method: "POST",
      body: JSON.stringify({ new_password: "B7-Evil-1" }),
    }, cookieOf(freshLogin.headers.get("set-cookie")));
    expect(merchantTry.status).toBe(403);
  }, 120_000);
});

describe("B7 maintenance purge", () => {
  it("purges only eligible rows and reports counts", async () => {
    d1(`INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at) VALUES ('sess_verify_b7_old', 'user_verify_b7_merchant', '${"aa".repeat(32)}', '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z');`);
    d1(`INSERT INTO idempotency_keys (key, store_id, request_hash, created_at) VALUES ('b7-old-key', 'store_verify_b7', '${"bb".repeat(32)}', '2020-01-01T00:00:00Z');`);
    const res = await api("/admin/maintenance/purge", {
      method: "POST",
      body: JSON.stringify({ sessions_older_than_days: 30, idempotency_older_than_days: 3 }),
    }, jarBootstrap);
    expect(res.status).toBe(200);
    const data = (res.body as { data: { sessionsPurged: number; idempotencyKeysPurged: number } }).data;
    expect(data.sessionsPurged).toBeGreaterThanOrEqual(1);
    expect(data.idempotencyKeysPurged).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("B7 seed determinism", () => {
  it("seed twice: second run changes nothing; seeded admin can log in", async () => {
    // Start from a clean seed slate (dependency order; seed rows carry no
    // orders so RESTRICT never blocks). Verifies create-then-skip, not just
    // skip-then-skip.
    for (const sql of [
      `DELETE FROM products WHERE id LIKE 'seed-%';`,
      `DELETE FROM categories WHERE id LIKE 'seed-%';`,
      `DELETE FROM shipping_rates WHERE id LIKE 'seed-%';`,
      `DELETE FROM subscriptions WHERE store_id LIKE 'seed-%';`,
      `DELETE FROM stores WHERE id LIKE 'seed-%';`,
      `DELETE FROM users WHERE id LIKE 'seed-%';`,
      `DELETE FROM plans WHERE id LIKE 'seed-%';`,
    ]) {
      const r = d1(sql);
      if (!r.ok) throw new Error(`seed cleanup failed: ${r.error}`);
    }
    const { execFileSync: exec } = await import("node:child_process");
    const runSeed = (extra: string[]) =>
      exec(isWindows ? "npx.cmd" : "npx", ["node", "scripts/seed.mjs", "--admin-password", "B7-Seed-Pw-1", ...extra], {
        encoding: "utf8",
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: isWindows,
      }) as string;
    const first = runSeed([]);
    expect(first).toContain("created");
    // compound SELECTs are unsupported locally; count tables individually
    const countOf = (table: string, col: string) =>
      (
        d1(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} LIKE 'seed-%';`).result?.[0] as unknown as {
          results?: { n: number }[];
        }
      )?.results?.[0]?.n;
    const before = [countOf("plans", "id"), countOf("users", "id"), countOf("stores", "id")];
    const second = runSeed([]);
    expect(second).toContain("0 created");
    const after = [countOf("plans", "id"), countOf("users", "id"), countOf("stores", "id")];
    expect(after).toEqual(before);

    // hash-compat proof: the seeded admin hash verifies through real login
    const login = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: "+963990000001", password: "B7-Seed-Pw-1" }),
    });
    expect(login.status).toBe(200);
  }, 180_000);
});
