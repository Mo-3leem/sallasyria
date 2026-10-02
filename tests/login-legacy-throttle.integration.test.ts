// Legacy-phone login clears account throttle state (roadmap B4 L1).
// A legacy raw-format stored phone authenticates through the exact-match
// fallback path, which banks failures under the shared per-IP invalid-phone
// bucket. On success the account's own (email/phone) throttle rows must be
// cleared too — hygiene must not depend on which spelling proved the
// password. Real workerd + real local D1. Fixtures use user_verify_b7lr_*
// (covered by scripts/clean-verify.mjs); throttle rows are namespaced
// `b7lr` for suite-local cleanup.
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18908;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

// Public Cloudflare Turnstile testing pair (documented, not a secret).
// No token is ever sent here (at most five failures per identity), so the
// always-BLOCKS key only pins the deterministic 400 challenge path.
const TEST_TURNSTILE_SECRET = "2x0000000000000000000000000000000AA";

const PASS = "Legacy-Strong-1";
const EMAIL = "b7lr@example.com";
// Stored raw and typed identically: un-normalizable (non-Syrian country
// code), so login resolves exclusively through the legacy exact-match
// fallback while the email identity carries the canonical throttle key.
const LEGACY_PHONE = "+964770000606";
const USER_ID = "user_verify_b7lr_m";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b7lrtest-"));
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

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function login(identity: string, password: string) {
  return api("/auth/login", { method: "POST", body: JSON.stringify({ identity, password }) });
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `TURNSTILE_SECRET:${TEST_TURNSTILE_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b7lr reset");
  const h = hashPassword(PASS);
  const r = d1(
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('${USER_ID}', '${LEGACY_PHONE}', '${EMAIL}', 'B7LR Merchant', '${h}', 'merchant');`
  );
  if (!r.ok) throw new Error(`B7LR seed failed: ${r.error}`);
  d1(`UPDATE users SET email_verified = 1 WHERE id = '${USER_ID}';`);
}, 180_000);

afterAll(async () => {
  d1(`DELETE FROM login_throttle WHERE identity LIKE '%b7lr%';`);
  stopDevServer(server);
  server = null;
  assertCleanVerify("b7lr cleanup");
}, 120_000);

describe("legacy fallback login clears account throttle", () => {
  it("email failures then a legacy-phone success reset the email counter", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(EMAIL, "Wrong-Password-9");
      expect(res.status, `email attempt ${i + 1}`).toBe(401);
    }
    // Legacy exact-match path authenticates with no canonical identity.
    const legacy = await login(LEGACY_PHONE, PASS);
    expect(legacy.status).toBe(200);
    // The email counter was cleared by that success: the next wrong
    // password is failure #1 (plain 401), not the 6th-attempt challenge.
    const next = await login(EMAIL, "Wrong-Password-9");
    expect(next.status).toBe(401);
    expect(next.body).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: expect.any(String) },
    });
  }, 120_000);
});
