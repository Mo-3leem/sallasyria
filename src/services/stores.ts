import type { D1Database } from "@cloudflare/workers-types";
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

// Single-row fetch AFTER access was proven by requireStoreAccess: returns
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
