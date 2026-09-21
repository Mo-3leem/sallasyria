// Self-profile integration suite: PATCH /auth/me for admins and merchants.
// Real workerd + real local D1. Fixtures use user_verify_pf_* (covered by
// scripts/clean-verify.mjs). No stores involved: this endpoint is
// user-scoped, so the tenant tests stay untouched.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`dev server never ready\n${serverOutput.slice(-3000)}`);
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
  server = spawn(isWindows ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    windowsHide: true,
  });
  server.stdout?.on("data", (d) => { serverOutput += String(d); });
  server.stderr?.on("data", (d) => { serverOutput += String(d); });
  await waitForHealth();

  assertCleanVerify("profile reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pf_admin', '${ADMIN_PHONE}', 'pfa@example.com', 'PF Admin', '${h}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pf_ma', '${MERCHANT_A_PHONE}', 'pfma@example.com', 'PF Merchant A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pf_mb', '${MERCHANT_B_PHONE}', '${MERCHANT_B_EMAIL}', 'PF Merchant B', '${h}', 'merchant');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`profile seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_pf_admin', 'user_verify_pf_ma', 'user_verify_pf_mb');`);
  jarAdmin = await loginJar("pfa@example.com", PASS);
  jarMerchant = await loginJar("pfma@example.com", PASS);
}, 180_000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    try {
      if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill("SIGTERM");
    } catch { /* best effort */ }
  }
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
  it("phone change defaults to revoking others; email login unaffected", async () => {
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
    expect((await api("/auth/me", {}, jar2)).status).toBe(401);
    // Phone is contact data, not identity: the same email still logs in.
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

  it("email change moves the login identity; old email dies", async () => {
    const jar1 = await loginJar(MERCHANT_B_EMAIL, PASS);
    const jar2 = await loginJar(MERCHANT_B_EMAIL, PASS);
    const first = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pfb-new@example.com", current_password: PASS }),
    }, jar1);
    expect(first.status).toBe(200);
    expect(((first.body as MeBody).data.user.email)).toBe("pfb-new@example.com");
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar2)).status).toBe(401);
    // New email authenticates; old email no longer does.
    expect((await api("/auth/login", { method: "POST", body: JSON.stringify({ email: "pfb-new@example.com", password: PASS }) })).status).toBe(200);
    expect((await api("/auth/login", { method: "POST", body: JSON.stringify({ email: MERCHANT_B_EMAIL, password: PASS }) })).status).toBe(401);
    const jar3 = await loginJar("pfb-new@example.com", PASS);
    const second = await api("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ email: "pfb-new2@example.com", current_password: PASS, logout_other_sessions: false }),
    }, jar1);
    expect(second.status).toBe(200);
    expect((await api("/auth/me", {}, jar1)).status).toBe(200);
    expect((await api("/auth/me", {}, jar3)).status).toBe(200);
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
