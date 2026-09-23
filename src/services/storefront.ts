import type { D1Database } from "@cloudflare/workers-types";

// Public storefront reads (P2, path scheme). Iron rules:
// - Published stores only: every query carries is_published = 1, so drafts
//   are invisible without a separate code path that could drift.
// - Published rows only: live products (deleted_at IS NULL, is_active = 1),
//   active categories. Retired/hidden rows never leave the server.
// - No PII, no prices beyond the published row itself, no auth required.
// - Tenant scope still comes from the URL via middleware (resolvePublished
//   helpers); services take explicit storeId like every other service.

export interface PublicStore {
  id: string;
  slug: string;
  name: string;
  currency: string;
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
}

export interface PublicProduct {
  id: string;
  category_id: string | null;
  name: string;
  slug: string;
  price: number;
  stock_quantity: number | null;
}

export async function getPublicStore(
  db: D1Database,
  storeId: string
): Promise<PublicStore | null> {
  return db
    .prepare(
      "SELECT id, slug, name, currency FROM stores WHERE id = ? AND is_published = 1"
    )
    .bind(storeId)
    .first<PublicStore>();
}

export async function listPublishedCategories(
  db: D1Database,
  storeId: string
): Promise<PublicCategory[]> {
  const res = await db
    .prepare(
      `SELECT id, name, slug, parent_id, sort_order FROM categories
        WHERE store_id = ? AND is_active = 1 ORDER BY sort_order, name`
    )
    .bind(storeId)
    .all<PublicCategory>();
  return res.results ?? [];
}

export async function listPublishedProducts(
  db: D1Database,
  storeId: string
): Promise<PublicProduct[]> {
  const res = await db
    .prepare(
      `SELECT id, category_id, name, slug, price, stock_quantity FROM products
        WHERE store_id = ? AND deleted_at IS NULL AND is_active = 1
        ORDER BY name`
    )
    .bind(storeId)
    .all<PublicProduct>();
  return res.results ?? [];
}
