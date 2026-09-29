// Guest cart Turnstile enforcement: cart create/add/setQty require a bot
// token; reads stay public. Real workerd + real local D1, booted with
// Cloudflare's PUBLIC always-BLOCKS test secret key (missing/invalid tokens
// fail deterministically; the always-passes key lives in the companion
// register file — one secret per worker). Carts are seeded directly via D1
// because creation itself is gated. Fixtures use store_verify_b9g_*
// (covered by scripts/clean-verify.mjs).
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18899;
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = "b9g-store-a";
const STORE = "store_verify_b9g_a";
const isWindows = process.platform === "win32";

// Public Cloudflare Turnstile testing pair (documented, not a secret):
// this always-BLOCKS secret rejects every token.
const TEST_TURNSTILE_SECRET = "2x0000000000000000000000000000000AA";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b9gtest-"));
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

async function api(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Turnstile-Token": token } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const post = (path: string, body: unknown, token?: string) =>
  api(path, { method: "POST", body: JSON.stringify(body) }, token);

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {
    args: ["--var", `TURNSTILE_SECRET:${TEST_TURNSTILE_SECRET}`],
  });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b9g reset");
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b9g_owner', '+963900001701', 'b9gowner@example.com', 'B9G Owner', 'x', 'merchant');`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('${STORE}', 'user_verify_b9g_owner', '${SLUG}', 'B9G Store A', 1);`,
    `INSERT INTO products (id, store_id, name, slug, price, stock_quantity) VALUES ('prod_verify_b9g_a', '${STORE}', 'B9G Prod', 'b9g-prod', 1000, 50);`,
    `INSERT INTO carts (id, store_id, customer_id, expires_at, checked_out_at) VALUES ('cart_verify_b9g_1', '${STORE}', NULL, '2099-01-01T00:00:00Z', NULL);`,
    `INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES ('line_verify_b9g_1', 'cart_verify_b9g_1', 'prod_verify_b9g_a', 2);`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B9G seed failed: ${r.error}`);
  }
}, 180_000);

afterAll(async () => {
  d1(`DELETE FROM cart_items WHERE id = 'line_verify_b9g_1';DELETE FROM carts WHERE id = 'cart_verify_b9g_1';`);
  stopDevServer(server);
  server = null;
  assertCleanVerify("b9g cleanup");
}, 120_000);

describe("guest cart bot protection", () => {
  it("create without a token is rejected, reads stay public", async () => {
    const denied = await post(`/s/${SLUG}/cart`, {});
    expect(denied.status).toBe(400);
    expect(denied.body).toEqual({
      ok: false,
      error: { code: "turnstile_required", message: expect.any(String) },
    });
    const read = await api(`/s/${SLUG}/cart/cart_verify_b9g_1`);
    expect(read.status).toBe(200);
  }, 60_000);

  it("add without a token is rejected; garbage token fails closed", async () => {
    const missing = await post(`/s/${SLUG}/cart/cart_verify_b9g_1/items`, {
      product_id: "prod_verify_b9g_a", quantity: 1,
    });
    expect(missing.status).toBe(400);
    const bad = await post(`/s/${SLUG}/cart/cart_verify_b9g_1/items`, {
      product_id: "prod_verify_b9g_a", quantity: 1,
    }, "garbage-token");
    expect(bad.status).toBe(403);
    expect(bad.body).toEqual({
      ok: false,
      error: { code: "turnstile_failed", message: expect.any(String) },
    });
  }, 60_000);

  it("set-quantity without a token is rejected", async () => {
    const res = await api(`/s/${SLUG}/cart/cart_verify_b9g_1/items/line_verify_b9g_1`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: 3 }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "turnstile_required", message: expect.any(String) },
    });
  }, 60_000);
});
