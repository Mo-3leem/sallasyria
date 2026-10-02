import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Store data access (roadmap B3). Type-level tenant boundary: every function
// takes explicit ids (storeId / ownerId) — never a Hono Context — so route
// code cannot smuggle client input into scoping. All SQL lives here; routes
// contain zero SQL strings (enforced by tests/tenant-conventions.test.ts).

export interface StorePublic {
  id: string;
  slug: string;
  name: string;
  currency: string;
  status: string;
  is_published: number;
}

const PUBLIC_COLUMNS = "id, slug, name, currency, status, is_published";
// NOTE: order_counter is deliberately NEVER selected (counter oracle).

export async function listStoresForOwner(
  db: D1Database,
  ownerId: string
): Promise<StorePublic[]> {
  const res = await db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM stores WHERE owner_id = ? ORDER BY created_at`)
    .bind(ownerId)
    .all<StorePublic>();
  return res.results ?? [];
}

export async function listAllStores(db: D1Database): Promise<StorePublic[]> {
  const res = await db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM stores ORDER BY created_at`)
    .all<StorePublic>();
  return res.results ?? [];
}

export interface StoreCreate {
  slug: string;
  name: string;
  currency?: string;
}

// Merchant self-service store creation (MVP): owner_id is a function
// argument supplied by the route from the SESSION — never from client input
// (the route 400s owner_id/store_id/id in the raw body on top of this).
// No one-store-per-merchant rule exists or is added: the schema's only store
// uniqueness is the global slug (uq_stores_slug), mapped here to a
// client-safe 409 (residual-race pattern mirrors services/catalog.ts).
// status/order_counter ride their DB defaults ('active'/1000).
export async function createStore(
  db: D1Database,
  ownerId: string,
  input: StoreCreate,
  nowIso: string = touch()
): Promise<StorePublic> {
  const id = uuidv7();
  try {
    await db
      .prepare(
        "INSERT INTO stores (id, owner_id, slug, name, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, ownerId, input.slug, input.name, input.currency ?? "SYP", nowIso, nowIso)
      .run();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(text)) {
      throw new AppError("slug_taken", 409, "Slug is already in use.");
    }
    throw err;
  }
  const row = await db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM stores WHERE id = ?`)
    .bind(id)
    .first<StorePublic>();
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}
// Store visibility toggle (POST /stores/:storeId/publish). Single writer of
// is_published: sets the flag (0 draft / 1 published) and bumps updated_at.
// Callers resolve authorization via requireStoreAccess; this function takes
// only the resolved storeId plus the validated flag — never raw client scope.
export async function setStorePublished(
  db: D1Database,
  storeId: string,
  isPublished: 0 | 1,
  nowIso: string = touch()
): Promise<StorePublic | null> {
  const current = await getStoreById(db, storeId);
  if (!current) return null;
  if (current.is_published === isPublished) return current;
  await db
    .prepare("UPDATE stores SET is_published = ?, updated_at = ? WHERE id = ?")
    .bind(isPublished, nowIso, storeId)
    .run();
  return getStoreById(db, storeId);
}

// null only in the impossible case (deleted between middlewares) — callers
// map that to 404, never to an unscoped read.
export async function getStoreById(
  db: D1Database,
  storeId: string
): Promise<StorePublic | null> {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM stores WHERE id = ?`)
    .bind(storeId)
    .first<StorePublic>();
}

// Owner lookup for audit branching (data access, not authorization — the
// allow/deny decision stays in requireStoreAccess).
export async function getStoreOwner(
  db: D1Database,
  storeId: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT owner_id FROM stores WHERE id = ?")
    .bind(storeId)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
}

// Admin store deletion for the merchant-management flow. No cascade is
// introduced here: dependent rows governed by ON DELETE CASCADE in the
// schema (categories, products, customers, addresses, carts, billing,
// themes, shipping) disappear with the store exactly as the schema
// defines, while RESTRICT-protected history is pre-checked below and
// reported as explicit 409s. Anything else that still blocks the delete
// surfaces as a generic dependents 409 — never a raw database error.
export async function deleteStoreByAdmin(
  db: D1Database,
  merchantId: string,
  storeId: string
): Promise<{ deleted: string }> {
  const owner = await getStoreOwner(db, storeId);
  if (owner === null) {
    throw new AppError("store_not_found", 404, "Store not found.");
  }
  // Cross-merchant guard: the store must belong to a merchant account and
  // to the selected one. Anything else answers identically to missing.
  const ownerRow = await db
    .prepare("SELECT role FROM users WHERE id = ?")
    .bind(owner)
    .first<{ role: string }>();
  if (!ownerRow || ownerRow.role !== "merchant" || owner !== merchantId) {
    throw new AppError("store_not_found", 404, "Store not found.");
  }
  const order = await db
    .prepare("SELECT 1 AS ok FROM orders WHERE store_id = ? LIMIT 1")
    .bind(storeId)
    .first<{ ok: number }>();
  if (order) {
    throw new AppError("store_has_orders", 409, "Store has orders and cannot be removed.");
  }
  const sub = await db
    .prepare("SELECT 1 AS ok FROM subscriptions WHERE store_id = ? LIMIT 1")
    .bind(storeId)
    .first<{ ok: number }>();
  if (sub) {
    throw new AppError("store_has_subscriptions", 409, "Store has subscriptions and cannot be removed.");
  }
  try {
    const res = await db
      .prepare("DELETE FROM stores WHERE id = ? AND owner_id = ?")
      .bind(storeId, merchantId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      throw new AppError("store_not_found", 404, "Store not found.");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const text = err instanceof Error ? err.message : String(err);
    if (/FOREIGN KEY constraint failed/i.test(text)) {
      throw new AppError("store_has_dependents", 409, "Store has dependent data and cannot be removed.");
    }
    throw err;
  }
  return { deleted: storeId };
}

export interface StorePatch {
  name?: string;
  slug?: string;
  currency?: string;
  status?: "active" | "paused" | "archived";
}

// General store-settings update (PATCH /stores/:storeId). Whitelist =
// { name, slug, currency, status } enforced by the route's zod schema plus
// its immutable-field guard (id/owner_id/store_id/order_counter/created_at
// never reach here). Status is constrained to the schema CHECK values by
// the route's enum validation. Slug is globally unique: an unchanged slug
// is a no-op, a taken slug is a 409 pre-check, and the UNIQUE index stays
// the race backstop (pattern mirrors createStore above).
export async function updateStore(
  db: D1Database,
  storeId: string,
  patch: StorePatch,
  nowIso: string = touch()
): Promise<StorePublic | null> {
  const current = await getStoreById(db, storeId);
  if (!current) return null;
  const next = {
    name: patch.name ?? current.name,
    slug: patch.slug ?? current.slug,
    currency: patch.currency ?? current.currency,
    status: patch.status ?? current.status,
  };
  if (next.slug !== current.slug) {
    const clash = await db
      .prepare("SELECT 1 AS ok FROM stores WHERE slug = ? AND id != ?")
      .bind(next.slug, storeId)
      .first<{ ok: number }>();
    if (clash) throw new AppError("slug_taken", 409, "Slug is already in use.");
  }
  try {
    await db
      .prepare("UPDATE stores SET name = ?, slug = ?, currency = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(next.name, next.slug, next.currency, next.status, nowIso, storeId)
      .run();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(text)) {
      throw new AppError("slug_taken", 409, "Slug is already in use.");
    }
    throw err;
  }
  return getStoreById(db, storeId);
}
