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
}

const PUBLIC_COLUMNS = "id, slug, name, currency, status";
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

export async function renameStore(
  db: D1Database,
  storeId: string,
  name: string,
  nowIso: string = touch()
): Promise<StorePublic | null> {
  // Whitelist = { name } enforced by the route's zod schema; this function
  // accepts nothing else, so no caller can smuggle store_id/id/deleted_at.
  await db
    .prepare("UPDATE stores SET name = ?, updated_at = ? WHERE id = ?")
    .bind(name, nowIso, storeId)
    .run();
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM stores WHERE id = ?`)
    .bind(storeId)
    .first<StorePublic>();
}
