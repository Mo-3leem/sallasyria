// B14-c E2E fixtures: minimal D1 seeds for browser smoke, reusing the
// repository's shared cleanup + execution harness (no duplicate infra).
// E2E users are UUID-keyed by createMerchant(), so they are NOT covered by
// clean-verify.mjs's user_verify% LIKE scope — deleteE2EFixtureRows below
// removes the deterministic E2E merchant by email/phone instead. The
// deterministic E2E store id additionally falls under the existing
// store_verify% scope.
//
// Password hashing stays server-side on purpose: the merchant is created
// through the real public registration endpoint (Turnstile passes through
// in dev without a secret), then verified + given a store directly.
import { assertCleanVerify, run } from "../scripts/clean-verify.mjs";

export const E2E_MERCHANT = {
  // +963900003401: dedicated block verified collision-free (the previous
  // +963900001991 collided with adversarial/image-tombstone fixtures on the
  // global users.phone UNIQUE constraint).
  phone: "+963900003401",
  email: "e2emerchant@example.com",
  name: "E2E Merchant",
  password: "E2e-Strong-1",
};

export const E2E_STORE = {
  id: "store_verify_e2e_a",
  slug: "e2e-store-a",
  name: "E2E Store",
};

// J3 admin: created through the same public registration endpoint as the
// merchant, then promoted via UPDATE (role CHECK allows merchant/admin).
// No bootstrap credential is used: ADMIN_BOOTSTRAP_PASSWORD is unset in
// local dev, so login returns must_rotate=false and no forced rotation.
export const E2E_ADMIN = {
  phone: "+963900001992",
  email: "e2eadmin@example.com",
  name: "E2E Admin",
  password: "E2e-Strong-1",
};

// J3 directory: row count must cross one UI page. The merchants directory
// requests no page_size, so the backend default (DEFAULT_PAGE_SIZE = 20 in
// src/lib/pagination.ts) applies — 21 rows yield exactly 2 pages.
export const E2E_DIRECTORY_COUNT = 21;
export const E2E_DIRECTORY_EMAIL_PREFIX = "e2edir";

// wrangler d1 execute --local has no bind-parameter API (SQL travels via
// --file), so every value below goes through lit(): single-quote escaping.
// All inputs are fixed repository constants, never user data — no arbitrary
// interpolation, and cleanup stays scoped to the deterministic e2e keys.
function lit(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function mustSucceed(label, res) {
  if (!res || !res.ok) throw new Error(`e2e seed failed (${label}): ${res?.error ?? "unknown"}`);
  return res;
}

// Repeatability: createMerchant() mints a random uuidv7 id, so the shared
// clean-verify.mjs `user_verify%` LIKE scope can never match the e2e user.
// Instead, scope strictly to the deterministic e2e keys (fixed email/phone
// + fixed store id/slug). Child-before-parent, mirroring clean-verify.mjs,
// so RESTRICT FKs never block the delete. Nothing outside these keys is
// ever touched.
function deleteE2EFixtureRows() {
  const email = lit(E2E_MERCHANT.email);
  const phone = lit(E2E_MERCHANT.phone);
  const storeId = lit(E2E_STORE.id);
  const slug = lit(E2E_STORE.slug);
  const userScope = `SELECT id FROM users WHERE email = ${email} OR phone = ${phone}`;
  mustSucceed(
    "e2e pre-clean sessions",
    run(`DELETE FROM sessions WHERE user_id IN (${userScope});`)
  );
  // Dependents of the fixture store (J1/J2 never create these, but an
  // aborted run must not poison the next one).
  for (const table of [
    "idempotency_keys",
    "order_items",
    "orders",
    "product_images",
    "products",
    "customer_addresses",
    "customers",
    "shipping_rates",
    "subscriptions",
  ]) {
    mustSucceed(
      `e2e pre-clean ${table}`,
      run(`DELETE FROM ${table} WHERE store_id = ${storeId};`)
    );
  }
  mustSucceed(
    "e2e pre-clean categories children",
    run(`DELETE FROM categories WHERE parent_id IS NOT NULL AND store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean categories",
    run(`DELETE FROM categories WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean stores",
    run(
      `DELETE FROM stores WHERE id = ${storeId} OR slug = ${slug} OR owner_id IN (${userScope});`
    )
  );
  mustSucceed(
    "e2e pre-clean users",
    run(`DELETE FROM users WHERE email = ${email} OR phone = ${phone};`)
  );
}

export function resetE2EFixtures(contextLabel) {
  assertCleanVerify(contextLabel);
}

export async function seedE2EMerchant(apiBase) {
  // Fixture-scoped pre-clean first: makes repeated runs safe even when the
  // previous run's user row survives the shared user_verify% cleanup.
  deleteE2EFixtureRows();
  // Local workerd has known-transient network faults on first contact
  // (ECONNRESET / fetch failed — same class scripts/clean-verify.mjs
  // retries). Retry the REGISTER request only; an HTTP status back is
  // deterministic and never retried (a 409 means the pre-clean missed,
  // which must fail loudly, not loop).
  let res = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${apiBase}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: E2E_MERCHANT.name,
          email: E2E_MERCHANT.email,
          phone: E2E_MERCHANT.phone,
          password: E2E_MERCHANT.password,
        }),
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  if (!res) throw new Error(`e2e register failed: ${lastErr?.message ?? lastErr}`);
  if (res.status !== 201) throw new Error(`e2e register failed: ${res.status}`);
  const body = await res.json();
  const userId = body?.data?.user?.id;
  if (!userId) throw new Error("e2e register returned no user id");
  mustSucceed(
    "e2e verify",
    run(`UPDATE users SET email_verified = 1 WHERE id = ${lit(userId)};`)
  );
  mustSucceed(
    "e2e store",
    run(
      `INSERT INTO stores (id, owner_id, slug, name) VALUES (${lit(E2E_STORE.id)}, ${lit(userId)}, ${lit(E2E_STORE.slug)}, ${lit(E2E_STORE.name)});`
    )
  );
  return { userId };
}

// Register through the real public endpoint with the same transient-fault
// retry contract as seedE2EMerchant: network throws retried (3x), HTTP
// statuses deterministic and never retried. Returns the server-minted id.
async function registerAccount(apiBase, { name, email, phone, password }, label) {
  let res = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${apiBase}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, password }),
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  if (!res) throw new Error(`e2e register failed (${label}): ${lastErr?.message ?? lastErr}`);
  if (res.status !== 201) throw new Error(`e2e register failed (${label}): ${res.status}`);
  const body = await res.json();
  const userId = body?.data?.user?.id;
  if (!userId) throw new Error(`e2e register returned no user id (${label})`);
  return userId;
}

// Fixture-scoped pre-clean for the admin (exact deterministic keys only).
function deleteE2EAdminRows() {
  const email = lit(E2E_ADMIN.email);
  const phone = lit(E2E_ADMIN.phone);
  const userScope = `SELECT id FROM users WHERE email = ${email} OR phone = ${phone}`;
  mustSucceed(
    "e2e pre-clean admin sessions",
    run(`DELETE FROM sessions WHERE user_id IN (${userScope});`)
  );
  mustSucceed(
    "e2e pre-clean admin stores",
    run(`DELETE FROM stores WHERE owner_id IN (${userScope});`)
  );
  mustSucceed(
    "e2e pre-clean admin users",
    run(`DELETE FROM users WHERE email = ${email} OR phone = ${phone};`)
  );
}

export async function seedE2EAdmin(apiBase) {
  deleteE2EAdminRows();
  const userId = await registerAccount(apiBase, E2E_ADMIN, "admin");
  mustSucceed(
    "e2e admin verify+promote",
    run(`UPDATE users SET email_verified = 1, role = 'admin' WHERE id = ${lit(userId)};`)
  );
  return { userId };
}

function directoryIdentity(i) {
  const pad = String(i).padStart(2, "0");
  return {
    name: `E2E Directory ${pad}`,
    email: `${E2E_DIRECTORY_EMAIL_PREFIX}${pad}@example.com`,
    // Canonical +963 + 9 digits, unique per row. The +963900003xxx block is
    // unused by every vitest suite (notably pagination.integration.test.ts
    // owns +963900002101..104, which an earlier revision collided with and
    // would have broken via the phone UNIQUE constraint).
    phone: `+9639000031${pad}`,
  };
}

// Fixture-scoped pre-clean for the directory namespace (LIKE prefix only —
// the prefix contains no _ or % wildcards, so matching is exact-prefix).
// email_tokens rows CASCADE off the user delete; mail_outbox carries no user
// FK (verified non-blocking across repeat runs).
function deleteE2EDirectoryRows() {
  const scope = `SELECT id FROM users WHERE email LIKE '${E2E_DIRECTORY_EMAIL_PREFIX}%'`;
  mustSucceed(
    "e2e pre-clean directory sessions",
    run(`DELETE FROM sessions WHERE user_id IN (${scope});`)
  );
  mustSucceed(
    "e2e pre-clean directory stores",
    run(`DELETE FROM stores WHERE owner_id IN (${scope});`)
  );
  mustSucceed(
    "e2e pre-clean directory users",
    run(`DELETE FROM users WHERE email LIKE '${E2E_DIRECTORY_EMAIL_PREFIX}%';`)
  );
}

export async function seedE2EMerchantDirectory(apiBase, count = E2E_DIRECTORY_COUNT) {
  deleteE2EDirectoryRows();
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const { name, email, phone } = directoryIdentity(i);
    ids.push(
      await registerAccount(apiBase, { name, email, phone, password: E2E_ADMIN.password }, `directory ${i}`)
    );
  }
  // One statement for all verifications: fewer wrangler invocations.
  mustSucceed(
    "e2e directory verify",
    run(`UPDATE users SET email_verified = 1 WHERE id IN (${ids.map(lit).join(", ")});`)
  );
  return { userIds: ids };
}

// J4 guest checkout fixture: published store + active product + active
// shipping rate + covering subscription. The owner registers through the
// real public endpoint (server-side hashing preserved); catalog/billing
// rows mirror the proven shapes in tests/checkout.integration.test.ts.
// Keys: the +9639000032xx/+9639000033xx blocks and every e2e-co-* id are
// unused by all vitest suites (audited); the store id additionally falls
// under the store_verify% global scope. Products are deleted + recreated
// on every seed, so stock is inherently reset between runs.
export const E2E_CO_OWNER = {
  phone: "+963900003301",
  email: "e2e-co-owner@example.com",
  name: "E2E CO Owner",
  password: "E2e-Strong-1",
};

export const E2E_CO_STORE = {
  id: "store_verify_e2e_co_a",
  slug: "e2e-co-store",
  name: "E2E CO Store",
};

export const E2E_CO_PLAN = {
  id: "plan_verify_e2e_co",
  code: "e2e-co-plan",
  name: "E2E CO Plan",
};

export const E2E_CO_SUBSCRIPTION = {
  id: "sub_verify_e2e_co_a",
  status: "active",
  billing_period: "monthly",
  starts_at: "2026-01-01T00:00:00Z",
  ends_at: "2099-01-01T00:00:00Z",
};

export const E2E_CO_PRODUCT = {
  id: "prod_verify_e2e_co_widget",
  slug: "e2e-co-widget",
  name: "E2E CO Widget",
  price: 25000,
  stock: 10,
};

export const E2E_CO_RATE = {
  id: "rate_verify_e2e_co_dam",
  governorate: "Damascus",
  shipping_method: "Standard",
  cost: 5000,
};

// Deterministic guest identity typed into the checkout form (spec-owned;
// customer rows upsert by phone per store and are pre-cleaned by store).
export const E2E_CO_GUEST = {
  name: "E2E Guest",
  phone: "+963900003201",
  email: "e2e-coguest@example.com",
  address: "E2E Street 1, Damascus",
};

// Fixture-scoped pre-clean, child-before-parent (cart_items references
// products RESTRICT, stores references users RESTRICT — parents go last).
// email_tokens rows CASCADE off the user delete; mail_outbox carries no
// user FK (verified non-blocking across repeat runs).
//
// The shared clean-verify reset covers guest carts too (cart_items:carts +
// carts entries), so the global reset converges on repeat runs; this
// fixture pre-clean additionally removes the UUID-keyed owner rows the
// shared LIKE scopes cannot match.
function deleteE2ECheckoutRows() {
  const ownerEmail = lit(E2E_CO_OWNER.email);
  const ownerPhone = lit(E2E_CO_OWNER.phone);
  const storeId = lit(E2E_CO_STORE.id);
  const planId = lit(E2E_CO_PLAN.id);
  const ownerScope = `SELECT id FROM users WHERE email = ${ownerEmail} OR phone = ${ownerPhone}`;
  const storeCarts = `SELECT id FROM carts WHERE store_id = ${storeId}`;
  mustSucceed(
    "e2e pre-clean checkout sessions",
    run(`DELETE FROM sessions WHERE user_id IN (${ownerScope});`)
  );
  mustSucceed(
    "e2e pre-clean checkout idempotency",
    run(`DELETE FROM idempotency_keys WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout cart items",
    run(`DELETE FROM cart_items WHERE cart_id IN (${storeCarts});`)
  );
  mustSucceed(
    "e2e pre-clean checkout carts",
    run(`DELETE FROM carts WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout order items",
    run(`DELETE FROM order_items WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout orders",
    run(`DELETE FROM orders WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout product images",
    run(`DELETE FROM product_images WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout products",
    run(`DELETE FROM products WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout categories children",
    run(`DELETE FROM categories WHERE parent_id IS NOT NULL AND store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout categories",
    run(`DELETE FROM categories WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout customer addresses",
    run(`DELETE FROM customer_addresses WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout customers",
    run(`DELETE FROM customers WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout shipping rates",
    run(`DELETE FROM shipping_rates WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout subscriptions",
    run(`DELETE FROM subscriptions WHERE store_id = ${storeId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout stores",
    run(`DELETE FROM stores WHERE id = ${storeId} OR owner_id IN (${ownerScope});`)
  );
  mustSucceed(
    "e2e pre-clean checkout plans",
    run(`DELETE FROM plans WHERE id = ${planId};`)
  );
  mustSucceed(
    "e2e pre-clean checkout users",
    run(`DELETE FROM users WHERE email = ${ownerEmail} OR phone = ${ownerPhone};`)
  );
}

export async function seedE2ECheckout(apiBase) {
  deleteE2ECheckoutRows();
  const ownerId = await registerAccount(apiBase, E2E_CO_OWNER, "checkout owner");
  mustSucceed(
    "e2e checkout catalog",
    run(
      `INSERT INTO plans (id, code, name) VALUES (${lit(E2E_CO_PLAN.id)}, ${lit(E2E_CO_PLAN.code)}, ${lit(E2E_CO_PLAN.name)});` +
        `INSERT INTO stores (id, owner_id, slug, name, is_published, status) VALUES (${lit(E2E_CO_STORE.id)}, ${lit(ownerId)}, ${lit(E2E_CO_STORE.slug)}, ${lit(E2E_CO_STORE.name)}, 1, 'active');` +
        `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, starts_at, ends_at) VALUES (${lit(E2E_CO_SUBSCRIPTION.id)}, ${lit(E2E_CO_STORE.id)}, ${lit(E2E_CO_PLAN.id)}, ${lit(E2E_CO_SUBSCRIPTION.status)}, ${lit(E2E_CO_SUBSCRIPTION.billing_period)}, ${lit(E2E_CO_SUBSCRIPTION.starts_at)}, ${lit(E2E_CO_SUBSCRIPTION.ends_at)});` +
        `INSERT INTO products (id, store_id, name, slug, price, stock_quantity) VALUES (${lit(E2E_CO_PRODUCT.id)}, ${lit(E2E_CO_STORE.id)}, ${lit(E2E_CO_PRODUCT.name)}, ${lit(E2E_CO_PRODUCT.slug)}, ${E2E_CO_PRODUCT.price}, ${E2E_CO_PRODUCT.stock});` +
        `INSERT INTO shipping_rates (id, store_id, governorate, shipping_method, cost, is_active) VALUES (${lit(E2E_CO_RATE.id)}, ${lit(E2E_CO_STORE.id)}, ${lit(E2E_CO_RATE.governorate)}, ${lit(E2E_CO_RATE.shipping_method)}, ${E2E_CO_RATE.cost}, 1);`
    )
  );
  return { ownerId };
}

// Read-only backend proof for J4: latest order of the store + its items +
// current product stock. Throws loudly on harness failure; returns nulls
// when the browser flow created nothing (spec asserts presence).
export function readE2ECheckoutOrder() {
  const storeId = lit(E2E_CO_STORE.id);
  const productId = lit(E2E_CO_PRODUCT.id);
  const select = (label, sql) => {
    const res = run(sql);
    if (!res || !res.ok) throw new Error(`e2e order read failed (${label}): ${res?.error ?? "unknown"}`);
    return res.result?.[0]?.results ?? [];
  };
  const orders = select(
    "orders",
    `SELECT id, order_number, status, payment_status, customer_name, customer_phone, shipping_governorate, shipping_method, shipping_cost, shipping_address, subtotal, total FROM orders WHERE store_id = ${storeId} ORDER BY order_number DESC LIMIT 1;`
  );
  const order = orders[0] ?? null;
  const items = order
    ? select(
      "order items",
      `SELECT product_id, product_name, quantity, unit_price, line_total FROM order_items WHERE order_id = ${lit(order.id)};`
    )
    : [];
  const customers = select(
    "customers",
    `SELECT name, phone, email FROM customers WHERE store_id = ${storeId};`
  );
  const stock = select(
    "product stock",
    `SELECT stock_quantity FROM products WHERE id = ${productId};`
  );
  return { order, items, customers, stock: stock[0]?.stock_quantity ?? null };
}
