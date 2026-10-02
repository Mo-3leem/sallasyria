import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam, storeIdParams } from "../openapi/params.js";
import { GOVERNORATES } from "../lib/governorates.js";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveStore, requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createRate,
  deleteRate,
  getRate,
  listRates,
  updateRate,
} from "../services/customers.js";

export const shippingRates = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
//
// PUBLIC / PRIVATE SPLIT: rates carry no secrets and the storefront needs
// them to quote delivery, so both reads are PUBLIC (scoped by path store,
// server-resolved as always). All mutations stay merchant-private + gated.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const merchantMutating = [...authed, requireActiveSubscription, requireActiveStore] as const;
const scopedRead = [resolveStore] as const;

const flag = z.union([z.literal(0), z.literal(1)]);

const rateSchema = z.object({
  governorate: z.enum(GOVERNORATES),
  shipping_method: z.string().min(1).max(200),
  cost: z.number().int().min(0),
  is_active: flag.default(1),
});

const ratePatchSchema = z.object({
  shipping_method: z.string().min(1).max(200).optional(),
  cost: z.number().int().min(0).optional(),
  is_active: flag.optional(),
});

const FORBIDDEN = ["store_id", "id", "governorate"] as const;

const rateDocSchema = z
  .object({
    id: z.string().openapi({ example: "rate_01J..." }),
    store_id: z.string(),
    governorate: z.string().openapi({ example: "Damascus" }),
    shipping_method: z.string().openapi({ example: "Standard" }),
    cost: z.number().openapi({ example: 5000 }),
    is_active: z.number(),
  })
  .openapi("ShippingRate");

const rateOkSchema = okOf(z.object({ rate: rateDocSchema }));
const idParams = z.object({ storeId: storeIdParam, id: idParam });

const listRatesRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List delivery rates",
  description: "Public price list: per-governorate delivery fee for the storefront.",
  middleware: [...scopedRead],
  request: { params: storeIdParams },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ rates: z.array(rateDocSchema) })) },
      },
      description: "Delivery rates of the store (public)",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown store",
    },
  },
});

shippingRates.openapi(listRatesRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { rates: await listRates(getDb(c), storeId) });
}, validationHook);

const getRateRoute = createRoute({
  method: "get",
  path: "/:id",
  summary: "Get one delivery rate",
  description: "404 for an unknown store or rate.",
  middleware: [...scopedRead],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: rateOkSchema } },
      description: "The rate (public)",
    },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Unknown store or rate",
    },
  },
});

shippingRates.openapi(getRateRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getRate(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("rate_not_found", 404, "Shipping rate not found.");
  return ok(c, { rate: row });
}, validationHook);

const createRateRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create a delivery rate",
  description: "One rate per governorate; 409 on duplicates. Fee in minor units.",
  middleware: [...merchantMutating],
  request: {
    params: storeIdParams,
    body: { content: { "application/json": { schema: rateSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: rateOkSchema } },
      description: "Rate created",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Rate for this governorate already exists" },
  },
});

shippingRates.openapi(createRateRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["store_id", "id"]);
  const { storeId } = storeScope(c);
  return ok(c, { rate: await createRate(getDb(c), storeId, c.req.valid("json")) }, 201);
}, validationHook);

const updateRateRoute = createRoute({
  method: "patch",
  path: "/:id",
  summary: "Update a delivery rate",
  description: "Governorate is identity (unique per store) and immutable on PATCH — delete and recreate to change it.",
  middleware: [...merchantMutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: ratePatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: rateOkSchema } },
      description: "Updated rate",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or rate" },
  },
});

shippingRates.openapi(updateRateRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  // Governorate is identity here (UNIQUE per store): changing it is really
  // delete+create, so it is forbidden on PATCH to keep semantics explicit.
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateRate(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("rate_not_found", 404, "Shipping rate not found.");
  return ok(c, { rate: row });
}, validationHook);

const deleteRateRoute = createRoute({
  method: "delete",
  path: "/:id",
  summary: "Delete a delivery rate",
  description: "Permanently removes the rate. Past order snapshots are unaffected.",
  middleware: [...merchantMutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } },
      description: "Deleted rate id",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or rate" },
  },
});

shippingRates.openapi(deleteRateRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, await deleteRate(getDb(c), storeId, resourceId(c)));
}, validationHook);
