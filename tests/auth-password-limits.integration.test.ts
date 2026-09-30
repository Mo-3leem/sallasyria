// B7b integration suite: per-account guards on merchant password rotation
// and email change. Real workerd + real local D1. Fixtures use
// user_verify_pwlim_* (covered by scripts/clean-verify.mjs).
//
// Cross-process note: the dev server runs in its own isolate, so the
// in-process reset seams cannot clear server-side buckets here. Every test
// uses dedicated users, making each bucket fresh by construction instead of
// relying on quota left over by sibling tests.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18903;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PASS0 = "Pwlim-Strong-0";
const USERS = [
  { id: "user_verify_pwlim_a", phone: "+963900001951", email: "pwla@example.com" },
  { id: "user_verify_pwlim_b", phone: "+963900001952", email: "pwlb@example.com" },
  { id: "user_verify_pwlim_c", phone: "+963900001953", email: "pwlc0@example.com" },
] as const;

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-pwlim-"));
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
    return { ok: false, result: undefined, error: String(e.stderr ?? e.message ?? err) };
  }
}

function qrows(res: { result?: unknown[] }): Record<string, unknown>[] {
  const first = res.result?.[0] as { results?: Record<string, unknown>[] } | undefined;
  return first?.results ?? [];
}

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const headers: Record<string, string> = {
    // Close every connection: slow wrangler-D1 gaps mid-test let workerd
    // close idle keep-alive sockets, and undici does not retry POST/PATCH
    // with bodies on a stale socket (ECONNRESET). Same discipline as the
    // billing suite.
    Connection: "close",
    ...(cookies ? { Cookie: cookies } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
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

async function loginJar(email: string, password: string): Promise<string> {
  const res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`pwlim setup login failed for ${email}: ${res.status}`);
  return cookieOf(res.headers.get("set-cookie"));
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {});
  await waitForHealthy(BASE, () => server, () => serverOutput);

  const h = hashPassword(PASS0);
  assertCleanVerify("pwlim reset");
  for (const u of USERS) {
    const r = d1(
      `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('${u.id}', '${u.phone}', '${u.email}', 'PW Lim', '${h}', 'merchant');`
    );
    if (!r.ok) throw new Error(`pwlim seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id LIKE 'user_verify_pwlim%';`);
}, 180_000);

afterAll(async () => {
  try {
    const users = d1(`DELETE FROM sessions WHERE user_id LIKE 'user_verify_pwlim%';DELETE FROM users WHERE id LIKE 'user_verify_pwlim%';`);
    expect(users.ok, `user cleanup failed: ${users.error}`).toBe(true);
    assertCleanVerify("pwlim end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 60_000);

describe("B7b merchant change-password guard (pw-change: 10/10min per user)", () => {
  it("wrong current password is still 401 below the limit; 11th attempt 429s", async () => {
    const jar = await loginJar("pwla@example.com", PASS0);
    // Wrong password: 401, consumes 1 unit of this user's own bucket.
    const wrong = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "Wrong-Pass-9", new_password: "Pwlim-Strong-1" }),
    }, jar);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: expect.any(String) },
    });
    // Chain 9 successful rotations (1 + 9 = 10 units consumed).
    let current = PASS0;
    for (let i = 1; i <= 9; i++) {
      const next = `Pwlim-Strong-${i}`;
      const res = await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      }, jar);
      expect(res.status).toBe(200);
      current = next;
    }
    // 11th attempt: 429 with the standard envelope, password untouched
    // (the final chained password still logs in afterwards).
    const limited = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: "Pwlim-Strong-10" }),
    }, jar);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
    const stillOk = await loginJar("pwla@example.com", current);
    expect(stillOk.length).toBeGreaterThan(0);
  }, 120_000);

  it("successful change still revokes other sessions; second user unaffected", async () => {
    // User B has a pristine bucket (per-user isolation).
    const jarB1 = await loginJar("pwlb@example.com", PASS0);
    const jarB2 = await loginJar("pwlb@example.com", PASS0);
    const changed = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: PASS0, new_password: "Pwlim-Strong-B" }),
    }, jarB1);
    expect(changed.status).toBe(200);
    // Caller survives; the other session is revoked (default true).
    expect((await api("/auth/me", {}, jarB1)).status).toBe(200);
    expect((await api("/auth/me", {}, jarB2)).status).toBe(401);
    // New password works for fresh logins.
    const fresh = await loginJar("pwlb@example.com", "Pwlim-Strong-B");
    expect(fresh.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("B7b merchant email-change guard (email-change: 5/hour per user)", () => {
  it("name-only updates never consume quota; 6th email change 429s with zero side effects", async () => {
    const jar = await loginJar("pwlc0@example.com", PASS0);
    // Six name-only PATCHes: all succeed, none touch the email bucket.
    for (let i = 1; i <= 6; i++) {
      const res = await api("/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ name: `PW Name ${i}` }),
      }, jar);
      expect(res.status).toBe(200);
    }
    // Five email rotations succeed (proves the name-only calls consumed
    // nothing: the full 5-unit budget is still intact).
    let email = "pwlc0@example.com";
    for (let i = 1; i <= 5; i++) {
      const next = `pwlc${i}@example.com`;
      const res = await api("/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ email: next, current_password: PASS0 }),
      }, jar);
      expect(res.status).toBe(200);
      expect((res.body as { data: { user: { email: string; email_verified: number } } }).data.user.email).toBe(next);
      expect((res.body as { data: { user: { email: string; email_verified: number } } }).data.user.email_verified).toBe(0);
      email = next;
      // Re-verify so the next rotation starts from a verified state (keeps
      // each step's precondition identical and the flag assertions sharp).
      d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_pwlim_c';`);
    }
    const tokensBefore = qrows(d1(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = 'user_verify_pwlim_c' AND purpose = 'verify' AND used_at IS NULL;`))[0]!["n"];
    const rowBefore = qrows(d1(`SELECT email, email_verified AS v FROM users WHERE id = 'user_verify_pwlim_c';`))[0]!;
    // 6th actual email change: rejected before any write.
    const limited = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pwlc-blocked@example.com", current_password: PASS0 }),
    }, jar);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
    // Zero side effects: address, flag, and live-token set all unchanged.
    const rowAfter = qrows(d1(`SELECT email, email_verified AS v FROM users WHERE id = 'user_verify_pwlim_c';`))[0]!;
    expect(rowAfter!["email"]).toBe(rowBefore!["email"]);
    expect(rowAfter!["v"]).toBe(rowBefore!["v"]);
    expect(email).toBe("pwlc5@example.com");
    const tokensAfter = qrows(d1(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = 'user_verify_pwlim_c' AND purpose = 'verify' AND used_at IS NULL;`))[0]!["n"];
    expect(tokensAfter).toBe(tokensBefore);
  }, 120_000);

  it("successful email change resets verification and mints exactly one live token", async () => {
    // Fresh user-scoped check on user B (whose bucket is nearly pristine:
    // one change-password consumed nothing from the email bucket).
    const jar = await loginJar("pwlb@example.com", "Pwlim-Strong-B");
    const tokensBefore = qrows(d1(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = 'user_verify_pwlim_b' AND purpose = 'verify' AND used_at IS NULL;`))[0]!["n"];
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pwlb-new@example.com", current_password: "Pwlim-Strong-B" }),
    }, jar);
    expect(res.status).toBe(200);
    const user = (res.body as { data: { user: { email: string; email_verified: number } } }).data.user;
    expect(user.email).toBe("pwlb-new@example.com");
    expect(user.email_verified).toBe(0);
    const tokensAfter = qrows(d1(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = 'user_verify_pwlim_b' AND purpose = 'verify' AND used_at IS NULL;`))[0]!["n"];
    expect(Number(tokensAfter) - Number(tokensBefore)).toBe(1);
  }, 120_000);
});
