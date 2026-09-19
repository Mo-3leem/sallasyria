import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam, storeIdParams, turnstileTokenHeader } from "../openapi/params.js";
import { GOVERNORATES } from "../lib/governorates.js";
import { requireAuth } from "../middleware/auth.js";
import { requireTurnstile } from "../middleware/turnstile.js";
import { limitPublicMutations } from "../middleware/public.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createAddress,
  deleteAddress,
  getAddress,
  listAddresses,
  makeDefaultAddress,
  updateAddress,
} from "../services/customers.js";

export const customerAddresses = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
//
// PUBLIC / PRIVATE SPLIT: buyers have no login, so create + make-default are
// PUBLIC (Turnstile + rate-limited, address ids unguessable); every read and
// all other mutations stay merchant-private. is_default is writable ONLY via
// make-default (direct writes are 400) so the single-default rule has exactly
// one writer.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const merchantMutating = [...authed, requireActiveSubscription] as const;
const buyerMutating = [resolveStore, limitPublicMutations, requireTurnstile()] as const;

const addressSchema = z.object({
  customer_id: z.string().min(1),
  recipient_name: z.string().min(1).max(200),
  phone: z.string().min(1).max(64),
  governorate: z.enum(GOVERNORATES),
  city: z.string().max(200).nullable().default(null),
  address_line: z.string().min(1).max(500),
});

const addressPatchSchema = z.object({
  recipient_name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(64).optional(),
  governorate: z.enum(GOVERNORATES).optional(),
  city: z.string().max(200).nullable().optional(),
  address_line: z.string().min(1).max(500).optional(),
});

const CREATE_FORBIDDEN = ["store_id", "id", "is_default"] as const;
const PATCH_FORBIDDEN = ["store_id", "id", "is_default", "customer_id"] as const;

const addressDocSchema = z
  .object({
    id: z.string().openapi({ example: "addr_01J..." }),
    store_id: z.string(),
    customer_id: z.string(),
    recipient_name: z.string().openapi({ example: "Layla Haddad" }),
    phone: z.string().openapi({ example: "+963991234567" }),
    governorate: z.string().openapi({ example: "Damascus" }),
    city: z.string().nullable(),
    address_line: z.string(),
    is_default: z.number(),
  })
  .openapi("CustomerAddress");

const addressOkSchema = okOf(z.object({ address: addressDocSchema }));
const idParams = z.object({ storeId: storeIdParam, id: idParam });

const createAddressRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Save a delivery address",
  description: "Public buyer flow (Turnstile + rate limit). The customer must belong to the same store.",
  middleware: [...buyerMutating],
  request: {
    params: storeIdParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: addressSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: addressOkSchema } },
      description: "Address saved (public buyer flow)",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body, phone, governorate, or immutable field" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

customerAddresses.openapi(createAddressRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, CREATE_FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { address: await createAddress(getDb(c), storeId, c.req.valid("json")) }, 201);
}, validationHook);

// customer_id stays a documented-but-optional query string on purpose: the
// manual missing-check below (with its exact message) remains the enforcer,
// so behavior is byte-identical to before documentation existed.
const listAddressesRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List a customer's saved addresses",
  description: "Filtered by required ?customer_id query, scoped to the store.",
  middleware: [...authed],
  request: {
    params: storeIdParams,
    query: z.object({ customer_id: z.string().optional().openapi({ example: "cust_01J..." }) }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ addresses: z.array(addressDocSchema) })) },
      },
      description: "Saved addresses of one customer",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Missing customer_id query",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
  },
});

customerAddresses.openapi(listAddressesRoute, async (c) => {
  const { storeId } = storeScope(c);
  const customerId = c.req.query("customer_id");
  if (!customerId) {
    throw new AppError("validation_failed", 400, "Missing customer_id query.");
  }
  return ok(c, { addresses: await listAddresses(getDb(c), storeId, customerId) });
}, validationHook);

const getAddressRoute = createRoute({
  method: "get",
  path: "/:id",
  summary: "Get one saved address",
  description: "404 for an unknown store or address.",
  middleware: [...authed],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: addressOkSchema } },
      description: "The address",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or address" },
  },
});

customerAddresses.openapi(getAddressRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getAddress(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address: row });
}, validationHook);

const updateAddressRoute = createRoute({
  method: "patch",
  path: "/:id",
  summary: "Update a saved address",
  description: "Partial update; is_default and customer_id are immutable — use the make-default endpoint for defaults.",
  middleware: [...merchantMutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: addressPatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: addressOkSchema } },
      description: "Updated address",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or address" },
  },
});

customerAddresses.openapi(updateAddressRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, PATCH_FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateAddress(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address: row });
}, validationHook);

const deleteAddressRoute = createRoute({
  method: "delete",
  path: "/:id",
  summary: "Delete a saved address",
  description: "Permanently removes the address. Past order snapshots are unaffected.",
  middleware: [...merchantMutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } },
      description: "Deleted address id",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or address" },
  },
});

customerAddresses.openapi(deleteAddressRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, await deleteAddress(getDb(c), storeId, resourceId(c)));
}, validationHook);

const makeDefaultRoute = createRoute({
  method: "post",
  path: "/:id/make-default",
  summary: "Set the default delivery address",
  description: "Public buyer flow (Turnstile + rate limit). Clears the old default atomically in one batch.",
  middleware: [...buyerMutating],
  request: { params: idParams, headers: turnstileTokenHeader },
  responses: {
    200: {
      content: { "application/json": { schema: addressOkSchema } },
      description: "Address promoted to default (atomic swap)",
    },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or address" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

customerAddresses.openapi(makeDefaultRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await makeDefaultAddress(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address: row });
}, validationHook);
