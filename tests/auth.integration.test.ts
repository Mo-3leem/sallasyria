// B2 integration suite: real workerd (wrangler dev) + real local D1.
// This file is ALSO the decisive B2-A runtime proof: every login executes
// noble-scrypt inside actual workerd — an incompatibility fails loudly here,
// not in production.
//
// Lifecycle: spawn server -> seed users via wrangler d1 execute -> run HTTP
// assertions with a manual cookie jar -> delete fixtures -> kill server.
// Fixture ids use the user_verify* namespace so scripts/clean-verify.mjs
// covers stragglers if a run aborts mid-flight.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { hashSessionToken, newSessionToken } from "../src/lib/session.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18877;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const MERCHANT_PHONE = "+963900000601";
const MERCHANT_EMAIL = "b2m@example.com";
const MERCHANT_PASS = "Merchant-Strong-1";
const ADMIN_PHONE = "+963900000602";
const ADMIN_EMAIL = "b2a@example.com";
const ADMIN_PASS = "Admin-Strong-2";
const INACTIVE_PHONE = "+963900000603";
const INACTIVE_EMAIL = "b2i@example.com";
const RATELIMIT_EMAIL = "ratelimit-b2@example.com";
const RATELIMIT_PHONE = "+963900009997";
const LEGACY_PHONE = "963900000604";
const LEGACY_EMAIL = "b2legacy@example.com";
const UNVERIFIED_PHONE = "+963900000605";
const UNVERIFIED_EMAIL = "b2unverified@example.com";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string): { ok: boolean; result?: unknown[]; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b2test-"));
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

function qrows(res: { result?: unknown[] }): Record<string, unknown>[] {
  const first = res.result?.[0] as { results?: Record<string, unknown>[] } | undefined;
  return first?.results ?? [];
}



function killServer(): void {
  stopDevServer(server);
  server = null;
}

function jar(): { cookies: Map<string, string>; ingest: (setCookie: string | null) => void; header: () => string } {
  const cookies = new Map<string, string>();
  return {
    cookies,
    ingest(setCookie: string | null) {
      if (!setCookie) return;
      // Single Set-Cookie per auth response in B2; split defensively on ", "
      // only when followed by a new cookie token (Expires contains commas).
      const parts = setCookie.split(/,(?=[^;=]+=[^;]+)/);
      for (const part of parts) {
        const seg = part.split(";")[0] ?? "";
        const idx = seg.indexOf("=");
        if (idx > 0) cookies.set(seg.slice(0, idx).trim(), seg.slice(idx + 1).trim());
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function api(
  path: string,
  init: RequestInit = {},
  cookies = ""
): Promise<{ status: number; body: unknown; setCookie: string | null }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get("set-cookie") };
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  const merchantHash = hashPassword(MERCHANT_PASS);
  const adminHash = hashPassword(ADMIN_PASS);
  assertCleanVerify("b2 reset");
  const stmts = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b2_merchant', '${MERCHANT_PHONE}', 'b2m@example.com', 'B2 Merchant', '${merchantHash}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b2_admin', '${ADMIN_PHONE}', 'b2a@example.com', 'B2 Admin', '${adminHash}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, is_active) VALUES ('user_verify_b2_inactive', '${INACTIVE_PHONE}', 'b2i@example.com', 'B2 Inactive', '${adminHash}', 0);`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b2_legacy', '${LEGACY_PHONE}', '${LEGACY_EMAIL}', 'B2 Legacy', '${merchantHash}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b2_unverified', '${UNVERIFIED_PHONE}', '${UNVERIFIED_EMAIL}', 'B2 Unverified', '${merchantHash}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b2_sess_a', '+963900000608', 'b2sessa@example.com', 'B2 Sessions A', '${merchantHash}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b2_sess_b', '+963900000609', 'b2sessb@example.com', 'B2 Sessions B', '${merchantHash}', 'merchant');`,
  ];
  for (const sql of stmts) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B2 seed failed: ${r.error} [${sql.slice(0, 80)}]`);
  }
  // Verification-gated login: seeded fixture users are verified, except the
  // dedicated unverified fixture; the unverified-login path is covered by
  // dedicated tests below.
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_b2_merchant', 'user_verify_b2_admin', 'user_verify_b2_inactive', 'user_verify_b2_legacy', 'user_verify_b2_sess_a', 'user_verify_b2_sess_b');`);
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b2 end");
  } finally {
    killServer();
  }
}, 60_000);

describe("B2 login", () => {
  it("valid login creates a session cookie and never leaks the token or hash", async () => {
    const j = jar();
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    expect(res.status).toBe(200);
    j.ingest(res.setCookie);
    const raw = j.cookies.get("ss_session");
    expect(raw).toBeTruthy();
    expect(res.setCookie).toContain("HttpOnly");
    expect(res.setCookie).toContain("SameSite=Lax");
    expect(res.setCookie).toContain("Path=/");
    // Host-only (no Domain attribute): the cookie is first-party wherever
    // the frontend is served, so browsers with third-party-cookie blocking
    // (mobile Safari ITP, WebViews) still persist the session. The app calls
    // the API same-origin via the /api/backend proxy for the same reason.
    expect(res.setCookie).not.toContain("Domain=");

    const body = res.body as { ok: boolean; data: { user: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.data.user).toMatchObject({ email: MERCHANT_EMAIL, role: "merchant" });
    expect(body.data.user).not.toHaveProperty("password_hash");
    expect(JSON.stringify(body)).not.toContain(raw);

    // DB holds SHA-256(raw), never raw.
    const expected = await hashSessionToken(raw!);
    const found = d1(
      `SELECT user_id, token_hash FROM sessions WHERE user_id = 'user_verify_b2_merchant';`
    );
    expect(found.ok).toBe(true);
    const rows = qrows(found);
    expect(rows.some((r) => r["token_hash"] === expected)).toBe(true);
    expect(rows.some((r) => r["token_hash"] === raw)).toBe(false);
  }, 30_000);

  it("wrong password, unknown identity, and inactive user share one 401", async () => {
    const bodies: unknown[] = [
      { email: MERCHANT_EMAIL, password: "Wrong-Password-9" },
      { email: "unknown-b2@example.com", password: "Whatever-1" },
      { email: INACTIVE_EMAIL, password: ADMIN_PASS },
      { identity: MERCHANT_PHONE, password: "Wrong-Password-9" },
      { identity: "+963900009999", password: "Whatever-1" },
      { identity: INACTIVE_PHONE, password: ADMIN_PASS },
    ];
    for (const body of bodies) {
      const res = await api("/auth/login", { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "invalid_credentials", message: "Invalid email/phone or password." },
      });
    }
  }, 60_000);

  it("email identity is normalized; legacy email field still works", async () => {
    const upper = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identity: "  B2M@EXAMPLE.COM  ", password: MERCHANT_PASS }),
    });
    expect(upper.status).toBe(200);
    const legacy = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    expect(legacy.status).toBe(200);
    // The deprecated email alias keeps its email shape: a phone is 400 there.
    const byPhone = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_PHONE, password: MERCHANT_PASS }),
    });
    expect(byPhone.status).toBe(400);
    const rawPhone = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "merchant", password: MERCHANT_PASS }),
    });
    expect(rawPhone.status).toBe(400);
  }, 60_000);

  it("phone login resolves formatting variants to one account", async () => {
    const variants = [
      "+963900000601",
      "0900000601",
      "+963 900 000 601",
      "+963-900-000-601",
      "(+963) 900-000-601",
      "٠٩٠٠٠٠٠٦٠١",
    ];
    for (const identity of variants) {
      const res = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identity, password: MERCHANT_PASS }),
      });
      expect(res.status, `variant ${identity}`).toBe(200);
      expect((res.body as { data: { user: { id: string } } }).data.user.id).toBe(
        "user_verify_b2_merchant"
      );
    }
  }, 60_000);

  it("admin login by phone works", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identity: ADMIN_PHONE, password: ADMIN_PASS }),
    });
    expect(res.status).toBe(200);
    expect((res.body as { data: { user: { role: string } } }).data.user.role).toBe("admin");
  }, 30_000);

  it("legacy raw-format stored phone still authenticates", async () => {
    // user_verify_b2_legacy stores "963900000604" (no +): the canonical
    // lookup misses, the exact-match fallback resolves it.
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identity: "963900000604", password: MERCHANT_PASS }),
    });
    expect(res.status).toBe(200);
    expect((res.body as { data: { user: { id: string } } }).data.user.id).toBe(
      "user_verify_b2_legacy"
    );
  }, 30_000);

  it("malformed phones follow the generic 401 path, never 400", async () => {
    for (const identity of ["not-a-phone", "+15551234567", "12", "+"]) {
      const res = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identity, password: "Whatever-1" }),
      });
      expect(res.status, `identity ${identity}`).toBe(401);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "invalid_credentials", message: "Invalid email/phone or password." },
      });
    }
  }, 60_000);

  it("unverified account by phone is 403, like email", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identity: UNVERIFIED_PHONE, password: MERCHANT_PASS }),
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "email_not_verified", message: "Email verification required." },
    });
  }, 30_000);

  it("missing identity is 400", async () => {
    const missing = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "x" }),
    });
    expect(missing.status).toBe(400);
    const empty = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identity: "", password: "x" }),
    });
    expect(empty.status).toBe(400);
  }, 30_000);

  it("registration stores the canonical phone", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "b2reg@example.com",
        phone: "0900000606",
        name: "B2 Reg",
        password: MERCHANT_PASS,
      }),
    });
    expect(res.status).toBe(201);
    const found = d1(`SELECT phone FROM users WHERE email = 'b2reg@example.com';`);
    expect(found.ok).toBe(true);
    expect(qrows(found)[0]?.["phone"]).toBe("+963900000606");
    const del = d1(`DELETE FROM users WHERE email = 'b2reg@example.com';`);
    expect(del.ok).toBe(true);
  }, 30_000);

  it("rejects invalid bodies with 400", async () => {
    const empty = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "", password: "" }) });
    expect(empty.status).toBe(400);
    const huge = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: "x".repeat(300) }),
    });
    expect(huge.status).toBe(400);
  }, 30_000);
});

describe("B2 sessions", () => {
  it("me works with the cookie and 401s without it", async () => {
    const j = jar();
    const login = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    j.ingest(login.setCookie);
    const me = await api("/auth/me", {}, j.header());
    expect(me.status).toBe(200);
    expect((me.body as { data: { user: { id: string } } }).data.user.id).toBe("user_verify_b2_merchant");

    const anon = await api("/auth/me");
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "Authentication required." },
    });
  }, 30_000);

  it("tampered and unknown tokens are rejected, never confused across users", async () => {
    const j = jar();
    const login = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
    });
    j.ingest(login.setCookie);
    const raw = j.cookies.get("ss_session")!;
    const tampered = await api("/auth/me", {}, `ss_session=${raw.slice(0, -2)}xx`);
    expect(tampered.status).toBe(401);
    const ghost = await api("/auth/me", {}, `ss_session=${"0".repeat(43)}`);
    expect(ghost.status).toBe(401);
    const me = await api("/auth/me", {}, j.header());
    expect(((me.body as { data: { user: { id: string } } }).data.user.id)).toBe("user_verify_b2_admin");
  }, 30_000);

  it("expired sessions are rejected", async () => {
    const token = newSessionToken();
    const hash = await hashSessionToken(token);
    const ins = d1(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('sess_verify_b2_expired', 'user_verify_b2_merchant', '${hash}', '2020-01-01T00:00:00Z');`
    );
    expect(ins.ok).toBe(true);
    const res = await api("/auth/me", {}, `ss_session=${token}`);
    expect(res.status).toBe(401);
  }, 30_000);

  it("logout revokes server-side: cookie dies immediately and row is marked", async () => {
    const j = jar();
    const login = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    j.ingest(login.setCookie);
    const out = await api("/auth/logout", { method: "POST" }, j.header());
    expect(out.status).toBe(200);
    const after = await api("/auth/me", {}, j.header());
    expect(after.status).toBe(401);
    const rows = qrows(
      d1(`SELECT revoked_at FROM sessions WHERE user_id = 'user_verify_b2_merchant' AND revoked_at IS NOT NULL;`)
    );
    expect(rows.length).toBeGreaterThan(0);
  }, 30_000);

  it("two sessions are independent; logout-others keeps only the caller", async () => {
    const a = jar();
    const b = jar();
    const la = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    const lb = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    a.ingest(la.setCookie);
    b.ingest(lb.setCookie);
    expect(a.cookies.get("ss_session")).not.toBe(b.cookies.get("ss_session"));

    expect((await api("/auth/logout", { method: "POST" }, a.header())).status).toBe(200);
    expect((await api("/auth/me", {}, a.header())).status).toBe(401);
    expect((await api("/auth/me", {}, b.header())).status).toBe(200);

    const c = jar();
    const lc = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASS }),
    });
    c.ingest(lc.setCookie);
    const purge = await api("/auth/logout-others", { method: "POST" }, c.header());
    expect(purge.status).toBe(200);
    expect((await api("/auth/me", {}, b.header())).status).toBe(401);
    expect((await api("/auth/me", {}, c.header())).status).toBe(200);
  }, 60_000);

  it("rate-limits sustained guessing on one key", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: RATELIMIT_EMAIL, password: "Guess-Number-1" }),
      });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(401); // limiter starts open: first attempts judged on merit
    expect(statuses[statuses.length - 1]).toBe(429);
  }, 120_000);

  it("rate-limits sustained guessing on a canonical phone key", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identity: RATELIMIT_PHONE, password: "Guess-Number-1" }),
      });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses[statuses.length - 1]).toBe(429);
  }, 120_000);
});

describe("B2 session list + per-session revoke", () => {
  // Dedicated fixtures: the login rate limiter (10/10min per identity) is
  // already exhausted for the shared merchant by earlier tests in this file.
  async function loginJar(email = "b2sessa@example.com"): Promise<{ jar: ReturnType<typeof jar>; header: string }> {
    const j = jar();
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: MERCHANT_PASS }),
    });
    expect(res.status).toBe(200);
    j.ingest(res.setCookie);
    return { jar: j, header: j.header() };
  }

  type SessionEntry = { id: string; created_at: string; last_used_at: string | null; current: boolean };

  async function listSessions(header: string) {
    const res = await api("/auth/sessions", {}, header);
    expect(res.status).toBe(200);
    return (res.body as { ok: boolean; data: { sessions: SessionEntry[] } }).data.sessions;
  }

  it("lists only the caller's live sessions with the current one flagged, never secrets", async () => {
    const a = await loginJar();
    const b = await loginJar();
    const mine = await listSessions(a.header);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const currents = mine.filter((s) => s.current);
    expect(currents).toHaveLength(1);
    for (const s of mine) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.created_at).toBe("string");
      expect(s).not.toHaveProperty("token_hash");
      expect(s).not.toHaveProperty("token");
    }
    expect(JSON.stringify(mine)).not.toContain("token_hash");
    // The other login's session is listed too (same user), flagged non-current.
    expect(mine.some((s) => !s.current)).toBe(true);
    // Cleanup: leave no extra sessions for later tests.
    const other = mine.find((s) => !s.current)!;
    const del = await api(`/auth/sessions/${other.id}`, { method: "DELETE" }, a.header);
    expect(del.status).toBe(200);
    expect((await listSessions(a.header)).length).toBe(mine.length - 1);
    expect((await api("/auth/me", {}, b.header)).status).toBe(401);
  }, 60_000);

  it("revoked sessions disappear and their cookies die; unknown ids 404", async () => {
    const a = await loginJar();
    const b = await loginJar();
    const mine = await listSessions(a.header);
    const other = mine.find((s) => !s.current)!;
    const del = await api(`/auth/sessions/${other.id}`, { method: "DELETE" }, a.header);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, data: { revoked: true } });
    // Revoked cookie is dead and the row no longer lists.
    expect((await api("/auth/me", {}, b.header)).status).toBe(401);
    expect((await listSessions(a.header)).some((s) => s.id === other.id)).toBe(false);
    // Repeat revoke is 404 (already revoked), unknown id is 404.
    expect((await api(`/auth/sessions/${other.id}`, { method: "DELETE" }, a.header)).status).toBe(404);
    expect((await api("/auth/sessions/no-such-session", { method: "DELETE" }, a.header)).status).toBe(404);
    // Caller survives: exactly one live session remains for this account
    // from this test (other tests' sessions may also list; all are ours).
    const rest = await listSessions(a.header);
    expect(rest.filter((s) => s.current)).toHaveLength(1);
  }, 60_000);

  it("cannot revoke the current session or another user's session; anon is 401", async () => {
    const a = await loginJar();
    const mine = await listSessions(a.header);
    const current = mine.find((s) => s.current)!;
    const selfDel = await api(`/auth/sessions/${current.id}`, { method: "DELETE" }, a.header);
    expect(selfDel.status).toBe(400);
    expect((await api("/auth/me", {}, a.header)).status).toBe(200);
    // Another user's live session id is opaque: revoke attempt 404s without
    // leaking whether it exists or belongs to someone else.
    const otherLogin = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "b2sessb@example.com", password: MERCHANT_PASS }),
    });
    const oj = jar();
    oj.ingest(otherLogin.setCookie);
    const otherSessions = await listSessions(oj.header());
    const foreign = otherSessions.find((s) => s.current)!;
    expect((await api(`/auth/sessions/${foreign.id}`, { method: "DELETE" }, a.header)).status).toBe(404);
    expect((await api("/auth/me", {}, oj.header())).status).toBe(200);
    // Anonymous.
    expect((await api("/auth/sessions")).status).toBe(401);
    expect((await api("/auth/sessions/whatever", { method: "DELETE" })).status).toBe(401);
    // Cleanup caller's extra session.
    const leftover = (await listSessions(a.header)).find((s) => !s.current);
    if (leftover) {
      expect((await api(`/auth/sessions/${leftover.id}`, { method: "DELETE" }, a.header)).status).toBe(200);
    }
  }, 60_000);
});
