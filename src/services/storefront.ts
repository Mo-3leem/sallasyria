import type { D1Database } from "@cloudflare/workers-types";
import { encodeCursor, type PageCursor } from "../lib/pagination.js";

// Public storefront reads (P2, path scheme). Iron rules:
// - Active published stores only: every query carries is_published = 1 AND
//   status = 'active', so drafts AND paused/archived stores are invisible
//   without a separate code path that could drift.
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

export interface PublicProductImage {
  id: string;
  url: string;
  alt_text: string | null;
  sort_order: number;
}

export interface PublicProduct {
  id: string;
  category_id: string | null;
  name: string;
  slug: string;
  price: number;
  stock_quantity: number | null;
  images: PublicProductImage[];
}

export async function getPublicStore(
  db: D1Database,
  storeId: string
): Promise<PublicStore | null> {
  return db
    .prepare(
      "SELECT id, slug, name, currency FROM stores WHERE id = ? AND is_published = 1 AND status = 'active'"
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
    .all<Omit<PublicProduct, "images">>();
  return attachImages(db, storeId, res.results ?? []);
}
export interface PublishedProductPage {
  products: PublicProduct[];
  nextCursor: string | null;
}

// Cursor page over the published catalog (roadmap B11): deterministic
// (name, id) ordering with id tie-break, opaque keyset cursor. The store
// predicate always applies — the cursor positions, never authorizes.
// Images attach per page exactly like the full listing above.
export async function listPublishedProductsPage(
  db: D1Database,
  storeId: string,
  opts: { cursor: PageCursor | null; limit: number }
): Promise<PublishedProductPage> {
  const args: unknown[] = [storeId];
  let keyset = "";
  if (opts.cursor !== null) {
    keyset = " AND (name > ? OR (name = ? AND id > ?))";
    args.push(opts.cursor.c, opts.cursor.c, opts.cursor.id);
  }
  const res = await db
    .prepare(
      `SELECT id, category_id, name, slug, price, stock_quantity FROM products
        WHERE store_id = ? AND deleted_at IS NULL AND is_active = 1${keyset}
        ORDER BY name, id LIMIT ?`
    )
    .bind(...args, opts.limit + 1)
    .all<Omit<PublicProduct, "images">>();
  const rows = res.results ?? [];
  const page = rows.slice(0, opts.limit);
  const nextCursor =
    rows.length > opts.limit
      ? encodeCursor(page[page.length - 1]!.name, page[page.length - 1]!.id)
      : null;
  return { products: await attachImages(db, storeId, page), nextCursor };
}

async function attachImages(
  db: D1Database,
  storeId: string,
  products: Omit<PublicProduct, "images">[]
): Promise<PublicProduct[]> {
  if (products.length === 0) return [];
  // Live gallery rows only (retired images stay merchant-private), ordered
  // with the same sort_order/created_at rule as the merchant image list.
  // Attached strictly to the published products above, so images of
  // retired/hidden products can never leak through this payload.
  const liveIds = new Set(products.map((p) => p.id));
  const placeholders = products.map(() => "?").join(",");
  const imgs = await db
    .prepare(
      `SELECT id, product_id, url, alt_text, sort_order FROM product_images
        WHERE store_id = ? AND deleted_at IS NULL AND product_id IN (${placeholders})
        ORDER BY sort_order, created_at`
    )
    .bind(storeId, ...products.map((p) => p.id))
    .all<PublicProductImage & { product_id: string }>();
  const byProduct = new Map<string, PublicProductImage[]>();
  for (const img of imgs.results ?? []) {
    if (!liveIds.has(img.product_id)) continue;
    const list = byProduct.get(img.product_id) ?? [];
    list.push({
      id: img.id,
      url: img.url,
      alt_text: img.alt_text,
      sort_order: img.sort_order,
    });
    byProduct.set(img.product_id, list);
  }
  return products.map((p) => ({ ...p, images: byProduct.get(p.id) ?? [] }));
}
