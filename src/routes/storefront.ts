import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { storeIdParam } from "../openapi/params.js";
import { limitPublicMutations } from "../middleware/public.js";
import {
  resolvePublishedStore,
  resolvePublishedStoreBySlug,
} from "../middleware/store.js";
import {
  getPublicStore,
  listPublishedCategories,
  listPublishedProducts,
} from "../services/storefront.js";

export const storefront = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Public reads mount resolvePublishedStore (+slug twin) and
// the store-scoped rate limit — drafts 404 identically to missing stores,
// unpublished rows never serialize.

const slugParam = z
  .string()
  .min(1)
  .max(200)
  .openapi({ param: { name: "slug", in: "path" }, example: "demo-store" });

const publicStoreSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    currency: z.string(),
  })
  .openapi("PublicStore");

const publicCategorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    parent_id: z.string().nullable(),
    sort_order: z.number(),
  })
  .openapi("PublicCategory");

const publicProductSchema = z
  .object({
    id: z.string(),
    category_id: z.string().nullable(),
    name: z.string(),
    slug: z.string(),
    price: z.number(),
    stock_quantity: z.number().nullable(),
  })
  .openapi("PublicProduct");

const bySlugRoute = createRoute({
  method: "get",
  path: "/by-slug/:slug",
  summary: "Resolve a published store id from its slug",
  description:
    "Storefront bootstrap: slug to id for published stores only. Unknown " +
    "and draft slugs answer with an identical 404 (slugs are public " +
    "addresses, but draft existence stays hidden).",
  middleware: [resolvePublishedStoreBySlug, limitPublicMutations],
  request: { params: z.object({ slug: slugParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ store: publicStoreSchema })) },
      },
      description: "Published store profile",
    },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown or draft store" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

storefront.openapi(bySlugRoute, async (c) => {
  const { storeId } = storeScope(c);
  const store = await getPublicStore(getDb(c), storeId);
  // Defensive only: the middleware proved published above; a null here
  // means unpublished/deleted mid-request — still 404, never unscoped data.
  if (!store) throw new AppError("store_not_found", 404, "Store not found.");
  return ok(c, { store });
}, validationHook);

const storeProfileRoute = createRoute({
  method: "get",
  path: "/:storeId/catalog/store",
  summary: "Published store profile",
  description: "Name/slug/currency of a published store. Drafts 404.",
  middleware: [resolvePublishedStore, limitPublicMutations],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ store: publicStoreSchema })) },
      },
      description: "Published store profile",
    },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown or draft store" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

storefront.openapi(storeProfileRoute, async (c) => {
  const { storeId } = storeScope(c);
  const store = await getPublicStore(getDb(c), storeId);
  if (!store) throw new AppError("store_not_found", 404, "Store not found.");
  return ok(c, { store });
}, validationHook);

const categoriesRoute = createRoute({
  method: "get",
  path: "/:storeId/catalog/categories",
  summary: "Published categories",
  description: "Active categories only, in display order. Drafts 404.",
  middleware: [resolvePublishedStore, limitPublicMutations],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ categories: z.array(publicCategorySchema) })) },
      },
      description: "Published categories",
    },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown or draft store" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

storefront.openapi(categoriesRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { categories: await listPublishedCategories(getDb(c), storeId) });
}, validationHook);

const productsRoute = createRoute({
  method: "get",
  path: "/:storeId/catalog/products",
  summary: "Published products",
  description:
    "Live, active products only (retired and hidden rows never serialize). Drafts 404.",
  middleware: [resolvePublishedStore, limitPublicMutations],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ products: z.array(publicProductSchema) })) },
      },
      description: "Published products",
    },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown or draft store" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

storefront.openapi(productsRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { products: await listPublishedProducts(getDb(c), storeId) });
}, validationHook);
