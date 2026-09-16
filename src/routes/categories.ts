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
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "../services/catalog.js";

export const categories = new Hono<AppEnv>();

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

const categorySchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema,
  parent_id: z.string().min(1).nullable().default(null),
  sort_order: z.number().int().default(0),
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

categories.get("/", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { categories: await listCategories(getDb(c), storeId) });
});

categories.get("/:id", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getCategory(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("category_not_found", 404, "Category not found.");
  return ok(c, { category: row });
});

categories.post("/", ...mutating, zBodyValidator(categorySchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { category: await createCategory(getDb(c), storeId, c.req.valid("json")) }, 201);
});

categories.patch("/:id", ...mutating, zBodyValidator(categoryPatchSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateCategory(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("category_not_found", 404, "Category not found.");
  return ok(c, { category: row });
});

// DELETE /:id → 409 has_dependents while products/children reference it;
// DELETE /:id?detach=true unassigns them in the same batch, then deletes.
categories.delete("/:id", ...mutating, async (c) => {
  const { storeId } = storeScope(c);
  const detach = c.req.query("detach") === "true";
  return ok(c, await deleteCategory(getDb(c), storeId, resourceId(c), { detach }));
});
