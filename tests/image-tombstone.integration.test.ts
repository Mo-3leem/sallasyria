// B13-L2 retired-image hardening: retired rows vanish from list/get/update
// and file delivery, R2 bytes are tombstoned on retire, restore still
// revives metadata. Real workerd + real local D1 with an emulated R2
// bucket and the URL signing secret set. Fixtures use user_verify_b13_* /
// store_verify_b13_* (covered by scripts/clean-verify.mjs).
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18909;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const SIGNING_SECRET = "b13-tombstone-secret";
const PASS = "B13-Strong-1";
const USER_ID = "user_verify_b13_m";
const EMAIL = "b13img@example.com";
const STORE_ID = "store_verify_b13_img";
const PRODUCT_ID = "prod_verify_b13_img";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b13test-"));
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

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const headers: Record<string, string> = {
    ...(cookies ? { Cookie: cookies } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON (file bytes) */ }
  return { status: res.status, body, headers: res.headers };
}

function tinyPng(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
    0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function uploadForm(productId: string): FormData {
  const form = new FormData();
  form.append("file", new File([tinyPng().buffer as ArrayBuffer], "shot.png", { type: "image/png" }));
  form.append("product_id", productId);
  return form;
}

async function loginJar(email: string): Promise<string> {
  const res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`b13 login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `URL_SIGNING_SECRET:${SIGNING_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b13 reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('${USER_ID}', '+963900001991', '${EMAIL}', 'B13 Merchant', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products) VALUES ('plan_verify_b13', 'b13-plan', 'B13 Plan', 50000, 500000, 100);`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('${STORE_ID}', '${USER_ID}', 'b13-img', 'B13 Img');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b13', '${STORE_ID}', 'plan_verify_b13', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${PRODUCT_ID}', '${STORE_ID}', 'B13 Prod', 'b13-prod', 1000);`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`b13 seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id = '${USER_ID}';`);
}, 180_000);

afterAll(async () => {
  stopDevServer(server);
  server = null;
  assertCleanVerify("b13 cleanup");
}, 120_000);

describe("B13-L2 retired-image tombstoning", () => {
  it("retire hides the row everywhere, tombstones bytes, restore revives metadata", async () => {
    const jar = await loginJar(EMAIL);
    const A = `/stores/${STORE_ID}/product-images`;
    const up = await api(`${A}/upload`, { method: "POST", body: uploadForm(PRODUCT_ID) }, jar);
    expect(up.status).toBe(201);
    const img = (up.body as { data: { image: { id: string; url: string } } }).data.image;
    expect(img.url.startsWith("r2://")).toBe(false);

    // Control: live bytes serve.
    expect((await api(img.url, {}, jar)).status).toBe(200);
    const listed = await api(`${A}?product_id=${PRODUCT_ID}`, {}, jar);
    expect(
      ((listed.body as { data: { images: { id: string }[] } }).data.images.some((r) => r.id === img.id))
    ).toBe(true);

    const del = await api(`${A}/${img.id}`, { method: "DELETE" }, jar);
    expect(del.status).toBe(200);

    // Metadata gone from every non-restore path...
    const listedAfter = await api(`${A}?product_id=${PRODUCT_ID}`, {}, jar);
    expect(
      ((listedAfter.body as { data: { images: { id: string }[] } }).data.images.some((r) => r.id === img.id))
    ).toBe(false);
    expect((await api(`${A}/${img.id}`, {}, jar)).status).toBe(404);
    expect((await api(`${A}/${img.id}`, {
      method: "PATCH",
      body: JSON.stringify({ alt_text: "x" }),
    }, jar)).status).toBe(404);
    // ...and the tombstoned bytes no longer serve either.
    expect((await api(img.url, {}, jar)).status).toBe(404);

    // Restore revives the metadata (bytes stay tombstoned by design).
    expect((await api(`${A}/${img.id}/restore`, { method: "POST" }, jar)).status).toBe(200);
    const listedAgain = await api(`${A}?product_id=${PRODUCT_ID}`, {}, jar);
    expect(
      ((listedAgain.body as { data: { images: { id: string }[] } }).data.images.some((r) => r.id === img.id))
    ).toBe(true);
    expect((await api(`${A}/${img.id}`, {}, jar)).status).toBe(200);
  }, 180_000);

  it("external URLs retire and restore without storage side effects", async () => {
    const jar = await loginJar(EMAIL);
    const A = `/stores/${STORE_ID}/product-images`;
    const created = await api(A, {
      method: "POST",
      body: JSON.stringify({ product_id: PRODUCT_ID, url: "https://cdn.example.com/b13.jpg" }),
    }, jar);
    expect(created.status).toBe(201);
    const id = (created.body as { data: { image: { id: string } } }).data.image.id;
    expect((await api(`${A}/${id}`, { method: "DELETE" }, jar)).status).toBe(200);
    expect((await api(`${A}/${id}`, {}, jar)).status).toBe(404);
    expect((await api(`${A}/${id}/restore`, { method: "POST" }, jar)).status).toBe(200);
    expect((await api(`${A}/${id}`, {}, jar)).status).toBe(200);
  }, 120_000);
});
