import type { Context, Next } from "hono";
import { getDb } from "../db.js";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";
import { auditLog } from "../lib/audit.js";
import { currentUser } from "./auth.js";

export interface StoreRow {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  currency: string;
  status: string;
}

// resolveStore: path param -> stores row -> trusted context. Runs WITHOUT
// requiring auth so future public routes (B5 reads) can reuse it. Sets ONLY
// the database's own id (never the raw param string beyond lookup).
// Unknown id -> 404. No ownership decision here (see requireStoreAccess).
export async function resolveStore(
  c: Context<AppEnv>,
  next: Next
): Promise<void> {
  const rawId = c.req.param("storeId");
  const row = await getDb(c)
    .prepare(
      "SELECT id, owner_id, slug, name, currency, status FROM stores WHERE id = ?"
    )
    .bind(rawId)
    .first<StoreRow>();
  if (row === null) {
    throw new AppError("store_not_found", 404, "Store not found.");
  }
  c.set("storeId", row.id);
  await next();
}

// requireStoreAccess: owner of the resolved store, or admin. Foreign stores
// answer IDENTICALLY to missing stores (404 store_not_found) so ids cannot
// be probed for existence (no oracle). Admin cross-store reads succeed but
// are audit-logged.
export async function requireStoreAccess(
  c: Context<AppEnv>,
  next: Next
): Promise<void> {
  const user = currentUser(c);
  if (!user) {
    throw new AppError("unauthorized", 401, "Authentication required.");
  }
  const storeId = c.get("storeId");
  const row = await getDb(c)
    .prepare("SELECT id, owner_id, slug, name, currency, status FROM stores WHERE id = ?")
    .bind(storeId)
    .first<StoreRow>();
  if (row === null || (row.owner_id !== user.id && user.role !== "admin")) {
    // Same shape as resolveStore's miss: existence and ownership stay hidden.
    throw new AppError("store_not_found", 404, "Store not found.");
  }
  if (row.owner_id !== user.id) {
    auditLog("admin.store.read", { actor: user.id, store: row.id, result: "ok" });
  }
  await next();
}
