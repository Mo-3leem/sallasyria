// MVP integration suite: merchant self-registration -> login -> multi-store
// creation -> tenant isolation -> admin cross-store access.
// Real workerd (wrangler dev) + real local D1. Fixtures use the user_verify_mvp_*
// namespace (covered by scripts/clean-verify.mjs). The admin account is seeded
// via SQL (no API creates users except POST /auth/register, which hardcodes
// role='merchant' — the suite proves an admin cannot be minted that way).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18886;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PHONE_A = "+963900001101";
const PHONE_B = "+963900001102";
const ADMIN_PHONE = "+963900001103";
const PASS = "Mvp-Strong-1";
const ADMIN_PASS = "Mvp-Admin-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-mvptest-"));
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
    return { ok, error: ok ? undefined : JSON.stringify(parsed), rows: parsed };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return { ok: false, error: String(e.stderr ?? e.message ?? err) };
  }
}

function mvpCleanupDeletes(): void {
  // Own namespace only (uuid ids never match the shared clean-verify
  // prefixes, so this suite owns its residue). Child-first for RESTRICT FKs:
  // sessions -> stores -> users.
  d1(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone IN ('${PHONE_A}', '${PHONE_B}') OR id = 'user_verify_mvp_admin');`);
  d1(`DELETE FROM stores WHERE slug LIKE 'mvp-%';`);
  d1(`DELETE FROM users WHERE id = 'user_verify_mvp_admin' OR phone IN ('${PHONE_A}', '${PHONE_B}');`);
}

function d1FirstValue(sql: string): unknown {
  const r = d1(sql) as { ok: boolean; rows?: { results?: Record<string, unknown>[] }[]; error?: string };
  if (!r.ok) throw new Error(`MVP d1 failed: ${r.error}`);
  return r.rows?.[0]?.results?.[0] ? Object.values(r.rows[0].results[0])[0] : undefined;
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

function killServer(): void {
  if (!server || server.exitCode !== null) return;
  try {
    if (isWindows && server.pid !== undefined) {
      execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
  } catch {
    try {
      server.kill("SIGKILL");
    } catch { /* best effort */ }
  }
  server = null;
}

async function api(path: string, init: RequestInit = {}, cookies = "") {
  // `Connection: close` on every request: Node's fetch pools keep-alive
  // sockets, and local `wrangler dev` on Windows closes idle ones while a
  // test is busy shelling out to `wrangler d1 execute` (~10s gaps). Reusing
  // the dead socket surfaces as `read ECONNRESET` on the next call — a
  // transport artifact, not an API failure. Fresh connections dodge it
  // without any retry (retries would risk double-committing POSTs).
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

let jarA = "";
let jarB = "";
let jarAdmin = "";
let storeA = "";
let storeB = "";

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

  assertCleanVerify("mvp reset");
  mvpCleanupDeletes();
  // Only the admin is seeded. Merchants A/B arrive exclusively through
  // POST /auth/register below — the suite's central claim.
  const h = hashPassword(ADMIN_PASS);
  const r = d1(
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_mvp_admin', '${ADMIN_PHONE}', 'mvpadmin@example.com', 'MVP Admin', '${h}', 'admin');`
  );
  if (!r.ok) throw new Error(`MVP admin seed failed: ${r.error}`);

  async function loginCookie(phone: string, password: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, password }),
    });
    if (res.status !== 200) throw new Error(`MVP login failed for ${phone}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarAdmin = await loginCookie(ADMIN_PHONE, ADMIN_PASS);
}, 180_000);

afterAll(async () => {
  mvpCleanupDeletes();
  killServer();
  assertCleanVerify("mvp cleanup");
}, 120_000);

describe("POST /auth/register", () => {
  it("creates a merchant (role forced, hash never exposed)", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone: PHONE_A, password: PASS, name: "MVP Merchant A" }),
    });
    expect(res.status).toBe(201);
    const user = (res.body as { data: { user: Record<string, unknown> } }).data.user;
    expect(user.role).toBe("merchant");
    expect(user.phone).toBe(PHONE_A);
    expect(user).not.toHaveProperty("password_hash");
    expect(user).not.toHaveProperty("password");
    // Stored as scrypt hash, never plaintext (server-side proof via SQL).
    const stored = d1FirstValue(`SELECT password_hash FROM users WHERE phone = '${PHONE_A}';`);
    expect(typeof stored).toBe("string");
    expect(stored).not.toContain(PASS);
    expect(String(stored).startsWith("s1$")).toBe(true);
    const role = d1FirstValue(`SELECT role FROM users WHERE phone = '${PHONE_A}';`);
    expect(role).toBe("merchant");
  });

  it("rejects duplicate phone with 409", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone: PHONE_A, password: PASS, name: "Clone" }),
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "phone_taken", message: "Phone number is already registered." },
    });
  });

  it("refuses role smuggling with 400 and creates no admin", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone: PHONE_B, password: PASS, name: "Sneaky", role: "admin" }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "immutable_field", message: "Field 'role' cannot be set by clients." },
    });
    // No admin row appeared for that phone (nor any row at all).
    expect(d1FirstValue(`SELECT role FROM users WHERE phone = '${PHONE_B}';`)).toBeUndefined();
  });

  it("validates input through the standard envelope", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone: "", password: "short", name: "X" }),
    });
    expect(res.status).toBe(400);
    const err = (res.body as { ok: boolean; error: { code: string; details: unknown[] } }).error;
    expect(err.code).toBe("validation_failed");
    expect(err.details.length).toBeGreaterThan(0);
  });

  it("registers merchant B and both merchants log in", async () => {
    const reg = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone: PHONE_B, password: PASS, name: "MVP Merchant B" }),
    });
    expect(reg.status).toBe(201);
    for (const [phone, set] of [[PHONE_A, (j: string) => { jarA = j; }], [PHONE_B, (j: string) => { jarB = j; }]] as const) {
      const login = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ phone, password: PASS }),
      });
      expect(login.status).toBe(200);
      set(cookieOf(login.setCookie));
      const me = await api("/auth/me", {}, cookieOf(login.setCookie));
      expect(((me.body as { data: { user: { role: string } } }).data.user.role)).toBe("merchant");
    }
    expect(jarA.length).toBeGreaterThan(0);
    expect(jarB.length).toBeGreaterThan(0);
  });
}, 120_000);

describe("POST /stores", () => {
  it("merchant A creates two stores, both owned by A", async () => {
    for (const [name, slug] of [["MVP Store A1", "mvp-store-a1"], ["MVP Store A2", "mvp-store-a2"]] as const) {
      const res = await api("/stores", { method: "POST", body: JSON.stringify({ name, slug }) }, jarA);
      expect(res.status).toBe(201);
      const store = (res.body as { data: { store: { id: string; slug: string; name: string; currency: string } } }).data.store;
      expect(store.slug).toBe(slug);
      expect(store.currency).toBe("SYP");
    }
    const list = await api("/stores", {}, jarA);
    const slugs = ((list.body as { data: { stores: { slug: string }[] } }).data.stores).map((s) => s.slug);
    expect(slugs).toContain("mvp-store-a1");
    expect(slugs).toContain("mvp-store-a2");
    const owner = d1FirstValue(`SELECT owner_id FROM stores WHERE slug = 'mvp-store-a1';`);
    const meId = d1FirstValue(`SELECT id FROM users WHERE phone = '${PHONE_A}';`);
    expect(owner).toBe(meId);
  });

  it("merchant B creates one store; slug clash is 409", async () => {
    const res = await api("/stores", { method: "POST", body: JSON.stringify({ name: "MVP Store B1", slug: "mvp-store-b1" }) }, jarB);
    expect(res.status).toBe(201);
    storeB = ((res.body as { data: { store: { id: string } } }).data.store).id;
    const clash = await api("/stores", { method: "POST", body: JSON.stringify({ name: "Clone", slug: "mvp-store-b1" }) }, jarA);
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({
      ok: false,
      error: { code: "slug_taken", message: "Slug is already in use." },
    });
  });

  it("refuses owner_id smuggling with 400", async () => {
    const otherId = d1FirstValue(`SELECT id FROM users WHERE phone = '${PHONE_B}';`);
    const res = await api(
      "/stores",
      { method: "POST", body: JSON.stringify({ name: "Hijack", slug: "mvp-hijack", owner_id: otherId }) },
      jarA
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "immutable_field", message: "Field 'owner_id' cannot be set by clients." },
    });
    expect(d1FirstValue(`SELECT id FROM stores WHERE slug = 'mvp-hijack';`)).toBeUndefined();
  });

  it("requires authentication", async () => {
    const res = await api("/stores", { method: "POST", body: JSON.stringify({ name: "Anon", slug: "mvp-anon" }) });
    expect(res.status).toBe(401);
  });
}, 120_000);

describe("tenant isolation across merchants", () => {
  it("resolves store ids for the isolation probes", async () => {
    storeA = String(d1FirstValue(`SELECT id FROM stores WHERE slug = 'mvp-store-a1';`));
    expect(storeA.length).toBeGreaterThan(0);
    expect(storeB.length).toBeGreaterThan(0);
  });

  it("A reads A, B reads B, cross-reads 404 identically", async () => {
    expect((await api(`/stores/${storeA}`, {}, jarA)).status).toBe(200);
    expect((await api(`/stores/${storeB}`, {}, jarB)).status).toBe(200);
    for (const [path, jar] of [[`/stores/${storeB}`, jarA], [`/stores/${storeA}`, jarB]] as const) {
      const res = await api(path, {}, jar);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "store_not_found", message: "Store not found." },
      });
    }
  });

  it("cross-merchant PATCH cannot modify the foreign store", async () => {
    const before = d1FirstValue(`SELECT name FROM stores WHERE id = '${storeB}';`);
    const res = await api(`/stores/${storeB}`, { method: "PATCH", body: JSON.stringify({ name: "Pwned" }) }, jarA);
    expect(res.status).toBe(404);
    expect(d1FirstValue(`SELECT name FROM stores WHERE id = '${storeB}';`)).toBe(before);
  });

  it("store-scoped resources reject a substituted foreign storeId", async () => {
    // Reads.
    expect((await api(`/stores/${storeB}/products`, {}, jarA)).status).toBe(404);
    expect((await api(`/stores/${storeB}/categories`, {}, jarA)).status).toBe(404);
    expect((await api(`/stores/${storeB}/customers`, {}, jarA)).status).toBe(404);
    expect((await api(`/stores/${storeB}/orders`, {}, jarA)).status).toBe(404);
    // Writes (ownership 404s before the subscription gate is even reached —
    // either way the foreign store is untouched and no data leaks).
    const post = await api(
      `/stores/${storeB}/products`,
      { method: "POST", body: JSON.stringify({ name: "X", slug: "mvp-x", price: 100 }) },
      jarA
    );
    expect(post.status).toBe(404);
    expect(d1FirstValue(`SELECT id FROM products WHERE slug = 'mvp-x';`)).toBeUndefined();
  });

  it("admin reads both merchants' stores", async () => {
    expect((await api(`/stores/${storeA}`, {}, jarAdmin)).status).toBe(200);
    expect((await api(`/stores/${storeB}`, {}, jarAdmin)).status).toBe(200);
    const list = await api("/stores", {}, jarAdmin);
    const ids = ((list.body as { data: { stores: { id: string }[] } }).data.stores).map((s) => s.id);
    expect(ids).toContain(storeA);
    expect(ids).toContain(storeB);
  });
}, 120_000);
