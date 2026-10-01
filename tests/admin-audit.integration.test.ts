// B12 integration suite: admin users directory + persistent audit log +
// audit viewer. Real workerd + real local D1. Fixtures use user_verify_b12_*
// (covered by scripts/clean-verify.mjs). Audit rows from other suites share
// the same local database, so every assertion here scopes by test actor or
// uses every()/at-least semantics — never global exact counts.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18906;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";
const PASS = "B12-Strong-1";
const ADMIN_ID = "user_verify_b12_admin";
const ADMIN_EMAIL = "b12admin@example.com";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b12test-"));
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
    const stmts = Array.isArray(parsed) ? parsed : [parsed];
    const ok = stmts.every((r) => (r as { success?: boolean }).success !== false && !(r as { error?: unknown }).error);
    return { ok, result: parsed, error: ok ? undefined : JSON.stringify(parsed).slice(0, 500) };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return { ok: false, result: undefined, error: String(e.stderr ?? e.message ?? err).slice(0, 500) };
  }
}

function qrows(res: { result?: unknown }): Record<string, unknown>[] {
  const arr = (Array.isArray(res.result) ? res.result : [res.result]) as { results?: Record<string, unknown>[] }[];
  return arr[0]?.results ?? [];
}

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const headers: Record<string, string> = {
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
  if (res.status !== 200) throw new Error(`b12 login failed for ${email}: ${res.status}`);
  return cookieOf(res.headers.get("set-cookie"));
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {});
  await waitForHealthy(BASE, () => server, () => serverOutput);
  assertCleanVerify("b12 reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('${ADMIN_ID}', '+963900002203', '${ADMIN_EMAIL}', 'B12 Admin', '${h}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b12_m1', '+963900002201', 'b12m1@example.com', 'B12 M1', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b12_m2', '+963900002202', 'b12m2@example.com', 'B12 M2', '${h}', 'merchant');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`b12 seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id LIKE 'user_verify_b12%';`);
}, 180_000);

afterAll(async () => {
  try {
    const users = d1(`DELETE FROM sessions WHERE user_id LIKE 'user_verify_b12%';DELETE FROM users WHERE id LIKE 'user_verify_b12%';DELETE FROM audit_logs WHERE actor_id LIKE 'user_verify_b12%' OR actor_id = 'billing:webhook';`);
    expect(users.ok, `cleanup failed: ${users.error}`).toBe(true);
    assertCleanVerify("b12 end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 60_000);

type DirBody = { data: { users: { id: string; role: string }[]; pagination: { total: number; total_pages: number } } };
type AuditBody = {
  data: {
    events: { id: string; created_at: string; action: string; actor_id: string; store_id: string | null; result: string }[];
    pagination: { total: number };
  };
};

describe("B12 admin users directory", () => {
  it("requires admin: anon 401, merchant 403", async () => {
    expect((await api("/admin/users")).status).toBe(401);
    const jarM = await loginJar("b12m1@example.com", PASS);
    expect((await api("/admin/users", {}, jarM)).status).toBe(403);
  }, 120_000);

  it("lists both roles with search, role filter, and pagination", async () => {
    const jar = await loginJar(ADMIN_EMAIL, PASS);
    const all = await api("/admin/users?page_size=100", {}, jar);
    expect(all.status).toBe(200);
    const ids = ((all.body as DirBody).data.users).map((u) => u.id);
    expect(ids).toContain(ADMIN_ID);
    expect(ids).toContain("user_verify_b12_m1");
    const roles = new Set(((all.body as DirBody).data.users).map((u) => u.role));
    expect(roles.has("admin")).toBe(true);
    expect(roles.has("merchant")).toBe(true);

    const onlyAdmins = await api("/admin/users?role=admin&page_size=100", {}, jar);
    const ba = onlyAdmins.body as DirBody;
    expect(ba.data.users.every((u) => u.role === "admin")).toBe(true);
    expect(ba.data.users.map((u) => u.id)).toContain(ADMIN_ID);
    const onlyMerchants = await api("/admin/users?role=merchant&q=b12m1", {}, jar);
    const bm = onlyMerchants.body as DirBody;
    expect(bm.data.users.every((u) => u.role === "merchant")).toBe(true);
    expect(bm.data.users.map((u) => u.id)).toContain("user_verify_b12_m1");

    expect((await api("/admin/users?role=owner", {}, jar)).status).toBe(400);
    expect((await api("/admin/users?page=0", {}, jar)).status).toBe(400);
    const paged = await api("/admin/users?page=1&page_size=1", {}, jar);
    expect((paged.body as DirBody).data.pagination.total).toBe(
      (all.body as DirBody).data.pagination.total
    );
  }, 120_000);
});

describe("B12 audit persistence and viewer", () => {
  it("viewer requires admin: anon 401, merchant 403", async () => {
    expect((await api("/admin/audit-log")).status).toBe(401);
    const jarM = await loginJar("b12m1@example.com", PASS);
    expect((await api("/admin/audit-log", {}, jarM)).status).toBe(403);
  }, 120_000);

  it("mutations and reads persist rows the viewer returns with filters", async () => {
    const jar = await loginJar(ADMIN_EMAIL, PASS);
    // A mutation with a distinctive actor + a read, then verify both rows.
    const upd = await api(`/admin/merchants/user_verify_b12_m1`, {
      method: "PATCH",
      body: JSON.stringify({ name: "B12 M1 Renamed" }),
    }, jar);
    expect(upd.status).toBe(200);
    const list = await api("/admin/merchants?page_size=1", {}, jar);
    expect(list.status).toBe(200);

    const byActor = await api(`/admin/audit-log?actor=${ADMIN_ID}&page_size=100`, {}, jar);
    expect(byActor.status).toBe(200);
    const rows = (byActor.body as AuditBody).data.events;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("admin.merchant.update");
    expect(actions).toContain("admin.merchants.read");
    expect(rows.every((r) => r.actor_id === ADMIN_ID)).toBe(true);
    // Rows carry ids only: no tokens, hashes, or passwords.
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.created_at).toBe("string");
      expect(JSON.stringify(r).toLowerCase()).not.toContain("password");
    }

    // Action filter narrows; unknown action value still 200 with rows.
    const byAction = await api(`/admin/audit-log?action=admin.merchant.update&page_size=100`, {}, jar);
    const ra = (byAction.body as AuditBody).data.events;
    expect(ra.length).toBeGreaterThanOrEqual(1);
    expect(ra.every((r) => r.action === "admin.merchant.update")).toBe(true);

    // Date bounds: wide range includes, future range excludes.
    const wide = await api(
      `/admin/audit-log?actor=${ADMIN_ID}&since=2020-01-01T00:00:00Z&until=2099-01-01T00:00:00Z`,
      {},
      jar
    );
    expect(((wide.body as AuditBody).data.events).length).toBeGreaterThanOrEqual(2);
    const future = await api(
      `/admin/audit-log?actor=${ADMIN_ID}&since=2099-06-01T00:00:00Z`,
      {},
      jar
    );
    expect(((future.body as AuditBody).data.events)).toEqual([]);
    expect((future.body as AuditBody).data.pagination.total).toBe(0);
  }, 180_000);

  it("viewer paginates with metadata and invalid params 400", async () => {
    const jar = await loginJar(ADMIN_EMAIL, PASS);
    const p1 = await api("/admin/audit-log?page=1&page_size=1", {}, jar);
    expect(p1.status).toBe(200);
    const b1 = p1.body as AuditBody & { data: { pagination: { page: number; page_size: number; total_pages: number } } };
    expect(b1.data.events).toHaveLength(1);
    expect(b1.data.pagination.page).toBe(1);
    expect(b1.data.pagination.page_size).toBe(1);
    expect((await api("/admin/audit-log?page=0", {}, jar)).status).toBe(400);
    expect((await api("/admin/audit-log?page_size=101", {}, jar)).status).toBe(400);
  }, 120_000);

  it("date bounds accept ISO datetimes and plain dates, reject garbage", async () => {
    const jar = await loginJar(ADMIN_EMAIL, PASS);
    // Plain YYYY-MM-DD bounds (what the viewer date inputs send).
    const day = await api(`/admin/audit-log?actor=${ADMIN_ID}&since=2020-01-01&until=2099-01-01`, {}, jar);
    expect(day.status).toBe(200);
    expect(((day.body as AuditBody).data.events).length).toBeGreaterThanOrEqual(1);
    // Malformed bounds are 400, not silent empty results.
    expect((await api("/admin/audit-log?since=not-a-date", {}, jar)).status).toBe(400);
    expect((await api("/admin/audit-log?until=2099-13-99", {}, jar)).status).toBe(400);
    expect((await api("/admin/audit-log?since=2020-13-01", {}, jar)).status).toBe(400);
  }, 120_000);
});
