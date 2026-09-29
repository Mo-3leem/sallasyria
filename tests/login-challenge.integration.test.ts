// Merchant/admin login brute-force escalation: after 5 consecutive wrong
// passwords for one identity, a Turnstile challenge is required before
// credentials are checked. Real workerd + real local D1. This file boots the
// worker with Cloudflare's PUBLIC always-BLOCKS test secret key, so failing
// verification is deterministic; the always-passes key lives in the
// companion login-challenge-pass file (one secret per worker).
// Fixtures use user_verify_b7c_* (covered by scripts/clean-verify.mjs).
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18897;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

// Public Cloudflare Turnstile testing pair (documented, not a secret):
// this always-BLOCKS secret rejects every token, including the dummy one.
const TEST_TURNSTILE_SECRET = "2x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const PASS = "Challenge-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b7ctest-"));
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

  assertCleanVerify("b7c reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b7c_m', '+963900000701', 'b7c@example.com', 'B7C Merchant', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b7c_u', '+963900000702', 'b7cu@example.com', 'B7C Unverified', '${h}', 'merchant');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B7C seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_b7c_m';`);
}, 180_000);

afterAll(async () => {
  stopDevServer(server);
  server = null;
  assertCleanVerify("b7c cleanup");
}, 120_000);

describe("login challenge escalation", () => {
  it("first five wrong passwords behave normally (identical 401s)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login("b7c@example.com", "Wrong-Password-9");
      expect(res.status, `attempt ${i + 1}`).toBe(401);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "invalid_credentials", message: expect.any(String) },
      });
    }
  }, 60_000);

  it("sixth attempt without a token requires the challenge", async () => {
    const res = await login("b7c@example.com", "Wrong-Password-9");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "turnstile_required", message: expect.any(String) },
    });
  }, 60_000);

  it("garbage token fails closed without checking credentials", async () => {
    const res = await login("b7c@example.com", "Wrong-Password-9", "garbage-token");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "turnstile_failed", message: expect.any(String) },
    });
  }, 60_000);

  it("valid token cannot pass a failing challenge; flow stays 403", async () => {
    // Even the dummy token fails against the always-blocks secret: the
    // challenge, not the password, decides here.
    const res = await login("b7c@example.com", "Wrong-Password-9", DUMMY_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "turnstile_failed", message: expect.any(String) },
    });
  }, 60_000);

  it("unknown identities are challenged identically (no oracle)", async () => {
    const ghost = `ghost-b7c-${Date.now()}@example.com`;
    for (let i = 0; i < 5; i++) {
      expect((await login(ghost, "Whatever-1")).status).toBe(401);
    }
    const challenged = await login(ghost, "Whatever-1");
    expect(challenged.status).toBe(400);
    expect(challenged.body).toEqual({
      ok: false,
      error: { code: "turnstile_required", message: expect.any(String) },
    });
  }, 60_000);

  it("malformed input never counts toward the challenge", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await login("", "x")).status).toBe(400);
    }
    // A valid-shape wrong password on a never-tried identity is only
    // failure #1 for it: plain 401, no challenge.
    expect((await login("fresh-b7c-shape@example.com", "Wrong-Password-9")).status).toBe(401);
  }, 60_000);

  it("unverified account is challenged before the gate, identically", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login("b7cu@example.com", "Wrong-Password-9")).status).toBe(401);
    }
    // Correct password would 403 at the verified gate, but the challenge
    // comes first and applies uniformly: 400 without a token here.
    expect((await login("b7cu@example.com", PASS)).status).toBe(400);
  }, 60_000);
});
