// P4 integration suite: buyer accounts, server carts, buyer mail.
// Real workerd + real local D1 (same pattern as the B6 suite). Guest
// checkout stays open throughout; accounts are optional convenience.
// Fixtures use the p4- prefix family (no SQL-underscore wildcards) and are
// deleted child-before-parent at the end with zero-row proof.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 18884;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const PASS = "Buyer-Strong-1";
const MERCHANT_PHONE = "+963994400001";
const MERCHANT_EMAIL = "qa-p4-merchant@example.com";
const SLUG = "p4-shop";
const BUYER_PHONE = "+963994400002";
const BUYER_EMAIL = "qa-p4-buyer@example.com";
const GUEST_PHONE = "+963994400003";
const STRANGER_PHONE = "+963994400004";
const ADMIN_PHONE = "+963994400005";

let server: ChildProcess | null = null;
let serverOutput = "";
let storeId = "";
let productId = "";
let merchantJar = "";
let adminJar = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-p4test-"));
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
    let alive = false;
    for (let i = 0; i < 5 && !alive; i++) {
      try {
        const probe = await fetch(`${BASE}/health`);
        alive = probe.ok;
      } catch { /* still down */ }
      if (!alive) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!alive) {
      throw new Error(`dev server unreachable during ${path}: ${String(err)}\n--- server tail ---\n${serverOutput.slice(-3000)}`);
    }
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, body, headers: res.headers };
}

function cookieOf(setCookie: string | null, name: string): string {
  if (!setCookie) throw new Error(`expected Set-Cookie for ${name}`);
  return `${name}=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

const data = (r: { body: unknown }): any => (r.body as { data: unknown }).data;
const code = (r: { body: unknown }): string => (r.body as { error?: { code?: string } }).error?.code ?? "";
let keySeq = 0;
const freshKey = () => `p4-key-${Date.now()}-${keySeq++}`;

function checkoutBody(over: Record<string, unknown> = {}) {
  return {
    customer: { name: "Guest Buyer", phone: GUEST_PHONE },
    shipping: {
      recipient_name: "Guest Buyer",
      phone: GUEST_PHONE,
      governorate: "Damascus",
      address_line: "Street 1, Damascus",
    },
    payment: { method: "cod" },
    ...over,
  };
}

beforeAll(async () => {
  // Pre-clean: a previous aborted run leaves p4- rows behind that would
  // collide with fixture phones/slugs below (409 on re-register).
  expect(cleanAll().ok).toBe(true);
  server = spawn(isWindows ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    windowsHide: true,
  });
  server.stdout?.on("data", (d) => { serverOutput += String(d); });
  server.stderr?.on("data", (d) => { serverOutput += String(d); });
  await waitForHealth();

  // Merchant + store (trial grant keeps the gate green) + publish + catalog.
  const reg = await api("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: MERCHANT_EMAIL, phone: MERCHANT_PHONE, password: PASS, name: "QA P4 Merchant" }),
  });
  expect(reg.status).toBe(201);
  // Merchant login gates on verified email: flip it directly (buyers have
  // no such gate by design, so only merchant/admin fixtures need this).
  expect(d1(`UPDATE users SET email_verified = 1 WHERE phone = '${MERCHANT_PHONE}';`).ok).toBe(true);
  const login = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: MERCHANT_EMAIL, password: PASS }),
  });
  expect(login.status).toBe(200);
  merchantJar = cookieOf(login.headers.get("set-cookie"), "ss_session");

  const store = await api("/stores", {
    method: "POST",
    body: JSON.stringify({ name: "P4 Shop", slug: SLUG }),
  }, merchantJar);
  expect(store.status).toBe(201);
  storeId = (data(store).store as { id: string }).id;
  expect(d1(`UPDATE stores SET is_published = 1 WHERE id = '${storeId}';`).ok).toBe(true);

  const cat = await api(`/stores/${storeId}/categories`, {
    method: "POST",
    body: JSON.stringify({ name: "P4 Cat", slug: "p4-cat" }),
  }, merchantJar);
  expect(cat.status).toBe(201);

  const prod = await api(`/stores/${storeId}/products`, {
    method: "POST",
    body: JSON.stringify({ name: "P4 Widget", slug: "p4-widget", price: 5000, stock_quantity: 5 }),
  }, merchantJar);
  expect(prod.status).toBe(201);
  productId = (data(prod).product as { id: string }).id;

  // Checkout requires a live rate for the governorate (same as B6).
  const rate = await api(`/stores/${storeId}/shipping-rates`, {
    method: "POST",
    body: JSON.stringify({ governorate: "Damascus", shipping_method: "Standard", cost: 5000 }),
  }, merchantJar);
  expect(rate.status).toBe(201);

  // Admin for sub-lifecycle mail + plan creation.
  const areg = await api("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "qa-p4-admin@example.com", phone: ADMIN_PHONE, password: PASS, name: "QA P4 Admin" }),
  });
  expect(areg.status).toBe(201);
  expect(d1(`UPDATE users SET role = 'admin', email_verified = 1 WHERE phone = '${ADMIN_PHONE}';`).ok).toBe(true);
  const alogin = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "qa-p4-admin@example.com", password: PASS }),
  });
  expect(alogin.status).toBe(200);
  adminJar = cookieOf(alogin.headers.get("set-cookie"), "ss_session");
}, 180_000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    try {
      if (isWindows && server.pid !== undefined) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill("SIGTERM");
    } catch { /* best effort */ }
  }
  server = null;
  // Fully prefix-based (no fixture ids needed): child-before-parent, one
  // D1 round-trip for deletes, one for users, one for the zero-proof.
  const cleaned = cleanAll();
  expect(cleaned.ok, `cleanup failed: ${cleaned.error}`).toBe(true);
  const users = d1(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '+963994400%');DELETE FROM users WHERE phone LIKE '+963994400%';`);
  expect(users.ok, `user cleanup failed: ${users.error}`).toBe(true);
  const left = qrows(
    d1(`SELECT (SELECT COUNT(*) FROM stores WHERE slug LIKE 'p4-%') AS s, (SELECT COUNT(*) FROM users WHERE phone LIKE '+963994400%') AS u, (SELECT COUNT(*) FROM carts WHERE store_id IN (SELECT id FROM stores WHERE slug LIKE 'p4-%')) AS c, (SELECT COUNT(*) FROM mail_outbox WHERE recipient LIKE 'qa-p4-%') AS m, (SELECT COUNT(*) FROM customers WHERE phone LIKE '+963994400%') AS cu, (SELECT COUNT(*) FROM buyer_sessions WHERE customer_id IN (SELECT id FROM customers WHERE phone LIKE '+963994400%')) AS bs;`)
  )[0];
  expect(left).toMatchObject({ s: 0, u: 0, c: 0, m: 0, cu: 0, bs: 0 });
}, 180_000);

// Prefix-family cleanup shared by the pre-run reset and afterAll.
function cleanAll() {
  const p4stores = `SELECT id FROM stores WHERE slug LIKE 'p4-%'`;
  const p4customers = `SELECT id FROM customers WHERE store_id IN (${p4stores})`;
  const stmts = [
    `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id IN (${p4stores}));`,
    `DELETE FROM idempotency_keys WHERE store_id IN (${p4stores});`,
    `DELETE FROM orders WHERE store_id IN (${p4stores});`,
    `DELETE FROM buyer_sessions WHERE customer_id IN (${p4customers});`,
    `DELETE FROM buyer_tokens WHERE customer_id IN (${p4customers});`,
    `DELETE FROM customer_addresses WHERE customer_id IN (${p4customers});`,
    `DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE store_id IN (${p4stores}));`,
    `DELETE FROM carts WHERE store_id IN (${p4stores});`,
    `DELETE FROM subscriptions WHERE store_id IN (${p4stores});`,
    `DELETE FROM customers WHERE store_id IN (${p4stores});`,
    `DELETE FROM products WHERE store_id IN (${p4stores});`,
    `DELETE FROM categories WHERE store_id IN (${p4stores});`,
    `DELETE FROM shipping_rates WHERE store_id IN (${p4stores});`,
    `DELETE FROM themes WHERE store_id IN (${p4stores});`,
    `DELETE FROM theme_previews WHERE store_id IN (${p4stores});`,
    `DELETE FROM stores WHERE slug LIKE 'p4-%';`,
    `DELETE FROM plans WHERE code LIKE 'p4-%';`,
    `DELETE FROM mail_outbox WHERE recipient LIKE 'qa-p4-%';`,
  ];
  return d1(stmts.join(""));
}

describe("P4 guest carts", () => {
  let cartId = "";

  it("creates, adds, reads, and updates a guest cart", async () => {
    const created = await api(`/s/${SLUG}/cart`, { method: "POST", body: JSON.stringify({}) });
    expect(created.status).toBe(201);
    cartId = (data(created).cart as { id: string }).id;
    expect(cartId.length).toBeGreaterThan(10);

    const added = await api(`/s/${SLUG}/cart/${cartId}/items`, {
      method: "POST",
      body: JSON.stringify({ product_id: productId, quantity: 2 }),
    });
    expect(added.status).toBe(200);
    const items = (data(added).cart as { items: { id: string; product_id: string; product_name: string; unit_price: number; quantity: number }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ product_id: productId, product_name: "P4 Widget", unit_price: 5000, quantity: 2 });

    const read = await api(`/s/${SLUG}/cart/${cartId}`);
    expect(read.status).toBe(200);

    const itemId = items[0]!.id;
    const set = await api(`/s/${SLUG}/cart/${cartId}/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: 3 }),
    });
    expect(set.status).toBe(200);
    expect(((data(set).cart as { items: { quantity: number }[] }).items[0] as { quantity: number }).quantity).toBe(3);
  });

  it("rejects unknown products and foreign carts identically", async () => {
    const bad = await api(`/s/${SLUG}/cart/${cartId}/items`, {
      method: "POST",
      body: JSON.stringify({ product_id: "prod-nope", quantity: 1 }),
    });
    expect(bad.status).toBe(409);
    expect(code(bad)).toBe("product_unavailable");

    const forged = await api(`/s/${SLUG}/cart/00000000-0000-0000-0000-000000000000`);
    expect(forged.status).toBe(404);
    expect(code(forged)).toBe("cart_not_found");
  });
});

describe("P4 cart checkout (guest-always)", () => {
  it("checks out by cart_id, consumes the cart, and mails a receipt", async () => {
    const created = await api(`/s/${SLUG}/cart`, { method: "POST", body: JSON.stringify({}) });
    const cid = (data(created).cart as { id: string }).id;
    await api(`/s/${SLUG}/cart/${cid}/items`, {
      method: "POST",
      body: JSON.stringify({ product_id: productId, quantity: 1 }),
    });
    const co = await api(`/stores/${storeId}/checkout`, {
      method: "POST",
      body: JSON.stringify(checkoutBody({ customer: { name: "Guest Buyer", phone: GUEST_PHONE, email: "qa-p4-guest@example.com" }, cart_id: cid })),
    }, "", freshKey());
    expect(co.status).toBe(201);
    const order = (data(co).order as { id: string; order_number: number });
    // Receipt intent recorded exactly once.
    const rows = qrows(d1(`SELECT dedupe_key, recipient FROM mail_outbox WHERE dedupe_key = 'order:${order.id}:confirm';`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient: "qa-p4-guest@example.com" });
    // Cart consumed: reuse is 404, not a replay.
    const reuse = await api(`/stores/${storeId}/checkout`, {
      method: "POST",
      body: JSON.stringify(checkoutBody({ cart_id: cid })),
    }, "", freshKey());
    expect(reuse.status).toBe(404);
  });

  it("requires exactly one of items / cart_id", async () => {
    const created = await api(`/s/${SLUG}/cart`, { method: "POST", body: JSON.stringify({}) });
    const cid = (data(created).cart as { id: string }).id;
    const both = await api(`/stores/${storeId}/checkout`, {
      method: "POST",
      body: JSON.stringify(checkoutBody({ items: [{ product_id: productId, quantity: 1 }], cart_id: cid })),
    }, "", freshKey());
    expect(both.status).toBe(422);
    expect(code(both)).toBe("cart_or_items");
    const neither = await api(`/stores/${storeId}/checkout`, {
      method: "POST",
      body: JSON.stringify(checkoutBody()),
    }, "", freshKey());
    expect(neither.status).toBe(422);
  });

  it("legacy items checkout still works (guest, no account)", async () => {
    const co = await api(`/stores/${storeId}/checkout`, {
      method: "POST",
      body: JSON.stringify(checkoutBody({ items: [{ product_id: productId, quantity: 1 }] })),
    }, "", freshKey());
    expect(co.status).toBe(201);
  });
});

describe("P4 buyer accounts", () => {
  let buyerJar = "";
  let buyerId = "";

  it("registers, logs in, and reads me", async () => {
    const reg = await api(`/s/${SLUG}/account/register`, {
      method: "POST",
      body: JSON.stringify({ name: "P4 Buyer", phone: BUYER_PHONE, email: BUYER_EMAIL, password: PASS }),
    });
    expect(reg.status).toBe(201);
    expect((data(reg) as { converted: boolean }).converted).toBe(false);
    buyerId = ((data(reg) as { buyer: { id: string } }).buyer).id;
    buyerJar = cookieOf(reg.headers.get("set-cookie"), "ss_buyer");

    const me = await api(`/s/${SLUG}/account/me`, {}, buyerJar);
    expect(me.status).toBe(200);
    expect((data(me) as { buyer: { email_verified: boolean } }).buyer.email_verified).toBe(false);

    const login = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: BUYER_EMAIL, password: PASS }),
    });
    expect(login.status).toBe(200);
    expect(((data(login) as { buyer: { id: string } }).buyer).id).toBe(buyerId);
  });

  it("answers unknown identity, wrong password, and guest rows with identical 404s", async () => {
    const unknown = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: "+963990000099", password: PASS }),
    });
    const wrong = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: BUYER_PHONE, password: "Wrong-Pass-1!" }),
    });
    const guest = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: GUEST_PHONE, password: PASS }),
    });
    for (const r of [unknown, wrong, guest]) {
      expect(r.status).toBe(404);
      expect(code(r)).toBe("user_not_found");
    }
  });

  it("converts a guest row by same phone and keeps its history", async () => {
    const reg = await api(`/s/${SLUG}/account/register`, {
      method: "POST",
      body: JSON.stringify({ name: "Claimed Guest", phone: GUEST_PHONE, password: PASS }),
    });
    expect(reg.status).toBe(201);
    expect((data(reg) as { converted: boolean }).converted).toBe(true);
    const guestJar = cookieOf(reg.headers.get("set-cookie"), "ss_buyer");
    const history = await api(`/s/${SLUG}/account/orders`, {}, guestJar);
    expect(history.status).toBe(200);
    // Two guest orders above (cart checkout + legacy items checkout).
    expect(((data(history) as { orders: unknown[] }).orders).length).toBeGreaterThanOrEqual(2);
  });

  it("rejects taken phones and emails with 409", async () => {
    const phone = await api(`/s/${SLUG}/account/register`, {
      method: "POST",
      body: JSON.stringify({ name: "Dup", phone: BUYER_PHONE, password: PASS }),
    });
    expect(phone.status).toBe(409);
    const email = await api(`/s/${SLUG}/account/register`, {
      method: "POST",
      body: JSON.stringify({ name: "Dup", phone: "+963994400006", email: BUYER_EMAIL, password: PASS }),
    });
    expect(email.status).toBe(409);
  });

  it("scopes sessions to their store and logs out", async () => {
    // Second store: same cookie must 401 there.
    const store2 = await api("/stores", {
      method: "POST",
      body: JSON.stringify({ name: "P4 Other", slug: "p4-other" }),
    }, merchantJar);
    expect(store2.status).toBe(201);
    const otherId = (data(store2).store as { id: string }).id;
    expect(d1(`UPDATE stores SET is_published = 1 WHERE id = '${otherId}';`).ok).toBe(true);
    const cross = await api(`/s/p4-other/account/me`, {}, buyerJar);
    expect(cross.status).toBe(401);

    const out = await api(`/s/${SLUG}/account/logout`, { method: "POST", body: JSON.stringify({}) }, buyerJar);
    expect(out.status).toBe(200);
    const dead = await api(`/s/${SLUG}/account/me`, {}, buyerJar);
    expect(dead.status).toBe(401);

    // Relogin for the remaining tests.
    const login = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: BUYER_PHONE, password: PASS }),
    });
    buyerJar = cookieOf(login.headers.get("set-cookie"), "ss_buyer");

    // Cleanup the second store (no orders/customers involved).
    expect(d1(`DELETE FROM subscriptions WHERE store_id = '${otherId}';DELETE FROM stores WHERE id = '${otherId}';`).ok).toBe(true);
  });

  it("changes password with current password and keeps the session", async () => {
    const NEW_PASS = "Buyer-New-9x";
    const path = `/s/${SLUG}/account/change-password`;
    const body = (c: string, n: string) => ({ method: "POST", body: JSON.stringify({ current_password: c, new_password: n }) });

    // Unauthenticated → 401.
    expect((await api(path, body(PASS, NEW_PASS))).status).toBe(401);
    // Too-short new password → 400.
    const short = await api(path, body(PASS, "short"), buyerJar);
    expect(short.status).toBe(400);
    // Wrong current password → 401 invalid_credentials; stored hash untouched.
    const wrong = await api(path, body("Wrong-Pass-9x", NEW_PASS), buyerJar);
    expect(wrong.status).toBe(401);
    expect(code(wrong)).toBe("invalid_credentials");
    const stillOld = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: BUYER_PHONE, password: PASS }),
    });
    expect(stillOld.status).toBe(200);

    // Correct rotation → 200; the same session survives (no re-login needed).
    const changed = await api(path, body(PASS, NEW_PASS), buyerJar);
    expect(changed.status).toBe(200);
    expect((await api(`/s/${SLUG}/account/me`, {}, buyerJar)).status).toBe(200);

    // Old password dead (404, same as login), new password works.
    const deadOld = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: BUYER_PHONE, password: PASS }),
    });
    expect(deadOld.status).toBe(404);
    const fresh = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: BUYER_PHONE, password: NEW_PASS }),
    });
    expect(fresh.status).toBe(200);
    const freshJar = cookieOf(fresh.headers.get("set-cookie"), "ss_buyer");

    // Restore the original password so later tests keep working.
    const back = await api(path, body(NEW_PASS, PASS), freshJar);
    expect(back.status).toBe(200);
  });

  it("merges a guest cart on login and checks out linked to the account", async () => {
    const guest = await api(`/s/${SLUG}/cart`, { method: "POST", body: JSON.stringify({}) });
    const gid = (data(guest).cart as { id: string }).id;
    await api(`/s/${SLUG}/cart/${gid}/items`, {
      method: "POST",
      body: JSON.stringify({ product_id: productId, quantity: 1 }),
    });
    const merged = await api(`/s/${SLUG}/account/cart/merge`, {
      method: "POST",
      body: JSON.stringify({ cart_id: gid }),
    }, buyerJar);
    expect(merged.status).toBe(200);
    expect(((data(merged).cart as { items: unknown[] }).items).length).toBeGreaterThanOrEqual(1);
    // Guest cart gone after merge.
    expect((await api(`/s/${SLUG}/cart/${gid}`, {}, "")).status).toBe(404);

    const my = await api(`/s/${SLUG}/account/cart`, {}, buyerJar);
    expect(my.status).toBe(200);
    const myId = (data(my).cart as { id: string }).id;
    const co = await api(`/stores/${storeId}/checkout`, {
      method: "POST",
      // Placeholder customer block: the session fills the real identity.
      body: JSON.stringify(checkoutBody({ customer: { name: "X", phone: "+963990000000" }, cart_id: myId })),
    }, buyerJar, freshKey());
    expect(co.status).toBe(201);
    expect(((data(co).order as { customer_phone: string }).customer_phone)).toBe(BUYER_PHONE);
  });
});

describe("P4 buyer address book", () => {
  let buyerJar = "";
  let strangerJar = "";

  beforeAll(async () => {
    const login = await api(`/s/${SLUG}/account/login`, {
      method: "POST",
      body: JSON.stringify({ identity: BUYER_PHONE, password: PASS }),
    });
    buyerJar = cookieOf(login.headers.get("set-cookie"), "ss_buyer");
    const sreg = await api(`/s/${SLUG}/account/register`, {
      method: "POST",
      body: JSON.stringify({ name: "Stranger", phone: STRANGER_PHONE, password: PASS }),
    });
    strangerJar = cookieOf(sreg.headers.get("set-cookie"), "ss_buyer");
  });

  it("CRUDs owned addresses and hides foreign ones", async () => {
    const created = await api(`/s/${SLUG}/account/addresses`, {
      method: "POST",
      body: JSON.stringify({
        recipient_name: "P4 Buyer",
        phone: BUYER_PHONE,
        governorate: "Damascus",
        address_line: "Street 2, Damascus",
      }),
    }, buyerJar);
    expect(created.status).toBe(201);
    const addrId = ((data(created) as { address: { id: string } }).address).id;

    // Stranger cannot see, touch, or steal it: identical 404s.
    expect((await api(`/s/${SLUG}/account/addresses`, {}, strangerJar)).status).toBe(200);
    const strangerList = ((data(await api(`/s/${SLUG}/account/addresses`, {}, strangerJar)) as { addresses: unknown[] }).addresses);
    expect(strangerList).toHaveLength(0);
    expect((await api(`/s/${SLUG}/account/addresses/${addrId}`, { method: "PATCH", body: JSON.stringify({ city: "X" }) }, strangerJar)).status).toBe(404);
    expect((await api(`/s/${SLUG}/account/addresses/${addrId}`, { method: "DELETE" }, strangerJar)).status).toBe(404);
    expect((await api(`/s/${SLUG}/account/addresses/${addrId}/make-default`, { method: "POST", body: JSON.stringify({}) }, strangerJar)).status).toBe(404);

    // Owner updates + makes default + deletes.
    const patched = await api(`/s/${SLUG}/account/addresses/${addrId}`, {
      method: "PATCH",
      body: JSON.stringify({ city: "Damascus City" }),
    }, buyerJar);
    expect(patched.status).toBe(200);
    const def = await api(`/s/${SLUG}/account/addresses/${addrId}/make-default`, {
      method: "POST",
      body: JSON.stringify({}),
    }, buyerJar);
    expect(def.status).toBe(200);
    expect(((data(def) as { address: { is_default: number } }).address).is_default).toBe(1);
    const del = await api(`/s/${SLUG}/account/addresses/${addrId}`, { method: "DELETE" }, buyerJar);
    expect(del.status).toBe(200);
  });
});

describe("P4 buyer mail", () => {
  it("notifies every CAS-applied transition exactly once", async () => {
    // The account order (not the guest-claimed one: conversion without an
    // email nulls the customer email, and mail correctly skips null).
    const rows = qrows(d1(`SELECT id, order_number FROM orders WHERE store_id = '${storeId}' AND customer_phone = '${BUYER_PHONE}' ORDER BY order_number ASC LIMIT 1;`));
    expect(rows.length).toBeGreaterThan(0);
    const orderId = String(rows[0]!.id);
    const st = await api(`/stores/${storeId}/orders/${orderId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "confirmed" }),
    }, merchantJar);
    expect(st.status).toBe(200);
    const confirmRows = qrows(d1(`SELECT recipient FROM mail_outbox WHERE dedupe_key = 'order:${orderId}:status:confirmed';`));
    expect(confirmRows.length).toBe(1);

    const pay = await api(`/stores/${storeId}/orders/${orderId}/payment`, {
      method: "PATCH",
      body: JSON.stringify({ payment_status: "paid" }),
    }, merchantJar);
    expect(pay.status).toBe(200);
    const payRows = qrows(d1(`SELECT recipient FROM mail_outbox WHERE dedupe_key = 'order:${orderId}:payment:paid';`));
    expect(payRows.length).toBe(1);

    // Illegal repeat: 409, no new mail.
    const before = qrows(d1(`SELECT COUNT(*) AS n FROM mail_outbox;`))[0]!["n"];
    const dup = await api(`/stores/${storeId}/orders/${orderId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "confirmed" }),
    }, merchantJar);
    expect(dup.status).toBe(409);
    const after = qrows(d1(`SELECT COUNT(*) AS n FROM mail_outbox;`))[0]!["n"];
    expect(after).toBe(before);
  }, 60_000);

  it("notifies sub activate/cancel to the store owner", async () => {
    const plan = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: "p4-plan", name: "P4 Plan", price_monthly: 1000 }),
    }, adminJar);
    expect(plan.status).toBe(201);
    const planId = ((data(plan) as { plan: { id: string } }).plan).id;

    // The store-creation trial still covers the store: expire it so the
    // manual activate passes the single-active-period guard.
    expect(d1(`UPDATE subscriptions SET status = 'expired' WHERE store_id = '${storeId}';`).ok).toBe(true);
    const act = await api("/admin/subscriptions", {
      method: "POST",
      body: JSON.stringify({ store_id: storeId, plan_id: planId, billing_period: "monthly", starts_at: "2026-09-23T12:00:00Z" }),
    }, adminJar);
    expect(act.status).toBe(201);
    const subId = ((data(act) as { subscription: { id: string } }).subscription).id;
    const actRows = qrows(d1(`SELECT recipient FROM mail_outbox WHERE dedupe_key = 'sub:${subId}:activated';`));
    expect(actRows).toHaveLength(1);
    expect(actRows[0]).toMatchObject({ recipient: MERCHANT_EMAIL });

    const cancel = await api(`/admin/subscriptions/${subId}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    }, adminJar);
    expect(cancel.status).toBe(200);
    const cancelRows = qrows(d1(`SELECT recipient FROM mail_outbox WHERE dedupe_key = 'sub:${subId}:cancelled';`));
    expect(cancelRows).toHaveLength(1);
  }, 60_000);

  it("sends the trial T-7d notice via the scheduled trigger", async () => {
    const plan = await api("/admin/plans", {
      method: "POST",
      body: JSON.stringify({ code: "p4-trial-plan", name: "P4 Trial", price_monthly: 1000 }),
    }, adminJar);
    const planId = ((data(plan) as { plan: { id: string } }).plan).id;
    const trialId = "sub_p4_trial_1";
    expect(
      d1(
        `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at, ends_at) VALUES ('${trialId}', '${storeId}', '${planId}', 'trialing', 'monthly', 0, '2026-09-23T12:00:00Z', '2026-09-26T12:00:00Z');`
      ).ok
    ).toBe(true);
    const trig = await fetch(`${BASE}/cdn-cgi/local/scheduled`);
    expect(trig.ok).toBe(true);
    // Cron runs detached: poll for the outbox row.
    let found: Record<string, unknown>[] = [];
    for (let i = 0; i < 20 && found.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      found = qrows(d1(`SELECT recipient FROM mail_outbox WHERE dedupe_key = 'trial-7d:${trialId}';`));
    }
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ recipient: MERCHANT_EMAIL });
    // Second trigger: no duplicate (CAS dedupe).
    await fetch(`${BASE}/cdn-cgi/local/scheduled`);
    await new Promise((r) => setTimeout(r, 3000));
    expect(qrows(d1(`SELECT COUNT(*) AS n FROM mail_outbox WHERE dedupe_key = 'trial-7d:${trialId}';`))[0]!["n"]).toBe(1);
  }, 60_000);
});
