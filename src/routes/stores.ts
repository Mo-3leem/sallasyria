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
import { listAllStores, getStoreById, getStoreOwner, listStoresForOwner, updateStore, createStore } from "../services/stores.js";
import { grantTrial } from "../services/billing.js";

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

const storeCreateSchema = z.object({
  name: z.string().min(1).max(200).openapi({ example: "Mo Electronics" }),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with dashes.")
    .openapi({ example: "mo-electronics" }),
  currency: z.string().min(1).max(8).default("SYP").openapi({ example: "SYP" }),
});

// owner_id joins the forbidden list here (on top of the default store_id/id):
// ownership flows ONLY from the session below, never from the body.
const CREATE_FORBIDDEN = ["store_id", "id", "owner_id"] as const;

// POST /stores — authenticated merchant self-service creation (MVP).
// Deliberately NOT behind requireActiveSubscription: a brand-new store has no
// subscription yet, and there is no other store's subscription that could
// cover it. Writes ON the new store stay gated per-store by the existing
// middleware, so creation grants no unentitled capability.
const createStoreRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create a store",
  description:
    "Creates a store owned by the caller; owner comes from the session, never the body. " +
    "No limit on stores per merchant. 409 when the slug is taken. " +
    "A free trial period (TRIAL_DAYS, default 14) is granted automatically " +
    "unless the trial is disabled or cannot resolve its plan — trial carries " +
    "its ends_at for banners. Merchant writes on the new store still need a " +
    "subscription per store.",
  middleware: [requireAuth],
  request: {
    body: { content: { "application/json": { schema: storeCreateSchema } } },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: okOf(
            z.object({
              store: storeDocSchema,
              trial: z
                .object({
                  status: z.string(),
                  ends_at: z.string().nullable(),
                })
                .nullable(),
            })
          ),
        },
      },
      description: "Created store plus trial grant (null when skipped)",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body or immutable field",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Slug already in use",
    },
  },
});

stores.openapi(createStoreRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, CREATE_FORBIDDEN);
  const ownerId = currentUser(c).id;
  const input = c.req.valid("json");
  const store = await createStore(getDb(c), ownerId, input);
  auditLog("store.create", { actor: ownerId, store: store.id, result: "ok" });
  // Trial is best-effort and never fails creation: grantTrial swallows its
  // own race/skip cases; anything unexpected here still 500s loudly below
  // (fail-closed beats a silent untrialed store).
  const { trial } = await grantTrial(getDb(c), c.env, store.id, ownerId);
  return ok(
    c,
    {
      store,
      trial: trial
        ? { status: trial.status, ends_at: trial.ends_at }
        : null,
    },
    201
  );
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

const storePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with dashes.")
    .optional(),
  currency: z.string().min(1).max(8).optional(),
});

// Identity, ownership, lifecycle, and counters can never be written through
// this endpoint (status stays operator-only until something consumes
// paused/archived; order_counter is allocator state).
const UPDATE_FORBIDDEN = ["store_id", "id", "owner_id", "status", "order_counter", "created_at"] as const;

const renameRoute = createRoute({
  method: "patch",
  path: "/:storeId",
  summary: "Update a store",
  description:
    "Partial update of name, slug, and currency. Unchanged slug is a no-op; taken slug is 409. " +
    "id, owner_id, store_id, status, order_counter, and created_at in the body are 400. " +
    "Merchant writes need an active subscription; admins bypass (audited).",
  middleware: [requireAuth, resolveStore, requireStoreAccess, requireActiveSubscription],
  request: {
    params: z.object({ storeId: storeIdParam }),
    body: { content: { "application/json": { schema: storePatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ store: storeDocSchema.nullable() })) } },
      description: "Updated store",
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
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Slug already in use",
    },
  },
});

// PATCH /stores/:storeId — whitelisted { name, slug, currency } only.
// Immutable fields are 400d on the RAW body even when matching
// (assertNoImmutableFields — validated output is already stripped, so
// checking it would prove nothing). Merchant writes additionally require a
// covering subscription; admins bypass (audited) so expired stores stay
// manageable. Store edits touch no credential identity: no session is ever
// revoked here.
stores.openapi(renameRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, UPDATE_FORBIDDEN);
  const { storeId } = storeScope(c);
  const user = currentUser(c);
  const input = c.req.valid("json");
  const updated = await updateStore(getDb(c), storeId, input);
  const ownerId = await getStoreOwner(getDb(c), storeId);
  if (user.role === "admin" && ownerId !== user.id) {
    auditLog("admin.store.update", { actor: user.id, store: storeId, result: "ok" });
  } else {
    auditLog("store.update", { actor: user.id, store: storeId, result: "ok" });
  }
  return ok(c, { store: updated });
}, validationHook);
