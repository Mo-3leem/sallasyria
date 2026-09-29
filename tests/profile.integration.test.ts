// Self-profile integration suite: PATCH /auth/me for admins and merchants.
// Real workerd + real local D1. Fixtures use user_verify_pf_* (covered by
// scripts/clean-verify.mjs). No stores involved: this endpoint is
// user-scoped, so the tenant tests stay untouched.

import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18888;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const ADMIN_PHONE = "+963900001301";
const MERCHANT_A_PHONE = "+963900001302";
const MERCHANT_B_PHONE = "+963900001303";
const MERCHANT_B_EMAIL = "pfb@example.com";
const PASS = "Profile-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-pftest-"));
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
    return { ok: false, error: String(e.stderr ?? e.message ?? err) };
  }
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

async function loginJar(email: string, password: string): Promise<string> {
  const res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`profile setup login failed for ${email}: ${res.status}`);
  return cookieOf(res.setCookie);
}

interface MeBody {
  data: { user: Record<string, unknown>; reauth_required: boolean };
}

let jarAdmin = "";
let jarMerchant = "";

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("profile reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pf_admin', '${ADMIN_PHONE}', 'pfa@example.com', 'PF Admin', '${h}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pf_ma', '${MERCHANT_A_PHONE}', 'pfma@example.com', 'PF Merchant A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pf_mb', '${MERCHANT_B_PHONE}', '${MERCHANT_B_EMAIL}', 'PF Merchant B', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pf_mc', '+963900001304', 'pfc@example.com', 'PF Merchant C', '${h}', 'merchant');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`profile seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_pf_admin', 'user_verify_pf_ma', 'user_verify_pf_mb', 'user_verify_pf_mc');`);
  jarAdmin = await loginJar("pfa@example.com", PASS);
  jarMerchant = await loginJar("pfma@example.com", PASS);
}, 180_000);

afterAll(async () => {
    stopDevServer(server);
    server = null;
  assertCleanVerify("profile cleanup");
}, 120_000);

function expectCleanUser(body: unknown): Record<string, unknown> {
  const user = (body as MeBody).data.user;
  expect(user).not.toHaveProperty("password_hash");
  expect(user).not.toHaveProperty("password");
  expect(JSON.stringify(body)).not.toContain(PASS);
  return user;
}

describe("GET /auth/me email_verified shaping", () => {
  it("reports the stored verification flag instead of a hardcoded 0", async () => {
    // Fixtures are seeded verified (see beforeAll UPDATE above).
    for (const jar of [jarAdmin, jarMerchant]) {
      const me = await api("/auth/me", {}, jar);
      expect(me.status).toBe(200);
      expect(((me.body as MeBody).data.user.email_verified)).toBe(1);
    }
  });

  it("PATCH /auth/me response carries the stored verification flag", async () => {
    const res = await api("/auth/me", { method: "PATCH", body: JSON.stringify({ name: "Verified Name" }) }, jarMerchant);
    expect(res.status).toBe(200);
    expect(((res.body as MeBody).data.user.email_verified)).toBe(1);
  });
});

describe("PATCH /auth/me name updates", () => {
  it("admin updates name, sessions stay valid", async () => {
    const res = await api("/auth/me", { method: "PATCH", body: JSON.stringify({ name: "Renamed Admin" }) }, jarAdmin);
    expect(res.status).toBe(200);
    const user = expectCleanUser(res.body);
    expect(user.name).toBe("Renamed Admin");
    expect((res.body as MeBody).data.reauth_required).toBe(false);
    // Old session still alive after a name-only edit.
    const me = await api("/auth/me", {}, jarAdmin);
    expect(me.status).toBe(200);
  });

  it("merchant updates name", async () => {
    const res = await api("/auth/me", { method: "PATCH", body: JSON.stringify({ name: "Renamed Merchant" }) }, jarMerchant);
    expect(res.status).toBe(200);
    expectCleanUser(res.body);
    expect(((res.body as MeBody).data.user.name)).toBe("Renamed Merchant");
  });
}, 90_000);

describe("PATCH /auth/me guards", () => {
  it("email/phone change without current_password is 400", async () => {
    for (const body of [{ email: "new@example.com" }, { phone: "+963900001399" }]) {
      const res = await api("/auth/me", { method: "PATCH", body: JSON.stringify(body) }, jarAdmin);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "current_password_required", message: expect.any(String) },
      });
    }
  });

  it("email/phone change with wrong password is 401", async () => {
    const res = await api(
      "/auth/me",
      { method: "PATCH", body: JSON.stringify({ email: "new@example.com", current_password: "Wrong-Pass-1" }) },
      jarAdmin
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: "Invalid email or password." },
    });
  });

  it("duplicate email is 409 email_taken", async () => {
    const res = await api(
      "/auth/me",
      { method: "PATCH", body: JSON.stringify({ email: MERCHANT_B_EMAIL, current_password: PASS }) },
      jarAdmin
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "email_taken", message: expect.any(String) },
    });
  });

  it("duplicate phone is 409 phone_taken", async () => {
    const res = await api(
      "/auth/me",
      { method: "PATCH", body: JSON.stringify({ phone: MERCHANT_B_PHONE, current_password: PASS }) },
      jarAdmin
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "phone_taken", message: expect.any(String) },
    });
  });

  it("immutable fields are 400", async () => {
    for (const [key, value] of [
      ["id", "forged"],
      ["role", "admin"],
      ["is_active", 0],
      ["password_hash", "s1$forged"],
      ["created_at", "2020-01-01T00:00:00Z"],
    ] as const) {
      const res = await api("/auth/me", { method: "PATCH", body: JSON.stringify({ [key]: value }) }, jarAdmin);
      expect(res.status, `field ${key}`).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "immutable_field", message: expect.any(String) },
      });
    }
  });
}, 90_000);

describe("PATCH /auth/me logout_other_sessions", () => {
  it("phone change defaults to keeping every session", async () => {
    const jar1 = await loginJar("pfma@example.com", PASS);
    const jar2 = await loginJar("pfma@example.com", PASS);
    const NEW_PHONE = "+963900001321";
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ phone: NEW_PHONE, current_password: PASS }),
    }, jar1);
    expect(res.status).toBe(200);
    const user = expectCleanUser(res.body);
    expect(user.phone).toBe(NEW_PHONE);
    expect((res.body as MeBody).data.reauth_required).toBe(false);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar2)).status).toBe(200);
    // Phone doubles as a login identity: the same email still logs in.
    expect((await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "pfma@example.com", password: PASS }) })).status).toBe(200);
  });

  it("phone change with explicit true revokes others only", async () => {
    const jar1 = await loginJar("pfma@example.com", PASS);
    const jar2 = await loginJar("pfma@example.com", PASS);
    const NEW_PHONE = "+963900001322";
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ phone: NEW_PHONE, current_password: PASS, logout_other_sessions: true }),
    }, jar1);
    expect(res.status).toBe(200);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar2)).status).toBe(401);
  });

  it("phone change with false keeps every session", async () => {
    const jar1 = await loginJar("pfma@example.com", PASS);
    const jar2 = await loginJar("pfma@example.com", PASS);
    const NEW_PHONE = "+963900001323";
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ phone: NEW_PHONE, current_password: PASS, logout_other_sessions: false }),
    }, jar1);
    expect(res.status).toBe(200);
    expect((res.body as MeBody).data.reauth_required).toBe(false);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar2)).status).toBe(200);
  });

  it("phone change stores the canonical form and it authenticates", async () => {
    const jar1 = await loginJar("pfma@example.com", PASS);
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ phone: "0900001324", current_password: PASS }),
    }, jar1);
    expect(res.status).toBe(200);
    expect(((res.body as MeBody).data.user.phone)).toBe("+963900001324");
    // The new canonical phone logs in via the identity field.
    expect((await api("/auth/login", { method: "POST", body: JSON.stringify({ identity: "+963900001324", password: PASS }) })).status).toBe(200);
    // Restore the fixture phone for later tests.
    const back = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ phone: MERCHANT_A_PHONE, current_password: PASS }),
    }, jar1);
    expect(back.status).toBe(200);
    expect(((back.body as MeBody).data.user.phone)).toBe(MERCHANT_A_PHONE);
  });

  it("email change moves the login identity; old email dies", async () => {
    const jar1 = await loginJar(MERCHANT_B_EMAIL, PASS);
    const jar2 = await loginJar(MERCHANT_B_EMAIL, PASS);
    const first = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pfb-new@example.com", current_password: PASS, logout_other_sessions: true }),
    }, jar1);
    expect(first.status).toBe(200);
    expect(((first.body as MeBody).data.user.email)).toBe("pfb-new@example.com");
    // Re-verification: the new address starts unverified.
    expect(((first.body as MeBody).data.user.email_verified)).toBe(0);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar2)).status).toBe(401);
    // New email must verify before it authenticates; old email is dead.
    expect((await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "pfb-new@example.com", password: PASS }) })).status).toBe(403);
    expect((await api("/auth/login", { method: "POST", body: JSON.stringify({ email: MERCHANT_B_EMAIL, password: PASS }) })).status).toBe(401);
    // Verify out-of-band (test shortcut for the mailed link; redeem itself
    // is covered in the email suite), then the new identity logs in.
    expect(d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_pf_mb';`).ok).toBe(true);
    expect((await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "pfb-new@example.com", password: PASS }) })).status).toBe(200);
    const jar3 = await loginJar("pfb-new@example.com", PASS);
    const second = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pfb-new2@example.com", current_password: PASS, logout_other_sessions: false }),
    }, jar1);
    expect(second.status).toBe(200);
    expect(((second.body as MeBody).data.user.email_verified)).toBe(0);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar3)).status).toBe(200);
    // Re-verify so later tests can log in as the restored address.
    expect(d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_pf_mb';`).ok).toBe(true);
  });

  it("email change with omitted flag keeps every session", async () => {
    const jar1 = await loginJar("pfb-new2@example.com", PASS);
    const jar2 = await loginJar("pfb-new2@example.com", PASS);
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pfb-new3@example.com", current_password: PASS }),
    }, jar1);
    expect(res.status).toBe(200);
    expect(((res.body as MeBody).data.user.email_verified)).toBe(0);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar2)).status).toBe(200);
    // restore the known address for later tests (and re-verify it, since
    // the change above reset the flag).
    const back = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pfb-new2@example.com", current_password: PASS }),
    }, jar1);
    expect(back.status).toBe(200);
    expect(d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_pf_mb';`).ok).toBe(true);
  });

  it("same-value phone/email needs no password and revokes nothing", async () => {
    const jar1 = await loginJar("pfb-new2@example.com", PASS);
    const jar2 = await loginJar("pfb-new2@example.com", PASS);
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ phone: MERCHANT_B_PHONE, email: "pfb-new2@example.com", logout_other_sessions: true }),
    }, jar1);
    expect(res.status).toBe(200);
    expect((res.body as MeBody).data.reauth_required).toBe(false);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar2)).status).toBe(200);
  });
}, 120_000);

describe("PATCH /auth/me email re-verification", () => {
  const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

  function liveVerifyTokens(userId: string): string[] {
    const r = d1(
      `SELECT token_hash FROM email_tokens WHERE user_id = '${userId}' AND purpose = 'verify' AND used_at IS NULL;`
    );
    if (!r.ok) throw new Error(`token lookup failed: ${r.error}`);
    return ((r.result?.[0] as unknown as { results?: { token_hash: string }[] } | undefined)?.results ?? []).map(
      (row) => row.token_hash
    );
  }

  it("email change resets verification, retires old tokens, issues a live one, gates login", async () => {
    // A known pre-change token: must be retired by the change.
    const oldRaw = "pfmc-old-token-1";
    expect(
      d1(
        `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ('tok_pfmc_old_1', 'user_verify_pf_mc', 'verify', '${tokenHash(oldRaw)}', '2099-01-01T00:00:00Z');`
      ).ok
    ).toBe(true);
    const jar1 = await loginJar("pfc@example.com", PASS);
    const res = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pfc-new@example.com", current_password: PASS, logout_other_sessions: false }),
    }, jar1);
    expect(res.status).toBe(200);
    expect(((res.body as MeBody).data.user.email)).toBe("pfc-new@example.com");
    expect(((res.body as MeBody).data.user.email_verified)).toBe(0);
    // Current session survives (flag omitted/false keeps everything).
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    // Stale token is dead: redeeming it 400s like an unknown token.
    expect(
      (await api("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: oldRaw }) })).status
    ).toBe(400);
    // Exactly one live token remains, and it is not the old one.
    const live = liveVerifyTokens("user_verify_pf_mc");
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(tokenHash(oldRaw));
    // Gate: new address 403s until verified; old address is a dead identity.
    expect(
      (await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "pfc-new@example.com", password: PASS }) })).status
    ).toBe(403);
    expect(
      (await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "pfc@example.com", password: PASS }) })).status
    ).toBe(401);
    // Verify out-of-band (test shortcut for the mailed link; the redeem
    // mechanics are covered in the email suite), then login works normally.
    expect(d1(`UPDATE users SET email_verified = 1 WHERE id = 'user_verify_pf_mc';`).ok).toBe(true);
    expect(
      (await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "pfc-new@example.com", password: PASS }) })).status
    ).toBe(200);
  }, 60_000);
});
