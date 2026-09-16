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
  getOrder,
  listOrders,
  transitionOrderStatus,
  transitionPaymentStatus,
} from "../services/orders.js";

export const orders = new Hono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
//
// Merchant-private: order rows carry buyer PII and there is no buyer login in
// MVP, so reads and transitions require an owning (or admin) session.
// Mutations additionally require a covering subscription.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const merchantMutating = [...authed, requireActiveSubscription] as const;

const FORBIDDEN = ["store_id", "id"] as const;

orders.get("/", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { orders: await listOrders(getDb(c), storeId) });
});

orders.get("/:id", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const found = await getOrder(getDb(c), storeId, resourceId(c));
  if (!found) throw new AppError("order_not_found", 404, "Order not found.");
  return ok(c, found);
});

const statusSchema = z.object({
  status: z.enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"]),
});

orders.patch("/:id/status", ...merchantMutating, zBodyValidator(statusSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const order = await transitionOrderStatus(getDb(c), storeId, resourceId(c), c.req.valid("json").status);
  if (!order) throw new AppError("order_not_found", 404, "Order not found.");
  return ok(c, { order });
});

const paymentSchema = z.object({
  payment_status: z.enum(["pending", "paid", "failed", "refunded"]),
});

orders.patch("/:id/payment", ...merchantMutating, zBodyValidator(paymentSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const order = await transitionPaymentStatus(getDb(c), storeId, resourceId(c), c.req.valid("json").payment_status);
  if (!order) throw new AppError("order_not_found", 404, "Order not found.");
  return ok(c, { order });
});
