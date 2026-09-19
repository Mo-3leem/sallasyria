import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { touch } from "../lib/time.js";
import type { CheckoutItemRow, CheckoutOrderRow } from "./checkout.js";

// Order reads + explicit state machines (roadmap B6). History is append-only
// in spirit: snapshots are never rewritten; status/payment move only along
// the maps below; terminal states are final. No other transition exists.

// Pending work arrives human-verified; shipped implies handed to courier;
// delivered/paid etc. follow the money and the truck, not client wishes.
const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

const PAYMENT_TRANSITIONS: Record<string, string[]> = {
  pending: ["paid", "failed"],
  paid: ["refunded"],
  failed: ["paid"],
  refunded: [],
};

export async function getOrder(
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

export async function listOrders(db: D1Database, storeId: string): Promise<CheckoutOrderRow[]> {
  const res = await db
    .prepare(
      `SELECT id, store_id, order_number, status, subtotal, discount, total,
              payment_method, payment_status, payment_reference, tracking_number,
              customer_name, customer_phone, shipping_method, shipping_cost,
              shipping_governorate, shipping_address
         FROM orders WHERE store_id = ? ORDER BY created_at DESC`
    )
    .bind(storeId)
    .all<CheckoutOrderRow>();
  return res.results ?? [];
}

export async function transitionOrderStatus(
  db: D1Database,
  storeId: string,
  orderId: string,
  to: string,
  nowIso: string = touch()
): Promise<CheckoutOrderRow | null> {
  const current = await getOrder(db, storeId, orderId);
  if (!current) return null;
  const allowed = ORDER_TRANSITIONS[current.order.status] ?? [];
  if (!allowed.includes(to)) {
    throw new AppError("invalid_transition", 409, "Order status transition is not allowed.");
  }
  // Compare-and-swap: the expected current status rides in the WHERE clause
  // so a concurrent transition that moved the row first makes this UPDATE a
  // no-op instead of a silent last-writer-wins overwrite.
  const applied = await db
    .prepare("UPDATE orders SET status = ?, updated_at = ? WHERE store_id = ? AND id = ? AND status = ?")
    .bind(to, nowIso, storeId, orderId, current.order.status)
    .run();
  if ((applied.meta.changes ?? 0) === 0) {
    throw new AppError("invalid_transition", 409, "Order status transition is not allowed.");
  }
  const updated = await getOrder(db, storeId, orderId);
  if (!updated) throw new AppError("internal", 500, "Something went wrong.");
  return updated.order;
}

export async function transitionPaymentStatus(
  db: D1Database,
  storeId: string,
  orderId: string,
  to: string,
  nowIso: string = touch()
): Promise<CheckoutOrderRow | null> {
  const current = await getOrder(db, storeId, orderId);
  if (!current) return null;
  const allowed = PAYMENT_TRANSITIONS[current.order.payment_status] ?? [];
  if (!allowed.includes(to)) {
    throw new AppError("invalid_transition", 409, "Payment status transition is not allowed.");
  }
  // Compare-and-swap, same rationale as transitionOrderStatus above.
  const applied = await db
    .prepare("UPDATE orders SET payment_status = ?, updated_at = ? WHERE store_id = ? AND id = ? AND payment_status = ?")
    .bind(to, nowIso, storeId, orderId, current.order.payment_status)
    .run();
  if ((applied.meta.changes ?? 0) === 0) {
    throw new AppError("invalid_transition", 409, "Payment status transition is not allowed.");
  }
  const updated = await getOrder(db, storeId, orderId);
  if (!updated) throw new AppError("internal", 500, "Something went wrong.");
  return updated.order;
}
