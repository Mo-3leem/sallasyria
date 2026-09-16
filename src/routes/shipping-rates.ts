import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
import { GOVERNORATES } from "../lib/governorates.js";
import { requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createRate,
  deleteRate,
  getRate,
  listRates,
  updateRate,
} from "../services/customers.js";

export const shippingRates = new Hono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
//
// PUBLIC / PRIVATE SPLIT: rates carry no secrets and the storefront needs
// them to quote delivery, so both reads are PUBLIC (scoped by path store,
// server-resolved as always). All mutations stay merchant-private + gated.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const merchantMutating = [...authed, requireActiveSubscription] as const;
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

shippingRates.get("/", ...scopedRead, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { rates: await listRates(getDb(c), storeId) });
});

shippingRates.get("/:id", ...scopedRead, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getRate(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("rate_not_found", 404, "Shipping rate not found.");
  return ok(c, { rate: row });
});

shippingRates.post("/", ...merchantMutating, zBodyValidator(rateSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["store_id", "id"]);
  const { storeId } = storeScope(c);
  return ok(c, { rate: await createRate(getDb(c), storeId, c.req.valid("json")) }, 201);
});

shippingRates.patch("/:id", ...merchantMutating, zBodyValidator(ratePatchSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  // Governorate is identity here (UNIQUE per store): changing it is really
  // delete+create, so it is forbidden on PATCH to keep semantics explicit.
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateRate(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("rate_not_found", 404, "Shipping rate not found.");
  return ok(c, { rate: row });
});

shippingRates.delete("/:id", ...merchantMutating, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, await deleteRate(getDb(c), storeId, resourceId(c)));
});
