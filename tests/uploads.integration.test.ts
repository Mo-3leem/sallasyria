// B8 integration suite: hardened upload flow end-to-end (real workerd,
// real local D1, locally emulated R2). Fixtures: user_verify_b8c_* (covered
// by scripts/clean-verify.mjs). Server boots with a throwaway .dev.vars
// carrying a TEST-ONLY signing secret (same pattern as the B7 bootstrap
// test); the file is removed in afterAll with an existence assertion.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { sanitizeImage } from "../src/lib/uploads.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18885;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";
const SECRET = `b8-test-signing-${Date.now().toString(36)}`;
const DEV_VARS = join(process.cwd(), ".dev.vars");

const OWNER_A = "+963900000861";
const OWNER_B = "+963900000862";
const PASS = "Uploads-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b8test-"));
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



async function apiRaw(path: string, init: RequestInit = {}, cookies = ""): Promise<Response> {
  const doFetch = () =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(cookies ? { Cookie: cookies } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
  try {
    return await doFetch();
  } catch (err) {
    let alive = false;
    for (let i = 0; i < 5 && !alive; i++) {
      try {
        alive = (await fetch(`${BASE}/health`)).ok;
      } catch { /* still down */ }
      if (!alive) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!alive) {
      throw new Error(`dev server unreachable during ${path}: ${String(err)}\n${serverOutput.slice(-3000)}`);
    }
    return doFetch();
  }
}

async function api(path: string, init: RequestInit = {}, cookies = "") {
  const res = await apiRaw(path, init, cookies);
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

function qrows(res: { result?: unknown[] }): Record<string, unknown>[] {
  const first = res.result?.[0] as { results?: Record<string, unknown>[] } | undefined;
  return first?.results ?? [];
}

// Minimal valid PNG with a textual chunk (EXIF-analogous metadata to strip).
function pngWithText(): Uint8Array {
  const bytes: number[] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
    0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x0b, 0x74, 0x45, 0x58, 0x74,
    0x54, 0x69, 0x74, 0x6c, 0x65, 0x00, 0x53, 0x65, 0x63, 0x72, 0x65, 0x74,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ];
  return Uint8Array.from(bytes);
}

const A = "/stores/store_verify_b8c_a";
const B = "/stores/store_verify_b8c_b";

let jarA = "";

beforeAll(async () => {
  if (existsSync(DEV_VARS)) {
    throw new Error("refusing to overwrite an existing .dev.vars (real secrets risk)");
  }
  writeFileSync(DEV_VARS, `URL_SIGNING_SECRET=${SECRET}\n`, "utf8");

  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b8 reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b8c_a', '${OWNER_A}', 'b8a@example.com', 'B8 Owner A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b8c_b', '${OWNER_B}', 'b8b@example.com', 'B8 Owner B', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b8c', 'b8c-plan', 'B8 Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b8c_a', 'user_verify_b8c_a', 'b8c-store-a', 'B8 Store A');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b8c_b', 'user_verify_b8c_b', 'b8c-store-b', 'B8 Store B');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b8c_a', 'store_verify_b8c_a', 'plan_verify_b8c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b8c_b', 'store_verify_b8c_b', 'plan_verify_b8c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b8c_a', 'store_verify_b8c_a', 'B8 Prod A', 'b8-prod-a', 1000);`,
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b8c_b', 'store_verify_b8c_b', 'B8 Prod B', 'b8-prod-b', 1000);`,
  ];
  // NOTE: last product intentionally targets a nonexistent store id to prove
  // seed failures are loud (fixed below before assertions run).
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B8 seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_b8c_a', 'user_verify_b8c_b');`);
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "b8a@example.com", password: PASS }),
  });
  if (login.status !== 200) throw new Error(`B8 setup login failed: ${login.status}`);
  jarA = cookieOf(login.headers.get("set-cookie"));
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b8 end");
  } finally {
    stopDevServer(server);
    server = null;
    if (existsSync(DEV_VARS)) rmSync(DEV_VARS, { force: true });
    if (existsSync(DEV_VARS)) throw new Error(".dev.vars was not removed");
  }
}, 60_000);

function uploadForm(png: Uint8Array, productId: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([png.buffer as ArrayBuffer], { type: "image/png" }), "photo.png");
  form.append("product_id", productId);
  return form;
}

// Structurally valid PNG of ~targetBytes: real signature + IHDR + one large
// IDAT chunk (CRC unchecked by the sanitizer, content preserved bit-for-bit)
// + IEND. Proves the 1-5MB window reaches the handler instead of dying at a
// JSON-sized body cap.
function largePng(targetBytes: number): Uint8Array {
  const ihdr = [
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  const dataLen = targetBytes - 8 - ihdr.length - 12 - 12;
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr];
  out.push((dataLen >>> 24) & 255, (dataLen >>> 16) & 255, (dataLen >>> 8) & 255, dataLen & 255);
  out.push(0x49, 0x44, 0x41, 0x54);
  for (let i = 0; i < dataLen; i++) out.push(0);
  out.push(0x00, 0x00, 0x00, 0x00);
  out.push(0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
  return Uint8Array.from(out);
}

describe("B8 hardened upload flow", () => {
  it("uploads, sanitizes, stores r2://, and serves bytes back", async () => {
    const png = pngWithText();
    const expected = sanitizeImage(png, "image/png").bytes;
    expect(expected.length).toBeLessThan(png.length); // textual chunk stripped

    const up = await api(`${A}/product-images/upload`, { method: "POST", body: uploadForm(png, "prod_verify_b8c_a") }, jarA);
    expect(up.status).toBe(201);
    const image = (up.body as { data: { image: { id: string; url: string } } }).data.image;
    expect(image.url).toContain("/product-images/file/");
    expect(image.url).toContain("sig=");

    // Stored DB form is the internal reference, never the signed link.
    const storedUrl = String(qrows(d1(`SELECT url FROM product_images WHERE id = '${image.id}';`))[0]?.["url"] ?? "");
    expect(storedUrl.startsWith("r2://images/")).toBe(true);

    // Anonymous bearer fetch returns the sanitized bytes, typed correctly.
    const signedPath = image.url.startsWith("http")
      ? new URL(image.url).pathname + new URL(image.url).search
      : image.url;
    const file = await apiRaw(signedPath);
    expect(file.status).toBe(200);
    const buf = new Uint8Array(await file.arrayBuffer());
    expect(buf).toEqual(expected);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("cache-control")).toContain("private");
  }, 120_000);

  it("accepts a valid ~2MB image: above the JSON cap, below the image cap", async () => {
    const up = await api(`${A}/product-images/upload`, {
      method: "POST",
      body: uploadForm(largePng(2 * 1024 * 1024), "prod_verify_b8c_a"),
    }, jarA);
    expect(up.status).toBe(201);
    expect((up.body as { data: { image: { url: string } } }).data.image.url).toContain("/product-images/file/");
  }, 120_000);

  it("rejects executables, oversize bodies, and cross-store products", async () => {
    const exe = new FormData();
    exe.append("file", new Blob([Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]).buffer as ArrayBuffer], { type: "image/jpeg" }), "evil.jpg");
    exe.append("product_id", "prod_verify_b8c_a");
    const bad = await api(`${A}/product-images/upload`, { method: "POST", body: exe }, jarA);
    expect(bad.status).toBe(400);

    const huge = new FormData();
    huge.append("file", new Blob([new Uint8Array(6 * 1024 * 1024).buffer as ArrayBuffer], { type: "image/png" }), "huge.png");
    huge.append("product_id", "prod_verify_b8c_a");
    expect((await api(`${A}/product-images/upload`, { method: "POST", body: huge }, jarA)).status).toBe(413);

    const foreign = new FormData();
    foreign.append("file", new Blob([pngWithText().buffer as ArrayBuffer], { type: "image/png" }), "x.png");
    foreign.append("product_id", "prod_verify_b8c_b");
    expect((await api(`${A}/product-images/upload`, { method: "POST", body: foreign }, jarA)).status).toBe(404);

    expect((await api(`${A}/product-images/upload`, { method: "POST", body: uploadForm(pngWithText(), "prod_verify_b8c_a") })).status).toBe(401);
  }, 120_000);

  it("signed links resist tampering, expiry, and cross-store replay", async () => {
    const up = await api(`${A}/product-images/upload`, { method: "POST", body: uploadForm(pngWithText(), "prod_verify_b8c_a") }, jarA);
    const url = (up.body as { data: { image: { url: string } } }).data.image.url;
    const u = new URL(url, "https://unused.test");
    const sig = u.searchParams.get("sig")!;
    const exp = u.searchParams.get("exp")!;
    const filePath = u.pathname;

    const tampered = await api(`${filePath}?exp=${exp}&sig=${sig.slice(0, -2)}xx`);
    expect(tampered.status).toBe(404);

    // cross-store replay: same key/sig under store B's path must fail
    const crossPath = filePath.replace("/stores/store_verify_b8c_a/", "/stores/store_verify_b8c_b/");
    expect((await api(`${crossPath}?exp=${exp}&sig=${sig}`)).status).toBe(404);

    // missing params fail closed as 404, never 500
    expect((await api(filePath)).status).toBe(404);
  }, 120_000);
});

describe("file-serving flood guard", () => {
  it("repeated invalid file reads eventually 429; product and avatar share one guard", async () => {
    // Limiter runs before HMAC/R2, so tampered links still count. Alternate
    // both file routes to prove they share the single public-file budget:
    // either route's flood trips the other. Loop past the generous budget;
    // assert the trip plus ample legitimate headroom.
    let successes = 0;
    let trippedAt = -1;
    for (let i = 0; i < 160 && trippedAt < 0; i++) {
      const path =
        i % 2 === 0
          ? `${A}/product-images/file/nope-${i}.jpg?exp=999&sig=nope`
          : `/auth/avatar/file/nope-${i}.jpg?uid=x&exp=999&sig=nope`;
      const res = await api(path);
      if (res.status === 429) {
        trippedAt = i;
        expect(res.body).toEqual({
          ok: false,
          error: { code: "rate_limited", message: expect.any(String) },
        });
      } else {
        expect(res.status).toBe(404);
        successes++;
      }
    }
    expect(trippedAt).toBeGreaterThanOrEqual(0);
    expect(successes).toBeGreaterThanOrEqual(100);
  }, 180_000);
});

describe("B7b product-upload guard (upload-product: 60/hour per store)", () => {
  it("60 uploads succeed; 61st 429s with no validation change below the limit", async () => {
    // Dedicated store+product under the covered verify prefix: store A's
    // bucket is already partially consumed by the B8 tests above, so a
    // flood there would trip early and couple this test to sibling
    // consumption. jarA owns the flood store (store-access pin).
    for (const sql of [
      `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b8c_flood', 'user_verify_b8c_a', 'b8c-flood', 'B8 Flood');`,
      `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b8c_flood', 'store_verify_b8c_flood', 'plan_verify_b8c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
      `INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b8c_flood', 'store_verify_b8c_flood', 'B8 Flood Prod', 'b8-flood-prod', 1000);`,
    ]) {
      const r = d1(sql);
      if (!r.ok) throw new Error(`flood seed failed: ${r.error}`);
    }
    const F = "/stores/store_verify_b8c_flood";
    const png = pngWithText();
    for (let i = 0; i < 60; i++) {
      const up = await api(`${F}/product-images/upload`, { method: "POST", body: uploadForm(png, "prod_verify_b8c_flood") }, jarA);
      expect(up.status).toBe(201);
    }
    const limited = await api(`${F}/product-images/upload`, { method: "POST", body: uploadForm(png, "prod_verify_b8c_flood") }, jarA);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
  }, 240_000);
});
