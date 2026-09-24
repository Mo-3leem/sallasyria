import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam } from "../openapi/params.js";
import { requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createProduct,
  getProduct,
  listProducts,
  removeProduct,
  restoreProduct,
  softDeleteProduct,
  updateProduct,
} from "../services/catalog.js";

export const products = new OpenAPIHono<AppEnv>();

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

const FORBIDDEN = ["store_id", "id", "deleted_at", "removed_at"] as const;

const productDocSchema = z
  .object({
    id: z.string().openapi({ example: "prod_01J..." }),
    store_id: z.string(),
    category_id: z.string().nullable(),
    name: z.string().openapi({ example: "Phone X" }),
    slug: z.string().openapi({ example: "phone-x" }),
    price: z.number().openapi({ example: 150000 }),
    stock_quantity: z.number().nullable(),
    is_active: z.number(),
    deleted_at: z.string().nullable(),
    removed_at: z.string().nullable(),
  })
  .openapi("Product");

const productOkSchema = okOf(z.object({ product: productDocSchema }));
const idParams = z.object({ storeId: storeIdParam, id: idParam });

const listProductsRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List products",
  description: "All products of the store, including retired ones.",
  middleware: [...authed],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ products: z.array(productDocSchema) })) },
      },
      description: "Products of the store",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

products.openapi(listProductsRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { products: await listProducts(getDb(c), storeId) });
}, validationHook);

const getProductRoute = createRoute({
  method: "get",
  path: "/:id",
  summary: "Get one product",
  description: "404 for an unknown store or product.",
  middleware: [...authed],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: productOkSchema } },
      description: "The product",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or product" },
  },
});

products.openapi(getProductRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getProduct(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
}, validationHook);

const createProductRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create a product",
  description:
    "Price is in minor units; optional category must belong to the same store. " +
    "The plan's product limit is enforced (409). Retired slugs are reusable.",
  middleware: [...mutating],
  request: {
    params: z.object({ storeId: storeIdParam }),
    body: { content: { "application/json": { schema: productSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: productOkSchema } },
      description: "Product created",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or category" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Slug taken or plan limit reached" },
  },
});

products.openapi(createProductRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { product: await createProduct(getDb(c), storeId, c.req.valid("json")) }, 201);
}, validationHook);

const updateProductRoute = createRoute({
  method: "patch",
  path: "/:id",
  summary: "Update a product",
  description: "Partial update; category changes are re-scoped to the same store. 409 when the slug is taken.",
  middleware: [...mutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: productPatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: productOkSchema } },
      description: "Updated product",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store, product, or category" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Slug already in use" },
  },
});

products.openapi(updateProductRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateProduct(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
}, validationHook);

// Soft retirement / archive (idempotent). Removed (business-deleted)
// products are outside archive scope and answer 404 here. No hard-delete
// route exists in MVP.
const softDeleteProductRoute = createRoute({
  method: "delete",
  path: "/:id",
  summary: "Archive a product (soft retirement)",
  description:
    "Sets deleted_at and deactivates instead of erasing, so order history stays intact. " +
    "Idempotent; releases the slug. Removed products answer 404. There is no hard-delete route.",
  middleware: [...mutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: productOkSchema } },
      description: "Retired product",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or product" },
  },
});

products.openapi(softDeleteProductRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await softDeleteProduct(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
}, validationHook);

// Business delete (soft delete, idempotent). Sets removed_at (plus
// deleted_at, so every live-product guard keeps excluding it) and
// deactivates instead of erasing: the row stays, so order_items references
// and historical orders stay intact. Works from active or archived;
// repeating it is a no-op. There is intentionally no hard-delete route.
const removeProductRoute = createRoute({
  method: "post",
  path: "/:id/delete",
  summary: "Delete a product (business soft delete)",
  description:
    "Removes the product from the catalog without erasing the row: sets " +
    "removed_at and deactivates, so order history stays intact. Idempotent; " +
    "releases the slug. Deleted products never appear in the storefront and " +
    "cannot be purchased. Restore with POST /:id/restore. There is no hard-delete route.",
  middleware: [...mutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: productOkSchema } },
      description: "Deleted product",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or product" },
  },
});

products.openapi(removeProductRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await removeProduct(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
}, validationHook);

// Restore fails 409 while a live row holds the slug (partial-unique rule).
const restoreProductRoute = createRoute({
  method: "post",
  path: "/:id/restore",
  summary: "Restore an archived or deleted product",
  description: "Clears deleted_at and removed_at and reactivates. 409 while another live product holds the slug — rename first.",
  middleware: [...mutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: productOkSchema } },
      description: "Restored product",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or product" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Slug taken by a live product" },
  },
});

products.openapi(restoreProductRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await restoreProduct(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("product_not_found", 404, "Product not found.");
  return ok(c, { product: row });
}, validationHook);
