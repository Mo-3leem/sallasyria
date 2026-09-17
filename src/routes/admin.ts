import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam } from "../openapi/params.js";
import { auditLog } from "../lib/audit.js";
import { hashPassword, PASSWORD_RULES } from "../lib/password.js";
import { touch } from "../lib/time.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import {
  activateSubscription,
  cancelSubscription,
  getSubscription,
  listSubscriptions,
  renewSubscription,
} from "../services/subscriptions.js";
import { userExists, resetUserPassword } from "../services/users.js";
import { purgeIdempotencyKeys, purgeSessions } from "../services/maintenance.js";

export const admin = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
// Every route here is admin-only (requireRole) and every mutation is audited.
// No tenant scoping applies: admins operate cross-store by design, which is
// exactly why each action emits an audit event.

// --- subscriptions (manual Syrian billing: activate/renew/cancel) ---

const authedAdmin = [requireAuth, requireRole("admin")] as const;

const isoDateTime = z.string().datetime({ offset: true }).max(32);
const billingPeriod = z.enum(["monthly", "yearly"]);

const subscriptionDocSchema = z
  .object({
    id: z.string(),
    store_id: z.string(),
    plan_id: z.string(),
    status: z.string().openapi({ example: "active" }),
    billing_period: z.string(),
    price_amount: z.number(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    cancelled_at: z.string().nullable(),
    payment_reference: z.string().nullable(),
  })
  .openapi("Subscription");

const subscriptionOkSchema = okOf(z.object({ subscription: subscriptionDocSchema }));
const idParams = z.object({ id: idParam });

const listSubscriptionsRoute = createRoute({
  method: "get",
  path: "/subscriptions",
  summary: "List all subscriptions",
  description: "Platform admin only, audited. Filter by ?status=active|expired|cancelled.",
  middleware: [...authedAdmin],
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ subscriptions: z.array(subscriptionDocSchema) })) },
      },
      description: "All subscriptions, newest first (admin)",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
  },
});

admin.openapi(listSubscriptionsRoute, async (c) => {
  // No store filter: admin counts are small at MVP and every query-param
  // filter is a future tenant-confusion surface. Client filters instead.
  return ok(c, { subscriptions: await listSubscriptions(getDb(c)) });
}, validationHook);

const activateSchema = z.object({
  store_id: z.string().min(1),
  plan_id: z.string().min(1),
  billing_period: billingPeriod,
  starts_at: isoDateTime.optional(),
  ends_at: isoDateTime.nullable().default(null),
  price_amount: z.number().int().min(0).default(0),
  payment_reference: z.string().max(200).nullable().default(null),
});

const activateRoute = createRoute({
  method: "post",
  path: "/subscriptions",
  summary: "Grant a subscription to a store",
  description: "Platform admin only, audited. 409 while the store has another active subscription — cancel it first.",
  middleware: [...authedAdmin],
  request: { body: { content: { "application/json": { schema: activateSchema } } } },
  responses: {
    201: {
      content: { "application/json": { schema: subscriptionOkSchema } },
      description: "Activated subscription period",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or plan" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Store already has an active subscription" },
  },
});

admin.openapi(activateRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["id", "status", "cancelled_at"]);
  const sub = await activateSubscription(getDb(c), c.req.valid("json"));
  auditLog("admin.subscription.activate", { actor: currentUser(c).id, store: sub.store_id, result: sub.id });
  return ok(c, { subscription: sub }, 201);
}, validationHook);

const cancelSchema = z.object({
  cancelled_at: isoDateTime.optional(),
});

const cancelRoute = createRoute({
  method: "post",
  path: "/subscriptions/:id/cancel",
  summary: "Cancel a subscription",
  description: "Platform admin only, audited. Cancelling an already-cancelled subscription is a 200 no-op.",
  middleware: [...authedAdmin],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: cancelSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: subscriptionOkSchema } },
      description: "Cancelled subscription (idempotent)",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown subscription" },
  },
});

admin.openapi(cancelRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["id", "status", "store_id", "plan_id"]);
  const sub = await cancelSubscription(getDb(c), resourceId(c), c.req.valid("json").cancelled_at);
  auditLog("admin.subscription.cancel", { actor: currentUser(c).id, store: sub.store_id, result: sub.id });
  return ok(c, { subscription: sub });
}, validationHook);

const renewSchema = z.object({
  billing_period: billingPeriod.optional(),
  starts_at: isoDateTime.optional(),
  ends_at: isoDateTime.nullable().optional(),
  price_amount: z.number().int().min(0).optional(),
  payment_reference: z.string().max(200).nullable().optional(),
});

const renewRoute = createRoute({
  method: "post",
  path: "/subscriptions/:id/renew",
  summary: "Renew a subscription",
  description:
    "Platform admin only, audited. History is append-only: renewal creates a new period, " +
    "never mutates the original activation.",
  middleware: [...authedAdmin],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: renewSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: subscriptionOkSchema } },
      description: "New subscription period (history append-only)",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown subscription" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Store already has an active subscription" },
  },
});

admin.openapi(renewRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["id", "status", "cancelled_at", "store_id", "plan_id"]);
  const sub = await renewSubscription(getDb(c), resourceId(c), c.req.valid("json"));
  auditLog("admin.subscription.renew", { actor: currentUser(c).id, store: sub.store_id, result: sub.id });
  return ok(c, { subscription: sub }, 201);
}, validationHook);

const getSubscriptionRoute = createRoute({
  method: "get",
  path: "/subscriptions/:id",
  summary: "Get one subscription",
  description: "Platform admin only, audited.",
  middleware: [...authedAdmin],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: subscriptionOkSchema } },
      description: "The subscription",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown subscription" },
  },
});

admin.openapi(getSubscriptionRoute, async (c) => {
  const sub = await getSubscription(getDb(c), resourceId(c));
  if (!sub) throw new AppError("subscription_not_found", 404, "Subscription not found.");
  return ok(c, { subscription: sub });
}, validationHook);

// --- assisted password reset (no email/SMS infra in MVP) ---

const resetSchema = z.object({
  new_password: z.string().min(PASSWORD_RULES.minNewChars).max(PASSWORD_RULES.maxChars),
});

// Sets a user's password and revokes ALL of their sessions including the
// caller's own if self-targeted (fail-closed for compromise; the admin
// re-logs in). Audited.
const resetPasswordRoute = createRoute({
  method: "post",
  path: "/users/:id/password",
  summary: "Reset any user's password",
  description:
    "Platform admin only, audited. Revokes every session of the target; admins cannot reset other admins.",
  middleware: [...authedAdmin],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: resetSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ reset: z.boolean() })) } },
      description: "Password reset; all target sessions revoked",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown user" },
  },
});

admin.openapi(resetPasswordRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["store_id", "id"]);
  const targetId = resourceId(c);
  if (!(await userExists(getDb(c), targetId))) {
    throw new AppError("user_not_found", 404, "User not found.");
  }
  const now = touch();
  await resetUserPassword(getDb(c), targetId, hashPassword(c.req.valid("json").new_password), now);
  auditLog("admin.user.password_reset", { actor: currentUser(c).id, result: targetId });
  return ok(c, { reset: true });
}, validationHook);

// --- local-only maintenance (purge) ---

const purgeSchema = z.object({
  sessions_older_than_days: z.number().int().min(1).max(3650).default(30),
  idempotency_older_than_days: z.number().int().min(1).max(3650).default(3),
});

// Runs the same purge functions as the production cron, but ONLY in
// development: in any other environment this route does not exist (404), so
// there is no remote mass-delete surface to audit or abuse.
const purgeRoute = createRoute({
  method: "post",
  path: "/maintenance/purge",
  summary: "Purge everything except the admin (dev only)",
  description: "Danger: wipes all stores, subscriptions, sessions, and idempotency keys. Refused outside development.",
  middleware: [requireAuth, requireRole("admin")],
  request: { body: { content: { "application/json": { schema: purgeSchema } } } },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(z.object({ sessionsPurged: z.number(), idempotencyKeysPurged: z.number() })),
        },
      },
      description: "Purge counts",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Not a development environment" },
  },
});

admin.openapi(purgeRoute, async (c) => {
  if ((c.env.ENVIRONMENT ?? "development") !== "development") {
    throw new AppError("not_found", 404, "Route does not exist.");
  }
  const { sessions_older_than_days, idempotency_older_than_days } = c.req.valid("json");
  const nowMs = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const cutoff = (days: number) =>
    new Date(nowMs - days * dayMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sessionsPurged = await purgeSessions(getDb(c), cutoff(sessions_older_than_days));
  const idempotencyKeysPurged = await purgeIdempotencyKeys(getDb(c), cutoff(idempotency_older_than_days));
  return ok(c, { sessionsPurged, idempotencyKeysPurged });
}, validationHook);
