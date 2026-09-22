// Email-flow integration suite: verification, resend, forgot/reset, and
// order-mail hooks against live workerd + real local D1. Raw tokens never
// touch D1 or logs, so redemption paths are seeded deterministically: the
// suite computes SHA-256(token) itself, inserts the token row, then redeems
// the raw token over HTTP — exercising the real CAS path end to end.
// SendGrid is never configured here (dev skip path); delivery itself is
// proven at unit level (tests/mail.test.ts). Fixtures use user_verify_em_*
// and store_verify_em_* (clean-verify namespaces).

import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18890;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const MERCHANT_EMAIL = "em@example.com";
const MERCHANT_PASS = "Email-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";
let seedCounter = 0;

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-emtest-"));
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
    return { ok: false, error: String(e.message ?? e.stderr ?? err) };
  }
}

function qval(sql: string): unknown {
  const r = d1(sql);
  if (!r.ok) throw new Error(`email d1 failed: ${r.error}`);
  const first = (r.result?.[0] as { results?: Record<string, unknown>[] } | undefined)?.results?.[0];
  return first ? Object.values(first)[0] : undefined;
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

function killServer(): void {
  if (server && server.exitCode === null) {
    try {
      if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill("SIGTERM");
    } catch { /* best effort */ }
  }
  server = null;
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
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

async function seedToken(userId: string, purpose: "verify" | "reset", token: string, expiresAt: string): Promise<void> {
  seedCounter++;
  const r = d1(
    `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ('tok_em_${purpose}_${seedCounter}', '${userId}', '${purpose}', '${tokenHash(token)}', '${expiresAt}');`
  );
  if (!r.ok) throw new Error(`token seed failed: ${r.error}`);
}

let jarMerchant = "";

beforeAll(async () => {
  server = spawn(isWindows ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    windowsHide: true,
  });
  server.stdout?.on("data", (d) => { serverOutput += String(d); });
  server.stderr?.on("data", (d) => { serverOutput += String(d); });
  try {
    await waitForHealth();

  assertCleanVerify("email reset");
  // API-registered users carry random uuid ids outside the shared prefixes:
  // remove them explicitly (by email) so reruns stay green. Sessions and
  // email tokens cascade from the user rows.
  d1(`DELETE FROM users WHERE email IN ('em-resend@example.com', 'em-resend2@example.com', 'em-new@example.com', 'em-gated@example.com');`);
    // Stale token rows cascade from users, but belt-and-braces for reruns:
    // the shared cleanup predates email_tokens, so clear our scope first.
    d1(`DELETE FROM email_tokens WHERE user_id LIKE 'user\\_verify\\_em\\_%' ESCAPE '\\';`);
    const seed = [
      `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_em_m', '+963900001401', '${MERCHANT_EMAIL}', 'EM Merchant', '${hashPassword(MERCHANT_PASS)}', 'merchant');`,
      `INSERT INTO plans (id, code, name) VALUES ('plan_verify_em', 'em-plan', 'EM Plan');`,
      `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_em_a', 'user_verify_em_m', 'em-store-a', 'EM Store A');`,
      `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_em_a', 'store_verify_em_a', 'plan_verify_em', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
      `INSERT INTO products (id, store_id, name, slug, price, stock_quantity) VALUES ('prod_verify_em_a', 'store_verify_em_a', 'EM Prod', 'em-prod', 1000, 50);`,
      `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('rate_verify_em_a', 'store_verify_em_a', 'Damascus', 'Standard', 5000);`,
    ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`email seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_em_m';`);
    const login = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    if (login.status !== 200) throw new Error(`email setup login failed: ${login.status}`);
    jarMerchant = cookieOf(login.setCookie);
  } catch (err) {
    killServer();
    throw err;
  }
}, 180_000);

afterAll(async () => {
  d1(`DELETE FROM users WHERE email IN ('em-resend@example.com', 'em-resend2@example.com', 'em-new@example.com', 'em-gated@example.com');`);
  killServer();
  assertCleanVerify("email cleanup");
}, 120_000);

describe("registration under email auth", () => {
  it("registers with email identity; phone stays contact-only", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "Em-New@Example.com",
        phone: "+963900001451",
        password: MERCHANT_PASS,
        name: "EM New",
      }),
    });
    expect(res.status).toBe(201);
    const user = (res.body as { data: { user: Record<string, unknown> } }).data.user;
    expect(user.email).toBe("em-new@example.com");
    expect(user.role).toBe("merchant");
    expect(user).not.toHaveProperty("password_hash");
    // Fresh registrations start unverified: login is 403 until verification.
    expect((await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "em-new@example.com", password: MERCHANT_PASS }),
    })).status).toBe(403);
    // Verify directly (mirrors clicking the emailed link) and log in.
    d1(`UPDATE users SET email_verified = 1 WHERE email = 'em-new@example.com';`);
    const login = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "EM-NEW@EXAMPLE.COM", password: MERCHANT_PASS }),
    });
    expect(login.status).toBe(200);
  }, 120_000);

  it("duplicate email is 409 email_taken; missing email is 400", async () => {
    const dup = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, phone: "+963900001452", password: MERCHANT_PASS, name: "Clone" }),
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({
      ok: false,
      error: { code: "email_taken", message: expect.any(String) },
    });
    const missing = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone: "+963900001453", password: MERCHANT_PASS, name: "NoMail" }),
    });
    expect(missing.status).toBe(400);
  }, 120_000);

  it("phone alone never authenticates", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "+963900001401", password: MERCHANT_PASS }),
    });
    expect(res.status).toBe(400);
  }, 120_000);

  it("unverified login is 403 with correct password, 401 with wrong password", async () => {
    const reg = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "em-gated@example.com", phone: "+963900001455", password: MERCHANT_PASS, name: "EM Gated" }),
    });
    expect(reg.status).toBe(201);
    const good = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "em-gated@example.com", password: MERCHANT_PASS }),
    });
    expect(good.status).toBe(403);
    expect(good.body).toEqual({
      ok: false,
      error: { code: "email_not_verified", message: "Email verification required." },
    });
    // Wrong password keeps the identical 401: the 403 never leaks verified state to guessers.
    const bad = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "em-gated@example.com", password: "Wrong-Pass-1x" }),
    });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: "Invalid email or password." },
    });
  }, 120_000);
});

describe("email verification (live CAS path)", () => {
  it("valid token verifies; reuse, forgery, and expiry are identical 400s", async () => {
    await seedToken("user_verify_em_m", "verify", "em-valid-token-1", "2099-01-01T00:00:00Z");
    const good = await api("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token: "em-valid-token-1" }),
    });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ ok: true, data: { verified: true } });
    expect(qval(`SELECT email_verified FROM users WHERE id = 'user_verify_em_m';`)).toBe(1);

    for (const token of ["em-valid-token-1", "em-forged-token"]) {
      const res = await api("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
      expect(res.status).toBe(400);
      expect((res.body as { ok: boolean; error: { code: string } }).error.code).toBe("invalid_token");
    }

    await seedToken("user_verify_em_m", "verify", "em-expired-token-1", "2020-01-01T00:00:00Z");
    const expired = await api("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token: "em-expired-token-1" }),
    });
    expect(expired.status).toBe(400);
  }, 120_000);

  it("concurrent redemption allows exactly one success", async () => {
    await seedToken("user_verify_em_m", "verify", "em-race-token-1", "2099-01-01T00:00:00Z");
    const results = await Promise.all([
      api("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: "em-race-token-1" }) }),
      api("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: "em-race-token-1" }) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  }, 120_000);

  it("resend requires ownership, retires old tokens, skips verified accounts", async () => {
    // Merchant is verified from the earlier test: no email, no new token.
    const done = await api("/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL }),
    }, jarMerchant);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ ok: true, data: { emailed: false } });

    // A foreign address is rejected, never mailed.
    const foreign = await api("/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email: "someone-else@example.com" }),
    }, jarMerchant);
    expect(foreign.status).toBe(400);

    // Unverified account: resend issues, and re-resend retires the first.
    const reg = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "em-resend@example.com", phone: "+963900001454", password: MERCHANT_PASS, name: "EM Resend" }),
    });
    expect(reg.status).toBe(201);
    // Unverified-but-authed account: register, verify via a seeded token
    // (mirrors clicking the emailed link), log in, then change the email via
    // PATCH /me — the new address is unverified while the session survives,
    // which is exactly the resend use case.
    const target = ((reg.body as { data: { user: { id: string } } }).data.user.id);
    await seedToken(target, "verify", "em-resend-token-1", "2099-01-01T00:00:00Z");
    expect((await api("/auth/verify-email", {
      method: "POST", body: JSON.stringify({ token: "em-resend-token-1" }),
    })).status).toBe(200);
    const targetJar = cookieOf((await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "em-resend@example.com", password: MERCHANT_PASS }),
    })).setCookie);
    const changed = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "em-resend2@example.com", current_password: MERCHANT_PASS }),
    }, targetJar);
    expect(changed.status).toBe(200);
    // PATCH /me intentionally leaves the verified flag alone (out of scope);
    // mark the new address unverified directly to exercise the resend path.
    d1(`UPDATE users SET email_verified = 0 WHERE id = '${target}';`);
    const live = () => Number(qval(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = '${target}' AND purpose = 'verify' AND used_at IS NULL;`) ?? 0);
    const first = await api("/auth/resend-verification", {
      method: "POST", body: JSON.stringify({ email: "em-resend2@example.com" }),
    }, targetJar);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, data: { emailed: true } });
    expect(live()).toBe(1);
    await api("/auth/resend-verification", {
      method: "POST", body: JSON.stringify({ email: "em-resend2@example.com" }),
    }, targetJar);
    expect(live()).toBe(1);
  }, 180_000);
});

describe("password reset (live CAS path)", () => {
  it("forgot is always 200 and stores nothing for unknown emails", async () => {
    const before = Number(qval(`SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'reset';`) ?? 0);
    const res = await api("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: "nobody-here@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { emailed: true } });
    expect(Number(qval(`SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'reset';`) ?? 0)).toBe(before);
  }, 120_000);

  it("forgot for a known email stores exactly one live reset token", async () => {
    const before = Number(qval(`SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'reset';`) ?? 0);
    const res = await api("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL }),
    });
    expect(res.status).toBe(200);
    expect(Number(qval(`SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'reset';`) ?? 0)).toBe(before + 1);
    expect(Number(qval(`SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'reset' AND used_at IS NULL;`) ?? 0)).toBe(1);
  }, 120_000);

  it("forgot is rate-limited without revealing anything", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await api("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: `rl-${i}@example.com` }),
      });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(200);
    expect(statuses[statuses.length - 1]).toBe(429);
  }, 120_000);

  it("reset with the flag revokes sessions; default keeps them", async () => {
    await seedToken("user_verify_em_m", "reset", "em-reset-token-1", "2099-01-01T00:00:00Z");
    const first = await api("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: "em-reset-token-1", new_password: "Email-New-1x", logout_other_sessions: true }),
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, data: { reset: true } });

    const again = await api("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: "em-reset-token-1", new_password: "Email-New-2x" }),
    });
    expect(again.status).toBe(400);

    expect((await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    })).status).toBe(401);
    expect((await api("/auth/me", {}, jarMerchant)).status).toBe(401);
    const fresh = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: "Email-New-1x" }),
    });
    expect(fresh.status).toBe(200);
    jarMerchant = cookieOf(fresh.setCookie);
  }, 120_000);

  it("reset defaults to keeping every session", async () => {
    const other = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: "Email-New-1x" }),
    });
    const jarOther = cookieOf(other.setCookie);
    await seedToken("user_verify_em_m", "reset", "em-reset-token-keep", "2099-01-01T00:00:00Z");
    const res = await api("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: "em-reset-token-keep", new_password: "Email-New-3x" }),
    });
    expect(res.status).toBe(200);
    expect((await api("/auth/me", {}, jarMerchant)).status).toBe(200);
    expect((await api("/auth/me", {}, jarOther)).status).toBe(200);
    // restore known password for later tests
    await seedToken("user_verify_em_m", "reset", "em-reset-token-restore", "2099-01-01T00:00:00Z");
    const restore = await api("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: "em-reset-token-restore", new_password: "Email-New-1x" }),
    });
    expect(restore.status).toBe(200);
  }, 120_000);

  it("concurrent resets allow exactly one success", async () => {
    await seedToken("user_verify_em_m", "reset", "em-reset-race-1", "2099-01-01T00:00:00Z");
    const results = await Promise.all([
      api("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: "em-reset-race-1", new_password: "Email-Race-1x" }),
      }),
      api("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: "em-reset-race-1", new_password: "Email-Race-2x" }),
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    let liveCount = 0;
    for (const password of ["Email-Race-1x", "Email-Race-2x"]) {
      const attempt = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: MERCHANT_EMAIL, password }),
      });
      if (attempt.status === 200) {
        liveCount++;
        jarMerchant = cookieOf(attempt.setCookie);
      } else {
        expect(attempt.status).toBe(401);
      }
    }
    expect(liveCount).toBe(1);
  }, 120_000);
});

describe("order mail hooks never break business flows", () => {
  it("checkout with email succeeds without mail configured", async () => {
    const res = await api("/stores/store_verify_em_a/checkout", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "EM Buyer", phone: "+963911600101", email: "buyer-em@example.com" },
        items: [{ product_id: "prod_verify_em_a", quantity: 1 }],
        shipping: {
          recipient_name: "EM Buyer",
          phone: "+963911600101",
          governorate: "Damascus",
          address_line: "Street 1, Damascus",
        },
        payment: { method: "cod" },
      }),
    });
    expect(res.status).toBe(201);
    expect((res.body as { data: { order: { status: string } } }).data.order.status).toBe("pending");
  }, 120_000);

  it("status transition still succeeds without mail configured", async () => {
    const created = await api("/stores/store_verify_em_a/checkout", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "EM Buyer", phone: "+963911600102" },
        items: [{ product_id: "prod_verify_em_a", quantity: 1 }],
        shipping: {
          recipient_name: "EM Buyer",
          phone: "+963911600102",
          governorate: "Damascus",
          address_line: "Street 1, Damascus",
        },
        payment: { method: "cod" },
      }),
    });
    expect(created.status).toBe(201);
    const id = (created.body as { data: { order: { id: string } } }).data.order.id;
    const moved = await api(`/stores/store_verify_em_a/orders/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "confirmed" }),
    }, jarMerchant);
    expect(moved.status).toBe(200);
    expect((moved.body as { data: { order: { status: string } } }).data.order.status).toBe("confirmed");
  }, 120_000);
});
