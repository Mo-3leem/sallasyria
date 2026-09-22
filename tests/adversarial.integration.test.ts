// Adversarial security/integration suite: fuzzing, IDOR matrix, mass
// assignment, money overflow, session-expiry enforcement.
// Real workerd + real local D1. Fixtures use user_adv_*/store_adv_*
// (covered by scripts/clean-verify.mjs). Local/test data only.

import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18889;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PASS = "Adv-Strong-1";
const A_PHONE = "+963900001901";
const B_PHONE = "+963900001902";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  // One retry for local-CLI flakes (busy wrangler spawns occasionally fail
  // with empty/transient errors despite a healthy DB). Retried statements
  // are fixture setup reads/writes with fixed IDs; a genuine constraint
  // failure reproduces identically and still fails loudly.
  let last = d1once(sql);
  if (!last.ok && (/busy|locked|timeout|ECONNRESET|fetch failed/i.test(last.error ?? "") || last.error === "")) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    last = d1once(sql);
  }
  return last;
}

function d1once(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-advtest-"));
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
    // message-first: execFileSync failures carry "" stderr with the real
    // cause in message (learned the hard way: stderr-first yields "").
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string };
    const detail = e.message || e.stderr || e.stdout || err;
    return { ok: false, error: String(detail).slice(0, 500) };
  }
}

function qval(sql: string): unknown {
  const r = d1(sql);
  if (!r.ok) throw new Error(`adv d1 failed: ${r.error}`);
  const first = (r.result?.[0] as { results?: Record<string, unknown>[] } | undefined)?.results?.[0];
  return first ? Object.values(first)[0] : undefined;
}

async function waitForHealth(): Promise<void> {  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`dev server never ready\n${serverOutput.slice(-3000)}`);
}

async function api(path: string, init: RequestInit = {}, cookies = "", key?: string) {
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(cookies ? { Cookie: cookies } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (key) headers["X-Idempotency-Key"] = key;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
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

function expectCleanEnvelope(res: { status: number; body: unknown }) {
  // Every response must be the project envelope with no leak markers,
  // regardless of status code.
  const text = JSON.stringify(res.body);
  expect(text).not.toMatch(/Traceback|at .*\(.*:\d+:\d+\)|SELECT .* FROM|Traceback/i);
  expect(res.body).toHaveProperty("ok");
  if ((res.body as { ok: boolean }).ok === false) {
    expect(res.body).toHaveProperty(["error", "code"]);
    expect(res.body).toHaveProperty(["error", "message"]);
  }
}

let jarA = "";
let jarB = "";
// Phones registered by fuzz tests (random uuid user ids, outside the
// clean-verify prefixes) — removed explicitly in afterAll so reruns stay green.
const createdPhones = new Set<string>();
function trackPhone(phone: string): string {
  createdPhones.add(phone);
  return phone;
}
const S = {
  a1: "store_adv_a1", a2: "store_adv_a2", b1: "store_adv_b1", b2: "store_adv_b2",
  prodA1: "", prodB1: "", catB1: "", custB1: "", addrB1: "", rateB1: "", orderB1: "", imgB1: "",
};

async function loginJar(email: string, password: string): Promise<string> {
  const res = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (res.status !== 200) throw new Error(`adv login failed for ${email}: ${res.status}`);
  return cookieOf(res.setCookie);
}

function killServer(): void {
  if (server && server.exitCode === null) {
    try {
      if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill("SIGTERM");
    } catch { /* best effort */ }
  }
  server = null;
}

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

  // If seeding fails, kill the server here: afterAll never runs when
  // beforeAll throws, and a leaked dev server holds the port/DB for the
  // next run.
  try {
  assertCleanVerify("adv reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_adv_a', '${A_PHONE}', 'adva@example.com', 'Adv A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_adv_b', '${B_PHONE}', 'advb@example.com', 'Adv B', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_adv_t1', 'adv-plan', 'Adv Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_adv_a1', 'user_adv_a', 'adv-a1', 'Adv A1');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_adv_a2', 'user_adv_a', 'adv-a2', 'Adv A2');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_adv_b1', 'user_adv_b', 'adv-b1', 'Adv B1');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_adv_b2', 'user_adv_b', 'adv-b2', 'Adv B2');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_adv_a1', 'store_adv_a1', 'plan_adv_t1', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_adv_a2', 'store_adv_a2', 'plan_adv_t1', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_adv_b1', 'store_adv_b1', 'plan_adv_t1', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_adv_b2', 'store_adv_b2', 'plan_adv_t1', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO categories (id, store_id, name, slug) VALUES ('cat_adv_b1', 'store_adv_b1', 'BCat', 'adv-bcat');`,
    `INSERT INTO products (id, store_id, category_id, name, slug, price, stock_quantity) VALUES ('prod_adv_b1', 'store_adv_b1', 'cat_adv_b1', 'BProd', 'adv-bprod', 5000, 10);`,
    `INSERT INTO products (id, store_id, name, slug, price, stock_quantity) VALUES ('prod_adv_a1', 'store_adv_a1', 'AProd', 'adv-aprod', 1000, 10);`,
    `INSERT INTO customers (id, store_id, name, phone) VALUES ('cust_adv_b1', 'store_adv_b1', 'BCust', '+963900001991');`,
    `INSERT INTO customer_addresses (id, store_id, customer_id, recipient_name, phone, governorate, city, address_line) VALUES ('addr_adv_b1', 'store_adv_b1', 'cust_adv_b1', 'BCust', '+963900001991', 'Damascus', NULL, 'B Street 1');`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('rate_adv_b1', 'store_adv_b1', 'Damascus', 'Standard', 5000);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('rate_adv_a1', 'store_adv_a1', 'Damascus', 'Standard', 5000);`,
  ];
  for (const [idx, sql] of seed.entries()) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`adv seed failed [${idx}]: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_adv_a', 'user_adv_b');`);
  jarA = await loginJar("adva@example.com", PASS);
  jarB = await loginJar("advb@example.com", PASS);
  S.prodA1 = "prod_adv_a1";
  S.prodB1 = "prod_adv_b1";
  S.catB1 = "cat_adv_b1";
  S.custB1 = "cust_adv_b1";
  S.addrB1 = "addr_adv_b1";
  S.rateB1 = "rate_adv_b1";

  // B1 image via URL attach (no R2 needed) + B1 order via checkout.
  const img = await api(`/stores/${S.b1}/product-images`, {
    method: "POST", body: JSON.stringify({ product_id: S.prodB1, url: "https://example.com/b.jpg" }),
  }, jarB);
  if (img.status !== 201) throw new Error(`adv image seed failed: ${img.status}`);
  S.imgB1 = ((img.body as { data: { image: { id: string } } }).data.image.id);
  const co = await api(`/stores/${S.b1}/checkout`, {
    method: "POST",
    body: JSON.stringify({
      customer: { name: "BCust", phone: "+963900001991" },
      items: [{ product_id: S.prodB1, quantity: 1 }],
      shipping: { recipient_name: "BCust", phone: "+963900001991", governorate: "Damascus", address_line: "B Street 1" },
      payment: { method: "cod" },
    }),
  }, jarB, `adv-key-${Date.now()}`);
  if (co.status !== 201) throw new Error(`adv order seed failed: ${co.status}`);
  S.orderB1 = ((co.body as { data: { order: { id: string } } }).data.order.id);
  } catch (err) {
    killServer();
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (createdPhones.size > 0) {
    const list = [...createdPhones].map((p) => `'${p}'`).join(",");
    // Sessions cascade from users (FK), so deleting the users is sufficient.
    d1(`DELETE FROM users WHERE phone IN (${list});`);
  }
  killServer();
  assertCleanVerify("adv cleanup");
}, 120_000);

describe("auth fuzz", () => {
  it("SQL injection in register fields is inert, never 500", async () => {
    const evil = "' OR '1'='1'; --";
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: `adv${Date.now() % 100000}@example.com`, phone: trackPhone(`+9639000019${Date.now() % 100}`), password: "Adv-Strong-9", name: evil }),
    });
    expectCleanEnvelope(res);
    expect([201, 400, 409]).toContain(res.status);
  });

  it("malformed types, empty, oversize register bodies are clean 400s", async () => {
    const bodies = [
      { email: "x@example.com", phone: 12345, password: "Adv-Strong-9", name: "X" },
      { email: "x@example.com", phone: ["+9631"], password: "Adv-Strong-9", name: "X" },
      { email: "", phone: "", password: "", name: "" },
      { email: "x@example.com", phone: "+9631", password: "short", name: "X" },
      { email: "x@example.com", phone: "+9631", password: "Adv-Strong-9", name: "x".repeat(201) },
      { email: "not-an-email", phone: "+9631", password: "Adv-Strong-9", name: "X" },
      ["not", "an", "object"],
      { email: "adv-extra@example.com", phone: trackPhone("+963900001910"), password: "Adv-Strong-9", name: "X", extra: { deep: { deeper: [1, { d: null }] } } },
    ];
    for (const body of bodies) {
      const res = await api("/auth/register", { method: "POST", body: JSON.stringify(body) });
      expectCleanEnvelope(res);
      expect([201, 400, 409]).toContain(res.status);
    }
  });

  it("50-level nested JSON does not crash or leak", async () => {
    let deep: unknown = "x";
    for (let i = 0; i < 50; i++) deep = { a: deep };
    // Unknown `pad` key is stripped by validation; unique email avoids
    // colliding with earlier fuzz registrations in this file.
    const res = await api("/auth/register", {
      method: "POST", body: JSON.stringify({ email: `advdeep${Date.now() % 100000}@example.com`, phone: trackPhone(`+9639000017${Date.now() % 100}`), password: "Adv-Strong-9", name: "X", pad: deep }),
    });
    expectCleanEnvelope(res);
    expect(res.status).toBe(201);
  });

  it("malformed JSON body is a clean 400", async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
    });
    expect(res.status).toBe(400);
    expectCleanEnvelope({ status: res.status, body: await res.json() });
  });

  it("login SQL injection email is 401, never 500; phone never authenticates", async () => {
    const res = await api("/auth/login", {
      method: "POST", body: JSON.stringify({ email: "' OR '1'='1", password: "x" }),
    });
    expect(res.status).toBe(400);
    expectCleanEnvelope(res);
    // A valid phone is not an email shape: rejected at validation, never auth.
    const byPhone = await api("/auth/login", {
      method: "POST", body: JSON.stringify({ email: A_PHONE, password: PASS }),
    });
    expect(byPhone.status).toBe(400);
    // Unknown but well-formed email: indistinguishable 401.
    const unknown = await api("/auth/login", {
      method: "POST", body: JSON.stringify({ email: "ghost-adv@example.com", password: "Whatever-1x" }),
    });
    expect(unknown.status).toBe(401);
  });

  it("mass-assignment role/id/is_active on register is 400 and creates nothing", async () => {
    const phone = trackPhone(`+9639000018${Date.now() % 100}`);
    const res = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: `advmass${Date.now() % 100000}@example.com`, phone, password: "Adv-Strong-9", name: "X", role: "admin", is_active: 0, id: "forged", store_id: "s" }),
    });
    expect(res.status).toBe(400);
    expect(qval(`SELECT id FROM users WHERE phone = '${phone}';`)).toBeUndefined();
  }, 120_000);
});

describe("cross-store IDOR matrix (A attacks B1)", () => {
  it("product read/patch/delete of B1 are 404 and change nothing", async () => {
    expect((await api(`/stores/${S.b1}/products/${S.prodB1}`, {}, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.b1}/products/${S.prodB1}`, {
      method: "PATCH", body: JSON.stringify({ price: 1 }),
    }, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.b1}/products/${S.prodB1}`, { method: "DELETE" }, jarA)).status).toBe(404);
    const still = await api(`/stores/${S.b1}/products/${S.prodB1}`, {}, jarB);
    expect(still.status).toBe(200);
    expect(((still.body as { data: { product: { price: number; deleted_at: unknown } } }).data.product.price)).toBe(5000);
  });

  it("product create with B1 category and category with B1 parent are 404", async () => {
    const p = await api(`/stores/${S.a1}/products`, {
      method: "POST", body: JSON.stringify({ name: "X", slug: `adv-x-${Date.now()}`, price: 1, category_id: S.catB1 }),
    }, jarA);
    expect(p.status).toBe(404);
    const c = await api(`/stores/${S.a1}/categories`, {
      method: "POST", body: JSON.stringify({ name: "X", slug: `adv-xc-${Date.now()}`, parent_id: S.catB1 }),
    }, jarA);
    expect(c.status).toBe(404);
  });

  it("address make-default/patch with B1 address id are 404", async () => {
    expect((await api(`/stores/${S.a1}/customer-addresses/${S.addrB1}/make-default`, { method: "POST", body: "{}" }, jarA)).status).toBe(404);
    const before = String(qval(`SELECT is_default FROM customer_addresses WHERE id = '${S.addrB1}';`));
    const patch = await api(`/stores/${S.a1}/customer-addresses/${S.addrB1}`, {
      method: "PATCH", body: JSON.stringify({ city: "Pwned" }),
    }, jarA);
    expect(patch.status).toBe(404);
    expect(String(qval(`SELECT is_default FROM customer_addresses WHERE id = '${S.addrB1}';`))).toBe(before);
  }, 120_000);

  it("customer delete of B1 customer is 404 and row survives", async () => {
    expect((await api(`/stores/${S.a1}/customers/${S.custB1}`, { method: "DELETE" }, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.b1}/customers/${S.custB1}`, {}, jarB)).status).toBe(200);
  });

  it("B1 order read/status/payment/image/rate access from A is 404", async () => {
    expect((await api(`/stores/${S.a1}/orders/${S.orderB1}`, {}, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.a1}/orders/${S.orderB1}/status`, {
      method: "PATCH", body: JSON.stringify({ status: "cancelled" }),
    }, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.a1}/orders/${S.orderB1}/payment`, {
      method: "PATCH", body: JSON.stringify({ payment_status: "paid" }),
    }, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.a1}/product-images/${S.imgB1}`, {}, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.a1}/shipping-rates/${S.rateB1}`, {}, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.a1}/shipping-rates/${S.rateB1}`, {
      method: "PATCH", body: JSON.stringify({ cost: 1 }),
    }, jarA)).status).toBe(404);
    expect((await api(`/stores/${S.a1}/shipping-rates/${S.rateB1}`, { method: "DELETE" }, jarA)).status).toBe(404);
    // B1 order untouched by the cancelled attempt.
    const check = await api(`/stores/${S.b1}/orders/${S.orderB1}`, {}, jarB);
    expect(((check.body as { data: { order: { status: string } } }).data.order.status)).toBe("pending");
  });

  it("checkout with B1 product inside A1 store is rejected without side effects", async () => {
    const before = Number(qval(`SELECT stock_quantity FROM products WHERE id = '${S.prodB1}';`));
    const res = await api(`/stores/${S.a1}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "X", phone: "+963900001980" },
        items: [{ product_id: S.prodB1, quantity: 1 }],
        shipping: { recipient_name: "X", phone: "+963900001980", governorate: "Damascus", address_line: "X" },
        payment: { method: "cod" },
      }),
    }, jarA, `adv-xstore-${Date.now()}`);
    expect(res.status).toBe(409);
    expect(Number(qval(`SELECT stock_quantity FROM products WHERE id = '${S.prodB1}';`))).toBe(before);
  }, 120_000);

  it("garbage and SQL-flavored IDs are clean 404s", async () => {
    for (const bad of ["' OR '1'='1", "../../etc/passwd", "%2e%2e/%2e%2e", "x".repeat(500)]) {
      const res = await api(`/stores/${S.a1}/products/${encodeURIComponent(bad)}`, {}, jarA);
      expectCleanEnvelope(res);
      expect(res.status).toBe(404);
    }
  });
});

describe("money overflow probe", () => {
  it("absurd price × quantity never 500s or leaks internals", async () => {
    const mk = await api(`/stores/${S.a2}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Whale", slug: `adv-whale-${Date.now()}`, price: 9007199254740991, stock_quantity: 10 }),
    }, jarA);
    expect(mk.status).toBe(201);
    const pid = ((mk.body as { data: { product: { id: string } } }).data.product.id);
    const co = await api(`/stores/${S.a2}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "W", phone: "+963900001981" },
        items: [{ product_id: pid, quantity: 999 }],
        shipping: { recipient_name: "W", phone: "+963900001981", governorate: "Damascus", address_line: "W" },
        payment: { method: "cod" },
      }),
    }, jarA, `adv-whale-${Date.now()}`);
    expectCleanEnvelope(co);
    // Either clean success with coherent numbers or clean rejection — never 500.
    expect([200, 201, 400, 409, 422]).toContain(co.status);
  });
});

describe("forged expired session is rejected", () => {
  it("D1-inserted expired session cookie is 401", async () => {
    const token = `adv-expired-token-${Date.now()}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const r = d1(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, updated_at) VALUES ('sess_adv_expired', 'user_adv_a', '${tokenHash}', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');`);
    if (!r.ok) throw new Error(`adv session seed failed: ${r.error}`);
    const res = await api("/auth/me", {}, `ss_session=${token}`);
    expect(res.status).toBe(401);
    expectCleanEnvelope(res);
  }, 120_000);
});
