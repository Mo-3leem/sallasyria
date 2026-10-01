// Malformed-phone throttle scope (roadmap B4 FIX 2): un-normalizable phone
// identities must throttle per client IP, not in one global bucket. Real
// workerd + real local D1, like the login-challenge suites. Uses the
// always-BLOCKS Turnstile test secret; no valid token is needed because the
// isolation proof only requires the challenge gate (400) versus the plain
// 401 path.
// Fixtures use no user rows at all (malformed identities never resolve), but
// the suite still goes through clean-verify, which now resets login_throttle
// (FIX 1), so repeated runs start with no throttle rows.
import { createHash } from "node:crypto";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18902;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

// Public Cloudflare Turnstile testing pair (documented, not a secret):
// this always-BLOCKS secret rejects every token.
const TEST_TURNSTILE_SECRET = "2x0000000000000000000000000000000AA";

// Malformed phone: no "@" (not an email) and un-normalizable as a Syrian
// phone (letters survive digit-folding, so the shape guard throws and the
// login flow falls into the per-IP invalid-phone throttle bucket).
const MALFORMED = "not-a-phone-b7ip";
const WRONG_PASS = "Wrong-Password-9";

// Two simulated client IPs via the same header clientIp() trusts first.
const IP_A = "10.244.0.11";
const IP_B = "10.244.0.12";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b7iptest-"));
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

async function api(path: string, init: RequestInit = {}, ip?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function login(identity: string, password: string, ip: string) {
  return api("/auth/login", { method: "POST", body: JSON.stringify({ identity, password }) }, ip);
}

// Mirrors the server-side persisted key: login-fail:invalid-phone:<sha256(ip)>.
// hashEmailToken() is plain SHA-256 hex, so node:crypto reproduces it exactly.
function invalidPhoneKey(ip: string): string {
  return `login-fail:invalid-phone:${createHash("sha256").update(ip, "utf8").digest("hex")}`;
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `TURNSTILE_SECRET:${TEST_TURNSTILE_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b7ip reset");
}, 180_000);

afterAll(async () => {
  // Remove this suite's throttle rows first so the shared cleanup assertion
  // (zero throttle rows) can pass; the reset in beforeAll covers stale rows
  // from interrupted runs.
  d1(`DELETE FROM login_throttle WHERE identity IN ('${invalidPhoneKey(IP_A)}', '${invalidPhoneKey(IP_B)}');`);
  stopDevServer(server);
  server = null;
  assertCleanVerify("b7ip cleanup");
}, 120_000);

describe("malformed-phone throttle is scoped per client IP", () => {
  it("drives IP-A to the challenge gate with plain 401s first", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(MALFORMED, WRONG_PASS, IP_A);
      expect(res.status, `IP-A attempt ${i + 1}`).toBe(401);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "invalid_credentials", message: expect.any(String) },
      });
    }
    const challenged = await login(MALFORMED, WRONG_PASS, IP_A);
    expect(challenged.status).toBe(400);
    expect(challenged.body).toEqual({
      ok: false,
      error: { code: "turnstile_required", message: expect.any(String) },
    });
  }, 60_000);

  it("a different IP does not share IP-A throttle state", async () => {
    // A shared global bucket would answer 400 here (6 fails already banked
    // by IP-A); per-IP scoping answers the plain 401 for failure #1.
    const first = await login(MALFORMED, WRONG_PASS, IP_B);
    expect(first.status).toBe(401);
    expect(first.body).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: expect.any(String) },
    });
    for (let i = 0; i < 4; i++) {
      const res = await login(MALFORMED, WRONG_PASS, IP_B);
      expect(res.status, `IP-B attempt ${i + 2}`).toBe(401);
    }
    const challenged = await login(MALFORMED, WRONG_PASS, IP_B);
    expect(challenged.status).toBe(400);
    expect(challenged.body).toEqual({
      ok: false,
      error: { code: "turnstile_required", message: expect.any(String) },
    });
  }, 60_000);
});
