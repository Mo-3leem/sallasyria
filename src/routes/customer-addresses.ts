import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
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

export const customerAddresses = new Hono<AppEnv>();

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

customerAddresses.post("/", ...buyerMutating, zBodyValidator(addressSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, CREATE_FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { address: await createAddress(getDb(c), storeId, c.req.valid("json")) }, 201);
});

customerAddresses.get("/", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const customerId = c.req.query("customer_id");
  if (!customerId) {
    throw new AppError("validation_failed", 400, "Missing customer_id query.");
  }
  return ok(c, { addresses: await listAddresses(getDb(c), storeId, customerId) });
});

customerAddresses.get("/:id", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getAddress(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address: row });
});

customerAddresses.patch("/:id", ...merchantMutating, zBodyValidator(addressPatchSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, PATCH_FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateAddress(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address: row });
});

customerAddresses.delete("/:id", ...merchantMutating, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, await deleteAddress(getDb(c), storeId, resourceId(c)));
});

customerAddresses.post("/:id/make-default", ...buyerMutating, async (c) => {
  const { storeId } = storeScope(c);
  const row = await makeDefaultAddress(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("address_not_found", 404, "Address not found.");
  return ok(c, { address: row });
});
