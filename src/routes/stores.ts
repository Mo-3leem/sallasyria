import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { storeScope } from "../db/tenant.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { storeIdParam } from "../openapi/params.js";
import { auditLog } from "../lib/audit.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import { listAllStores, getStoreById, getStoreOwner, listStoresForOwner, renameStore } from "../services/stores.js";

export const stores = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): this file contains zero SQL strings and never
// reads store scoping from params/bodies. storeId flows ONLY from
// storeScope(c) (server-resolved by resolveStore); all queries live in
// services/*. Neither rule is commentary — tests/tenant-conventions.test.ts
// fails the suite if either is violated.

const storeDocSchema = z
  .object({
    id: z.string().openapi({ example: "store_01J..." }),
    slug: z.string().openapi({ example: "demo-store" }),
    name: z.string().openapi({ example: "Demo Store" }),
    currency: z.string().openapi({ example: "SYP" }),
    status: z.string().openapi({ example: "active" }),
  })
  .openapi("Store");

const listStoresRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List own stores",
  description: "Stores owned by the caller; admins see all stores (audited).",
  middleware: [requireAuth],
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ stores: z.array(storeDocSchema) })) },
      },
      description: "Own stores (all stores for admins)",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
  },
});

// GET /stores — own stores; admins see all (admin listing is itself audited).
stores.openapi(listStoresRoute, async (c) => {
  const user = currentUser(c);
  if (user.role === "admin") {
    auditLog("admin.store.read", { actor: user.id, result: "list-all" });
    return ok(c, { stores: await listAllStores(getDb(c)) });
  }
  return ok(c, { stores: await listStoresForOwner(getDb(c), user.id) });
}, validationHook);

const getStoreRoute = createRoute({
  method: "get",
  path: "/:storeId",
  summary: "Get one store",
  description: "Owner or admin only. Foreign and missing ids answer with an identical 404 (no existence oracle).",
  middleware: [requireAuth, resolveStore, requireStoreAccess],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ store: storeDocSchema.nullable() })) },
      },
      description: "The store (null only if deleted mid-request)",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown or foreign store (identical: no oracle)",
    },
  },
});

// GET /stores/:storeId — owner or admin. Foreign and missing ids answer
// identically (404 store_not_found): no existence oracle.
stores.openapi(getStoreRoute, async (c) => {
  const { storeId } = storeScope(c);
  const store = await getStoreById(getDb(c), storeId);
  if (store === null) {
    // Defensive only: requireStoreAccess proved access above, so a null here
    // means deletion raced the middlewares — still 404, never unscoped data.
    return ok(c, { store: null });
  }
  return ok(c, { store });
}, validationHook);

const renameSchema = z.object({ name: z.string().min(1).max(200) });

const renameRoute = createRoute({
  method: "patch",
  path: "/:storeId",
  summary: "Rename a store",
  description:
    "Whitelisted name field only; store_id/id in the body are 400. " +
    "Merchant writes need an active subscription; admins bypass (audited).",
  middleware: [requireAuth, resolveStore, requireStoreAccess, requireActiveSubscription],
  request: {
    params: z.object({ storeId: storeIdParam }),
    body: { content: { "application/json": { schema: renameSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ store: storeDocSchema.nullable() })) } },
      description: "Renamed store",
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
      description: "Inactive subscription (merchants)",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown or foreign store",
    },
  },
});

// PATCH /stores/:storeId — whitelisted { name } only. store_id/id in the body
// are 400 even when matching (assertNoImmutableFields on the RAW body —
// validated output is already stripped, so checking it would prove nothing).
// Merchant writes additionally require a covering subscription; admins bypass
// (audited) so expired stores stay manageable.
stores.openapi(renameRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw);
  const { storeId } = storeScope(c);
  const user = currentUser(c);
  const updated = await renameStore(getDb(c), storeId, c.req.valid("json").name);
  const ownerId = await getStoreOwner(getDb(c), storeId);
  if (user.role === "admin" && ownerId !== user.id) {
    auditLog("admin.store.update", { actor: user.id, store: storeId, result: "ok" });
  } else {
    auditLog("store.update", { actor: user.id, store: storeId, result: "ok" });
  }
  return ok(c, { store: updated });
}, validationHook);
