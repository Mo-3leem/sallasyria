// Merchant registration bot protection: Turnstile is required, enforced
// before any account work. Real workerd + real local D1, booted with
// Cloudflare's PUBLIC always-PASS test secret key so the dummy token passes
// deterministically (failure paths live in the cart file with the
// always-blocks key — one secret per worker). Registered rows use
// b9r- emails/phones, removed explicitly so reruns stay green.
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18900;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

// Public Cloudflare Turnstile testing pair (documented, not a secret):
// this always-PASS secret accepts the dummy token below.
const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b9rtest-"));
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

async function api(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Turnstile-Token": token } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const EMAILS = [
  "b9r-missing@example.com",
  "b9r-valid@example.com",
  "b9r-dup@example.com",
  "b9r-badbody@example.com",
  "b9r-flood@example.com",
];

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `TURNSTILE_SECRET:${TEST_TURNSTILE_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b9r reset");
  d1(`DELETE FROM users WHERE email IN (${EMAILS.map((e) => `'${e}'`).join(",")});`);
}, 180_000);

afterAll(async () => {
  d1(`DELETE FROM users WHERE email IN (${EMAILS.map((e) => `'${e}'`).join(",")});`);
  stopDevServer(server);
  server = null;
  assertCleanVerify("b9r cleanup");
}, 120_000);

describe("merchant registration bot protection", () => {
  const reg = (email: string, phone: string, token?: string, extra: Record<string, unknown> = {}) =>
    api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, phone, password: "Register-Strong-1", name: "B9R Merchant", ...extra }),
    }, token);

  it("missing token is rejected before any account work", async () => {
    const res = await reg("b9r-missing@example.com", "+963991700001");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "turnstile_required", message: expect.any(String) },
    });
  }, 60_000);

  it("valid token lets registration succeed", async () => {
    const res = await reg("b9r-valid@example.com", "+963991700002", DUMMY_TOKEN);
    expect(res.status).toBe(201);
    expect((res.body as { data: { user: { email: string } } }).data.user.email).toBe("b9r-valid@example.com");
  }, 60_000);

  it("duplicate identities still 409 with a valid token", async () => {
    const first = await reg("b9r-dup@example.com", "+963991700003", DUMMY_TOKEN);
    expect(first.status).toBe(201);
    const again = await reg("b9r-dup@example.com", "+963991700004", DUMMY_TOKEN);
    expect(again.status).toBe(409);
  }, 60_000);

  it("invalid bodies still 400 with a valid token", async () => {
    const res = await reg("not-an-email", "+963991700005", DUMMY_TOKEN);
    expect(res.status).toBe(400);
  }, 60_000);
});
