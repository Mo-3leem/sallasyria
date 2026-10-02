import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";
import { normalizePhone } from "../lib/phone.js";
import { buildUpsertCustomer } from "./customers.js";

// Checkout (roadmap B6, validated H1/H2/H6 reviews).
//
// Single-batch atomic unit, in order:
//   [0..k-1]   stock decrements, tracked lines only (existing CHECK>=0 aborts
//              the batch on insufficiency — no silent oversell, no branching)
//   [k]        counter UPDATE ... RETURNING (response verification only)
//   [k+1]      customer upsert (same statement as the public endpoint)
//   [k+2]      order INSERT, number read in-transaction via subquery
//   [k+3..]    order_items INSERTs
//   [last]     idempotency key claim (UNIQUE aborts concurrent dupes)
// The key claim sits LAST deliberately: its composite FK references the order
// row created earlier in the same batch, and immediate FK enforcement would
// reject a claim for a not-yet-existing order. Position does not weaken
// exactly-once: ANY statement failure (including the final UNIQUE conflict)
// rolls back the entire batch, so a concurrent duplicate's counter bump,
// stock moves, and order rows all vanish with it.
// The counter value is NOT passed from app to SQL (that would reintroduce a
// race); the order reads the just-incremented counter with a subquery, and
// the RETURNING value is asserted equal to the stored row afterwards.
//
// Failure semantics: any statement failure rolls back the whole batch
// (counter restored, key unclaimed, no partial order). The handler then:
//   key now present + hash match -> replay the winner (concurrency case);
//   else re-resolve (product/rate retired mid-flight -> 409 with Pc precision);
//   else re-read tracked stocks (insufficient -> 409, no decrement happened);
//   else rethrow (sanitized 500).
// Post-commit, purchasability is re-verified for every line (retired
// mid-flight race window); on violation the just-created order is deleted in
// a compensating batch (items + key cascade) and 409 is returned. Counter
// gaps are therefore possible ONLY on failed checkouts — numbers are never
// reused or duplicated (documented relaxation of "never skipped").

export interface CheckoutItemInput {
  product_id: string;
  quantity: number;
  selected_options?: string | null;
}

export interface CheckoutInput {
  customer: { name: string; phone: string; email?: string | null };
  items: CheckoutItemInput[];
  shipping: {
    recipient_name: string;
    phone: string;
    governorate: string;
    city?: string | null;
    address_line: string;
  };
  payment: { method: "cod" | "bank_transfer" | "wallet"; reference?: string | null };
}

interface ResolvedLine {
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  selected_options: string | null;
  tracked: boolean;
}

interface ResolvedCheckout {
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  lines: ResolvedLine[];
  subtotal: number;
  discount: number;
  shippingMethod: string;
  shippingCost: number;
  shippingGovernorate: string;
  shippingAddress: string;
  paymentMethod: string;
  paymentReference: string | null;
  total: number;
}

export interface CheckoutOrderRow {
  id: string;
  store_id: string;
  order_number: number;
  status: string;
  subtotal: number;
  discount: number;
  total: number;
  payment_method: string;
  payment_status: string;
  payment_reference: string | null;
  tracking_number: string | null;
  customer_name: string;
  customer_phone: string;
  shipping_method: string;
  shipping_cost: number;
  shipping_governorate: string;
  shipping_address: string;
}

export interface CheckoutItemRow {
  id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface CheckoutResult {
  order: CheckoutOrderRow;
  items: CheckoutItemRow[];
  replayed: boolean;
}

const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Canonical JSON: sorted keys, recursive. The request hash must be stable
// across whitespace/key-order variations, or identical retries would look
// like conflicting requests.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ProductRow {
  id: string;
  name: string;
  price: number;
  stock_quantity: number | null;
}

async function resolveCheckout(
  db: D1Database,
  storeId: string,
  input: CheckoutInput
): Promise<ResolvedCheckout> {
  const customerPhone = normalizePhone(input.customer.phone);
  const shipPhone = normalizePhone(input.shipping.phone);

  // Purchasability in ONE query: missing, cross-store, retired, and inactive
  // all map to a single oracle-safe code (buyers learn nothing about catalog
  // internals beyond "unavailable right now").
  const placeholders = input.items.map(() => "?").join(",");
  const found = await db
    .prepare(
      `SELECT id, name, price, stock_quantity FROM products
        WHERE store_id = ? AND id IN (${placeholders})
          AND deleted_at IS NULL AND is_active = 1`
    )
    .bind(storeId, ...input.items.map((l) => l.product_id))
    .all<ProductRow>();
  const byId = new Map((found.results ?? []).map((p) => [p.id, p]));
  const lines: ResolvedLine[] = input.items.map((l) => {
    const p = byId.get(l.product_id);
    if (!p) {
      throw new AppError("product_unavailable", 409, "A product in the order is unavailable.");
    }
    const line_total = l.quantity * p.price;
    return {
      product_id: p.id,
      product_name: p.name,
      quantity: l.quantity,
      unit_price: p.price,
      line_total,
      selected_options: l.selected_options ?? null,
      tracked: p.stock_quantity !== null,
    };
  });

  const rate = await db
    .prepare(
      "SELECT shipping_method, cost FROM shipping_rates WHERE store_id = ? AND governorate = ? AND is_active = 1"
    )
    .bind(storeId, input.shipping.governorate)
    .first<{ shipping_method: string; cost: number }>();
  if (!rate) {
    throw new AppError("shipping_unavailable", 409, "Delivery is unavailable for this governorate.");
  }

  if (input.payment.method !== "cod" && !input.payment.reference) {
    throw new AppError("payment_reference_required", 422, "Payment reference is required for this method.");
  }

  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const discount = 0; // No promotion engine in MVP: client discount is never accepted (route forbids the keys).
  const total = subtotal - discount + rate.cost;

  return {
    customerName: input.customer.name,
    customerPhone,
    customerEmail: input.customer.email ?? null,
    lines,
    subtotal,
    discount,
    shippingMethod: rate.shipping_method,
    shippingCost: rate.cost,
    shippingGovernorate: input.shipping.governorate,
    shippingAddress: `${input.shipping.recipient_name}, ${input.shipping.address_line}${input.shipping.city ? `, ${input.shipping.city}` : ""} (${shipPhone})`,
    paymentMethod: input.payment.method,
    paymentReference: input.payment.method === "cod" ? null : (input.payment.reference ?? null),
    total,
  };
}

interface KeyRow {
  key: string;
  store_id: string;
  order_id: string | null;
  request_hash: string;
}

async function loadOrder(
  db: D1Database,
  storeId: string,
  orderId: string
): Promise<{ order: CheckoutOrderRow; items: CheckoutItemRow[] } | null> {
  const order = await db
    .prepare(
      `SELECT id, store_id, order_number, status, subtotal, discount, total,
              payment_method, payment_status, payment_reference, tracking_number,
              customer_name, customer_phone, shipping_method, shipping_cost,
              shipping_governorate, shipping_address
         FROM orders WHERE store_id = ? AND id = ?`
    )
    .bind(storeId, orderId)
    .first<CheckoutOrderRow>();
  if (!order) return null;
  const items = await db
    .prepare(
      "SELECT id, product_name, quantity, unit_price, line_total FROM order_items WHERE store_id = ? AND order_id = ? ORDER BY rowid"
    )
    .bind(storeId, orderId)
    .all<CheckoutItemRow>();
  return { order, items: items.results ?? [] };
}

export async function checkout(
  db: D1Database,
  storeId: string,
  input: CheckoutInput,
  rawKey: string | null,
  nowIso: string = touch()
): Promise<CheckoutResult> {
  // Client-supplied key or server-generated (no dedup benefit, documented).
  const key = rawKey ?? `srv-${uuidv7()}`;
  if (rawKey !== null && !KEY_RE.test(rawKey)) {
    throw new AppError("invalid_idempotency_key", 400, "Invalid idempotency key.");
  }
  const requestHash = await sha256Hex(canonicalJson(input));

  // Store-scoped lookup (PRIMARY KEY (store_id, key) since 0007): the same
  // key string in another store is an independent row, never a conflict.
  const existing = await db
    .prepare("SELECT key, store_id, order_id, request_hash FROM idempotency_keys WHERE store_id = ? AND key = ?")
    .bind(storeId, key)
    .first<KeyRow>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError("idempotency_conflict", 422, "Idempotency key was already used differently.");
    }
    if (existing.order_id === null) {
      throw new AppError("conflict", 409, "Checkout is already being processed.");
    }
    const replay = await loadOrder(db, storeId, existing.order_id);
    if (!replay) {
      throw new AppError("internal", 500, "Something went wrong.");
    }
    return { ...replay, replayed: true };
  }

  const r = await resolveCheckout(db, storeId, input);
  const orderId = uuidv7();
  const itemIds = r.lines.map(() => uuidv7());

  const trackedCount = r.lines.filter((l) => l.tracked).length;
  const statements = [
    ...r.lines
      .filter((l) => l.tracked)
      .map((l) =>
        db
          .prepare(
            "UPDATE products SET stock_quantity = stock_quantity - ? WHERE store_id = ? AND id = ? AND stock_quantity IS NOT NULL AND stock_quantity >= ?"
          )
          .bind(l.quantity, storeId, l.product_id, l.quantity)
      ),
    db
      .prepare("UPDATE stores SET order_counter = order_counter + 1 WHERE id = ? RETURNING order_counter")
      .bind(storeId),
    buildUpsertCustomer(
      db,
      storeId,
      { name: r.customerName, phone: r.customerPhone, email: r.customerEmail },
      nowIso
    ),
    db
      .prepare(
        `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, discount, total,
                             payment_method, payment_status, payment_reference,
                             customer_name, customer_phone, shipping_method, shipping_cost,
                             shipping_governorate, shipping_address, created_at, updated_at)
         SELECT ?, ?, c.id, (SELECT order_counter FROM stores WHERE id = ?),
                ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM customers c WHERE c.store_id = ? AND c.phone = ?`
      )
      .bind(
        orderId, storeId, storeId,
        r.subtotal, r.discount, r.total,
        r.paymentMethod, r.paymentReference,
        r.customerName, r.customerPhone, r.shippingMethod, r.shippingCost,
        r.shippingGovernorate, r.shippingAddress, nowIso, nowIso,
        storeId, r.customerPhone
      ),
    ...r.lines.map((l, i) =>
      db
        .prepare(
          `INSERT INTO order_items (id, store_id, order_id, product_id, quantity, product_name, selected_options, unit_price, line_total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          itemIds[i], storeId, orderId, l.product_id, l.quantity,
          l.product_name, l.selected_options, l.unit_price, l.line_total, nowIso, nowIso
        )
    ),
    db
      .prepare("INSERT INTO idempotency_keys (key, store_id, order_id, request_hash, status) VALUES (?, ?, ?, ?, 'completed')")
      .bind(key, storeId, orderId, requestHash),
  ];

  let results;
  try {
    results = await db.batch(statements);
  } catch (err) {
    // Failure diagnosis, cheapest decisive check first (store-scoped like the
    // pre-check above: another store's identical key must never replay here).
    const raced = await db
      .prepare("SELECT key, store_id, order_id, request_hash FROM idempotency_keys WHERE store_id = ? AND key = ?")
      .bind(storeId, key)
      .first<KeyRow>();
    if (raced && raced.request_hash === requestHash && raced.order_id !== null) {
      const replay = await loadOrder(db, storeId, raced.order_id);
      if (replay) return { ...replay, replayed: true };
    }
    // Product/rate retired between resolve and commit surfaces here with Pc precision.
    try {
      await resolveCheckout(db, storeId, input);
    } catch (resolveErr) {
      if (resolveErr instanceof AppError) throw resolveErr;
    }
    // Stock shortfall (CHECK abort): the decrement never happened, nothing skipped.
    const stocks = await db
      .prepare(
        `SELECT id, stock_quantity FROM products WHERE store_id = ? AND id IN (${r.lines.map(() => "?").join(",")})`
      )
      .bind(storeId, ...r.lines.map((l) => l.product_id))
      .all<{ id: string; stock_quantity: number | null }>();
    const byId = new Map((stocks.results ?? []).map((s) => [s.id, s.stock_quantity]));
    for (const l of r.lines) {
      const s = byId.get(l.product_id);
      if (s !== null && s !== undefined && s < l.quantity) {
        throw new AppError("insufficient_stock", 409, "Insufficient stock for an item in the order.");
      }
    }
    throw err;
  }

  // Atomic-predicate backstop (roadmap B13-L12): each decrement above carries
  // `AND stock_quantity >= ?`, so a shortfall that raced in after resolve
  // updates zero rows instead of overselling. Overall batch success does not
  // imply every row moved, so verify per-statement changes here; on a miss,
  // compensate exactly like the retired-mid-flight guard below (the order row
  // already exists) and keep the existing insufficient_stock 409. The
  // idempotency row goes too — otherwise a same-key retry would hit a
  // dangling order_id and 500 instead of re-attempting deterministically.
  const decrements = results.slice(0, trackedCount) as unknown as {
    meta?: { changes?: number | null };
  }[];
  if (decrements.some((d) => (d.meta?.changes ?? 0) < 1)) {
    await db.batch([
      db.prepare("DELETE FROM orders WHERE store_id = ? AND id = ?").bind(storeId, orderId),
      db.prepare("DELETE FROM idempotency_keys WHERE store_id = ? AND key = ? AND order_id = ?").bind(storeId, key, orderId),
    ]);
    throw new AppError("insufficient_stock", 409, "Insufficient stock for an item in the order.");
  }

  // Wire-proof: the RETURNING counter must equal the stored order number.
  // Mismatch is impossible by construction; if it ever fires, shout.
  // (Counter UPDATE is statement index [trackedCount]: after the stock updates.)
  const returned = (
    results[trackedCount] as unknown as { results?: { order_counter?: unknown }[] }
  )?.results?.[0]?.order_counter;
  const created = await loadOrder(db, storeId, orderId);
  if (!created) {
    throw new AppError("internal", 500, "Something went wrong.");
  }
  if (Number(returned) !== created.order.order_number) {
    console.error(`counter_mismatch store=${storeId} order=${orderId}`);
    throw new AppError("internal", 500, "Something went wrong.");
  }

  // Retired-mid-flight guard: a product retired/deactivated between resolve
  // and commit would otherwise sell. Re-resolve purchasability; on violation
  // delete the just-created order (items + key cascade) and 409.
  try {
    await resolveCheckoutPurchasable(db, storeId, r.lines.map((l) => l.product_id));
  } catch (guardErr) {
    await db.batch([
      db.prepare("DELETE FROM orders WHERE store_id = ? AND id = ?").bind(storeId, orderId),
    ]);
    if (guardErr instanceof AppError) throw guardErr;
    throw new AppError("product_unavailable", 409, "A product in the order is unavailable.");
  }

  return { ...created, replayed: false };
}

async function resolveCheckoutPurchasable(
  db: D1Database,
  storeId: string,
  productIds: string[]
): Promise<void> {
  if (productIds.length === 0) return;
  const placeholders = productIds.map(() => "?").join(",");
  const found = await db
    .prepare(
      `SELECT id FROM products WHERE store_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL AND is_active = 1`
    )
    .bind(storeId, ...productIds)
    .all<{ id: string }>();
  if ((found.results ?? []).length !== productIds.length) {
    throw new AppError("product_unavailable", 409, "A product in the order is unavailable.");
  }
}
