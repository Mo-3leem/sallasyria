import type { Context, Next } from "hono";
import { getDb } from "../db.js";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";
import { auditEvent } from "../services/audit.js";
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

// resolvePublishedStore: public-route twin of resolveStore for the
// path-based program (P1). Same fail-closed contract — unknown, missing,
// AND unpublished ids answer with an identical 404 (no oracle
// distinguishing "does not exist" from "exists but draft") — so future
// public catalog/checkout routes mount THIS instead of resolveStore.
// Merchant-private routes keep resolveStore: owners always manage their
// own drafts. Reads the flag in one query; no ownership decision here.
export async function resolvePublishedStore(
  c: Context<AppEnv>,
  next: Next
): Promise<void> {
  const rawId = c.req.param("storeId");
  const row = await getDb(c)
    .prepare(
      "SELECT id, is_published FROM stores WHERE id = ?"
    )
    .bind(rawId)
    .first<{ id: string; is_published: number }>();
  if (row === null || row.is_published !== 1) {
    throw new AppError("store_not_found", 404, "Store not found.");
  }
  c.set("storeId", row.id);
  await next();
}
// resolvePublishedStoreBySlug: same fail-closed contract keyed by slug
// for the storefront bootstrap (/stores/by-slug/:slug). Unknown, missing,
// and unpublished slugs answer identically (no oracle). Only the resolved
// id enters context — never the raw slug.
export async function resolvePublishedStoreBySlug(
  c: Context<AppEnv>,
  next: Next
): Promise<void> {
  const rawSlug = c.req.param("slug");
  const row = await getDb(c)
    .prepare(
      "SELECT id FROM stores WHERE slug = ? AND is_published = 1"
    )
    .bind(rawSlug)
    .first<{ id: string }>();
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
    await auditEvent(c, getDb(c),"admin.store.read", { actor: user.id, store: row.id, result: "ok" });
  }
  await next();
}
