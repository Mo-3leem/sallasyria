import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createProduct,
  getProduct,
  listProducts,
  restoreProduct,
  softDeleteProduct,
  updateProduct,
} from "../services/catalog.js";

export const products = new Hono<AppEnv>();

// NOTE (type-level boundary, same as stores routes): this file contains zero
// SQL strings and reads scoping only from storeScope(c). All queries live in
// services/catalog.ts. Enforced by tests/tenant-conventions.test.ts.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const mutating = [...authed, requireActiveSubscription] as const;

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with dashes.");

const flag = z.union([z.literal(0), z.literal(1)]);

const productSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema,
  category_id: z.string().min(1).nullable().default(null),
  price: z.number().int().min(0),
  stock_quantity: z.number().int().min(0).nullable().default(null),
  is_active: flag.default(1),
});

const productPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: slugSchema.optional(),
  category_id: z.string().min(1).nullable().optional(),
  price: z.number().int().min(0).optional(),
  stock_quantity: z.number().int().min(0).nullable().optional(),
  is_active: flag.optional(),
});

const FORBIDDEN = ["store_id", "id", "deleted_at"] as const;

products.get("/", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { products: await listProducts(getDb(c), storeId) });
});

products.get("/:id", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getProduct(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
});

products.post("/", ...mutating, zBodyValidator(productSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { product: await createProduct(getDb(c), storeId, c.req.valid("json")) }, 201);
});

products.patch("/:id", ...mutating, zBodyValidator(productPatchSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateProduct(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
});

// Soft retirement (idempotent). No hard-delete route exists in MVP.
products.delete("/:id", ...mutating, async (c) => {
  const { storeId } = storeScope(c);
  const row = await softDeleteProduct(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
});

// Restore fails 409 while a live row holds the slug (partial-unique rule).
products.post("/:id/restore", ...mutating, async (c) => {
  const { storeId } = storeScope(c);
  const row = await restoreProduct(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
});
