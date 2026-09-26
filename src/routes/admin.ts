import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { AppEnv, Env } from "../env.js";
import { getDb } from "../db.js";
import { resourceId } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam } from "../openapi/params.js";
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
  subscriptionNotifyTarget,
} from "../services/subscriptions.js";
import { buildSubscriptionEmail, fireOutboxMail } from "../services/mail-outbox.js";
import {
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  updatePlan,
} from "../services/plans.js";
import {
  deleteMerchant,
  getMerchantPublic,
  getUserPublic,
  resetUserPassword,
  searchMerchants,
  updateMerchantByAdmin,
} from "../services/users.js";
import { deleteStoreByAdmin, getStoreById, listStoresForOwner } from "../services/stores.js";
import {
  deleteCustomer,
  getCustomer,
  searchCustomers,
  updateCustomer,
} from "../services/customers.js";

export const admin = new OpenAPIHono<AppEnv>();

// Merchant notice for sub lifecycle events, post-commit via the exactly-once
// outbox. Never throws: mail can never fail admin operations.
async function notifySubOwner(
  db: D1Database,
  env: Env,
  c: unknown,
  sub: { id: string },
  event: "activated" | "cancelled" | "renewed",
  detail: string
): Promise<void> {
  try {
    const target = await subscriptionNotifyTarget(db, sub.id);
    if (!target?.email) return;
    const msg = buildSubscriptionEmail(target.storeName, event, detail);
    await fireOutboxMail(db, env, c, `sub:${sub.id}:${event}`, {
      to: target.email,
      subject: msg.subject,
      text: msg.text,
    });
  } catch {
    // Fall through: mail never fails admin ops.
  }
}

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
  await notifySubOwner(getDb(c), c.env, c, sub, "activated", `Plan ${sub.plan_id}, ${sub.starts_at} to ${sub.ends_at ?? "open"}.`);
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
  await notifySubOwner(getDb(c), c.env, c, sub, "cancelled", `Cancelled at ${sub.cancelled_at ?? "now"}.`);
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
  await notifySubOwner(getDb(c), c.env, c, sub, "renewed", `Plan ${sub.plan_id}, ${sub.starts_at} to ${sub.ends_at ?? "open"}.`);
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

// --- plans (platform-level reference data, admin-managed) ---

const planDocSchema = z
  .object({
    id: z.string().openapi({ example: "plan_01J..." }),
    code: z.string().openapi({ example: "premium" }),
    name: z.string().openapi({ example: "Premium" }),
    price_monthly: z.number().openapi({ example: 250000 }),
    price_yearly: z.number().openapi({ example: 2500000 }),
    max_products: z.number().nullable().openapi({ example: 500 }),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Plan");

const planOkSchema = okOf(z.object({ plan: planDocSchema }));
const planIdParams = z.object({ id: idParam });

const codeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Plan code must be lowercase alphanumeric with dashes.");

const planCreateSchema = z.object({
  code: codeSchema,
  name: z.string().min(1).max(200),
  price_monthly: z.number().int().min(0).default(0),
  price_yearly: z.number().int().min(0).default(0),
  max_products: z.number().int().min(1).nullable().default(null),
});

const planPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  price_monthly: z.number().int().min(0).optional(),
  price_yearly: z.number().int().min(0).optional(),
  max_products: z.number().int().min(1).nullable().optional(),
});

const CREATE_PLAN_FORBIDDEN = ["id"] as const;
const UPDATE_PLAN_FORBIDDEN = ["id", "code"] as const;

const listPlansRoute = createRoute({
  method: "get",
  path: "/plans",
  summary: "List all plans",
  description: "Platform admin only. Platform-level reference data, not tenant-scoped.",
  middleware: [...authedAdmin],
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ plans: z.array(planDocSchema) })) } },
      description: "All plans",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
  },
});

admin.openapi(listPlansRoute, async (c) => {
  return ok(c, { plans: await listPlans(getDb(c)) });
}, validationHook);

const getPlanRoute = createRoute({
  method: "get",
  path: "/plans/:id",
  summary: "Get one plan",
  description: "Platform admin only.",
  middleware: [...authedAdmin],
  request: { params: planIdParams },
  responses: {
    200: {
      content: { "application/json": { schema: planOkSchema } },
      description: "The plan",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown plan" },
  },
});

admin.openapi(getPlanRoute, async (c) => {
  const plan = await getPlan(getDb(c), resourceId(c));
  if (!plan) throw new AppError("plan_not_found", 404, "Plan not found.");
  return ok(c, { plan });
}, validationHook);

const createPlanRoute = createRoute({
  method: "post",
  path: "/plans",
  summary: "Create a plan",
  description:
    "Platform admin only, audited. Code is unique and lowercase kebab-case; id is generated server-side. " +
    "max_products null means unlimited.",
  middleware: [...authedAdmin],
  request: {
    body: { content: { "application/json": { schema: planCreateSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: planOkSchema } },
      description: "Created plan",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Plan code already in use" },
  },
});

admin.openapi(createPlanRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, CREATE_PLAN_FORBIDDEN);
  const plan = await createPlan(getDb(c), c.req.valid("json"));
  auditLog("admin.plan.create", { actor: currentUser(c).id, result: plan.id });
  return ok(c, { plan }, 201);
}, validationHook);

const updatePlanRoute = createRoute({
  method: "patch",
  path: "/plans/:id",
  summary: "Update a plan",
  description:
    "Platform admin only, audited. Whitelisted name/prices/max_products only — code and id are immutable. " +
    "Edits affect future plan-limit enforcement; existing subscriptions keep working and their price_amount is untouched.",
  middleware: [...authedAdmin],
  request: {
    params: planIdParams,
    body: { content: { "application/json": { schema: planPatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: planOkSchema } },
      description: "Updated plan",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown plan" },
  },
});

admin.openapi(updatePlanRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, UPDATE_PLAN_FORBIDDEN);
  const plan = await updatePlan(getDb(c), resourceId(c), c.req.valid("json"));
  if (!plan) throw new AppError("plan_not_found", 404, "Plan not found.");
  auditLog("admin.plan.update", { actor: currentUser(c).id, result: plan.id });
  return ok(c, { plan });
}, validationHook);

const deletePlanRoute = createRoute({
  method: "delete",
  path: "/plans/:id",
  summary: "Delete a plan",
  description:
    "Platform admin only, audited. Hard delete; 409 while any subscription references the plan.",
  middleware: [...authedAdmin],
  request: { params: planIdParams },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } },
      description: "Deleted plan id",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown plan" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Plan referenced by subscriptions" },
  },
});

admin.openapi(deletePlanRoute, async (c) => {
  const targetId = resourceId(c);
  const result = await deletePlan(getDb(c), targetId);
  if (!result) throw new AppError("plan_not_found", 404, "Plan not found.");
  auditLog("admin.plan.delete", { actor: currentUser(c).id, result: targetId });
  return ok(c, result);
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
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only, or target is another admin" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown user" },
  },
});

admin.openapi(resetPasswordRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["store_id", "id"]);
  const targetId = resourceId(c);
  const target = await getUserPublic(getDb(c), targetId);
  if (!target) {
    throw new AppError("user_not_found", 404, "User not found.");
  }
  const me = currentUser(c);
  // Admins cannot reset other admins: without this, any admin could take
  // over every peer admin account (password + sessions). Self-reset stays
  // allowed (fail-closed compromise recovery; caller re-logs in).
  if (target.role === "admin" && target.id !== me.id) {
    throw new AppError("forbidden", 403, "Cannot reset another admin's password.");
  }
  const now = touch();
  await resetUserPassword(getDb(c), targetId, hashPassword(c.req.valid("json").new_password), now);
  auditLog("admin.user.password_reset", { actor: currentUser(c).id, result: targetId });
  return ok(c, { reset: true });
}, validationHook);

// --- merchant account management (platform admins only, audited) ---
//
// Merchants are role='merchant' user rows. Reads/writes below never touch
// admin rows (404, same as unknown ids) and never accept role, password
// hash, sessions, or tokens. Password changes reuse the existing assisted
// reset route; merchant deletion is blocked while stores exist (see
// deleteMerchant) so business history is never destroyed silently.

const merchantDocSchema = z
  .object({
    id: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    name: z.string(),
    role: z.string(),
    email_verified: z.number(),
    avatar_url: z.string().nullable(),
    is_active: z.number().optional(),
  })
  .openapi("AdminMerchant");

const merchantOkSchema = okOf(z.object({ merchant: merchantDocSchema }));

const storeRefSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    currency: z.string(),
    status: z.string(),
    is_published: z.number(),
  })
  .openapi("AdminMerchantStore");

const merchantPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: z.string().min(1).max(32).optional(),
  is_active: z.union([z.literal(0), z.literal(1)]).optional(),
});

const MERCHANT_FORBIDDEN = ["id", "role", "password_hash", "avatar_url", "store_id"] as const;

const listMerchantsRoute = createRoute({
  method: "get",
  path: "/merchants",
  summary: "List/search merchants",
  description:
    "Platform admin only. Merchants only (admin accounts never list). " +
    "Optional ?q= matches email (case-insensitive) or phone (any common formatting); capped result set.",
  middleware: [...authedAdmin],
  request: {
    query: z.object({ q: z.string().max(254).optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ merchants: z.array(merchantDocSchema) })) },
      },
      description: "Matching merchants, newest first",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
  },
});

admin.openapi(listMerchantsRoute, async (c) => {
  const q = c.req.valid("query").q ?? null;
  return ok(c, { merchants: await searchMerchants(getDb(c), q) });
}, validationHook);

const getMerchantRoute = createRoute({
  method: "get",
  path: "/merchants/:id",
  summary: "Get a merchant with their stores",
  description: "Platform admin only. 404 for unknown ids and admin accounts.",
  middleware: [...authedAdmin],
  request: { params: idParams },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(z.object({ merchant: merchantDocSchema, stores: z.array(storeRefSchema) })),
        },
      },
      description: "Merchant plus owned stores",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown merchant" },
  },
});

admin.openapi(getMerchantRoute, async (c) => {
  const targetId = resourceId(c);
  const merchant = await getMerchantPublic(getDb(c), targetId);
  if (!merchant) throw new AppError("user_not_found", 404, "User not found.");
  return ok(c, {
    merchant,
    stores: await listStoresForOwner(getDb(c), targetId),
  });
}, validationHook);

const updateMerchantRoute = createRoute({
  method: "patch",
  path: "/merchants/:id",
  summary: "Update a merchant",
  description:
    "Platform admin only, audited. Editable: name, email, phone, is_active. " +
    "Phone/email are normalized and uniqueness-checked like self-service. " +
    "id, role, password hash, and avatar in the body are 400.",
  middleware: [...authedAdmin],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: merchantPatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: merchantOkSchema } },
      description: "Updated merchant",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown merchant" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Phone or email already registered" },
  },
});

admin.openapi(updateMerchantRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, MERCHANT_FORBIDDEN);
  const targetId = resourceId(c);
  const merchant = await updateMerchantByAdmin(getDb(c), targetId, c.req.valid("json"));
  if (!merchant) throw new AppError("user_not_found", 404, "User not found.");
  auditLog("admin.merchant.update", { actor: currentUser(c).id, result: targetId });
  return ok(c, { merchant });
}, validationHook);

const deleteMerchantRoute = createRoute({
  method: "delete",
  path: "/merchants/:id",
  summary: "Delete a merchant permanently",
  description:
    "Platform admin only, audited. 409 while the merchant owns any store, " +
    "so business history is never destroyed. Never targets admins or self.",
  middleware: [...authedAdmin],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } },
      description: "Deleted merchant id",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only, or self-delete" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown merchant" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Merchant owns stores" },
  },
});

admin.openapi(deleteMerchantRoute, async (c) => {
  const targetId = resourceId(c);
  const me = currentUser(c);
  if (targetId === me.id) {
    throw new AppError("forbidden", 403, "Cannot delete your own admin account.");
  }
  const target = await getMerchantPublic(getDb(c), targetId);
  if (!target) throw new AppError("user_not_found", 404, "User not found.");
  const result = await deleteMerchant(getDb(c), targetId);
  auditLog("admin.merchant.delete", { actor: me.id, result: targetId });
  return ok(c, result);
}, validationHook);

const deleteMerchantStoreRoute = createRoute({
  method: "delete",
  path: "/merchants/:id/stores/:storeId",
  summary: "Delete a merchant's store permanently",
  description:
    "Platform admin only, audited. The store must belong to the selected " +
    "merchant account — anything else answers 404, so one merchant's stores " +
    "can never be touched through another merchant. 409 while the store " +
    "has orders or subscriptions. Schema-defined cascades (catalog, " +
    "customers, carts, billing, themes) apply; nothing else is removed.",
  middleware: [...authedAdmin],
  request: { params: z.object({ id: idParam, storeId: storeIdParam }) },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } },
      description: "Deleted store id",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown merchant or store" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Store has orders, subscriptions, or dependents" },
  },
});

admin.openapi(deleteMerchantStoreRoute, async (c) => {
  const targetId = resourceId(c);
  const storeId = resourceId(c, "storeId");
  const merchant = await getMerchantPublic(getDb(c), targetId);
  if (!merchant) throw new AppError("user_not_found", 404, "User not found.");
  const result = await deleteStoreByAdmin(getDb(c), targetId, storeId);
  auditLog("admin.store.delete", { actor: currentUser(c).id, store: storeId, result: targetId });
  return ok(c, result);
}, validationHook);

// --- admin customer management (scoped through the merchant's stores) ---
//
// The frontend only ever calls these with stores from the selected
// merchant's store list. Customers stay store-scoped: every operation
// reuses the existing customer services, so validation, phone
// normalization, and the order-history 409 behave identically.

const customerDocSchema = z
  .object({
    id: z.string(),
    store_id: z.string(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
  })
  .openapi("AdminCustomer");

const customerOkSchema = okOf(z.object({ customer: customerDocSchema }));

const adminCustomerPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(64).optional(),
  email: z.string().email().max(254).nullable().optional(),
});

const ADMIN_CUSTOMER_FORBIDDEN = ["store_id", "id"] as const;

// Admin store scope: the path store must exist (404 otherwise). No
// merchant linkage is asserted here — the UI only ever passes stores from
// the selected merchant's list, and admin routes are cross-store by design
// (see the file header). Every customer operation below stays store-scoped
// through the shared customer services.
async function storeScopeAdmin(c: Context<AppEnv>): Promise<{ storeId: string }> {
  const storeId = resourceId(c, "storeId");
  const store = await getStoreById(getDb(c), storeId);
  if (!store) throw new AppError("store_not_found", 404, "Store not found.");
  return { storeId };
}

const listStoreCustomersRoute = createRoute({
  method: "get",
  path: "/stores/:storeId/customers",
  summary: "List/search a store's customers",
  description:
    "Platform admin only. Store-scoped; optional ?q= matches email or phone. Capped result set.",
  middleware: [...authedAdmin],
  request: {
    params: z.object({ storeId: storeIdParam }),
    query: z.object({ q: z.string().max(254).optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ customers: z.array(customerDocSchema) })) },
      },
      description: "Matching customers",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

admin.openapi(listStoreCustomersRoute, async (c) => {
  const { storeId } = await storeScopeAdmin(c);
  const q = c.req.valid("query").q ?? null;
  return ok(c, { customers: await searchCustomers(getDb(c), storeId, q) });
}, validationHook);

const getStoreCustomerRoute = createRoute({
  method: "get",
  path: "/stores/:storeId/customers/:id",
  summary: "Get a store customer",
  description: "Platform admin only. 404 for an unknown store or customer.",
  middleware: [...authedAdmin],
  request: { params: z.object({ storeId: storeIdParam, id: idParam }) },
  responses: {
    200: {
      content: { "application/json": { schema: customerOkSchema } },
      description: "The customer",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
  },
});

admin.openapi(getStoreCustomerRoute, async (c) => {
  const { storeId } = await storeScopeAdmin(c);
  const row = await getCustomer(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("customer_not_found", 404, "Customer not found.");
  return ok(c, { customer: row });
}, validationHook);

const updateStoreCustomerRoute = createRoute({
  method: "patch",
  path: "/stores/:storeId/customers/:id",
  summary: "Update a store customer",
  description:
    "Platform admin only, audited. Same validation as the merchant flow: " +
    "name/phone/email, phone re-normalized, 409 when taken.",
  middleware: [...authedAdmin],
  request: {
    params: z.object({ storeId: storeIdParam, id: idParam }),
    body: { content: { "application/json": { schema: adminCustomerPatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: customerOkSchema } },
      description: "Updated customer",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Phone taken by another customer" },
  },
});

admin.openapi(updateStoreCustomerRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ADMIN_CUSTOMER_FORBIDDEN);
  const { storeId } = await storeScopeAdmin(c);
  const row = await updateCustomer(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("customer_not_found", 404, "Customer not found.");
  auditLog("admin.customer.update", { actor: currentUser(c).id, store: storeId, result: row.id });
  return ok(c, { customer: row });
}, validationHook);

const deleteStoreCustomerRoute = createRoute({
  method: "delete",
  path: "/stores/:storeId/customers/:id",
  summary: "Delete a store customer",
  description:
    "Platform admin only, audited. 409 when the customer has orders, so order history stays intact.",
  middleware: [...authedAdmin],
  request: { params: z.object({ storeId: storeIdParam, id: idParam }) },
  responses: {
    200: {
      content: { "application/json": { schema: okOf(z.object({ deleted: z.string() })) } },
      description: "Deleted customer id",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or customer" },
    409: { content: { "application/json": { schema: failEnvelope } }, description: "Customer has orders" },
  },
});

admin.openapi(deleteStoreCustomerRoute, async (c) => {
  const { storeId } = await storeScopeAdmin(c);
  const result = await deleteCustomer(getDb(c), storeId, resourceId(c));
  auditLog("admin.customer.delete", { actor: currentUser(c).id, store: storeId, result: result.deleted });
  return ok(c, result);
}, validationHook);
