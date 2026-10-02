import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { orderDocSchema, orderItemDocSchema } from "../openapi/orders.js";
import { idParam, storeIdParam, storeIdParams } from "../openapi/params.js";
import { pageMeta, pageMetaSchema, pageQuerySchema } from "../lib/pagination.js";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveStore, requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  getOrder,
  listOrders,
  orderNotifyTarget,
  transitionOrderStatus,
  transitionPaymentStatus,
} from "../services/orders.js";
import { buildStatusEmail } from "../services/mail.js";
import { fireOutboxMail } from "../services/mail-outbox.js";

export const orders = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
//
// Merchant-private: order rows carry buyer PII and there is no buyer login in
// MVP, so reads and transitions require an owning (or admin) session.
// Mutations additionally require a covering subscription.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const merchantMutating = [...authed, requireActiveSubscription, requireActiveStore] as const;

const FORBIDDEN = ["store_id", "id"] as const;

const orderWithItemsSchema = okOf(
  z.object({ order: orderDocSchema, items: z.array(orderItemDocSchema) })
);
const idParams = z.object({ storeId: storeIdParam, id: idParam });

const listOrdersRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List orders",
  description: "Orders of the store, newest first. Paginated; optional server-side ?status= filter.",
  middleware: [...authed],
  request: {
    params: storeIdParams,
    query: pageQuerySchema.extend({
      status: z.enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ orders: z.array(orderDocSchema), pagination: pageMetaSchema })) },
      },
      description: "Orders of the store, newest first, with pagination metadata",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid page, page size, or status" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

orders.openapi(listOrdersRoute, async (c) => {
  const { storeId } = storeScope(c);
  const query = c.req.valid("query");
  const { orders, total } = await listOrders(getDb(c), storeId, {
    status: query.status ?? null,
    page: query.page,
    pageSize: query.page_size,
  });
  return ok(c, {
    orders,
    pagination: pageMeta(total, query.page, query.page_size),
  });
}, validationHook);

const getOrderRoute = createRoute({
  method: "get",
  path: "/:id",
  summary: "Get one order",
  description: "Full order with frozen item snapshots and computed totals. 404 for an unknown store or order.",
  middleware: [...authed],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: orderWithItemsSchema } },
      description: "Order with snapshot lines",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or order" },
  },
});

orders.openapi(getOrderRoute, async (c) => {
  const { storeId } = storeScope(c);
  const found = await getOrder(getDb(c), storeId, resourceId(c));
  if (!found) throw new AppError("order_not_found", 404, "Order not found.");
  return ok(c, found);
}, validationHook);

const statusSchema = z.object({
  status: z.enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"]),
});

const statusTransitionRoute = createRoute({
  method: "patch",
  path: "/:id/status",
  summary: "Advance or cancel an order",
  description:
    "Stepwise lifecycle pending → confirmed → processing → shipped → delivered; " +
    "cancel is allowed until handover to the courier. Anything else is 409.",
  middleware: [...merchantMutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: statusSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ order: orderDocSchema })) } },
      description: "Order after transition",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or order" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Transition not allowed" },
  },
});

orders.openapi(statusTransitionRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const to = c.req.valid("json").status;
  const order = await transitionOrderStatus(getDb(c), storeId, resourceId(c), to);
  if (!order) throw new AppError("order_not_found", 404, "Order not found.");
  // Buyer notice for the CAS-applied transition only (failures throw above),
  // post-commit via the exactly-once outbox.
  try {
    const target = await orderNotifyTarget(getDb(c), storeId, order.id);
    if (target?.email) {
      const msg = buildStatusEmail(target.storeName, target.orderNumber, "status", to, null);
      await fireOutboxMail(getDb(c), c.env, c, `order:${order.id}:status:${to}`, {
        to: target.email,
        subject: msg.subject,
        text: msg.text,
      });
    }
  } catch {
    // Mail never fails transitions.
  }
  return ok(c, { order });
}, validationHook);

const paymentSchema = z.object({
  payment_status: z.enum(["pending", "paid", "failed", "refunded"]),
});

const paymentTransitionRoute = createRoute({
  method: "patch",
  path: "/:id/payment",
  summary: "Record payment status",
  description:
    "pending → paid or failed; paid → refunded; failed may retry to paid. " +
    "Anything else is 409.",
  middleware: [...merchantMutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: paymentSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ order: orderDocSchema })) } },
      description: "Order after payment transition",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or order" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Transition not allowed" },
  },
});

orders.openapi(paymentTransitionRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const to = c.req.valid("json").payment_status;
  const order = await transitionPaymentStatus(getDb(c), storeId, resourceId(c), to);
  if (!order) throw new AppError("order_not_found", 404, "Order not found.");
  try {
    const target = await orderNotifyTarget(getDb(c), storeId, order.id);
    if (target?.email) {
      const msg = buildStatusEmail(target.storeName, target.orderNumber, "payment", to, null);
      await fireOutboxMail(getDb(c), c.env, c, `order:${order.id}:payment:${to}`, {
        to: target.email,
        subject: msg.subject,
        text: msg.text,
      });
    }
  } catch {
    // Mail never fails transitions.
  }
  return ok(c, { order });
}, validationHook);
