import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
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

export const customers = new Hono<AppEnv>();

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
  email: emailSchema.optional(),
});

const FORBIDDEN = ["store_id", "id"] as const;

customers.post("/", ...buyerMutating, zBodyValidator(upsertSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  // Upserts are idempotent writes: always 200, whether the row was created
  // or updated (distinguishing would cost an extra read for zero benefit).
  const row = await upsertCustomer(getDb(c), storeId, c.req.valid("json"));
  return ok(c, { customer: row });
});

customers.get("/", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { customers: await listCustomers(getDb(c), storeId) });
});

customers.get("/:id", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getCustomer(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("customer_not_found", 404, "Customer not found.");
  return ok(c, { customer: row });
});

customers.patch("/:id", ...merchantMutating, zBodyValidator(customerPatchSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateCustomer(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("customer_not_found", 404, "Customer not found.");
  return ok(c, { customer: row });
});

customers.delete("/:id", ...merchantMutating, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, await deleteCustomer(getDb(c), storeId, resourceId(c)));
});
