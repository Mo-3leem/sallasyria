import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam, storeIdParams, turnstileTokenHeader } from "../openapi/params.js";
import { requireAuth } from "../middleware/auth.js";
import { requireTurnstile } from "../middleware/turnstile.js";
import { limitPublicMutations } from "../middleware/public.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  deleteCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
  upsertCustomer,
} from "../services/customers.js";

export const customers = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
//
// PUBLIC / PRIVATE SPLIT (roadmap B5, binding):
// - POST / ................. PUBLIC buyer upsert (no login exists for buyers).
//   Turnstile + per-store rate limit apply; the (store_id, phone) UNIQUE plus
//   server-side normalization is the abuse backstop.
// - GET currently allow unauthenticated reads (no PII beyond what the buyer
//   typed) — every other read/manage route stays merchant-private.
// - GET /:id, PATCH, DELETE . merchant-private (+ gate on mutations).

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const merchantMutating = [...authed, requireActiveSubscription] as const;
const buyerMutating = [resolveStore, limitPublicMutations, requireTurnstile()] as const;

const emailSchema = z.string().email().max(254).nullable().default(null);

const upsertSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(64),
  email: emailSchema.optional(),
});

const customerPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(64).optional(),
  // No .default(null) here (unlike the shared emailSchema used by POST):
  // an omitted email must stay undefined so the service merge preserves the
  // stored value. Explicit null still clears, per contract.
  email: z.string().email().max(254).nullable().optional(),
});

const FORBIDDEN = ["store_id", "id"] as const;

const customerDocSchema = z
  .object({
    id: z.string().openapi({ example: "cust_01J..." }),
    store_id: z.string(),
    name: z.string().openapi({ example: "Layla Haddad" }),
    phone: z.string().openapi({ example: "+963991234567" }),
    email: z.string().nullable(),
  })
  .openapi("Customer");

const customerOkSchema = okOf(z.object({ customer: customerDocSchema }));
const idParams = z.object({ storeId: storeIdParam, id: idParam });

const upsertCustomerRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create or update a customer by phone",
  description:
    "Public buyer flow (Turnstile + rate limit). Phone is normalized server-side; " +
    "the same phone in another store is a different customer. Always 200.",
  middleware: [...buyerMutating],
  request: {
    params: storeIdParams,
    headers: turnstileTokenHeader,
    body: { content: { "application/json": { schema: upsertSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: customerOkSchema } },
      description: "Created or updated customer (idempotent by phone)",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body, phone, or immutable field" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Bot verification failed" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Rate limited" },
  },
});

customers.openapi(upsertCustomerRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  // Upserts are idempotent writes: always 200, whether the row was created
  // or updated (distinguishing would cost an extra read for zero benefit).
  const row = await upsertCustomer(getDb(c), storeId, c.req.valid("json"));
  return ok(c, { customer: row });
}, validationHook);

const listCustomersRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List customers",
  description: "All customers of the store.",
  middleware: [...authed],
  request: { params: storeIdParams },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ customers: z.array(customerDocSchema) })) },
      },
      description: "Customers of the store",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

customers.openapi(listCustomersRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { customers: await listCustomers(getDb(c), storeId) });
}, validationHook);

const getCustomerRoute = createRoute({
  method: "get",
  path: "/:id",
  summary: "Get one customer",
  description: "404 for an unknown store or customer.",
  middleware: [...authed],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: customerOkSchema } },
      description: "The customer",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
  },
});

customers.openapi(getCustomerRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getCustomer(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("customer_not_found", 404, "Customer not found.");
  return ok(c, { customer: row });
}, validationHook);

const updateCustomerRoute = createRoute({
  method: "patch",
  path: "/:id",
  summary: "Update a customer",
  description: "Partial update; phone changes are re-normalized and 409 when taken by another customer.",
  middleware: [...merchantMutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: customerPatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: customerOkSchema } },
      description: "Updated customer",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Phone taken by another customer" },
  },
});

customers.openapi(updateCustomerRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateCustomer(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("customer_not_found", 404, "Customer not found.");
  return ok(c, { customer: row });
}, validationHook);

const deleteCustomerRoute = createRoute({
  method: "delete",
  path: "/:id",
  summary: "Delete a customer",
  description: "409 when the customer has orders, so order history stays intact.",
  middleware: [...merchantMutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } },
      description: "Deleted customer id",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Customer has orders" },
  },
});

customers.openapi(deleteCustomerRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, await deleteCustomer(getDb(c), storeId, resourceId(c)));
}, validationHook);
