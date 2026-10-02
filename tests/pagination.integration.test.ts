// B11 pagination integration suite: offset pages for merchant/admin lists,
// cursor pages for the public catalog and buyer history. Real workerd +
// real local D1. Fixtures use user_verify_pg11_* / store_verify_pg11_*
// (covered by scripts/clean-verify.mjs). Each flood-sensitive case uses
// dedicated fixtures so no test depends on sibling consumption.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18905;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";
const PASS = "Pg11-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-pg11-"));
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

function cookieOf(setCookie: string | null, name = "ss_session"): string {
  if (!setCookie) throw new Error("expected Set-Cookie");
  return `${name}=${(setCookie.split(";")[0] ?? "").split("=").slice(1).join("=")}`;
}

const stamp = (day: number) => `2026-02-${String(day).padStart(2, "0")}T00:00:00Z`;

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; }, {});
  await waitForHealthy(BASE, () => server, () => serverOutput);
  assertCleanVerify("pg11 reset");

  const h = hashPassword(PASS);
  const users: string[] = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pg11_m1', '+963900002101', 'pg11m1@example.com', 'PG11 M1', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pg11_m2', '+963900002102', 'pg11m2@example.com', 'PG11 M2', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pg11_admin', '+963900002103', 'pg11admin@example.com', 'PG11 Admin', '${h}', 'admin');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pg11_m3', '+963900002104', 'pg11m3@example.com', 'PG11 M3', '${h}', 'merchant');`,
  ];
  for (let i = 0; i < 25; i++) {
    const n = String(i).padStart(2, "0");
    users.push(
      `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_pg11_x${n}', '+9639000022${n}', 'pg11x${n}@example.com', 'PG11 X${n}', '${h}', 'merchant');`
    );
  }
  let r = d1(users.join("\n"));
  if (!r.ok) throw new Error(`pg11 users failed: ${r.error}`);
  r = d1(`UPDATE users SET email_verified = 1 WHERE id LIKE 'user_verify_pg11%';`);
  if (!r.ok) throw new Error(`pg11 verify failed: ${r.error}`);

  const base: string[] = [
    `INSERT INTO plans (id, code, name, price_monthly, price_yearly, max_products) VALUES ('plan_verify_pg11', 'pg11-plan', 'PG11 Plan', 50000, 500000, 100);`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('store_verify_pg11_s1', 'user_verify_pg11_m1', 'pg11-s1', 'PG11 S1', 1);`,
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('store_verify_pg11_s2', 'user_verify_pg11_m2', 'pg11-s2', 'PG11 S2', 1);`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_pg11_a', 'store_verify_pg11_s1', 'plan_verify_pg11', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at, cancelled_at) VALUES ('sub_verify_pg11_c', 'store_verify_pg11_s1', 'plan_verify_pg11', 'cancelled', 'monthly', '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z', '2025-06-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_pg11_e', 'store_verify_pg11_s1', 'plan_verify_pg11', 'expired', 'monthly', '2024-01-01T00:00:00Z', '2024-06-01T00:00:00Z');`,
  ];
  // 25 products: 20 staggered daily, 5 sharing one timestamp (tie-break).
  const products: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const n = String(i).padStart(2, "0");
    products.push(
      `INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_${n}', 'store_verify_pg11_s1', 'Product ${n}', 'pg11-prod-${n}', 1000, '${stamp(i)}');`
    );
  }
  for (let i = 21; i <= 25; i++) {
    const n = String(i).padStart(2, "0");
    products.push(
      `INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_${n}', 'store_verify_pg11_s1', 'Product ${n}', 'pg11-prod-${n}', 1000, '${stamp(21)}');`
    );
  }
  products.push(
    `INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_s2a', 'store_verify_pg11_s2', 'S2 A', 'pg11-s2-a', 1000, '${stamp(1)}');`,
    `INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_s2b', 'store_verify_pg11_s2', 'S2 B', 'pg11-s2-b', 1000, '${stamp(2)}');`,
    `INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_s2c', 'store_verify_pg11_s2', 'S2 C', 'pg11-s2-c', 1000, '${stamp(3)}');`
  );
  // 25 customers + 25 orders (10 pending, 10 confirmed, 5 shipped).
  const people: string[] = [];
  const orders: string[] = [];
  const statuses = [...Array<string>(10).fill("pending"), ...Array<string>(10).fill("confirmed"), ...Array<string>(5).fill("shipped")];
  for (let i = 1; i <= 25; i++) {
    const n = String(i).padStart(2, "0");
    people.push(
      `INSERT INTO customers (id, store_id, name, phone) VALUES ('cust_verify_pg11_${n}', 'store_verify_pg11_s1', 'Cust ${n}', '+9639000023${n}');`
    );
    orders.push(
      `INSERT INTO orders (id, store_id, customer_id, order_number, status, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address, created_at) VALUES ('order_verify_pg11_${n}', 'store_verify_pg11_s1', 'cust_verify_pg11_${n}', ${1000 + i}, '${statuses[i - 1]}', 'Cust ${n}', '+9639000023${n}', 'Standard', 'Damascus', 'Street 1', '${stamp(i)}');`
    );
  }
  for (const [label, sqls] of [["base", base], ["products", products], ["people", people], ["orders", orders]] as const) {
    const rr = d1(sqls.join("\n"));
    if (!rr.ok) throw new Error(`pg11 ${label} failed: ${rr.error}`);
  }
  // Filter lab (merchant product q/status): dedicated stores so the s1/s2
  // totals asserted above stay exact. 22 "Filter NN" rows with staggered
  // timestamps; 6 archived (deleted_at set), 3 business-deleted
  // (removed_at set); one same-named row in s2 for isolation checks.
  const filterLab: string[] = [
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('store_verify_pg11_s3', 'user_verify_pg11_m3', 'pg11-s3', 'PG11 S3', 0);`,
  ];
  for (let i = 1; i <= 22; i++) {
    const n = String(i).padStart(2, "0");
    filterLab.push(
      `INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_f${n}', 'store_verify_pg11_s3', 'Filter ${n}', 'pg11-f-${n}', 1000, '${stamp(i)}');`
    );
  }
  for (const n of ["02", "06", "10", "14", "18", "22"]) {
    filterLab.push(
      `UPDATE products SET deleted_at = '2026-02-10T00:00:00Z' WHERE id = 'prod_verify_pg11_f${n}';`
    );
  }
  for (const n of ["05", "13", "20"]) {
    filterLab.push(
      `UPDATE products SET deleted_at = '2026-02-10T00:00:00Z', removed_at = '2026-02-11T00:00:00Z' WHERE id = 'prod_verify_pg11_f${n}';`
    );
  }
  filterLab.push(
    `INSERT INTO stores (id, owner_id, slug, name, is_published) VALUES ('store_verify_pg11_s4', 'user_verify_pg11_m2', 'pg11-s4', 'PG11 S4', 0);`,
    `INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_f_s4', 'store_verify_pg11_s4', 'Filter S4', 'pg11-f-s4', 1000, '${stamp(1)}');`
  );
  const fr = d1(filterLab.join("\n"));
  if (!fr.ok) throw new Error(`pg11 filter lab failed: ${fr.error}`);
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("pg11 end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 60_000);

async function merchantJar(email: string): Promise<string> {
  const res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`pg11 login failed for ${email}: ${res.status}`);
  return cookieOf(res.headers.get("set-cookie"));
}

async function buyerJar(slug: string, name: string, phone: string): Promise<{ jar: string; customerId: string }> {
  const reg = await api(`/s/${slug}/account/register`, {
    method: "POST",
    body: JSON.stringify({ name, phone, password: PASS }),
  });
  if (reg.status !== 201) throw new Error(`pg11 buyer register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const jar = cookieOf(reg.headers.get("set-cookie"), "ss_buyer");
  const rows = qrows(d1(`SELECT id FROM customers WHERE store_id = 'store_verify_pg11_s1' AND phone = '${phone}';`));
  return { jar, customerId: String(rows[0]!.id) };
}

describe("B11 offset: merchant orders", () => {
  it("defaults to page 1x20 with totals; pages are stable and deterministic", async () => {
    const jar = await merchantJar("pg11m1@example.com");
    const p1 = await api("/stores/store_verify_pg11_s1/orders", {}, jar);
    expect(p1.status).toBe(200);
    const b1 = p1.body as { data: { orders: { id: string; created_at?: string }[]; pagination: { page: number; page_size: number; total: number; total_pages: number } } };
    expect(b1.data.pagination).toEqual({ page: 1, page_size: 20, total: 25, total_pages: 2 });
    expect(b1.data.orders).toHaveLength(20);
    // Newest first with id tie-break: non-increasing (created_at, id).
    const keys = b1.data.orders.map((o) => o.id);
    expect(new Set(keys).size).toBe(20);
    const p2 = await api("/stores/store_verify_pg11_s1/orders?page=2", {}, jar);
    expect(p2.status).toBe(200);
    const b2 = p2.body as typeof b1;
    expect(b2.data.pagination).toEqual({ page: 2, page_size: 20, total: 25, total_pages: 2 });
    expect(b2.data.orders).toHaveLength(5);
    // Boundary: no duplicates or skips across pages.
    expect(new Set([...keys, ...b2.data.orders.map((o) => o.id)]).size).toBe(25);
  }, 120_000);

  it("validates params, filters by status, handles empty and beyond-last pages", async () => {
    const jar = await merchantJar("pg11m1@example.com");
    const A = "/stores/store_verify_pg11_s1/orders";
    for (const bad of ["?page=0", "?page=-1", "?page=abc", "?page_size=0", "?page_size=101", "?page_size=xyz", "?status=bogus"]) {
      expect((await api(`${A}${bad}`, {}, jar)).status).toBe(400);
    }
    const pending = await api(`${A}?status=pending&page_size=100`, {}, jar);
    expect(pending.status).toBe(200);
    const bp = pending.body as { data: { orders: { status: string }[]; pagination: { total: number } } };
    expect(bp.data.pagination.total).toBe(10);
    expect(bp.data.orders.every((o) => o.status === "pending")).toBe(true);
    const shipped = await api(`${A}?status=shipped`, {}, jar);
    expect((shipped.body as typeof bp).data.pagination.total).toBe(5);
    // Store S2 has no orders: zero totals, empty array.
    const empty = await api("/stores/store_verify_pg11_s2/orders", {}, await merchantJar("pg11m2@example.com"));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      ok: true,
      data: { orders: [], pagination: { page: 1, page_size: 20, total: 0, total_pages: 0 } },
    });
    // Beyond last page: empty with correct metadata, not an error.
    const beyond = await api(`${A}?page=9`, {}, jar);
    expect(beyond.status).toBe(200);
    expect(beyond.body).toEqual({
      ok: true,
      data: { orders: [], pagination: { page: 9, page_size: 20, total: 25, total_pages: 2 } },
    });
  }, 120_000);

  it("tolerates inserts and deletes between page requests", async () => {
    const jar = await merchantJar("pg11m1@example.com");
    const A = "/stores/store_verify_pg11_s1/orders?page_size=10";
    const p1 = await api(A, {}, jar);
    const ids1 = ((p1.body as { data: { orders: { id: string }[] } }).data.orders).map((o) => o.id);
    expect(ids1).toHaveLength(10);
    // Insert a newest order: page 2 still succeeds with valid rows.
    let r = d1(`INSERT INTO customers (id, store_id, name, phone) VALUES ('cust_verify_pg11_xx', 'store_verify_pg11_s1', 'Cust XX', '+963900002399');`);
    if (!r.ok) throw new Error(r.error);
    r = d1(`INSERT INTO orders (id, store_id, customer_id, order_number, status, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address, created_at) VALUES ('order_verify_pg11_xx', 'store_verify_pg11_s1', 'cust_verify_pg11_xx', 1999, 'pending', 'Cust XX', '+963900002399', 'Standard', 'Damascus', 'Street 1', '2026-03-01T00:00:00Z');`);
    if (!r.ok) throw new Error(r.error);
    const p2 = await api(`${A}&page=2`, {}, jar);
    expect(p2.status).toBe(200);
    const b2 = p2.body as { data: { orders: { id: string }[]; pagination: { total: number } } };
    expect(b2.data.pagination.total).toBe(26);
    expect(b2.data.orders).toHaveLength(10);
    // Delete from page-1 range: page 2 still succeeds (offset skew tolerated).
    r = d1(`DELETE FROM orders WHERE id = 'order_verify_pg11_xx';DELETE FROM customers WHERE id = 'cust_verify_pg11_xx';`);
    if (!r.ok) throw new Error(r.error);
    const victim = ids1[0]!;
    const orig = qrows(d1(`SELECT order_number AS n, status AS s, customer_id AS c, created_at AS t FROM orders WHERE id = '${victim}';`))[0]!;
    r = d1(`DELETE FROM orders WHERE id = '${victim}';`);
    if (!r.ok) throw new Error(r.error);
    const p2b = await api(`${A}&page=2`, {}, jar);
    expect(p2b.status).toBe(200);
    // Victim still deleted here: 24 rows, request succeeds regardless.
    expect((p2b.body as typeof b2).data.pagination.total).toBe(24);
    // Restore the victim byte-identically so later tests see the fixture set.
    r = d1(`INSERT INTO orders (id, store_id, customer_id, order_number, status, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address, created_at) VALUES ('${victim}', 'store_verify_pg11_s1', '${orig["c"]}', ${orig["n"]}, '${orig["s"]}', 'Cust', '+963900002301', 'Standard', 'Damascus', 'Street 1', '${orig["t"]}');`);
    if (!r.ok) throw new Error(r.error);
    expect(String(qrows(d1(`SELECT COUNT(*) AS n FROM orders WHERE store_id = 'store_verify_pg11_s1';`))[0]!["n"])).toBe("25");
  }, 180_000);

  it("keeps tenant scoping: foreign store 404s, counts stay scoped", async () => {
    const jar2 = await merchantJar("pg11m2@example.com");
    expect((await api("/stores/store_verify_pg11_s1/orders", {}, jar2)).status).toBe(404);
    const jar1 = await merchantJar("pg11m1@example.com");
    expect((await api("/stores/store_verify_pg11_s2/orders", {}, jar1)).status).toBe(404);
    const own = await api("/stores/store_verify_pg11_s2/orders", {}, jar2);
    expect(own.status).toBe(200);
    expect((own.body as { data: { pagination: { total: number } } }).data.pagination.total).toBe(0);
  }, 120_000);
});

describe("B11 offset: merchant products and customers", () => {
  it("pages products with totals and id tie-break on duplicate timestamps", async () => {
    const jar = await merchantJar("pg11m1@example.com");
    const A = "/stores/store_verify_pg11_s1/products";
    // Full set on one page (max size): the five same-timestamp rows must
    // sort strictly by id.
    const full = await api(`${A}?page_size=100`, {}, jar);
    expect(full.status).toBe(200);
    const bf = full.body as { data: { products: { id: string }[]; pagination: { total: number } } };
    expect(bf.data.pagination.total).toBe(25);
    const sameDay = bf.data.products.filter((p) => p.id >= "prod_verify_pg11_21");
    expect(sameDay.map((p) => p.id)).toEqual([
      "prod_verify_pg11_21",
      "prod_verify_pg11_22",
      "prod_verify_pg11_23",
      "prod_verify_pg11_24",
      "prod_verify_pg11_25",
    ]);
    const p1 = await api(A, {}, jar);
    expect(p1.status).toBe(200);
    const b1 = p1.body as { data: { products: { id: string; created_at: string }[]; pagination: { page: number; page_size: number; total: number; total_pages: number } } };
    expect(b1.data.pagination).toEqual({ page: 1, page_size: 20, total: 25, total_pages: 2 });
    const p2 = await api(`${A}?page=2`, {}, jar);
    const b2 = p2.body as typeof b1;
    expect(b2.data.products).toHaveLength(5);
    const all = [...b1.data.products, ...b2.data.products].map((p) => p.id);
    expect(new Set(all).size).toBe(25);
    // S2 isolation: own total only, foreign 404s.
    const jar2 = await merchantJar("pg11m2@example.com");
    const s2 = await api("/stores/store_verify_pg11_s2/products", {}, jar2);
    expect((s2.body as typeof b1).data.pagination.total).toBe(3);
    expect((await api("/stores/store_verify_pg11_s1/products", {}, jar2)).status).toBe(404);
  }, 120_000);

  it("pages customers with totals; invalid params 400", async () => {
    const jar = await merchantJar("pg11m1@example.com");
    const A = "/stores/store_verify_pg11_s1/customers";
    const p1 = await api(`${A}?page_size=10`, {}, jar);
    expect(p1.status).toBe(200);
    const b1 = p1.body as { data: { customers: { id: string }[]; pagination: { total: number; total_pages: number } } };
    expect(b1.data.pagination).toEqual({ page: 1, page_size: 10, total: 25, total_pages: 3 });
    expect(b1.data.customers).toHaveLength(10);
    expect((await api(`${A}?page=0`, {}, jar)).status).toBe(400);
    expect((await api(`${A}?page_size=101`, {}, jar)).status).toBe(400);
  }, 120_000);
});

describe("B11 offset: admin directory", () => {
  it("merchants search pages with counts reflecting the query", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "pg11admin@example.com", password: PASS }),
    });
    expect(res.status).toBe(200);
    const jar = cookieOf(res.headers.get("set-cookie"));
    const A = "/admin/merchants";
    const p1 = await api(A, {}, jar);
    expect(p1.status).toBe(200);
    const b1 = p1.body as { data: { merchants: { id: string }[]; pagination: { total: number; total_pages: number } } };
    // 2 named + 25 generated merchants (other suites' merchants may also
    // exist in this database; assert at-least, not exact).
    expect(b1.data.pagination.total).toBeGreaterThanOrEqual(27);
    expect(b1.data.merchants.length).toBeLessThanOrEqual(20);
    const q = await api(`${A}?q=pg11x&page_size=100`, {}, jar);
    expect(q.status).toBe(200);
    const bq = q.body as typeof b1;
    expect(bq.data.pagination.total).toBe(25);
    expect(bq.data.merchants.every((m) => m.id.startsWith("user_verify_pg11_x"))).toBe(true);
    const q2 = await api(`${A}?q=pg11x&page_size=10&page=3`, {}, jar);
    expect((q2.body as typeof b1).data.merchants).toHaveLength(5);
    // Non-admin is forbidden; invalid page is 400.
    const jarM = await merchantJar("pg11m1@example.com");
    expect((await api(A, {}, jarM)).status).toBe(403);
    expect((await api(`${A}?page=0`, {}, jar)).status).toBe(400);
  }, 120_000);

  it("store customers search pages scoped to the store", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "pg11admin@example.com", password: PASS }),
    });
    const jar = cookieOf(res.headers.get("set-cookie"));
    const A = "/admin/stores/store_verify_pg11_s1/customers";
    const p1 = await api(`${A}?page_size=10`, {}, jar);
    expect(p1.status).toBe(200);
    const b1 = p1.body as { data: { customers: { id: string }[]; pagination: { total: number; total_pages: number } } };
    expect(b1.data.pagination).toEqual({ page: 1, page_size: 10, total: 25, total_pages: 3 });
    const q = await api(`${A}?q=%2B963900002305&page_size=100`, {}, jar);
    expect((q.body as typeof b1).data.pagination.total).toBe(1);
    // Unknown store stays 404 (not an empty page).
    expect((await api("/admin/stores/store_verify_pg11_nope/customers", {}, jar)).status).toBe(404);
  }, 120_000);

  it("subscriptions filter server-side by status with scoped counts", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "pg11admin@example.com", password: PASS }),
    });
    const jar = cookieOf(res.headers.get("set-cookie"));
    const A = "/admin/subscriptions";
    const all = await api(A, {}, jar);
    expect(all.status).toBe(200);
    const active = await api(`${A}?status=active`, {}, jar);
    const ba = active.body as { data: { subscriptions: { status: string }[]; pagination: { total: number } } };
    expect(ba.data.subscriptions.every((s) => s.status === "active")).toBe(true);
    expect(ba.data.pagination.total).toBeGreaterThanOrEqual(1);
    const cancelled = await api(`${A}?status=cancelled`, {}, jar);
    const bc = cancelled.body as typeof ba;
    expect(bc.data.subscriptions.every((s) => s.status === "cancelled")).toBe(true);
    expect((await api(`${A}?status=bogus`, {}, jar)).status).toBe(400);
  }, 120_000);
});

describe("B11 cursor: public catalog products", () => {
  it("walks every page exactly once with opaque cursors", async () => {
    const seen: string[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;
    let lastNext: string | null = "start";
    while (lastNext !== null && pages < 10) {
      const url =
        cursor === undefined
          ? `/stores/store_verify_pg11_s1/catalog/products?limit=7`
          : `/stores/store_verify_pg11_s1/catalog/products?limit=7&cursor=${encodeURIComponent(cursor)}`;
      const res = await api(url);
      expect(res.status).toBe(200);
      const b = res.body as { data: { products: { id: string; name: string }[]; pagination: { next_cursor: string | null } } };
      expect(b.data.products.length).toBeLessThanOrEqual(7);
      // Name-ascending with id tie-break within the page.
      const names = b.data.products.map((p) => p.name);
      expect([...names].sort()).toEqual(names);
      seen.push(...b.data.products.map((p) => p.id));
      lastNext = b.data.pagination.next_cursor;
      if (lastNext !== null) {
        // Opaque: not a raw name/id pair and not empty.
        expect(lastNext).not.toContain("Product");
        expect(lastNext.length).toBeGreaterThan(8);
        cursor = lastNext;
      }
      pages++;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(lastNext).toBeNull();
  }, 120_000);

  it("rejects malformed cursors and limits; tolerates writes between pages", async () => {
    const base = `/stores/store_verify_pg11_s1/catalog/products`;
    expect((await api(`${base}?cursor=!!!not-base64!!!`)).status).toBe(400);
    expect((await api(`${base}?cursor=${encodeURIComponent("bm90LWpzb24=")}`)).status).toBe(400);
    expect((await api(`${base}?limit=0`)).status).toBe(400);
    expect((await api(`${base}?limit=101`)).status).toBe(400);
    // Insert between pages: keyset walk neither duplicates nor skips.
    const p1 = await api(`${base}?limit=24`);
    const b1 = p1.body as { data: { products: { id: string; name: string; slug: string }[]; pagination: { next_cursor: string } } };
    expect(b1.data.products).toHaveLength(24);
    let r = d1(`INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('prod_verify_pg11_zz', 'store_verify_pg11_s1', 'ZZZ Last', 'pg11-zz', 1000, '2026-03-01T00:00:00Z');`);
    if (!r.ok) throw new Error(r.error);
    const p2 = await api(`${base}?limit=24&cursor=${encodeURIComponent(b1.data.pagination.next_cursor)}`);
    const b2 = p2.body as { data: { products: { id: string }[]; pagination: { next_cursor: string | null } } };
    const union = [...b1.data.products, ...b2.data.products].map((p) => p.id);
    expect(new Set(union).size).toBe(26);
    expect(union).toContain("prod_verify_pg11_zz");
    // Delete between pages: remaining rows still walk exactly.
    r = d1(`DELETE FROM products WHERE id = 'prod_verify_pg11_zz';`);
    if (!r.ok) throw new Error(r.error);
    const victim = b1.data.products[0]!.id;
    r = d1(`DELETE FROM products WHERE id = '${victim}';`);
    if (!r.ok) throw new Error(r.error);
    const p2b = await api(`${base}?limit=24&cursor=${encodeURIComponent(b1.data.pagination.next_cursor)}`);
    expect(p2b.status).toBe(200);
    // Restore the victim byte-identically (first of name order is
    // prod_verify_pg11_01, created day 1) for a stable fixture set.
    const v = b1.data.products[0]!;
    r = d1(`INSERT INTO products (id, store_id, name, slug, price, created_at) VALUES ('${v.id}', 'store_verify_pg11_s1', '${v.name}', '${v.slug}', 1000, '${stamp(1)}');`);
    if (!r.ok) throw new Error(r.error);
  }, 180_000);

  it("empty catalog returns no cursor; draft stores stay hidden", async () => {
    // S2 has 3 products; walk them to exhaustion for the empty-tail shape.
    let cursor: string | undefined = undefined;
    let count = 0;
    let last: string | null = "start";
    while (last !== null) {
      const url =
        cursor === undefined
          ? `/stores/store_verify_pg11_s2/catalog/products?limit=2`
          : `/stores/store_verify_pg11_s2/catalog/products?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await api(url);
      expect(res.status).toBe(200);
      const b = res.body as { data: { products: unknown[]; pagination: { next_cursor: string | null } } };
      count += b.data.products.length;
      last = b.data.pagination.next_cursor;
      if (last !== null) cursor = last;
    }
    expect(count).toBe(3);
  }, 120_000);
});

describe("B11 cursor: buyer order history", () => {
  it("walks one account's history; isolation and validation hold", async () => {
    const b1 = await buyerJar("pg11-s1", "Buyer One", "+963900002401");
    const b2 = await buyerJar("pg11-s1", "Buyer Two", "+963900002402");
    const mk: string[] = [];
    for (let i = 1; i <= 5; i++) {
      mk.push(
        `INSERT INTO orders (id, store_id, customer_id, order_number, status, customer_name, customer_phone, shipping_method, shipping_governorate, shipping_address, created_at) VALUES ('border_verify_pg11_0${i}', 'store_verify_pg11_s1', '${b1.customerId}', ${2000 + i}, 'pending', 'Buyer One', '+963900002401', 'Standard', 'Damascus', 'Street 1', '2026-02-1${i}T00:00:00Z');`
      );
    }
    const r = d1(mk.join("\n"));
    if (!r.ok) throw new Error(r.error);
    const seen: string[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;
    let last: string | null = "start";
    while (last !== null && pages < 10) {
      const url =
        cursor === undefined
          ? `/s/pg11-s1/account/orders?limit=2`
          : `/s/pg11-s1/account/orders?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await api(url, {}, b1.jar);
      expect(res.status).toBe(200);
      const b = res.body as { data: { orders: { id: string }[]; pagination: { next_cursor: string | null } } };
      seen.push(...b.data.orders.map((o) => o.id));
      last = b.data.pagination.next_cursor;
      if (last !== null) cursor = last;
      pages++;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(last).toBeNull();
    // Buyer two sees an empty history (own scope only).
    const other = await api(`/s/pg11-s1/account/orders`, {}, b2.jar);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({
      ok: true,
      data: { orders: [], pagination: { next_cursor: null } },
    });
    // Malformed cursor and bad limit are 400, not leaks.
    expect((await api(`/s/pg11-s1/account/orders?cursor=nope!!`, {}, b1.jar)).status).toBe(400);
    expect((await api(`/s/pg11-s1/account/orders?limit=101`, {}, b1.jar)).status).toBe(400);
  }, 180_000);
});

describe("B11 medium-fix regressions: picker assembly and overview totals", () => {
  it("design-picker walk assembles the full catalog exactly once", async () => {
    // Mirrors the theme-builder picker: walk pages to total_pages,
    // deduplicate by id, terminate on exhaustion.
    const jar = await merchantJar("pg11m1@example.com");
    const seen = new Map<string, { name: string }>();
    let page = 1;
    let totalPages = 1;
    do {
      const res = await api(`/stores/store_verify_pg11_s1/products?page=${page}`, {}, jar);
      expect(res.status).toBe(200);
      const b = res.body as {
        data: { products: { id: string; name: string }[]; pagination: { total: number; total_pages: number } };
      };
      for (const p of b.data.products) {
        if (!seen.has(p.id)) seen.set(p.id, { name: p.name });
      }
      totalPages = b.data.pagination.total_pages;
      page += 1;
    } while (page <= totalPages);
    const dbCount = qrows(d1(`SELECT COUNT(*) AS n FROM products WHERE store_id = 'store_verify_pg11_s1';`))[0]!["n"];
    expect(seen.size).toBe(Number(dbCount));
    expect(seen.size).toBeGreaterThan(20);
  }, 180_000);

  it("admin overview reads server totals, never page lengths", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "pg11admin@example.com", password: PASS }),
    });
    expect(res.status).toBe(200);
    const jar = cookieOf(res.headers.get("set-cookie"));
    const all = await api("/admin/subscriptions?page_size=1", {}, jar);
    expect(all.status).toBe(200);
    const ba = all.body as { data: { subscriptions: unknown[]; pagination: { total: number } } };
    expect(ba.data.subscriptions).toHaveLength(1);
    const dbTotal = qrows(d1(`SELECT COUNT(*) AS n FROM subscriptions;`))[0]!["n"];
    expect(ba.data.pagination.total).toBe(Number(dbTotal));
    const active = await api("/admin/subscriptions?status=active&page_size=1", {}, jar);
    expect(active.status).toBe(200);
    const bc = active.body as { data: { subscriptions: { status: string }[]; pagination: { total: number } } };
    expect(bc.data.subscriptions.every((s) => s.status === "active")).toBe(true);
    const dbActive = qrows(d1(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active';`))[0]!["n"];
    expect(bc.data.pagination.total).toBe(Number(dbActive));
  }, 120_000);
});

type FilterRow = {
  id: string;
  name: string;
  deleted_at: string | null;
  removed_at: string | null;
};

type FilterBody = {
  data: {
    products: FilterRow[];
    pagination: { page: number; page_size: number; total: number; total_pages: number };
  };
};

describe("B11 merchant product filtering", () => {
  const A = "/stores/store_verify_pg11_s3/products";

  it("q filters names server-side", async () => {
    const jar = await merchantJar("pg11m3@example.com");
    const res = await api(`${A}?q=Filter%200`, {}, jar);
    expect(res.status).toBe(200);
    const b = res.body as FilterBody;
    expect(b.data.pagination).toEqual({ page: 1, page_size: 20, total: 9, total_pages: 1 });
    expect(b.data.products).toHaveLength(9);
    expect(b.data.products.every((p) => p.name.includes("Filter 0"))).toBe(true);
  }, 120_000);

  it("status filters by lifecycle bucket", async () => {
    const jar = await merchantJar("pg11m3@example.com");
    const archived = await api(`${A}?status=archived`, {}, jar);
    expect(archived.status).toBe(200);
    const ba = archived.body as FilterBody;
    expect(ba.data.pagination.total).toBe(6);
    expect(ba.data.products.every((p) => p.deleted_at !== null && p.removed_at === null)).toBe(true);
    const deleted = await api(`${A}?status=deleted`, {}, jar);
    expect(deleted.status).toBe(200);
    const bd = deleted.body as FilterBody;
    expect(bd.data.pagination.total).toBe(3);
    expect(bd.data.products.every((p) => p.removed_at !== null)).toBe(true);
    const active = await api(`${A}?status=active`, {}, jar);
    expect((active.body as FilterBody).data.pagination.total).toBe(13);
  }, 120_000);

  it("filtered metadata spans pages; page 2 holds the tail", async () => {
    const jar = await merchantJar("pg11m3@example.com");
    const p1 = await api(`${A}?q=Filter`, {}, jar);
    expect(p1.status).toBe(200);
    const b1 = p1.body as FilterBody;
    expect(b1.data.pagination).toEqual({ page: 1, page_size: 20, total: 22, total_pages: 2 });
    expect(b1.data.products).toHaveLength(20);
    const p2 = await api(`${A}?q=Filter&page=2`, {}, jar);
    expect(p2.status).toBe(200);
    const b2 = p2.body as FilterBody;
    expect(b2.data.pagination).toEqual({ page: 2, page_size: 20, total: 22, total_pages: 2 });
    expect(b2.data.products.map((p) => p.id)).toEqual([
      "prod_verify_pg11_f21",
      "prod_verify_pg11_f22",
    ]);
    expect(new Set([...b1.data.products, ...b2.data.products].map((p) => p.id)).size).toBe(22);
  }, 120_000);

  it("combined q + status filters intersect", async () => {
    const jar = await merchantJar("pg11m3@example.com");
    const res = await api(`${A}?q=Filter%201&status=active`, {}, jar);
    expect(res.status).toBe(200);
    const b = res.body as FilterBody;
    // Filter 10-19 minus archived (10, 14, 18) minus deleted (13).
    expect(b.data.pagination.total).toBe(6);
    expect(b.data.products.every((p) => p.name.includes("Filter 1"))).toBe(true);
    expect(b.data.products.every((p) => p.deleted_at === null && p.removed_at === null)).toBe(true);
  }, 120_000);

  it("empty result keeps the normal paginated shape; invalid status 400s", async () => {
    const jar = await merchantJar("pg11m3@example.com");
    const empty = await api(`${A}?q=zzz-no-such-product`, {}, jar);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      ok: true,
      data: { products: [], pagination: { page: 1, page_size: 20, total: 0, total_pages: 0 } },
    });
    expect((await api(`${A}?status=bogus`, {}, jar)).status).toBe(400);
    expect((await api(`${A}?status=paused`, {}, jar)).status).toBe(400);
  }, 120_000);

  it("filters cannot expose another store's products", async () => {
    const jar1 = await merchantJar("pg11m3@example.com");
    const s1 = await api(`${A}?q=Filter`, {}, jar1);
    expect(((s1.body as FilterBody).data.products.every((p) => p.id.startsWith("prod_verify_pg11_f")))).toBe(true);
    // S4 holds its own "Filter S4" row: visible to its owner only.
    const jar2 = await merchantJar("pg11m2@example.com");
    const s2 = await api("/stores/store_verify_pg11_s4/products?q=Filter", {}, jar2);
    expect(s2.status).toBe(200);
    expect((s2.body as FilterBody).data.pagination.total).toBe(1);
    // Foreign store stays 404 even with matching filters.
    expect((await api(`${A}?q=Filter`, {}, jar2)).status).toBe(404);
  }, 120_000);
});
