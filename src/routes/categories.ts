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
import { requireActiveStore, requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "../services/catalog.js";

export const categories = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary, same as stores routes): this file contains zero
// SQL strings and reads scoping only from storeScope(c). All queries live in
// services/catalog.ts. Enforced by tests/tenant-conventions.test.ts.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const mutating = [...authed, requireActiveSubscription, requireActiveStore] as const;

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with dashes.");

const categorySchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema,
  parent_id: z.string().min(1).nullable().default(null),
  // Omitted sort_order appends to the sibling list (service computes
  // MAX+1); explicit values are still honored for reordering/imports.
  sort_order: z.number().int().optional(),
  is_active: z.union([z.literal(0), z.literal(1)]).default(1),
});

const categoryPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: slugSchema.optional(),
  parent_id: z.string().min(1).nullable().optional(),
  sort_order: z.number().int().optional(),
  is_active: z.union([z.literal(0), z.literal(1)]).optional(),
});

const FORBIDDEN = ["store_id", "id", "deleted_at"] as const;

const categoryDocSchema = z
  .object({
    id: z.string().openapi({ example: "cat_01J..." }),
    store_id: z.string(),
    parent_id: z.string().nullable(),
    name: z.string().openapi({ example: "Phones" }),
    slug: z.string().openapi({ example: "phones" }),
    sort_order: z.number(),
    is_active: z.number(),
  })
  .openapi("Category");

const categoryOkSchema = okOf(z.object({ category: categoryDocSchema }));

const listCategoriesRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List categories",
  description: "All categories of the store in display order.",
  middleware: [...authed],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(z.object({ categories: z.array(categoryDocSchema) })),
        },
      },
      description: "Categories of the store",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown store",
    },
  },
});

categories.openapi(listCategoriesRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { categories: await listCategories(getDb(c), storeId) });
}, validationHook);

const getCategoryRoute = createRoute({
  method: "get",
  path: "/:id",
  summary: "Get one category",
  description: "404 for an unknown store or category.",
  middleware: [...authed],
  request: { params: z.object({ storeId: storeIdParam, id: idParam }) },
  responses: {
    200: {
      content: { "application/json": { schema: categoryOkSchema } },
      description: "The category",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown store or category",
    },
  },
});

categories.openapi(getCategoryRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getCategory(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("category_not_found", 404, "Category not found.");
  return ok(c, { category: row });
}, validationHook);

const createCategoryRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create a category",
  description:
    "Slug must be unique per store and lowercase dashed; an optional parent must belong to the same store. " +
    "Omitted sort_order appends the category to the end of its sibling list. " +
    "409 when the slug is taken.",
  middleware: [...mutating],
  request: {
    params: z.object({ storeId: storeIdParam }),
    body: { content: { "application/json": { schema: categorySchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: categoryOkSchema } },
      description: "Category created",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body or immutable field",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    403: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Inactive subscription",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown store or parent category",
    },
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Slug already in use",
    },
  },
});

categories.openapi(createCategoryRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { category: await createCategory(getDb(c), storeId, c.req.valid("json")) }, 201);
}, validationHook);

const updateCategoryRoute = createRoute({
  method: "patch",
  path: "/:id",
  summary: "Update a category",
  description:
    "Partial update. Parent changes are cycle-checked: self-parent and parent cycles are 400.",
  middleware: [...mutating],
  request: {
    params: z.object({ storeId: storeIdParam, id: idParam }),
    body: { content: { "application/json": { schema: categoryPatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: categoryOkSchema } },
      description: "Updated category",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body, immutable field, or bad parent",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    403: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Inactive subscription",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown store, category, or parent",
    },
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Slug already in use",
    },
  },
});

categories.openapi(updateCategoryRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateCategory(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("category_not_found", 404, "Category not found.");
  return ok(c, { category: row });
}, validationHook);

// DELETE /:id → 409 has_dependents while products/children reference it;
// DELETE /:id?detach=true unassigns them in the same batch, then deletes.
// The detach flag is declared optional-string so docs show it while the
// exact `=== "true"` semantics (and handler) stay byte-identical.
const deleteCategoryRoute = createRoute({
  method: "delete",
  path: "/:id",
  summary: "Delete a category",
  description:
    "409 while assigned products or child categories reference it; " +
    "repeat with ?detach=true to unassign them atomically first.",
  middleware: [...mutating],
  request: {
    params: z.object({ storeId: storeIdParam, id: idParam }),
    query: z.object({ detach: z.string().optional().openapi({ example: "true" }) }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ deleted: z.string() })) },
      },
      description: "Deleted category id",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    403: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Inactive subscription",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown store or category",
    },
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Has dependents (retry with ?detach=true)",
    },
  },
});

categories.openapi(deleteCategoryRoute, async (c) => {
  const { storeId } = storeScope(c);
  const detach = c.req.query("detach") === "true";
  return ok(c, await deleteCategory(getDb(c), storeId, resourceId(c), { detach }));
}, validationHook);
