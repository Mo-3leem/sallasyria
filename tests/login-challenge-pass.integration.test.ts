// Merchant/admin login challenge continuation: proves a VALID Turnstile
// token lets the flow proceed and that success resets the failure counter.
// Real workerd + real local D1, booted with Cloudflare's PUBLIC always-PASS
// test secret key (garbage also passes here by design — failure paths live
// in the companion login-challenge file with the always-blocks key).
// Fixtures use user_verify_b7p_* (covered by scripts/clean-verify.mjs).
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18898;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

// Public Cloudflare Turnstile testing pair (documented, not a secret):
// this always-PASS secret accepts every token, including dummy and garbage.
const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const PASS = "Challenge-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b7ptest-"));
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
    const ok = Array.isArray(parsed) && parsed.every((r) => (r as { success: boolean }).success);
    return { ok, result: parsed, error: ok ? undefined : JSON.stringify(parsed) };
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string };
    return { ok: false, error: String(e.stderr ?? e.stdout ?? e.message ?? err) };
  }
}

async function api(path: string, init: RequestInit = {}, cookies = "", token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...(token ? { "X-Turnstile-Token": token } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function login(identity: string, password: string, token?: string) {
  return api("/auth/login", { method: "POST", body: JSON.stringify({ identity, password }) }, "", token);
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `TURNSTILE_SECRET:${TEST_TURNSTILE_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b7p reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b7p_m', '+963900000711', 'b7p@example.com', 'B7P Merchant', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b7p_u', '+963900000712', 'b7pu@example.com', 'B7P Unverified', '${h}', 'merchant');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B7P seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_b7p_m';`);
}, 180_000);

afterAll(async () => {
  stopDevServer(server);
  server = null;
  assertCleanVerify("b7p cleanup");
}, 120_000);

describe("login challenge continuation (valid token)", () => {
  it("challenged attempt with a valid token runs the password check", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login("b7p@example.com", "Wrong-Password-9")).status).toBe(401);
    }
    // Past the threshold: a valid token lets the flow continue, so a wrong
    // password is a plain 401 rather than a challenge rejection.
    const res = await login("b7p@example.com", "Wrong-Password-9", DUMMY_TOKEN);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: expect.any(String) },
    });
  }, 60_000);

  it("successful authentication resets the failure counter", async () => {
    const email = "b7p-reset@example.com";
    expect(d1(`INSERT INTO users (id, phone, email, name, password_hash, role, email_verified) VALUES ('user_verify_b7p_r', '+963900000713', '${email}', 'B7P Reset', '${hashPassword(PASS)}', 'merchant', 1);`).ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect((await login(email, "Wrong-Password-9")).status).toBe(401);
    }
    // Challenged: valid token + correct password succeeds...
    const good = await login(email, PASS, DUMMY_TOKEN);
    expect(good.status).toBe(200);
    // ...and the counter is cleared: a lone wrong password is plain 401 again.
    expect((await login(email, "Wrong-Password-9")).status).toBe(401);
    expect(d1(`DELETE FROM users WHERE id = 'user_verify_b7p_r';`).ok).toBe(true);
  }, 120_000);

  it("correct password on an unverified account gates 403 and resets", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login("b7pu@example.com", "Wrong-Password-9")).status).toBe(401);
    }
    // Valid token passes the challenge; the verified gate answers 403, and
    // the proven password clears the counter...
    expect((await login("b7pu@example.com", PASS, DUMMY_TOKEN)).status).toBe(403);
    // ...so the next wrong password is a plain 401, not a challenge.
    expect((await login("b7pu@example.com", "Wrong-Password-9")).status).toBe(401);
  }, 60_000);
});
