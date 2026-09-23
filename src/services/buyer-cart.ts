import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Server carts (P4). Guest carts are capability-addressed (unguessable uuid,
// customer_id NULL); account carts are resolved per (store, customer).
// 30-day TTL, sliding on write. Stock is NOT reserved: availability is
// re-validated inside the atomic checkout batch. Consumption is a CAS claim
// (checked_out_at IS NULL): exactly one checkout wins a cart; a failed
// checkout unclaims best-effort so the buyer keeps their cart.

export const CART_TTL_MS = 30 * 24 * 3600 * 1000;
export const CART_MAX_QTY = 999;

export interface CartRow {
  id: string;
  store_id: string;
  customer_id: string | null;
  expires_at: string;
  checked_out_at: string | null;
}

export interface CartLine {
  id: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
}

function expiryIso(nowMs: number = Date.now()): string {
  return new Date(nowMs + CART_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function createCart(
  db: D1Database,
  storeId: string,
  customerId: string | null,
  nowIso: string = touch()
): Promise<CartRow> {
  const row = await db
    .prepare(
      "INSERT INTO carts (id, store_id, customer_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, store_id, customer_id, expires_at, checked_out_at"
    )
    .bind(uuidv7(), storeId, customerId, expiryIso(), nowIso, nowIso)
    .first<CartRow>();
  if (!row) throw new AppError("conflict", 409, "Could not create cart.");
  return row;
}

async function liveCart(
  db: D1Database,
  storeId: string,
  cartId: string,
  nowIso: string = touch()
): Promise<CartRow> {
  const row = await db
    .prepare("SELECT id, store_id, customer_id, expires_at, checked_out_at FROM carts WHERE id = ? AND store_id = ?")
    .bind(cartId, storeId)
    .first<CartRow>();
  // Missing, foreign, expired, or already consumed: identical 404, no oracle.
  if (!row || row.expires_at <= nowIso || row.checked_out_at !== null) {
    throw new AppError("cart_not_found", 404, "Cart not found or expired.");
  }
  return row;
}

export async function getCartLines(db: D1Database, cartId: string): Promise<CartLine[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.product_id, p.name AS product_name, p.price AS unit_price, i.quantity
       FROM cart_items i JOIN products p ON p.id = i.product_id
       WHERE i.cart_id = ? ORDER BY i.created_at ASC`
    )
    .bind(cartId)
    .all<CartLine>();
  return results ?? [];
}

export async function getCart(
  db: D1Database,
  storeId: string,
  cartId: string,
  nowIso: string = touch()
): Promise<{ cart: CartRow; items: CartLine[] }> {
  const cart = await liveCart(db, storeId, cartId, nowIso);
  return { cart, items: await getCartLines(db, cartId) };
}

async function assertSellableProduct(db: D1Database, storeId: string, productId: string): Promise<void> {
  // Same sellability rule as the storefront (P2): live rows only
  // (deleted_at IS NULL, is_active = 1). The store itself is resolved
  // published upstream; stock is re-validated inside the checkout batch.
  const p = await db
    .prepare("SELECT is_active FROM products WHERE id = ? AND store_id = ? AND deleted_at IS NULL")
    .bind(productId, storeId)
    .first<{ is_active: number }>();
  if (!p || p.is_active !== 1) {
    throw new AppError("product_unavailable", 409, "Product is not available.");
  }
}

export async function addCartItem(
  db: D1Database,
  storeId: string,
  cartId: string,
  productId: string,
  quantity: number,
  nowIso: string = touch()
): Promise<{ cart: CartRow; items: CartLine[] }> {
  const cart = await liveCart(db, storeId, cartId, nowIso);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > CART_MAX_QTY) {
    throw new AppError("invalid_quantity", 400, "Quantity must be 1..999.");
  }
  await assertSellableProduct(db, storeId, productId);
  const line = await db
    .prepare("SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?")
    .bind(cartId, productId)
    .first<{ id: string; quantity: number }>();
  const next = (line?.quantity ?? 0) + quantity;
  if (next > CART_MAX_QTY) {
    throw new AppError("quantity_exceeded", 422, "Line quantity cannot exceed 999.");
  }
  if (line) {
    await db.prepare("UPDATE cart_items SET quantity = ? WHERE id = ?").bind(next, line.id).run();
  } else {
    await db
      .prepare("INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES (?, ?, ?, ?)")
      .bind(uuidv7(), cartId, productId, quantity)
      .run();
  }
  await db
    .prepare("UPDATE carts SET expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(expiryIso(), nowIso, cartId)
    .run();
  return { cart, items: await getCartLines(db, cartId) };
}

export async function setCartItemQty(
  db: D1Database,
  storeId: string,
  cartId: string,
  itemId: string,
  quantity: number,
  nowIso: string = touch()
): Promise<{ cart: CartRow; items: CartLine[] }> {
  const cart = await liveCart(db, storeId, cartId, nowIso);
  const line = await db
    .prepare("SELECT id FROM cart_items WHERE id = ? AND cart_id = ?")
    .bind(itemId, cartId)
    .first<{ id: string }>();
  if (!line) throw new AppError("cart_item_not_found", 404, "Cart item not found.");
  if (quantity === 0) {
    await db.prepare("DELETE FROM cart_items WHERE id = ?").bind(itemId).run();
  } else {
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > CART_MAX_QTY) {
      throw new AppError("invalid_quantity", 400, "Quantity must be 0..999.");
    }
    await db.prepare("UPDATE cart_items SET quantity = ? WHERE id = ?").bind(quantity, itemId).run();
  }
  await db
    .prepare("UPDATE carts SET expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(expiryIso(), nowIso, cartId)
    .run();
  return { cart, items: await getCartLines(db, cartId) };
}

export async function accountCart(
  db: D1Database,
  storeId: string,
  customerId: string,
  nowIso: string = touch()
): Promise<CartRow> {
  const existing = await db
    .prepare(
      "SELECT id, store_id, customer_id, expires_at, checked_out_at FROM carts WHERE store_id = ? AND customer_id = ? AND expires_at > ? AND checked_out_at IS NULL ORDER BY updated_at DESC LIMIT 1"
    )
    .bind(storeId, customerId, nowIso)
    .first<CartRow>();
  if (existing) return existing;
  return createCart(db, storeId, customerId, nowIso);
}

export async function mergeGuestCart(
  db: D1Database,
  storeId: string,
  customerId: string,
  guestCartId: string,
  nowIso: string = touch()
): Promise<{ cart: CartRow; items: CartLine[] }> {
  const guest = await liveCart(db, storeId, guestCartId, nowIso);
  if (guest.customer_id !== null) {
    throw new AppError("forbidden", 403, "Only guest carts can be merged.");
  }
  const target = await accountCart(db, storeId, customerId, nowIso);
  if (target.id === guest.id) return { cart: target, items: await getCartLines(db, target.id) };
  const guestLines = await getCartLines(db, guest.id);
  for (const line of guestLines) {
    const mine = await db
      .prepare("SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?")
      .bind(target.id, line.product_id)
      .first<{ id: string; quantity: number }>();
    const next = (mine?.quantity ?? 0) + line.quantity;
    if (next > CART_MAX_QTY) {
      throw new AppError("quantity_exceeded", 422, "Merged line quantity cannot exceed 999.");
    }
    if (mine) {
      await db.prepare("UPDATE cart_items SET quantity = ? WHERE id = ?").bind(next, mine.id).run();
    } else {
      await db
        .prepare("INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES (?, ?, ?, ?)")
        .bind(uuidv7(), target.id, line.product_id, line.quantity)
        .run();
    }
  }
  await db.prepare("DELETE FROM carts WHERE id = ?").bind(guest.id).run();
  return { cart: target, items: await getCartLines(db, target.id) };
}

// CAS-consumes a cart for checkout. Returns lines shaped as checkout items;
// availability/stock is enforced by the atomic checkout batch itself.
export async function claimCart(
  db: D1Database,
  storeId: string,
  cartId: string,
  nowIso: string = touch()
): Promise<{ product_id: string; quantity: number }[]> {
  const claimed = await db
    .prepare(
      "UPDATE carts SET checked_out_at = ? WHERE id = ? AND store_id = ? AND expires_at > ? AND checked_out_at IS NULL"
    )
    .bind(nowIso, cartId, storeId, nowIso)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    throw new AppError("cart_not_found", 404, "Cart not found, expired, or already checked out.");
  }
  const lines = await getCartLines(db, cartId);
  if (lines.length === 0) {
    await db.prepare("UPDATE carts SET checked_out_at = NULL WHERE id = ?").bind(cartId).run();
    throw new AppError("cart_empty", 422, "Cart is empty.");
  }
  return lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity }));
}

export async function unclaimCart(db: D1Database, cartId: string): Promise<void> {
  await db.prepare("UPDATE carts SET checked_out_at = NULL WHERE id = ?").bind(cartId).run();
}
