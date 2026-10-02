import type { D1Database } from "@cloudflare/workers-types";
import { encodeCursor, type PageCursor } from "../lib/pagination.js";
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

export type OrderStatusFilter =
  | "pending"
  | "confirmed"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";

export interface OrderPage {
  orders: CheckoutOrderRow[];
  total: number;
}

const ORDER_LIST_COLUMNS = `id, store_id, order_number, status, subtotal, discount, total,
              payment_method, payment_status, payment_reference, tracking_number,
              customer_name, customer_phone, shipping_method, shipping_cost,
              shipping_governorate, shipping_address`;

// Merchant order list (roadmap B11): store-scoped, optional server-side
// status filter, deterministic newest-first ordering with id tie-break,
// offset page + filtered total from the same predicates.
export async function listOrders(
  db: D1Database,
  storeId: string,
  opts: { status?: OrderStatusFilter | null; page: number; pageSize: number }
): Promise<OrderPage> {
  const args: unknown[] = [storeId];
  let where = "WHERE store_id = ?";
  if (opts.status != null) {
    where += " AND status = ?";
    args.push(opts.status);
  }
  const offset = (opts.page - 1) * opts.pageSize;
  const res = await db
    .prepare(
      `SELECT ${ORDER_LIST_COLUMNS} FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .bind(...args, opts.pageSize, offset)
    .all<CheckoutOrderRow>();
  const counted = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders ${where}`)
    .bind(...args)
    .first<{ n: number }>();
  return { orders: res.results ?? [], total: counted?.n ?? 0 };
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

// Buyer notification target for a CAS-applied transition: the customer email
// on file (null when the buyer never gave one — callers skip, never
// fabricate) plus store + order context for the message.
export interface OrderNotifyTarget {
  email: string | null;
  orderNumber: number;
  storeName: string;
}

export async function orderNotifyTarget(
  db: D1Database,
  storeId: string,
  orderId: string
): Promise<OrderNotifyTarget | null> {
  const row = await db
    .prepare(
      `SELECT o.order_number AS orderNumber, c.email AS email, s.name AS storeName
         FROM orders o
         JOIN stores s ON s.id = o.store_id
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.store_id = ? AND o.id = ?`
    )
    .bind(storeId, orderId)
    .first<OrderNotifyTarget>();
  return row ?? null;
}

export interface CustomerOrderPage {
  orders: CheckoutOrderRow[];
  nextCursor: string | null;
}

// Buyer order history (roadmap B11): one account only, newest first with id
// tie-break, opaque keyset cursor. The store+customer predicates always
// apply — the cursor positions, never authorizes.
export async function listCustomerOrders(
  db: D1Database,
  storeId: string,
  customerId: string,
  opts: { cursor: PageCursor | null; limit: number }
): Promise<CustomerOrderPage> {
  const args: unknown[] = [storeId, customerId];
  let keyset = "";
  if (opts.cursor !== null) {
    keyset = " AND (created_at < ? OR (created_at = ? AND id < ?))";
    args.push(opts.cursor.c, opts.cursor.c, opts.cursor.id);
  }
  const res = await db
    .prepare(
      `SELECT id, store_id, order_number, status, subtotal, discount, total,
              payment_method, payment_status, payment_reference, tracking_number,
              customer_name, customer_phone, shipping_method, shipping_cost,
              shipping_governorate, shipping_address, created_at
         FROM orders WHERE store_id = ? AND customer_id = ?${keyset} ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(...args, opts.limit + 1)
    .all<CheckoutOrderRow & { created_at: string }>();
  const rows = res.results ?? [];
  const page = rows.slice(0, opts.limit);
  const nextCursor =
    rows.length > opts.limit
      ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.id)
      : null;
  return { orders: page, nextCursor };
}
