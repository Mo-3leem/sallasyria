import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { storeIdParam } from "../openapi/params.js";
import { auditEvent } from "../services/audit.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import { listAllStores, getStoreById, getStoreOwner, listStoresForOwner, setStorePublished, updateStore, createStore, deleteStoreByAdmin } from "../services/stores.js";
import { checkStatusChangeLimit, checkStoreDeleteLimit } from "../lib/rate-limit.js";
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
    is_published: z.number().openapi({ example: 0 }),
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
    await auditEvent(c, getDb(c),"admin.store.read", { actor: user.id, result: "list-all" });
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
  await auditEvent(c, getDb(c),"store.create", { actor: ownerId, store: store.id, result: "ok" });
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
  status: z.enum(["active", "paused", "archived"]).optional(),
});

// Identity, ownership, lifecycle-visibility, and counters can never be
// written through this endpoint (is_published has its own POST
// /:storeId/publish endpoint; order_counter is allocator state). Status IS
// writable here (roadmap B10): paused hides the public storefront and blocks
// content mutations/checkout; archived additionally freezes merchant writes
// except through this same endpoint, so every state stays recoverable.
const UPDATE_FORBIDDEN = ["store_id", "id", "owner_id", "is_published", "order_counter", "created_at"] as const;

const renameRoute = createRoute({
  method: "patch",
  path: "/:storeId",
  summary: "Update a store",
  description:
    "Partial update of name, slug, currency, and status. Unchanged slug is a no-op; taken slug is 409. " +
    "Status accepts active/paused/archived: paused hides the storefront and blocks content mutations and checkout; " +
    "archived additionally freezes merchant writes (settings/status/delete stay available so every state recovers). " +
    "id, owner_id, store_id, order_counter, and created_at in the body are 400. " +
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
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many status changes",
    },
  },
});

// PATCH /stores/:storeId — whitelisted { name, slug, currency, status } only.
// Immutable fields are 400d on the RAW body even when matching
// (assertNoImmutableFields — validated output is already stripped, so
// checking it would prove nothing). Merchant writes additionally require a
// covering subscription; admins bypass (audited) so expired stores stay
// manageable. Store edits touch no credential identity: no session is ever
// revoked here. Status-only recovery on an expired subscription uses
// POST /:storeId/status below (this endpoint stays subscription-gated like
// every other PATCH write).
stores.openapi(renameRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, UPDATE_FORBIDDEN);
  const { storeId } = storeScope(c);
  const user = currentUser(c);
  const input = c.req.valid("json");
  // Status writes share the per-user status-change budget (abuse guard
  // before work); name/slug/currency-only patches are never limited.
  if (input.status !== undefined && !checkStatusChangeLimit(user.id)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const updated = await updateStore(getDb(c), storeId, input);
  const ownerId = await getStoreOwner(getDb(c), storeId);
  if (input.status !== undefined) {
    await auditEvent(c, getDb(c), "store.status", { actor: user.id, store: storeId, result: input.status });
  } else if (user.role === "admin" && ownerId !== user.id) {
    await auditEvent(c, getDb(c),"admin.store.update", { actor: user.id, store: storeId, result: "ok" });
  } else {
    await auditEvent(c, getDb(c),"store.update", { actor: user.id, store: storeId, result: "ok" });
  }
  return ok(c, { store: updated });
}, validationHook);

const publishSchema = z.object({
  is_published: z.union([z.literal(0), z.literal(1)]).openapi({ example: 1 }),
});

// Only is_published may be written through this endpoint: every other
// store field in the body is 400 (same immutable-field philosophy as PATCH).
const PUBLISH_FORBIDDEN = ["store_id", "id", "owner_id", "status", "order_counter", "created_at", "name", "slug", "currency"] as const;

const publishRoute = createRoute({
  method: "post",
  path: "/:storeId/publish",
  summary: "Publish or unpublish a store",
  description:
    "Sets store visibility for the public storefront (/s/:slug). " +
    "is_published=1 makes the store publicly resolvable; 0 hides it again. " +
    "Owner or admin only (foreign ids are 404, no oracle). " +
    "Deliberately NOT subscription-gated: publishing is visibility, not a " +
    "premium write — a brand-new store must be publishable right after " +
    "creation. Audited as store.publish.",
  middleware: [requireAuth, resolveStore, requireStoreAccess],
  request: {
    params: z.object({ storeId: storeIdParam }),
    body: { content: { "application/json": { schema: publishSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ store: storeDocSchema.nullable() })) },
      },
      description: "Store with updated visibility (null only if deleted mid-request)",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid body or immutable field",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown or foreign store",
    },
  },
});

// POST /stores/:storeId/publish — the single writer of is_published.
// requireStoreAccess proves ownership (admins bypass per convention); the
// service writes only the flag plus updated_at and returns the store.
stores.openapi(publishRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, PUBLISH_FORBIDDEN);
  const { storeId } = storeScope(c);
  const user = currentUser(c);
  const { is_published } = c.req.valid("json");
  const updated = await setStorePublished(getDb(c), storeId, is_published);
  if (updated === null) {
    // Defensive only: requireStoreAccess proved access above, so a null here
    // means deletion raced the middlewares — still 404, never unscoped data.
    return ok(c, { store: null });
  }
  await auditEvent(c, getDb(c),"store.publish", { actor: user.id, store: storeId, result: is_published === 1 ? "published" : "unpublished" });
  return ok(c, { store: updated });
}, validationHook);

const statusSchema = z.object({
  status: z.enum(["active", "paused", "archived"]).openapi({ example: "paused" }),
});

// Only status may be written through this endpoint: every other store
// field in the body is 400 (same immutable-field philosophy as publish).
const STATUS_FORBIDDEN = ["store_id", "id", "owner_id", "is_published", "order_counter", "created_at", "name", "slug", "currency"] as const;

const statusRoute = createRoute({
  method: "post",
  path: "/:storeId/status",
  summary: "Set store lifecycle status",
  description:
    "Sets active/paused/archived. Paused hides the public storefront and blocks content mutations and checkout; " +
    "archived additionally freezes merchant writes. Settings, visibility, status changes, and deletion stay " +
    "available on non-active stores so every state recovers. Owner or admin only (foreign ids are 404, no oracle). " +
    "Deliberately NOT subscription-gated — like publishing, lifecycle is not a premium write, so a paused store " +
    "with an expired subscription can still resume. Audited as store.status.",
  middleware: [requireAuth, resolveStore, requireStoreAccess],
  request: {
    params: z.object({ storeId: storeIdParam }),
    body: { content: { "application/json": { schema: statusSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ store: storeDocSchema.nullable() })) },
      },
      description: "Store with updated status (null only if deleted mid-request)",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Invalid status or immutable field",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown or foreign store",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many status changes",
    },
  },
});

// POST /stores/:storeId/status — the subscription-independent status writer
// (recovery path). Reuses updateStore with a status-only patch; the route
// schema plus STATUS_FORBIDDEN admit nothing else.
stores.openapi(statusRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, STATUS_FORBIDDEN);
  const { storeId } = storeScope(c);
  const user = currentUser(c);
  const { status } = c.req.valid("json");
  // Abuse guard before the write (see PATCH above for the shared budget).
  if (!checkStatusChangeLimit(user.id)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const updated = await updateStore(getDb(c), storeId, { status });
  if (updated === null) {
    // Defensive only: requireStoreAccess proved access above, so a null here
    // means deletion raced the middlewares — still 404, never unscoped data.
    return ok(c, { store: null });
  }
  await auditEvent(c, getDb(c), "store.status", { actor: user.id, store: storeId, result: status });
  return ok(c, { store: updated });
}, validationHook);

const deleteStoreRoute = createRoute({
  method: "delete",
  path: "/:storeId",
  summary: "Delete own store permanently",
  description:
    "Owner only (foreign ids are 404, no oracle). Reuses the exact admin " +
    "deletion guards: 409 while the store has orders, subscriptions, or " +
    "dependent rows; schema cascades remove catalog, customers, carts, " +
    "billing intents, and themes. Permanent hard delete — archiving suspends, " +
    "deletion removes. Audited as merchant.store.delete.",
  middleware: [requireAuth, resolveStore, requireStoreAccess],
  request: {
    params: z.object({ storeId: storeIdParam }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ deleted: z.string() })) },
      },
      description: "Deleted store id",
    },
    401: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unauthenticated",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown or foreign store",
    },
    409: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Store has orders, subscriptions, or dependent rows",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
  },
});

// DELETE /stores/:storeId — merchant self-service hard delete. No
// subscription gate (an expired store must remain deletable) and no active-
// status gate (paused/archived stores must remain deletable); the guards
// that matter live inside deleteStoreByAdmin and are identical to the admin
// path. Rate-limited per user: deletion is irreversible.
stores.openapi(deleteStoreRoute, async (c) => {
  const { storeId } = storeScope(c);
  const user = currentUser(c);
  if (!checkStoreDeleteLimit(user.id)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const result = await deleteStoreByAdmin(getDb(c), user.id, storeId);
  await auditEvent(c, getDb(c), "merchant.store.delete", { actor: user.id, store: storeId, result: result.deleted });
  return ok(c, result);
}, validationHook);
