// Merchant login lockout (roadmap B4): the 10th consecutive wrong password
// establishes a 15-minute lockout that answers the generic 429 without
// checking credentials (even with a correct password and a valid Turnstile
// token), locked requests never extend the lock, unknown identities lock
// identically, and password reset clears the throttle so the user recovers.
// Real workerd + real local D1, booted with Cloudflare's PUBLIC always-PASS
// test secret key. Fixtures use user_verify_b7lock_* (covered by
// scripts/clean-verify.mjs); throttle rows are namespaced `b7lock` for
// suite-local cleanup.
//
// NOTE on IPs: every login attempt carries a UNIQUE cf-connecting-ip. The
// pre-existing 10/10min per-IP login limiter would otherwise trip on the
// 11th same-IP attempt and mask the throttle lockout with an identical
// 429 — rotating IPs keeps each per-IP bucket at one attempt, so every 429
// below can only come from the persistent per-identity throttle (which is
// deliberately IP-independent). This doubles as the distributed-attacker
// scenario the throttle is designed for.
import { createHash } from "node:crypto";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18907;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

// Public Cloudflare Turnstile testing pair (documented, not a secret):
// this always-PASS secret accepts every token, including dummy and garbage.
const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const PASS = "Lockout-Strong-1";
const NEW_PASS = "Lockout-New-1x";
const EMAIL = "b7lock-a@example.com";
const USER_ID = "user_verify_b7lock_m";
const GHOST = `ghost-b7lock-${Date.now()}@example.com`;
const RESET_RAW = "b7lock-reset-token-1";

let server: ChildProcess | null = null;
let serverOutput = "";
let ipCounter = 0;

function freshIp(): string {
  ipCounter += 1;
  return `10.20.${Math.floor(ipCounter / 250) + 1}.${(ipCounter % 250) + 1}`;
}

function d1exec(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b7locktest-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const out = execFileSync(isWindows ? "npx.cmd" : "npx", ["wrangler", "d1", "execute", "sallasyria-db", "--local", "--json", "--file", file], {
    encoding: "utf8",
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
  });
  return JSON.parse(out) as Array<{ success: boolean; results?: Array<Record<string, unknown>> }>;
}

function d1(sql: string) {
  try {
    const parsed = d1exec(sql);
    const ok = Array.isArray(parsed) && parsed.every((r) => r.success);
    return { ok, result: parsed, error: ok ? undefined : JSON.stringify(parsed) };
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string };
    return { ok: false, error: String(e.stderr ?? e.stdout ?? e.message ?? err) };
  }
}

function qrow(sql: string): Record<string, unknown> | null {
  const parsed = d1exec(sql);
  for (const block of parsed) {
    if (Array.isArray(block.results) && block.results.length > 0) {
      return block.results[0] as Record<string, unknown>;
    }
  }
  return null;
}

function throttleOf(identity: string) {
  return qrow(`SELECT fails, locked_until AS lockedUntil FROM login_throttle WHERE identity = 'login-fail:${identity}';`);
}

async function api(path: string, init: RequestInit = {}, token?: string, ip?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Turnstile-Token": token } : {}),
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function login(identity: string, password: string, token?: string, ip: string = freshIp()) {
  return api("/auth/login", { method: "POST", body: JSON.stringify({ identity, password }) }, token, ip);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `TURNSTILE_SECRET:${TEST_TURNSTILE_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b7lock reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('${USER_ID}', '+963900000721', '${EMAIL}', 'B7Lock Merchant', '${h}', 'merchant');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B7LOCK seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id = '${USER_ID}';`);
}, 180_000);

afterAll(async () => {
  d1(`DELETE FROM login_throttle WHERE identity LIKE '%b7lock%';`);
  d1(`DELETE FROM email_tokens WHERE user_id = '${USER_ID}';`);
  stopDevServer(server);
  server = null;
  assertCleanVerify("b7lock cleanup");
}, 120_000);

describe("login lockout escalation", () => {
  it("10th failure locks while answering 401; 11th is the generic 429", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(EMAIL, "Wrong-Password-9");
      expect(res.status, `attempt ${i + 1}`).toBe(401);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "invalid_credentials", message: expect.any(String) },
      });
    }
    // Attempts 6-9: challenged, valid token, wrong password stays 401.
    for (let i = 6; i <= 9; i++) {
      const res = await login(EMAIL, "Wrong-Password-9", DUMMY_TOKEN);
      expect(res.status, `attempt ${i}`).toBe(401);
    }
    // 10th: still the normal 401, but the lock is established as a side effect.
    const tenth = await login(EMAIL, "Wrong-Password-9", DUMMY_TOKEN);
    expect(tenth.status).toBe(401);
    const state = throttleOf(EMAIL);
    expect(state).not.toBeNull();
    expect(state?.fails).toBe(10);
    expect(state?.lockedUntil).not.toBeNull();
    // 11th: generic lockout response (per-IP buckets hold one attempt each,
    // so this 429 can only come from the per-identity throttle lockout).
    const locked = await login(EMAIL, "Wrong-Password-9", DUMMY_TOKEN);
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
  }, 120_000);

  it("locked correct password plus valid token still 429s (no bypass)", async () => {
    const res = await login(EMAIL, PASS, DUMMY_TOKEN);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
  }, 60_000);

  it("locked requests never extend the lockout", async () => {
    const before = throttleOf(EMAIL)?.lockedUntil;
    expect(before).not.toBeNull();
    expect((await login(EMAIL, "Wrong-Password-9", DUMMY_TOKEN)).status).toBe(429);
    expect(throttleOf(EMAIL)?.lockedUntil).toBe(before);
  }, 60_000);

  it("unknown identities reach the lockout identically (no oracle)", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(GHOST, "Whatever-1")).status).toBe(401);
    }
    for (let i = 6; i <= 10; i++) {
      expect((await login(GHOST, "Whatever-1", DUMMY_TOKEN)).status, `ghost attempt ${i}`).toBe(401);
    }
    const state = throttleOf(GHOST);
    expect(state?.fails).toBe(10);
    expect(state?.lockedUntil).not.toBeNull();
    expect((await login(GHOST, "Whatever-1", DUMMY_TOKEN)).status).toBe(429);
  }, 120_000);

  it("password reset clears the throttle so the user recovers", async () => {
    const seed = d1(
      `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ('tok_b7lock_reset_1', '${USER_ID}', 'reset', '${tokenHash(RESET_RAW)}', '2099-01-01T00:00:00Z');`
    );
    expect(seed.ok).toBe(true);
    const reset = await api("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: RESET_RAW, new_password: NEW_PASS }),
    });
    expect(reset.status).toBe(200);
    // Locked row is gone: the new password authenticates with no challenge.
    expect((await login(EMAIL, NEW_PASS)).status).toBe(200);
    // And the counter restarted: a wrong password is failure #1, not a lock.
    expect((await login(EMAIL, "Wrong-Password-9")).status).toBe(401);
    expect(throttleOf(EMAIL)?.fails ?? 1).toBe(1);
  }, 120_000);
});
