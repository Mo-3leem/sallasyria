// Avatar integration suite: user profile pictures over the shared R2
// upload pipeline. Real workerd + real local D1 + emulated local R2.
// Fixtures use user_verify_av_* (covered by scripts/clean-verify.mjs).
// The signing secret arrives via `wrangler dev --var` (never .dev.vars,
// never committed) so the full sign/upload/serve path is exercised.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18891;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";
const SIGNING_SECRET = "avatar-integration-secret";

const PHONE_A = "+963900000701";
const PHONE_B = "+963900000702";
const EMAIL_A = "ava@example.com";
const EMAIL_B = "avb@example.com";
const PASS = "Avatar-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-avtest-"));
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

function qrows(res: { result?: unknown[] }): Record<string, unknown>[] {
  const first = res.result?.[0] as { results?: Record<string, unknown>[] } | undefined;
  return first?.results ?? [];
}



async function api(path: string, init: RequestInit = {}, cookies = "") {
  const headers: Record<string, string> = {
    ...(cookies ? { Cookie: cookies } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  // fetch sets the multipart boundary itself; a preset Content-Type would
  // break the body parse (same discipline as the product upload suite).
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON (image bytes) */ }
  return { status: res.status, body, headers: res.headers, raw: res };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

// Minimal valid 1x1 PNG (signature + IHDR + IEND): sniffs as image/png.
function tinyPng(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
    0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function avatarForm(bytes: Uint8Array, name = "avatar.png", type = "image/png"): FormData {
  const form = new FormData();
  form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type }), name);
  return form;
}

let jarA = "";
let jarB = "";

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `URL_SIGNING_SECRET:${SIGNING_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  const h = hashPassword(PASS);
  assertCleanVerify("av reset");
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_av_a', '${PHONE_A}', '${EMAIL_A}', 'AV Owner A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_av_b', '${PHONE_B}', '${EMAIL_B}', 'AV Owner B', '${h}', 'merchant');`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`AV seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_av_a', 'user_verify_av_b');`);

  async function loginCookie(email: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`AV setup login failed for ${email}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarA = await loginCookie(EMAIL_A);
  jarB = await loginCookie(EMAIL_B);
}, 180_000);

afterAll(async () => {
  try {
    const users = d1(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id LIKE 'user_verify_av%');DELETE FROM users WHERE id LIKE 'user_verify_av%';`);
    expect(users.ok, `user cleanup failed: ${users.error}`).toBe(true);
    assertCleanVerify("av end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 60_000);

describe("avatar upload validation", () => {
  it("rejects anonymous, missing file, non-image, and oversize uploads", async () => {
    // Anonymous: 401 before any file handling.
    const anon = await api("/auth/me/avatar", { method: "POST", body: avatarForm(tinyPng()) });
    expect(anon.status).toBe(401);

    // Missing file field.
    const empty = await api("/auth/me/avatar", { method: "POST", body: new FormData() }, jarA);
    expect(empty.status).toBe(400);

    // Non-image bytes with an image filename: magic-byte sniff rejects.
    const exe = await api(
      "/auth/me/avatar",
      { method: "POST", body: avatarForm(Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]), "evil.jpg", "image/jpeg") },
      jarA
    );
    expect(exe.status).toBe(400);

    // Oversize (> 5 MB): 413 before buffering.
    const huge = new Uint8Array(6 * 1024 * 1024);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const big = await api("/auth/me/avatar", { method: "POST", body: avatarForm(huge) }, jarA);
    expect(big.status).toBe(413);
  }, 60_000);
});

describe("avatar lifecycle", () => {
  it("uploads, serves bytes, replaces, and deletes", async () => {
    // Fresh accounts expose avatar_url null.
    const before = await api("/auth/me", {}, jarA);
    expect(((before.body as { data: { user: { avatar_url: unknown } } }).data.user.avatar_url)).toBeNull();

    const up = await api("/auth/me/avatar", { method: "POST", body: avatarForm(tinyPng()) }, jarA);
    expect(up.status).toBe(200);
    const link = ((up.body as { data: { user: { avatar_url: string } } }).data.user.avatar_url);
    expect(link).toContain("/auth/avatar/file/");
    expect(link).toContain("sig=");

    // DB holds the internal reference, never the signed link.
    const stored = String(qrows(d1(`SELECT avatar_url FROM users WHERE id = 'user_verify_av_a';`))[0]?.["avatar_url"] ?? "");
    expect(stored.startsWith("r2://avatars/user_verify_av_a/")).toBe(true);

    // The signed link serves the sanitized bytes, anonymous bearer-style.
    const served = await fetch(`${BASE}${link}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/png");
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // Tampered links 404 identically to missing ones.
    const bad = await fetch(`${BASE}${link.slice(0, -2)}xx`);
    expect(bad.status).toBe(404);

    // Replace: new link works, old object is retired (old link 404s).
    const up2 = await api("/auth/me/avatar", { method: "POST", body: avatarForm(tinyPng()) }, jarA);
    expect(up2.status).toBe(200);
    const link2 = ((up2.body as { data: { user: { avatar_url: string } } }).data.user.avatar_url);
    expect(link2).not.toBe(link);
    expect((await fetch(`${BASE}${link}`)).status).toBe(404);
    expect((await fetch(`${BASE}${link2}`)).status).toBe(200);

    // Delete: clears the reference; idempotent on repeat.
    const del = await api("/auth/me/avatar", { method: "DELETE" }, jarA);
    expect(del.status).toBe(200);
    expect(((del.body as { data: { user: { avatar_url: unknown } } }).data.user.avatar_url)).toBeNull();
    expect((await fetch(`${BASE}${link2}`)).status).toBe(404);
    const del2 = await api("/auth/me/avatar", { method: "DELETE" }, jarA);
    expect(del2.status).toBe(200);
  }, 120_000);

  it("is strictly self-scoped: no cross-account reads or writes", async () => {
    // B uploads; A's profile still shows no avatar.
    const upB = await api("/auth/me/avatar", { method: "POST", body: avatarForm(tinyPng()) }, jarB);
    expect(upB.status).toBe(200);
    const meA = await api("/auth/me", {}, jarA);
    expect(((meA.body as { data: { user: { avatar_url: unknown } } }).data.user.avatar_url)).toBeNull();

    // No target id exists on either endpoint: B's DELETE clears only B.
    const delB = await api("/auth/me/avatar", { method: "DELETE" }, jarB);
    expect(delB.status).toBe(200);
    // Anonymous delete is 401, never a silent no-op.
    expect((await api("/auth/me/avatar", { method: "DELETE" })).status).toBe(401);
  }, 60_000);
});
