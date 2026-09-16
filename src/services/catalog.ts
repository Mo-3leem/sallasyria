import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Catalog data access (roadmap B4). Type-level tenant boundary, same as
// stores service: every function takes explicit (db, storeId, ...) — never a
// Context — and all SQL lives here (routes contain zero SQL strings,
// enforced by tests/tenant-conventions.test.ts).
//
// Deviation handling (approved, DB track): composite FKs use RESTRICT where
// the document once said SET NULL, so the application performs explicit
// detach-then-delete flows (deleteCategory with detach=true). Products and
// images retire via soft-delete; there is intentionally NO hard-delete route
// in MVP (history preservation), hence no product/image cascade path to test
// at HTTP level.

// Residual constraint failures (pre-checks make them race-windows only, never
// the primary validation path) map to client-safe codes instead of 500s.
function mapCatalogError(err: unknown, slugCode: "slug_taken"): never {
  const text = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(text)) {
    throw new AppError(slugCode, 409, "Slug is already in use in this store.");
  }
  if (/FOREIGN KEY constraint failed/i.test(text)) {
    throw new AppError("conflict", 409, "Referenced record no longer exists.");
  }
  throw err;
}

export interface CategoryRow {
  id: string;
  store_id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  sort_order: number;
  is_active: number;
}

export interface ProductRow {
  id: string;
  store_id: string;
  category_id: string | null;
  name: string;
  slug: string;
  price: number;
  stock_quantity: number | null;
  is_active: number;
  deleted_at: string | null;
}

export interface ProductImageRow {
  id: string;
  store_id: string;
  product_id: string;
  url: string;
  alt_text: string | null;
  sort_order: number;
  deleted_at: string | null;
}

// ---------------------------------------------------------------- categories

async function categoryInStore(
  db: D1Database,
  storeId: string,
  categoryId: string | null
): Promise<boolean> {
  if (categoryId === null) return true;
  const row = await db
    .prepare("SELECT 1 AS ok FROM categories WHERE store_id = ? AND id = ?")
    .bind(storeId, categoryId)
    .first<{ ok: number }>();
  return row !== null;
}

export interface CategoryInput {
  name: string;
  slug: string;
  parent_id?: string | null;
  sort_order?: number;
  is_active?: number;
}

export async function createCategory(
  db: D1Database,
  storeId: string,
  input: CategoryInput,
  nowIso: string = touch()
): Promise<CategoryRow> {
  const parentId = input.parent_id ?? null;
  if (!(await categoryInStore(db, storeId, parentId))) {
    throw new AppError("parent_not_found", 404, "Parent category not found.");
  }
  const id = uuidv7();
  try {
    await db
      .prepare(
        `INSERT INTO categories (id, store_id, parent_id, name, slug, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, storeId, parentId, input.name, input.slug, input.sort_order ?? 0, input.is_active ?? 1, nowIso, nowIso)
      .run();
  } catch (err) {
    mapCatalogError(err, "slug_taken");
  }
  const row = await getCategory(db, storeId, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

export async function listCategories(db: D1Database, storeId: string): Promise<CategoryRow[]> {
  const res = await db
    .prepare("SELECT * FROM categories WHERE store_id = ? ORDER BY sort_order, created_at")
    .bind(storeId)
    .all<CategoryRow>();
  return res.results ?? [];
}

export async function getCategory(
  db: D1Database,
  storeId: string,
  id: string
): Promise<CategoryRow | null> {
  return db
    .prepare("SELECT * FROM categories WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .first<CategoryRow>();
}

export interface CategoryPatch {
  name?: string;
  slug?: string;
  parent_id?: string | null;
  sort_order?: number;
  is_active?: number;
}

export async function updateCategory(
  db: D1Database,
  storeId: string,
  id: string,
  patch: CategoryPatch,
  nowIso: string = touch()
): Promise<CategoryRow | null> {
  const current = await getCategory(db, storeId, id);
  if (!current) return null;
  const nextParent = patch.parent_id === undefined ? current.parent_id : patch.parent_id;
  if (nextParent !== null) {
    if (nextParent === id) {
      throw new AppError("invalid_parent", 400, "A category cannot be its own parent.");
    }
    if (!(await categoryInStore(db, storeId, nextParent))) {
      throw new AppError("parent_not_found", 404, "Parent category not found.");
    }
    // Cycle guard: walk ancestors with a cap; deeper chains are rejected
    // rather than risking unbounded traversal or cyclic trees downstream.
    let cursor: string | null = nextParent;
    for (let depth = 0; depth < 25; depth++) {
      if (cursor === id) {
        throw new AppError("invalid_parent", 400, "Parent assignment would create a cycle.");
      }
      const parent: { parent_id: string | null } | null = await db
        .prepare("SELECT parent_id FROM categories WHERE store_id = ? AND id = ?")
        .bind(storeId, cursor)
        .first<{ parent_id: string | null }>();
      cursor = parent?.parent_id ?? null;
      if (cursor === null) break;
    }
    if (cursor !== null) {
      throw new AppError("invalid_parent", 400, "Category nesting is too deep.");
    }
  }
  const next = {
    name: patch.name ?? current.name,
    slug: patch.slug ?? current.slug,
    parent_id: nextParent,
    sort_order: patch.sort_order ?? current.sort_order,
    is_active: patch.is_active ?? current.is_active,
  };
  try {
    await db
      .prepare(
        "UPDATE categories SET name = ?, slug = ?, parent_id = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE store_id = ? AND id = ?"
      )
      .bind(next.name, next.slug, next.parent_id, next.sort_order, next.is_active, nowIso, storeId, id)
      .run();
  } catch (err) {
    mapCatalogError(err, "slug_taken");
  }
  return getCategory(db, storeId, id);
}

// Explicit detach-then-delete (approved RESTRICT deviation): without detach,
// any assigned product or child category blocks with 409 has_dependents;
// with detach=true the app unassigns them in the SAME batch, then deletes.
export async function deleteCategory(
  db: D1Database,
  storeId: string,
  id: string,
  opts: { detach: boolean },
  nowIso: string = touch()
): Promise<{ deleted: string }> {
  const current = await getCategory(db, storeId, id);
  if (!current) {
    throw new AppError("category_not_found", 404, "Category not found.");
  }
  if (!opts.detach) {
    const prod = await db
      .prepare("SELECT 1 AS ok FROM products WHERE store_id = ? AND category_id = ? LIMIT 1")
      .bind(storeId, id)
      .first<{ ok: number }>();
    const child = await db
      .prepare("SELECT 1 AS ok FROM categories WHERE store_id = ? AND parent_id = ? LIMIT 1")
      .bind(storeId, id)
      .first<{ ok: number }>();
    if (prod !== null || child !== null) {
      throw new AppError(
        "has_dependents",
        409,
        "Category has assigned products or subcategories. Detach them first."
      );
    }
    await db
      .prepare("DELETE FROM categories WHERE store_id = ? AND id = ?")
      .bind(storeId, id)
      .run();
    return { deleted: id };
  }
  const batch = await db.batch([
    db
      .prepare("UPDATE products SET category_id = NULL, updated_at = ? WHERE store_id = ? AND category_id = ?")
      .bind(nowIso, storeId, id),
    db
      .prepare("UPDATE categories SET parent_id = NULL, updated_at = ? WHERE store_id = ? AND parent_id = ?")
      .bind(nowIso, storeId, id),
    db.prepare("DELETE FROM categories WHERE store_id = ? AND id = ?").bind(storeId, id),
  ]);
  if (!batch.every((r) => r.success)) {
    throw new AppError("internal", 500, "Something went wrong.");
  }
  return { deleted: id };
}

// ---------------------------------------------------------------- products

async function activePlanLimit(db: D1Database, storeId: string): Promise<number | null> {
  // NULL = unlimited. No covering subscription row (gate normally blocks first,
  // this is defense in depth): allow, the gate owns that decision.
  const row = await db
    .prepare(
      `SELECT p.max_products AS max_products FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.store_id = ? AND s.status = 'active'
        ORDER BY s.starts_at DESC LIMIT 1`
    )
    .bind(storeId)
    .first<{ max_products: number | null }>();
  if (!row) return null;
  return row.max_products;
}

export interface ProductInput {
  name: string;
  slug: string;
  category_id?: string | null;
  price: number;
  stock_quantity?: number | null;
  is_active?: number;
}

export async function createProduct(
  db: D1Database,
  storeId: string,
  input: ProductInput,
  nowIso: string = touch()
): Promise<ProductRow> {
  const categoryId = input.category_id ?? null;
  if (!(await categoryInStore(db, storeId, categoryId))) {
    throw new AppError("category_not_found", 404, "Category not found.");
  }
  const limit = await activePlanLimit(db, storeId);
  if (limit !== null) {
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND deleted_at IS NULL")
      .bind(storeId)
      .first<{ n: number }>();
    // Accepted MVP race (validated H2/H4 review): two concurrent creates can
    // overshoot by a row; exact counting would need serialization. The limit
    // is enforced per-request, which is sufficient at this scale.
    if ((count?.n ?? 0) >= limit) {
      throw new AppError("plan_limit", 409, "Product limit for this plan is reached.");
    }
  }
  const id = uuidv7();
  try {
    await db
      .prepare(
        `INSERT INTO products (id, store_id, category_id, name, slug, price, stock_quantity, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id, storeId, categoryId, input.name, input.slug, input.price,
        input.stock_quantity ?? null, input.is_active ?? 1, nowIso, nowIso
      )
      .run();
  } catch (err) {
    mapCatalogError(err, "slug_taken");
  }
  const row = await getProduct(db, storeId, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

export async function listProducts(db: D1Database, storeId: string): Promise<ProductRow[]> {
  const res = await db
    .prepare("SELECT * FROM products WHERE store_id = ? ORDER BY created_at")
    .bind(storeId)
    .all<ProductRow>();
  return res.results ?? [];
}

export async function getProduct(
  db: D1Database,
  storeId: string,
  id: string
): Promise<ProductRow | null> {
  return db
    .prepare("SELECT * FROM products WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .first<ProductRow>();
}

export interface ProductPatch {
  name?: string;
  slug?: string;
  category_id?: string | null;
  price?: number;
  stock_quantity?: number | null;
  is_active?: number;
}

export async function updateProduct(
  db: D1Database,
  storeId: string,
  id: string,
  patch: ProductPatch,
  nowIso: string = touch()
): Promise<ProductRow | null> {
  const current = await getProduct(db, storeId, id);
  if (!current) return null;
  const nextCategory = patch.category_id === undefined ? current.category_id : patch.category_id;
  if (!(await categoryInStore(db, storeId, nextCategory))) {
    throw new AppError("category_not_found", 404, "Category not found.");
  }
  const next = {
    name: patch.name ?? current.name,
    slug: patch.slug ?? current.slug,
    category_id: nextCategory,
    price: patch.price ?? current.price,
    stock_quantity: patch.stock_quantity === undefined ? current.stock_quantity : patch.stock_quantity,
    is_active: patch.is_active ?? current.is_active,
  };
  try {
    await db
      .prepare(
        "UPDATE products SET name = ?, slug = ?, category_id = ?, price = ?, stock_quantity = ?, is_active = ?, updated_at = ? WHERE store_id = ? AND id = ?"
      )
      .bind(next.name, next.slug, next.category_id, next.price, next.stock_quantity, next.is_active, nowIso, storeId, id)
      .run();
  } catch (err) {
    mapCatalogError(err, "slug_taken");
  }
  return getProduct(db, storeId, id);
}

// Soft retirement (idempotent): sets deleted_at, preserves the row for order
// history. There is intentionally no hard-delete route in MVP.
export async function softDeleteProduct(
  db: D1Database,
  storeId: string,
  id: string,
  nowIso: string = touch()
): Promise<ProductRow | null> {
  const current = await getProduct(db, storeId, id);
  if (!current) return null;
  await db
    .prepare("UPDATE products SET deleted_at = ?, updated_at = ? WHERE store_id = ? AND id = ?")
    .bind(nowIso, nowIso, storeId, id)
    .run();
  return getProduct(db, storeId, id);
}

// Restore fails 409 when a live row already holds the slug (partial-unique
// rule proven at DB level); the caller renames first, then retries.
export async function restoreProduct(
  db: D1Database,
  storeId: string,
  id: string,
  nowIso: string = touch()
): Promise<ProductRow | null> {
  const current = await getProduct(db, storeId, id);
  if (!current) return null;
  try {
    await db
      .prepare("UPDATE products SET deleted_at = NULL, updated_at = ? WHERE store_id = ? AND id = ?")
      .bind(nowIso, storeId, id)
      .run();
  } catch (err) {
    mapCatalogError(err, "slug_taken");
  }
  return getProduct(db, storeId, id);
}

// ---------------------------------------------------------------- images

export interface ProductImageInput {
  product_id: string;
  url: string;
  alt_text?: string | null;
  sort_order?: number;
}

async function productInStore(db: D1Database, storeId: string, productId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM products WHERE store_id = ? AND id = ?")
    .bind(storeId, productId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function createImage(
  db: D1Database,
  storeId: string,
  input: ProductImageInput,
  nowIso: string = touch()
): Promise<ProductImageRow> {
  if (!(await productInStore(db, storeId, input.product_id))) {
    throw new AppError("product_not_found", 404, "Product not found.");
  }
  const id = uuidv7();
  await db
    .prepare(
      `INSERT INTO product_images (id, store_id, product_id, url, alt_text, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, storeId, input.product_id, input.url, input.alt_text ?? null, input.sort_order ?? 0, nowIso, nowIso)
    .run();
  const row = await getImage(db, storeId, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

export async function listImages(
  db: D1Database,
  storeId: string,
  productId: string
): Promise<ProductImageRow[]> {
  if (!(await productInStore(db, storeId, productId))) {
    throw new AppError("product_not_found", 404, "Product not found.");
  }
  const res = await db
    .prepare("SELECT * FROM product_images WHERE store_id = ? AND product_id = ? ORDER BY sort_order, created_at")
    .bind(storeId, productId)
    .all<ProductImageRow>();
  return res.results ?? [];
}

export async function getImage(
  db: D1Database,
  storeId: string,
  id: string
): Promise<ProductImageRow | null> {
  return db
    .prepare("SELECT * FROM product_images WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .first<ProductImageRow>();
}

export interface ProductImagePatch {
  url?: string;
  alt_text?: string | null;
  sort_order?: number;
}

export async function updateImage(
  db: D1Database,
  storeId: string,
  id: string,
  patch: ProductImagePatch,
  nowIso: string = touch()
): Promise<ProductImageRow | null> {
  const current = await getImage(db, storeId, id);
  if (!current) return null;
  const next = {
    url: patch.url ?? current.url,
    alt_text: patch.alt_text === undefined ? current.alt_text : patch.alt_text,
    sort_order: patch.sort_order ?? current.sort_order,
  };
  await db
    .prepare("UPDATE product_images SET url = ?, alt_text = ?, sort_order = ?, updated_at = ? WHERE store_id = ? AND id = ?")
    .bind(next.url, next.alt_text, next.sort_order, nowIso, storeId, id)
    .run();
  return getImage(db, storeId, id);
}

export async function softDeleteImage(
  db: D1Database,
  storeId: string,
  id: string,
  nowIso: string = touch()
): Promise<ProductImageRow | null> {
  const current = await getImage(db, storeId, id);
  if (!current) return null;
  await db
    .prepare("UPDATE product_images SET deleted_at = ?, updated_at = ? WHERE store_id = ? AND id = ?")
    .bind(nowIso, nowIso, storeId, id)
    .run();
  return getImage(db, storeId, id);
}

export async function restoreImage(
  db: D1Database,
  storeId: string,
  id: string,
  nowIso: string = touch()
): Promise<ProductImageRow | null> {
  const current = await getImage(db, storeId, id);
  if (!current) return null;
  await db
    .prepare("UPDATE product_images SET deleted_at = NULL, updated_at = ? WHERE store_id = ? AND id = ?")
    .bind(nowIso, storeId, id)
    .run();
  return getImage(db, storeId, id);
}
