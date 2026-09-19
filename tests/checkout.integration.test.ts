// B6 integration suite: atomic checkout + idempotency + stock + transitions.
// Real workerd + real local D1. Checkout is a PUBLIC buyer endpoint (no login
// exists for buyers); merchant order reads/transitions use one owner login.
// Fixtures: user_verify_b6c_* (covered by scripts/clean-verify.mjs).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18883;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const OWNER_A = "+963900000831";
const OWNER_B = "+963900000832";
const PASS = "Checkout-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";
let keySeq = 0;
const freshKey = () => `b6-key-${Date.now()}-${keySeq++}`;

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b6test-"));
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

async function api(path: string, init: RequestInit = {}, cookies = "", key: string | null = "__none__") {
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(cookies ? { Cookie: cookies } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (key !== "__none__" && key !== null) headers["X-Idempotency-Key"] = key;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch (err) {
    // Local dev-server flakiness triage (same pattern as admin suite): if the
    // connection itself failed, confirm whether the server is actually dead
    // and attach its tail. Never masks HTTP error statuses.
    let alive = false;
    for (let i = 0; i < 5 && !alive; i++) {
      try {
        const probe = await fetch(`${BASE}/health`);
        alive = probe.ok;
      } catch { /* still down */ }
      if (!alive) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!alive) {
      throw new Error(
        `dev server unreachable during ${path}: ${String(err)}\n--- server tail ---\n${serverOutput.slice(-3000)}`
      );
    }
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `ss_session=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

const A = "/stores/store_verify_b6c_a";
const B = "/stores/store_verify_b6c_b";
const EXP = "/stores/store_verify_b6c_expired";

function validBody(over: Record<string, unknown> = {}) {
  return {
    customer: { name: "Buyer", phone: "+963911600001" },
    items: [{ product_id: "prod_verify_b6c_tracked", quantity: 2 }],
    shipping: {
      recipient_name: "Buyer",
      phone: "+963911600001",
      governorate: "Damascus",
      address_line: "Street 1, Damascus",
    },
    payment: { method: "cod" },
    ...over,
  };
}

let jarA = "";

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

  assertCleanVerify("b6 reset");
  const h = hashPassword(PASS);
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b6c_a', '${OWNER_A}', 'b6ca@example.com', 'B6 Owner A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b6c_b', '${OWNER_B}', 'b6cb@example.com', 'B6 Owner B', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b6c', 'b6c-plan', 'B6 Plan');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b6c_a', 'user_verify_b6c_a', 'b6c-store-a', 'B6 Store A');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b6c_expired', 'user_verify_b6c_a', 'b6c-store-expired', 'B6 Expired');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b6c_b', 'user_verify_b6c_b', 'b6c-store-b', 'B6 Store B');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b6c_a', 'store_verify_b6c_a', 'plan_verify_b6c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b6c_e', 'store_verify_b6c_expired', 'plan_verify_b6c', 'expired', 'monthly', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b6c_b', 'store_verify_b6c_b', 'plan_verify_b6c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO products (id, store_id, name, slug, price, stock_quantity) VALUES ('prod_verify_b6c_tracked', 'store_verify_b6c_a', 'Tracked', 'b6-tracked', 100000, 100);`,
    `INSERT INTO products (id, store_id, name, slug, price, stock_quantity) VALUES ('prod_verify_b6c_untracked', 'store_verify_b6c_a', 'Untracked', 'b6-untracked', 50000, NULL);`,
    `INSERT INTO products (id, store_id, name, slug, price, deleted_at) VALUES ('prod_verify_b6c_deleted', 'store_verify_b6c_a', 'Deleted', 'b6-deleted', 1000, '2026-09-15T00:00:00Z');`,
    `INSERT INTO products (id, store_id, name, slug, price, is_active) VALUES ('prod_verify_b6c_inactive', 'store_verify_b6c_a', 'Inactive', 'b6-inactive', 1000, 0);`,
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b6c_b', 'store_verify_b6c_b', 'Prod B', 'b6-b', 777);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('rate_verify_b6c_dam', 'store_verify_b6c_a', 'Damascus', 'Standard', 5000);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, is_active) VALUES ('rate_verify_b6c_ale', 'store_verify_b6c_a', 'Aleppo', 'Standard', 7000, 0);`,
    `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost) VALUES ('rate_verify_b6c_dam_b', 'store_verify_b6c_b', 'Damascus', 'Standard', 9000);`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B6 seed failed: ${r.error}`);
  }
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: OWNER_A, password: PASS }),
  });
  if (login.status !== 200) throw new Error(`B6 setup login failed: ${login.status}`);
  jarA = cookieOf(login.headers.get("set-cookie"));
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b6 end");
  } finally {
    if (server && server.exitCode === null) {
      try {
        if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        else server.kill("SIGTERM");
      } catch { /* best effort */ }
    }
    server = null;
  }
}, 60_000);

function orderOf(res: { body: unknown }) {
  return (res.body as { data: { order: Record<string, unknown>; items: unknown[] } }).data;
}

describe("B6 happy path + snapshots + counter", () => {
  it("anonymous checkout computes totals, freezes snapshots, decrements stock", async () => {
    const stockOf = () =>
      qrows(d1(`SELECT stock_quantity FROM products WHERE id = 'prod_verify_b6c_tracked';`))[0]?.["stock_quantity"];
    const before = stockOf();
    const res = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody()),
    }, "", freshKey());
    expect(res.status).toBe(201);
    const { order, items } = orderOf(res);
    expect(order["subtotal"]).toBe(200000);
    expect(order["discount"]).toBe(0);
    expect(order["total"]).toBe(205000);
    expect(order["status"]).toBe("pending");
    expect(order["payment_status"]).toBe("pending");
    expect(order["customer_name"]).toBe("Buyer");
    expect(order["shipping_governorate"]).toBe("Damascus");
    expect(order["shipping_cost"]).toBe(5000);
    expect(items).toHaveLength(1);
    expect(order["order_number"]).toEqual(expect.any(Number));

    // Stock moved by exactly the purchased quantity (relative, not hardcoded).
    expect(stockOf()).toBe(Number(before) - 2);
  }, 60_000);

  it("second checkout gets the next sequential number", async () => {
    const r1 = await api(`${A}/checkout`, { method: "POST", body: JSON.stringify(validBody()) }, "", freshKey());
    const r2 = await api(`${A}/checkout`, { method: "POST", body: JSON.stringify(validBody()) }, "", freshKey());
    const n1 = orderOf(r1).order["order_number"] as number;
    const n2 = orderOf(r2).order["order_number"] as number;
    expect(n2).toBe(n1 + 1);
  });
});

describe("B6 idempotency: exactly-once", () => {
  it("five concurrent same-key checkouts create exactly one order", async () => {
    const key = freshKey();
    const body = JSON.stringify(validBody({ customer: { name: "Race", phone: "+963911600021" } }));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api(`${A}/checkout`, { method: "POST", body }, "", key))
    );
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    const ids = results.map((r) => orderOf(r).order["id"]);
    expect(new Set(ids).size).toBe(1);
    const created = results.filter((r) => r.status === 201);
    const replayed = results.filter((r) => r.status === 200);
    expect(created.length + replayed.length).toBe(5);
    expect(created.length).toBe(1);
  }, 120_000);

  it("same key + same body replays; same key + different body is 422", async () => {
    const key = freshKey();
    const body = JSON.stringify(validBody({ customer: { name: "Replay", phone: "+963911600031" } }));
    const first = await api(`${A}/checkout`, { method: "POST", body }, "", key);
    expect(first.status).toBe(201);
    const again = await api(`${A}/checkout`, { method: "POST", body }, "", key);
    expect(again.status).toBe(200);
    expect(orderOf(again).order["id"]).toBe(orderOf(first).order["id"]);
    expect((again.body as { data: { replayed: boolean } }).data.replayed).toBe(true);

    const conflict = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ customer: { name: "Different", phone: "+963911600032" } })),
    }, "", key);
    expect(conflict.status).toBe(422);
    expect(conflict.body).toEqual({
      ok: false,
      error: { code: "idempotency_conflict", message: expect.any(String) },
    });
  });

  it("missing key works without dedup; malformed key is 400", async () => {
    const noKey = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ customer: { name: "NoKey", phone: "+963911600041" } })),
    }, "", null);
    expect(noKey.status).toBe(201);
    const badKey = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody()),
    }, "", "bad key!!");
    expect(badKey.status).toBe(400);
  });
});

describe("B6 failure atomicity + stock", () => {
  it("unknown product fails closed with counter untouched", async () => {
    const before = qrows(d1(`SELECT order_counter FROM stores WHERE id = 'store_verify_b6c_a';`))[0]?.["order_counter"];
    const res = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ items: [{ product_id: "no-such-product", quantity: 1 }] })),
    }, "", freshKey());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "product_unavailable", message: expect.any(String) },
    });
    const after = qrows(d1(`SELECT order_counter FROM stores WHERE id = 'store_verify_b6c_a';`))[0]?.["order_counter"];
    expect(after).toBe(before);
  }, 60_000);

  it("insufficient stock is 409 with no decrement; untracked sells freely", async () => {
    // Ask for one more than currently available, whatever prior tests consumed.
    const current = Number(
      qrows(d1(`SELECT stock_quantity FROM products WHERE id = 'prod_verify_b6c_tracked';`))[0]?.["stock_quantity"]
    );
    const short = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ items: [{ product_id: "prod_verify_b6c_tracked", quantity: current + 1 }] })),
    }, "", freshKey());
    expect(short.status).toBe(409);
    expect(short.body).toEqual({
      ok: false,
      error: { code: "insufficient_stock", message: expect.any(String) },
    });
    expect(qrows(d1(`SELECT stock_quantity FROM products WHERE id = 'prod_verify_b6c_tracked';`))[0]?.["stock_quantity"]).toBe(current);

    const bulk = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ items: [{ product_id: "prod_verify_b6c_untracked", quantity: 100 }] })),
    }, "", freshKey());
    expect(bulk.status).toBe(201);
  }, 60_000);

  it("deleted, inactive, and cross-store products are all 409 product_unavailable", async () => {
    for (const product_id of ["prod_verify_b6c_deleted", "prod_verify_b6c_inactive", "prod_verify_b6c_b", "ghost-id"]) {
      const res = await api(`${A}/checkout`, {
        method: "POST",
        body: JSON.stringify(validBody({ items: [{ product_id, quantity: 1 }] })),
      }, "", freshKey());
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        ok: false,
        error: { code: "product_unavailable", message: expect.any(String) },
      });
    }
  });
});

describe("B6 last-unit race (different keys)", () => {
  it("two concurrent checkouts on stock=1 yield exactly one 201 + one 409, stock 0, no gap", async () => {
    // Dedicated fixture with stock exactly 1, untouched by every other test
    // (removed afterwards by the shared clean-verify store-prefix cleanup).
    const seedRace = d1(
      `INSERT INTO products (id, store_id, name, slug, price, stock_quantity) VALUES ('prod_verify_b6c_race', 'store_verify_b6c_a', 'Race', 'b6-race', 1000, 1);`
    );
    if (!seedRace.ok) throw new Error(`race fixture failed: ${seedRace.error}`);

    const counterBefore = Number(
      qrows(d1(`SELECT order_counter FROM stores WHERE id = 'store_verify_b6c_a';`))[0]?.["order_counter"]
    );
    // Distinct customer phones attribute the single winning order below.
    const bodyFor = (phone: string) =>
      JSON.stringify(validBody({
        customer: { name: "Racer", phone },
        items: [{ product_id: "prod_verify_b6c_race", quantity: 1 }],
      }));
    const [r1, r2] = await Promise.all([
      api(`${A}/checkout`, { method: "POST", body: bodyFor("+963911600081") }, "", freshKey()),
      api(`${A}/checkout`, { method: "POST", body: bodyFor("+963911600082") }, "", freshKey()),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body).toEqual({
      ok: false,
      error: { code: "insufficient_stock", message: expect.any(String) },
    });

    // Exactly one order exists for the two racing customers.
    const orders = qrows(d1(
      `SELECT id, order_number, customer_phone FROM orders WHERE store_id = 'store_verify_b6c_a' AND customer_phone IN ('+963911600081', '+963911600082');`
    ));
    expect(orders).toHaveLength(1);
    // No order-number gap from the rolled-back loser: the winner took the
    // very next number (its batch kept the counter bump, the loser lost its).
    expect(orders[0]?.["order_number"]).toBe(counterBefore + 1);

    // Final stock is exactly 0 — decremented once, never negative.
    const stock = qrows(d1(`SELECT stock_quantity FROM products WHERE id = 'prod_verify_b6c_race';`))[0]?.["stock_quantity"];
    expect(stock).toBe(0);
  }, 120_000);
});

describe("B6 money, shipping, payment rules", () => {
  it("client totals/discount are rejected, never trusted", async () => {
    for (const extra of [{ subtotal: 1 }, { total: 1 }, { discount: 9999 }]) {
      const res = await api(`${A}/checkout`, {
        method: "POST",
        body: JSON.stringify({ ...validBody(), ...extra }),
      }, "", freshKey());
      expect(res.status).toBe(400);
    }
    // discount column is always server-zero in MVP
    const res = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ customer: { name: "Disc", phone: "+963911600051" } })),
    }, "", freshKey());
    expect(orderOf(res).order["discount"]).toBe(0);
  });

  it("transfer without reference is 422; cod needs none", async () => {
    const missing = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ payment: { method: "bank_transfer" } })),
    }, "", freshKey());
    expect(missing.status).toBe(422);
    const withRef = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({
        customer: { name: "Transfer", phone: "+963911600052" },
        payment: { method: "bank_transfer", reference: "TRX-123" },
      })),
    }, "", freshKey());
    expect(withRef.status).toBe(201);
  });

  it("unknown or inactive governorate rate is 409", async () => {
    const unknown = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({
        shipping: {
          recipient_name: "B", phone: "+963911600053", governorate: "Homs",
          address_line: "X",
        },
      })),
    }, "", freshKey());
    expect(unknown.status).toBe(409);
    const inactive = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({
        shipping: {
          recipient_name: "B", phone: "+963911600054", governorate: "Aleppo",
          address_line: "X",
        },
      })),
    }, "", freshKey());
    expect(inactive.status).toBe(409);
  });

  it("expired store cannot sell, even anonymously", async () => {
    const res = await api(`${EXP}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody()),
    }, "", freshKey());
    expect(res.status).toBe(403);
  });
});

describe("B6 merchant order reads + transitions", () => {
  it("reads require auth, stay scoped, and never leak counter internals", async () => {
    expect((await api(`${A}/orders`)).status).toBe(401);
    const list = await api(`${A}/orders`, {}, jarA);
    expect(list.status).toBe(200);
    expect(((list.body as { data: { orders: unknown[] } }).data.orders.length)).toBeGreaterThan(0);

    const firstId = ((list.body as { data: { orders: { id: string }[] } }).data.orders[0] as { id: string }).id;
    const one = await api(`${A}/orders/${firstId}`, {}, jarA);
    expect(one.status).toBe(200);
    expect((one.body as { data: { items: unknown[] } }).data.items.length).toBeGreaterThan(0);
    expect((await api(`${A}/orders/no-such-order`, {}, jarA)).status).toBe(404);

    // order created in store B is invisible through store A's path
    const createdB = await api(`${B}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "Bee", phone: "+963911600061" },
        items: [{ product_id: "prod_verify_b6c_b", quantity: 1 }],
        shipping: { recipient_name: "Bee", phone: "+963911600061", governorate: "Damascus", address_line: "B St" },
        payment: { method: "cod" },
      }),
    }, "", freshKey());
    expect(createdB.status).toBe(201);
    const bOrderId = orderOf(createdB).order["id"] as string;
    expect((await api(`${A}/orders/${bOrderId}`, {}, jarA)).status).toBe(404);
    expect((await api(`${B}/orders/${bOrderId}`)).status).toBe(401);
  });

  it("status and payment follow the transition maps, terminal is final", async () => {
    const mk = await api(`${A}/checkout`, {
      method: "POST",
      body: JSON.stringify(validBody({ customer: { name: "Flow", phone: "+963911600071" } })),
    }, "", freshKey());
    const id = orderOf(mk).order["id"] as string;

    const skip = await api(`${A}/orders/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "shipped" }),
    }, jarA);
    expect(skip.status).toBe(409);

    for (const s of ["confirmed", "processing", "shipped", "delivered"]) {
      const r = await api(`${A}/orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: s }),
      }, jarA);
      expect(r.status).toBe(200);
    }
    const dead = await api(`${A}/orders/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    }, jarA);
    expect(dead.status).toBe(409);

    const paid = await api(`${A}/orders/${id}/payment`, {
      method: "PATCH",
      body: JSON.stringify({ payment_status: "paid" }),
    }, jarA);
    expect(paid.status).toBe(200);
    const refunded = await api(`${A}/orders/${id}/payment`, {
      method: "PATCH",
      body: JSON.stringify({ payment_status: "refunded" }),
    }, jarA);
    expect(refunded.status).toBe(200);
    const stuck = await api(`${A}/orders/${id}/payment`, {
      method: "PATCH",
      body: JSON.stringify({ payment_status: "paid" }),
    }, jarA);
    expect(stuck.status).toBe(409);

    expect((await api(`${A}/orders/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "confirmed" }),
    })).status).toBe(401);
  });
});
