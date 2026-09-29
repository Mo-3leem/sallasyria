// Buyer forgot-password target throttle: repeated reset mail to one target
// is capped per address even across rotated IPs, without revealing whether
// the target exists. Real workerd + real local D1. No Turnstile secret is
// configured, so the dev bypass applies (missing/invalid tokens would 400
// before any throttle logic; the throttle itself needs no token to trip).
// Fixtures use store_verify_b9h_*/user_verify_b9h_* (covered by
// scripts/clean-verify.mjs).
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18901;
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = "b9h-store-a";
const STORE = "store_verify_b9h_a";
const isWindows = process.platform === "win32";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b9htest-"));
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
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const forgot = (identity: string) =>
  api(`/s/${SLUG}/account/forgot-password`, {
    method: "POST",
    body: JSON.stringify({ identity }),
  });

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b9h reset");
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9h_owner', '+963900001711', 'b9howner@example.com', 'B9H Owner', 'x', 'merchant');`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('${STORE}', 'user_verify_b9h_owner', '${SLUG}', 'B9H Store A', 1);`,
    `INSERT INTO customers (id, store_id, name, phone, email) VALUES ('cust_verify_b9h_a', '${STORE}', 'B9H Buyer', '+963911500071', 'b9h-buyer@example.com');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B9H seed failed: ${r.error}`);
  }
}, 180_000);

afterAll(async () => {
  stopDevServer(server);
  server = null;
  assertCleanVerify("b9h cleanup");
}, 120_000);

describe("buyer forgot-password target throttle", () => {
  it("unknown, real, and malformed targets share one flat success shape", async () => {
    for (const identity of ["ghost-nobody@example.com", "b9h-buyer@example.com", "+963900009999"]) {
      const res = await forgot(identity);
      expect(res.status, identity).toBe(200);
      expect(res.body).toEqual({ ok: true, data: { accepted: true } });
    }
  }, 60_000);

  it("repeated requests to one target trip the per-target bucket; others stay open", async () => {
    // Account bucket is 5/hour: five pass, sixth 429s. Fresh target, so the
    // IP bucket (60/min, shared) has ample room in this file.
    for (let i = 0; i < 5; i++) {
      const res = await forgot("b9h-flood@example.com");
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const blocked = await forgot("b9h-flood@example.com");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
    const other = await forgot("b9h-other@example.com");
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ ok: true, data: { accepted: true } });
  }, 120_000);
});
