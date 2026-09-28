// B4 integration suite: catalog CRUD + tenant isolation + detach flows +
// plan limits + subscription gate. Real workerd + real local D1. Fixtures use
// user_verify_b4c_* (covered by scripts/clean-verify.mjs). Two logins total.

import { execFileSync, type ChildProcess } from "node:child_process";
import { spawnDevServer, stopDevServer, waitForHealthy } from "../scripts/dev-server.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password.js";
import { assertCleanVerify } from "../scripts/clean-verify.mjs";

const PORT = 18880;
const BASE = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

const OWNER_A = "+963900000811";
const OWNER_B = "+963900000812";
const PASS = "Catalog-Strong-1";

let server: ChildProcess | null = null;
let serverOutput = "";

function d1(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "sallasyria-b4test-"));
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
    return { ok, error: ok ? undefined : JSON.stringify(parsed) };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return { ok: false, error: String(e.stderr ?? e.message ?? err) };
  }
}



async function api(path: string, init: RequestInit = {}, cookies = "") {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
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

const A = "/stores/store_verify_b4c_a";
const B = "/stores/store_verify_b4c_b";
const EXP = "/stores/store_verify_b4c_expired";
const LIM = "/stores/store_verify_b4c_limited";

let jarA = "";
let jarB = "";

beforeAll(async () => {
  server = spawnDevServer(PORT, (d: string) => { serverOutput += d; });
  await waitForHealthy(BASE, () => server, () => serverOutput);

  const h = hashPassword(PASS);
  assertCleanVerify("b4 reset");
  const seed = [
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b4c_a', '${OWNER_A}', 'b4ca@example.com', 'B4 Owner A', '${h}', 'merchant');`,
    `INSERT INTO users (id, phone, email, name, password_hash, role) VALUES ('user_verify_b4c_b', '${OWNER_B}', 'b4cb@example.com', 'B4 Owner B', '${h}', 'merchant');`,
    `INSERT INTO plans (id, code, name) VALUES ('plan_verify_b4c', 'b4c-plan', 'B4 Plan');`,
    `INSERT INTO plans (id, code, name, max_products) VALUES ('plan_verify_b4c_limited', 'b4c-limited', 'B4 Limited', 1);`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b4c_a', 'user_verify_b4c_a', 'b4c-store-a', 'B4 Store A');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b4c_expired', 'user_verify_b4c_a', 'b4c-store-expired', 'B4 Expired');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b4c_b', 'user_verify_b4c_b', 'b4c-store-b', 'B4 Store B');`,
    `INSERT INTO stores (id, owner_id, slug, name) VALUES ('store_verify_b4c_limited', 'user_verify_b4c_a', 'b4c-store-limited', 'B4 Limited');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b4c_a', 'store_verify_b4c_a', 'plan_verify_b4c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b4c_e', 'store_verify_b4c_expired', 'plan_verify_b4c', 'expired', 'monthly', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b4c_b', 'store_verify_b4c_b', 'plan_verify_b4c', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES ('sub_verify_b4c_l', 'store_verify_b4c_limited', 'plan_verify_b4c_limited', 'active', 'monthly', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');`,
    `INSERT INTO categories (id, store_id, name, slug) VALUES ('cat_verify_b4c_a', 'store_verify_b4c_a', 'Cat A', 'cat-a');`,
    `INSERT INTO categories (id, store_id, name, slug) VALUES ('cat_verify_b4c_b', 'store_verify_b4c_b', 'Cat B', 'cat-b');`,
    `INSERT INTO products (id, store_id, category_id, name, slug, price) VALUES ('prod_verify_b4c_a', 'store_verify_b4c_a', 'cat_verify_b4c_a', 'Prod A', 'prod-a', 150000);`,
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b4c_b', 'store_verify_b4c_b', 'Prod B', 'prod-b', 200000);`,
  ];
  for (const sql of seed) {
    const r = d1(sql);
    if (!r.ok) throw new Error(`B4 seed failed: ${r.error}`);
  }
  d1(`UPDATE users SET email_verified = 1 WHERE id IN ('user_verify_b4c_a', 'user_verify_b4c_b');`);

  async function loginCookie(email: string): Promise<string> {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    if (res.status !== 200) throw new Error(`B4 setup login failed for ${email}: ${res.status}`);
    return cookieOf(res.headers.get("set-cookie"));
  }
  jarA = await loginCookie("b4ca@example.com");
  jarB = await loginCookie("b4cb@example.com");
}, 180_000);

afterAll(async () => {
  try {
    assertCleanVerify("b4 end");
  } finally {
    stopDevServer(server);
    server = null;
  }
}, 60_000);

describe("B4 categories", () => {
  it("CRUD with validation; bad parent/slug rejected", async () => {
    const created = await api(`${A}/categories`, {
      method: "POST",
      body: JSON.stringify({ name: "New Cat", slug: "new-cat" }),
    }, jarA);
    expect(created.status).toBe(201);
    const cat = (created.body as { data: { category: { id: string } } }).data.category;

    const listed = await api(`${A}/categories`, {}, jarA);
    expect((listed.body as { data: { categories: unknown[] } }).data.categories.length).toBeGreaterThanOrEqual(2);

    const patched = await api(`${A}/categories/${cat.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed Cat" }),
    }, jarA);
    expect(patched.status).toBe(200);

    const badSlug = await api(`${A}/categories`, {
      method: "POST",
      body: JSON.stringify({ name: "Bad", slug: "Not A Slug!!" }),
    }, jarA);
    expect(badSlug.status).toBe(400);

    const badParent = await api(`${A}/categories`, {
      method: "POST",
      body: JSON.stringify({ name: "Bad", slug: "bad-parent", parent_id: "cat_verify_b4c_b" }),
    }, jarA);
    expect(badParent.status).toBe(404);
    expect(badParent.body).toEqual({
      ok: false,
      error: { code: "parent_not_found", message: "Parent category not found." },
    });

    const selfParent = await api(`${A}/categories/${cat.id}`, {
      method: "PATCH",
      body: JSON.stringify({ parent_id: cat.id }),
    }, jarA);
    expect(selfParent.status).toBe(400);
  });

  it("parent/child cycle is rejected", async () => {    const p = (await api(`${A}/categories`, {
      method: "POST",
      body: JSON.stringify({ name: "Cycle P", slug: "cycle-p" }),
    }, jarA).then((r) => (r.body as { data: { category: { id: string } } }).data.category));
    const ch = (await api(`${A}/categories`, {
      method: "POST",
      body: JSON.stringify({ name: "Cycle C", slug: "cycle-c", parent_id: p.id }),
    }, jarA).then((r) => (r.body as { data: { category: { id: string } } }).data.category));
    const cycle = await api(`${A}/categories/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ parent_id: ch.id }),
    }, jarA);
    expect(cycle.status).toBe(400);
    expect(cycle.body).toEqual({
      ok: false,
      error: { code: "invalid_parent", message: expect.any(String) },
    });
  });

  it("create without sort_order appends to the sibling list", async () => {
    async function createCat(body: unknown) {
      const res = await api(`${A}/categories`, { method: "POST", body: JSON.stringify(body) }, jarA);
      expect(res.status).toBe(201);
      return (res.body as { data: { category: { id: string; sort_order: number; parent_id: string | null } } }).data.category;
    }
    const r1 = await createCat({ name: "Append One", slug: "append-one" });
    const r2 = await createCat({ name: "Append Two", slug: "append-two" });
    expect(r2.sort_order).toBeGreaterThan(r1.sort_order);
    const ch1 = await createCat({ name: "Append Child 1", slug: "append-child-1", parent_id: r1.id });
    const ch2 = await createCat({ name: "Append Child 2", slug: "append-child-2", parent_id: r1.id });
    expect(ch2.sort_order).toBeGreaterThan(ch1.sort_order);
    // Explicit values are still honored.
    const ex = await createCat({ name: "Append Explicit", slug: "append-explicit", sort_order: -5 });
    expect(ex.sort_order).toBe(-5);
  });

  it("reorder via sort_order PATCH persists list order; parents untouched", async () => {
    async function createCat(slug: string) {
      const res = await api(`${A}/categories`, { method: "POST", body: JSON.stringify({ name: slug, slug }) }, jarA);
      expect(res.status).toBe(201);
      return (res.body as { data: { category: { id: string } } }).data.category;
    }
    const a = await createCat("ord-a");
    const b = await createCat("ord-b");
    const c = await createCat("ord-c");
    for (const [id, sort] of [[c.id, 0], [b.id, 1], [a.id, 2]] as const) {
      const patched = await api(`${A}/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ sort_order: sort }),
      }, jarA);
      expect(patched.status).toBe(200);
      expect((patched.body as { data: { category: { parent_id: string | null } } }).data.category.parent_id).toBeNull();
    }
    const listed = await api(`${A}/categories`, {}, jarA);
    const slugs = ((listed.body as { data: { categories: { slug: string }[] } }).data.categories)
      .map((cat) => cat.slug)
      .filter((slug) => slug.startsWith("ord-"));
    expect(slugs).toEqual(["ord-c", "ord-b", "ord-a"]);
  });

  it("cross-store reorder is 404 and changes nothing", async () => {
    const before = await api(`${B}/categories/cat_verify_b4c_b`, {}, jarB);
    const beforeOrder = (before.body as { data: { category: { sort_order: number } } }).data.category.sort_order;
    const patch = await api(`${A}/categories/cat_verify_b4c_b`, {
      method: "PATCH",
      body: JSON.stringify({ sort_order: 999 }),
    }, jarA);
    expect(patch.status).toBe(404);
    const after = await api(`${B}/categories/cat_verify_b4c_b`, {}, jarB);
    expect((after.body as { data: { category: { sort_order: number } } }).data.category.sort_order).toBe(beforeOrder);
  });

  it("cross-store category access is 404 and side-effect free", async () => {
    expect((await api(`${A}/categories/cat_verify_b4c_b`, {}, jarA)).status).toBe(404);
    const patch = await api(`${A}/categories/cat_verify_b4c_b`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Hijacked" }),
    }, jarA);
    expect(patch.status).toBe(404);
    const del = await api(`${A}/categories/cat_verify_b4c_b`, { method: "DELETE" }, jarA);
    expect(del.status).toBe(404);
    const intact = await api(`${B}/categories/cat_verify_b4c_b`, {}, jarB);
    expect(((intact.body as { data: { category: { name: string } } }).data.category.name)).toBe("Cat B");
  });

  it("delete with dependents is 409; detach=true deletes and unassigns", async () => {
    const blocked = await api(`${A}/categories/cat_verify_b4c_a`, { method: "DELETE" }, jarA);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({
      ok: false,
      error: { code: "has_dependents", message: expect.any(String) },
    });
    const detached = await api(`${A}/categories/cat_verify_b4c_a?detach=true`, { method: "DELETE" }, jarA);
    expect(detached.status).toBe(200);
    const prod = await api(`${A}/products/prod_verify_b4c_a`, {}, jarA);
    expect(((prod.body as { data: { product: { category_id: string | null } } }).data.product.category_id)).toBeNull();
    expect((await api(`${A}/categories/cat_verify_b4c_a`, {}, jarA)).status).toBe(404);
  });

  it("writes on expired-subscription stores are 403; reads stay open", async () => {
    const blocked = await api(`${EXP}/categories`, {
      method: "POST",
      body: JSON.stringify({ name: "Nope", slug: "nope" }),
    }, jarA);
    expect(blocked.status).toBe(403);
    expect((await api(`${EXP}/categories`, {}, jarA)).status).toBe(200);
  });

  it("immutable fields in body are 400", async () => {
    const res = await api(`${A}/categories`, {
      method: "POST",
      body: JSON.stringify({ name: "X", slug: "x-immutable", store_id: "store_verify_b4c_b" }),
    }, jarA);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "immutable_field", message: "Field 'store_id' cannot be set by clients." },
    });
  });
});

describe("B4 products", () => {
  it("CRUD with price/category validation", async () => {
    const created = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Widget", slug: "widget", price: 999 }),
    }, jarA);
    expect(created.status).toBe(201);

    const negPrice = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Bad", slug: "bad-price", price: -5 }),
    }, jarA);
    expect(negPrice.status).toBe(400);

    const badCat = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Bad", slug: "bad-cat", price: 10, category_id: "cat_verify_b4c_b" }),
    }, jarA);
    expect(badCat.status).toBe(404);

    const dupSlug = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Dup", slug: "widget", price: 10 }),
    }, jarA);
    expect(dupSlug.status).toBe(409);
    expect(dupSlug.body).toEqual({
      ok: false,
      error: { code: "slug_taken", message: expect.any(String) },
    });
  });

  it("cross-store product access is 404 and side-effect free", async () => {
    expect((await api(`${A}/products/prod_verify_b4c_b`, {}, jarA)).status).toBe(404);
    const patch = await api(`${A}/products/prod_verify_b4c_b`, {
      method: "PATCH",
      body: JSON.stringify({ price: 1 }),
    }, jarA);
    expect(patch.status).toBe(404);
    const intact = await api(`${B}/products/prod_verify_b4c_b`, {}, jarB);
    expect(((intact.body as { data: { product: { price: number } } }).data.product.price)).toBe(200000);
  });

  it("soft-delete releases the slug; restore conflicts 409 then succeeds", async () => {
    type Row = {
      id: string; store_id: string; name: string; slug: string;
      category_id: string | null; price: number; stock_quantity: number | null;
      is_active: number; deleted_at: string | null;
    };
    const created = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Temp", slug: "temp-slug", price: 50 }),
    }, jarA);
    const fresh = (created.body as { data: { product: Row } }).data.product;
    const id = fresh.id;
    expect(fresh.is_active).toBe(1);
    expect(fresh.deleted_at).toBeNull();

    const del = await api(`${A}/products/${id}`, { method: "DELETE" }, jarA);
    expect(del.status).toBe(200);
    const deleted = (del.body as { data: { product: Row } }).data.product;
    expect(deleted.deleted_at).toBeTruthy();
    expect(deleted.is_active).toBe(0);

    // Listing still returns the retired row, with both retirement markers.
    const listed = await api(`${A}/products`, {}, jarA);
    const found = (
      (listed.body as { data: { products: Row[] } }).data.products
    ).find((p) => p.id === id);
    expect(found).toBeDefined();
    expect(found!.deleted_at).toBeTruthy();
    expect(found!.is_active).toBe(0);

    const reuse = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Temp 2", slug: "temp-slug", price: 60 }),
    }, jarA);
    expect(reuse.status).toBe(201);

    const restoreClash = await api(`${A}/products/${id}/restore`, { method: "POST" }, jarA);
    expect(restoreClash.status).toBe(409);

    const rename = await api(`${A}/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ slug: "temp-slug-freed" }),
    }, jarA);
    expect(rename.status).toBe(200);
    const beforeRestore = (rename.body as { data: { product: Row } }).data.product;

    const restored = await api(`${A}/products/${id}/restore`, { method: "POST" }, jarA);
    expect(restored.status).toBe(200);
    const revived = (restored.body as { data: { product: Row } }).data.product;
    expect(revived.deleted_at).toBeNull();
    expect(revived.is_active).toBe(1);
    // Same row, all other fields untouched by delete → restore.
    for (const key of ["id", "store_id", "name", "slug", "category_id", "price", "stock_quantity"] as const) {
      expect(revived[key]).toEqual(beforeRestore[key]);
    }

    // Restored product is listed as live.
    const relisted = await api(`${A}/products`, {}, jarA);
    const live = (
      (relisted.body as { data: { products: Row[] } }).data.products
    ).find((p) => p.id === id);
    expect(live).toBeDefined();
    expect(live!.deleted_at).toBeNull();
    expect(live!.is_active).toBe(1);
  });

  it("business delete keeps the row, protects order history, and blocks resale", async () => {
    type Row = {
      id: string; store_id: string; name: string; slug: string;
      price: number; is_active: number;
      deleted_at: string | null; removed_at: string | null;
    };
    // Active product + a Damascus rate so guest checkout can run.
    const created = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Doomed Widget", slug: "doomed-widget", price: 7000 }),
    }, jarA);
    expect(created.status).toBe(201);
    const id = ((created.body as { data: { product: Row } }).data.product).id;
    const rate = await api(`${A}/shipping-rates`, {
      method: "POST",
      body: JSON.stringify({ governorate: "Damascus", shipping_method: "Standard", cost: 3000 }),
    }, jarA);
    expect(rate.status).toBe(201);

    // Guest COD order referencing the product.
    const co = await api(`${A}/checkout`, {
      method: "POST",
      headers: { "X-Idempotency-Key": `b4c-del-${Date.now()}` },
      body: JSON.stringify({
        customer: { name: "Doomed Buyer", phone: "+963911800001" },
        items: [{ product_id: id, quantity: 2 }],
        shipping: {
          recipient_name: "Doomed Buyer",
          phone: "+963911800001",
          governorate: "Damascus",
          address_line: "Street 9, Damascus",
        },
        payment: { method: "cod" },
      }),
    });
    expect(co.status).toBe(201);
    const orderId = ((co.body as { data: { order: { id: string } } }).data.order).id;
    const before = await api(`${A}/orders/${orderId}`, {}, jarA);
    expect(before.status).toBe(200);

    // Delete from the active state.
    const del = await api(`${A}/products/${id}/delete`, { method: "POST" }, jarA);
    expect(del.status).toBe(200);
    const gone = (del.body as { data: { product: Row } }).data.product;
    expect(gone.removed_at).toBeTruthy();
    expect(gone.deleted_at).toBeTruthy();
    expect(gone.is_active).toBe(0);

    // The row still exists (no hard delete) and the order is byte-identical.
    const still = await api(`${A}/products/${id}`, {}, jarA);
    expect(still.status).toBe(200);
    expect(((still.body as { data: { product: Row } }).data.product.removed_at)).toBeTruthy();
    const after = await api(`${A}/orders/${orderId}`, {}, jarA);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);

    // Repeating delete is a safe no-op; the retired product can no longer
    // be purchased (same 409 as archived products).
    expect((await api(`${A}/products/${id}/delete`, { method: "POST" }, jarA)).status).toBe(200);
    const repurchase = await api(`${A}/checkout`, {
      method: "POST",
      headers: { "X-Idempotency-Key": `b4c-del-retry-${Date.now()}` },
      body: JSON.stringify({
        customer: { name: "Late Buyer", phone: "+963911800002" },
        items: [{ product_id: id, quantity: 1 }],
        shipping: {
          recipient_name: "Late Buyer",
          phone: "+963911800002",
          governorate: "Damascus",
          address_line: "Street 9, Damascus",
        },
        payment: { method: "cod" },
      }),
    });
    expect(repurchase.status).toBe(409);

    // Restore revives a deleted product (both flags cleared).
    const restored = await api(`${A}/products/${id}/restore`, { method: "POST" }, jarA);
    expect(restored.status).toBe(200);
    const revived = (restored.body as { data: { product: Row } }).data.product;
    expect(revived.deleted_at).toBeNull();
    expect(revived.removed_at).toBeNull();
    expect(revived.is_active).toBe(1);
  });

  it("delete works from archived; archive on removed is 404; cross-merchant delete is 404", async () => {
    const created = await api(`${A}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Arch Then Gone", slug: "arch-then-gone", price: 100 }),
    }, jarA);
    expect(created.status).toBe(201);
    const id = ((created.body as { data: { product: { id: string } } }).data.product).id;

    // Archive first, then business-delete from the archived state.
    expect((await api(`${A}/products/${id}`, { method: "DELETE" }, jarA)).status).toBe(200);
    const del = await api(`${A}/products/${id}/delete`, { method: "POST" }, jarA);
    expect(del.status).toBe(200);
    expect(((del.body as { data: { product: { removed_at: string | null } } }).data.product.removed_at)).toBeTruthy();

    // Archive scope excludes removed products.
    const archiveAgain = await api(`${A}/products/${id}`, { method: "DELETE" }, jarA);
    expect(archiveAgain.status).toBe(404);

    // Another merchant cannot delete it (identical 404, no oracle: the
    // store-access middleware rejects before the product is ever read).
    const foreign = await api(`${A}/products/${id}/delete`, { method: "POST" }, jarB);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({
      ok: false,
      error: { code: "store_not_found", message: "Store not found." },
    });

    // Anonymous delete is 401.
    expect((await api(`${A}/products/${id}/delete`, { method: "POST" })).status).toBe(401);

    // removed_at is immutable through create/PATCH like deleted_at.
    const badPatch = await api(`${A}/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ removed_at: null }),
    }, jarA);
    expect(badPatch.status).toBe(400);

    // Expired store: shared subscription gate blocks delete like PATCH.
    expect(d1(`INSERT INTO products (id, store_id, name, slug, price) VALUES ('prod_verify_b4c_gone', 'store_verify_b4c_expired', 'Gone', 'gone-widget', 100);`).ok).toBe(true);
    const gated = await api(`${EXP}/products/prod_verify_b4c_gone/delete`, { method: "POST" }, jarA);
    expect(gated.status).toBe(403);
    expect(gated.body).toEqual({
      ok: false,
      error: { code: "subscription_inactive", message: "Store subscription is not active." },
    });
  });

  it("plan product limit enforced; expired store blocked", async () => {
    const first = await api(`${LIM}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Only One", slug: "only-one", price: 10 }),
    }, jarA);
    expect(first.status).toBe(201);
    const second = await api(`${LIM}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Too Many", slug: "too-many", price: 10 }),
    }, jarA);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      ok: false,
      error: { code: "plan_limit", message: expect.any(String) },
    });

    const expired = await api(`${EXP}/products`, {
      method: "POST",
      body: JSON.stringify({ name: "Nope", slug: "nope-exp", price: 10 }),
    }, jarA);
    expect(expired.status).toBe(403);
  });
});

describe("B4 product images", () => {
  it("CRUD with https + same-store product validation", async () => {
    const created = await api(`${A}/product-images`, {
      method: "POST",
      body: JSON.stringify({ product_id: "prod_verify_b4c_a", url: "https://cdn.example.com/a.jpg" }),
    }, jarA);
    expect(created.status).toBe(201);
    const img = (created.body as { data: { image: { id: string } } }).data.image;

    const httpUrl = await api(`${A}/product-images`, {
      method: "POST",
      body: JSON.stringify({ product_id: "prod_verify_b4c_a", url: "http://cdn.example.com/a.jpg" }),
    }, jarA);
    expect(httpUrl.status).toBe(400);

    const foreignProduct = await api(`${A}/product-images`, {
      method: "POST",
      body: JSON.stringify({ product_id: "prod_verify_b4c_b", url: "https://cdn.example.com/b.jpg" }),
    }, jarA);
    expect(foreignProduct.status).toBe(404);

    const listed = await api(`${A}/product-images?product_id=prod_verify_b4c_a`, {}, jarA);
    expect(((listed.body as { data: { images: unknown[] } }).data.images.length)).toBeGreaterThanOrEqual(1);

    const patched = await api(`${A}/product-images/${img.id}`, {
      method: "PATCH",
      body: JSON.stringify({ alt_text: "Front view", sort_order: 2 }),
    }, jarA);
    expect(patched.status).toBe(200);

    const del = await api(`${A}/product-images/${img.id}`, { method: "DELETE" }, jarA);
    expect(del.status).toBe(200);
    expect((await api(`${A}/product-images/${img.id}/restore`, { method: "POST" }, jarA)).status).toBe(200);
  });

  it("cross-store image access is 404", async () => {
    const mk = await api(`${B}/product-images`, {
      method: "POST",
      body: JSON.stringify({ product_id: "prod_verify_b4c_b", url: "https://cdn.example.com/secret.jpg" }),
    }, jarB);
    const imgId = (mk.body as { data: { image: { id: string } } }).data.image.id;
    expect((await api(`${A}/product-images/${imgId}`, {}, jarA)).status).toBe(404);
    expect((await api(`${A}/product-images/${imgId}`, { method: "DELETE" }, jarA)).status).toBe(404);
    expect((await api(`${B}/product-images/${imgId}`, {}, jarB)).status).toBe(200);
  });
});
