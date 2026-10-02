// B13-L4 shipping-rate visibility: public reads expose only active rates
// of published stores; merchants keep full visibility of their own stores.
// Real workerd + real local D1. Fixtures use user_verify_b13ship_* /
// store_verify_b13ship_* (covered by scripts/clean-verify.mjs).
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18910;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PASS = "B13Ship-Strong-1";
const PUB = "store_verify_b13ship_pub";
const DRAFT = "store_verify_b13ship_draft";
const M2STORE = "store_verify_b13ship_m2";
const ACTIVE_ID = "rate_verify_b13ship_active";
const INACTIVE_ID = "rate_verify_b13ship_inactive";
const DRAFT_RATE_ID = "rate_verify_b13ship_draft";
const M2_RATE_ID = "rate_verify_b13ship_m2";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b13shiptest-"));
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
  } catch { /* non-JSON */ }
  return { status: res.status, body, headers: res.headers };
}

async function loginJar(email: string): Promise<string> {
  const res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`b13ship login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  assertCleanVerify("b13ship reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b13ship_m', '+963900001981', 'b13shipm@example.com', 'B13 Ship', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b13ship_m2', '+963900001982', 'b13shipm2@example.com', 'B13 Ship2', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products) VALUES ('plan_verify_b13ship', 'b13ship-plan', 'B13 Ship Plan', 50000, 500000, 100);`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('${PUB}', 'user_verify_b13ship_m', 'b13ship-pub', 'B13 Pub', 1);`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('${DRAFT}', 'user_verify_b13ship_m', 'b13ship-draft', 'B13 Draft', 0);`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('${M2STORE}', 'user_verify_b13ship_m2', 'b13ship-m2', 'B13 M2', 1);`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b13ship', '${PUB}', 'plan_verify_b13ship', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, is_active) VALUES ('${ACTIVE_ID}', '${PUB}', 'Damascus', 'Standard', 5000, 1);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, is_active) VALUES ('${INACTIVE_ID}', '${PUB}', 'Aleppo', 'Standard', 7000, 0);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, is_active) VALUES ('${DRAFT_RATE_ID}', '${DRAFT}', 'Damascus', 'Standard', 4000, 1);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, is_active) VALUES ('${M2_RATE_ID}', '${M2STORE}', 'Damascus', 'Standard', 6000, 1);`,
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b13ship', '${PUB}', 'B13 Ship Prod', 'b13ship-prod', 1000);`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`b13ship seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id LIKE 'user_verify_b13ship%';`);
}, 180_000);

afterAll(async () => {
  try {
    d1(`DELETE FROM shipping_rates WHERE store_id LIKE 'store\\_verify\\_b13ship\\_%' ESCAPE '\\';`);
    assertCleanVerify("b13ship end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 120_000);

type RateList = { data: { rates: { id: string; is_active: number }[] } };
type RateOne = { data: { rate: { id: string; is_active: number } } };

describe("B13-L4 public shipping-rate visibility", () => {
  it("published store exposes only the active rate", async () => {
    const res = await api(`/stores/${PUB}/shipping-rates/published`);
    expect(res.status).toBe(200);
    const ids = ((res.body as RateList).data.rates.map((r) => r.id));
    expect(ids).toEqual([ACTIVE_ID]);
  });

  it("public get-one hides inactive rows identically to unknown ids", async () => {
    expect((await api(`/stores/${PUB}/shipping-rates/published/${INACTIVE_ID}`)).status).toBe(404);
    expect((await api(`/stores/${PUB}/shipping-rates/published/${ACTIVE_ID}`)).status).toBe(200);
    expect((await api(`/stores/${PUB}/shipping-rates/published/ghost-rate`)).status).toBe(404);
  });

  it("draft store resolves 404 on both public reads", async () => {
    expect((await api(`/stores/${DRAFT}/shipping-rates/published`)).status).toBe(404);
    expect((await api(`/stores/${DRAFT}/shipping-rates/published/${DRAFT_RATE_ID}`)).status).toBe(404);
    expect((await api(`/stores/store_verify_b13ship_nope/shipping-rates/published`)).status).toBe(404);
  });

  it("cross-store rate ids do not leak across paths", async () => {
    expect((await api(`/stores/${PUB}/shipping-rates/published/${M2_RATE_ID}`)).status).toBe(404);
  });
});

describe("B13-L4 merchant shipping-rate visibility", () => {
  it("owner sees active and inactive rows on merchant paths", async () => {
    const jar = await loginJar("b13shipm@example.com");
    const listed = await api(`/stores/${PUB}/shipping-rates`, {}, jar);
    expect(listed.status).toBe(200);
    expect(((listed.body as RateList).data.rates.map((r) => r.id).sort())).toEqual(
      [ACTIVE_ID, INACTIVE_ID].sort()
    );
    expect((await api(`/stores/${PUB}/shipping-rates/${INACTIVE_ID}`, {}, jar)).status).toBe(200);
  });

  it("foreign merchants and anonymous callers are rejected on merchant paths", async () => {
    const jar2 = await loginJar("b13shipm2@example.com");
    expect((await api(`/stores/${PUB}/shipping-rates`, {}, jar2)).status).toBe(404);
    expect((await api(`/stores/${PUB}/shipping-rates/${ACTIVE_ID}`, {}, jar2)).status).toBe(404);
    expect((await api(`/stores/${PUB}/shipping-rates`)).status).toBe(401);
    expect((await api(`/stores/${PUB}/shipping-rates/${ACTIVE_ID}`)).status).toBe(401);
  });
});

describe("B13-L4 checkout quoting regression", () => {
  it("checkout still quotes the active rate", async () => {
    const res = await api(`/stores/${PUB}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "Ship", phone: "+963911600099" },
        items: [{ product_id: "prod_verify_b13ship", quantity: 1 }],
        shipping: {
          recipient_name: "Ship",
          phone: "+963911600099",
          governorate: "Damascus",
          address_line: "Street 1",
        },
        payment: { method: "cod" },
      }),
    });
    expect(res.status).toBe(201);
  });
});
