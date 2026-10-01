import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam } from "../openapi/params.js";
import { auditEvent } from "../services/audit.js";
import { checkBillingIntentLimit, checkWebhookIpLimit, clientIp } from "../lib/rate-limit.js";
import { configuredProvider, selectProvider } from "../lib/billing/registry.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import {
  createBillingIntent,
  getIntent,
  getIntentForStore,
  hasIntentWithKey,
  listAllIntents,
  listIntentsForStore,
  settleWebhook,
} from "../services/billing.js";
import { listSubscriptions, storeOwnerNotifyTarget } from "../services/subscriptions.js";
import { buildSubscriptionEmail, fireOutboxMail } from "../services/mail-outbox.js";

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). All queries live in services/billing.ts + subscriptions.ts.
//
// Two routers in one file: store-scoped buyer/merchant flows mount under
// /stores/:storeId, the provider webhook mounts at /billing (public).

export const storeBilling = new OpenAPIHono<AppEnv>();
export const billingWebhook = new OpenAPIHono<AppEnv>();

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const authedAdmin = [requireAuth, requireRole("admin")] as const;

const billingPeriod = z.enum(["monthly", "yearly"]);

const intentDocSchema = z
  .object({
    id: z.string().openapi({ example: "bill_01J..." }),
    store_id: z.string(),
    plan_id: z.string(),
    billing_period: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.string().openapi({ example: "pending" }),
    provider: z.string(),
    expires_at: z.string().nullable(),
  })
  .openapi("BillingIntent");

const subscriptionDocSchema = z
  .object({
    id: z.string(),
    store_id: z.string(),
    plan_id: z.string(),
    status: z.string(),
    billing_period: z.string(),
    price_amount: z.number(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    cancelled_at: z.string().nullable(),
    payment_reference: z.string().nullable(),
  })
  .openapi("StoreSubscription");

// Client money is rejected outright: the price always comes from plans.
// Forbidden on top of the tenant defaults for the same reason checkout
// rejects totals (fail-closed beats ignore-silently).
const CHECKOUT_FORBIDDEN = ["store_id", "id", "amount", "currency", "price_amount"] as const;

const checkoutSchema = z.object({
  plan_id: z.string().min(1),
  billing_period: billingPeriod,
});

const IDEMPOTENCY_HEADER = "X-Idempotency-Key";

const checkoutRoute = createRoute({
  method: "post",
  path: "/subscriptions/checkout",
  summary: "Start a self-serve subscription checkout",
  description:
    "Authenticated owner/admin flow (NO subscription gate: this is how an " +
    "uncovered store pays). Price is loaded server-side from the plan — any " +
    "client amount is 400. Idempotent per store via X-Idempotency-Key " +
    "(replay returns the same intent; differing body is 422). Returns a " +
    "provider redirect URL; money never touches our servers.",
  middleware: [...authed],
  request: {
    params: z.object({ storeId: storeIdParam }),
    body: { content: { "application/json": { schema: checkoutSchema } } },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: okOf(
            z.object({ intent_id: z.string(), redirect_url: z.string() })
          ),
        },
      },
      description: "Checkout intent + provider redirect",
    },
    200: {
      content: {
        "application/json": {
          schema: okOf(
            z.object({ intent_id: z.string(), redirect_url: z.string() })
          ),
        },
      },
      description: "Replayed intent (idempotency key already used)",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or client money field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or plan" },
    422: { content: { "application/json": { schema: failEnvelope } }, description: "Idempotency key reused with a different checkout" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Too many attempts" }
  },
});

storeBilling.openapi(checkoutRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, CHECKOUT_FORBIDDEN);
  const { storeId } = storeScope(c);
  const input = c.req.valid("json");
  const key = c.req.header(IDEMPOTENCY_HEADER) ?? null;
  // Abuse guard: each fresh intent below costs one provider call plus a row.
  // Replays bypass the limiter so idempotent retries stay valid: when the
  // key already exists, createBillingIntent below returns the existing
  // replay (200) or conflict (422) exactly as before. Only new keys — and
  // keyless requests, which always mint — consume quota.
  if (key === null || !(await hasIntentWithKey(getDb(c), storeId, key))) {
    if (!checkBillingIntentLimit(storeId)) {
      throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
    }
  }
  const { intent, redirectUrl, replayed } = await createBillingIntent(
    getDb(c),
    c.env,
    {
      storeId,
      planId: input.plan_id,
      billingPeriod: input.billing_period,
      idempotencyKey: key,
    }
  );
  await auditEvent(c, getDb(c),"billing.checkout.start", {
    actor: currentUser(c).id,
    store: storeId,
    result: intent.id,
  });
  return ok(
    c,
    { intent_id: intent.id, redirect_url: redirectUrl },
    replayed ? 200 : 201
  );
}, validationHook);

const storeSubscriptionsRoute = createRoute({
  method: "get",
  path: "/subscriptions",
  summary: "List a store's subscription periods",
  description:
    "Merchant-private read of the store's own billing history (active, " +
    "trialing, cancelled, expired). Reads are open by design; the " +
    "subscription gate mounts on mutating routes only.",
  middleware: [...authed],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(z.object({ subscriptions: z.array(subscriptionDocSchema) })),
        },
      },
      description: "Subscription periods, newest first",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

storeBilling.openapi(storeSubscriptionsRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { subscriptions: await listSubscriptions(getDb(c), storeId) });
}, validationHook);

const getIntentRoute = createRoute({
  method: "get",
  path: "/billing/intents/:id",
  summary: "Poll one checkout intent",
  description:
    "Owner/admin polling after the provider return (lost-webhook / " +
    "closed-tab recovery). Exposes status + amounts only — no secrets, no " +
    "raw provider payloads.",
  middleware: [...authed],
  request: {
    params: z.object({ storeId: storeIdParam, id: idParam }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ intent: intentDocSchema })) },
      },
      description: "The intent",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or intent" },
  },
});

storeBilling.openapi(getIntentRoute, async (c) => {
  const { storeId } = storeScope(c);
  const intent = await getIntentForStore(getDb(c), storeId, resourceId(c));
  if (!intent) throw new AppError("intent_not_found", 404, "Intent not found.");
  return ok(c, { intent });
}, validationHook);

const listStoreIntentsRoute = createRoute({
  method: "get",
  path: "/billing/intents",
  summary: "List a store's checkout intents",
  description: "Owner/admin history of checkout attempts, newest first.",
  middleware: [...authed],
  request: { params: z.object({ storeId: storeIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ intents: z.array(intentDocSchema) })) },
      },
      description: "Checkout intents, newest first",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

storeBilling.openapi(listStoreIntentsRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { intents: await listIntentsForStore(getDb(c), storeId) });
}, validationHook);

const adminIntentsRoute = createRoute({
  method: "get",
  path: "/admin/intents",
  summary: "List all checkout intents",
  description:
    "Platform admin only. Cross-store billing monitoring; newest first.",
  middleware: [...authedAdmin],
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ intents: z.array(intentDocSchema) })) },
      },
      description: "All checkout intents, newest first",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Admin only" },
  },
});

billingWebhook.openapi(adminIntentsRoute, async (c) => {
  return ok(c, { intents: await listAllIntents(getDb(c)) });
}, validationHook);

// ---- provider webhook (PUBLIC: providers cannot authenticate) --------
//
// Unknown, duplicate, expired, and tampered deliveries all resolve 200
// with processed:false (no oracle, provider retries converge). Only a
// verified success/failure flips the intent row. Missing signing secrets
// outside development fail closed with 503 via the adapter. Logging is
// method+path+status+intent_id only — never payloads or secrets.

const webhookRoute = createRoute({
  method: "post",
  path: "/webhook/:provider",
  summary: "Receive a provider payment webhook",
  description:
    "Provider-to-server callback. Signature/timestamp/replay verified by " +
    "the configured adapter; success appends exactly one active period " +
    "(concurrent double-pays collapse idempotently).",
  request: {
    params: z.object({ provider: z.string().min(1).max(64) }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(
            z.object({
              processed: z.boolean(),
              activated: z.boolean(),
              duplicate: z.boolean(),
            })
          ),
        },
      },
      description: "Webhook accepted (processed reports whether it changed anything)",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Bad signature, stale event, or malformed payload" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown provider" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Too many attempts" },
    503: { content: { "application/json": { schema: failEnvelope } }, description: "Provider not configured" },
  },
});

billingWebhook.openapi(webhookRoute, async (c) => {
  // Flood guard first (cheap reject before any crypto/DB work). Generous on
  // purpose: legitimate provider retries are sparse; HMAC verification below
  // stays the real boundary and keeps its exact failure shapes.
  if (!checkWebhookIpLimit(clientIp(c))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const pathProvider = resourceId(c, "provider");
  const adapter = selectProvider(pathProvider);
  if (adapter.name !== configuredProvider(c.env).name) {
    throw new AppError("unknown_provider", 404, "Unknown payment provider.");
  }
  const result = await adapter.verifyWebhook(c.req.raw, c.env);
  const outcome = await settleWebhook(getDb(c), result);
  // Merchant notice for a newly settled payment (success or fail), post-
  // commit via the exactly-once outbox. Duplicates/replays were already
  // notified; mail never fails the webhook.
  if (outcome.processed && !outcome.duplicate) {
    try {
      const intent = await getIntent(getDb(c), result.intentId);
      const target = intent ? await storeOwnerNotifyTarget(getDb(c), intent.store_id) : null;
      if (target?.email) {
        const failed = !outcome.activated;
        const msg = buildSubscriptionEmail(
          target.storeName,
          failed ? "payment_failed" : "activated",
          failed
            ? `Payment ${intent?.id ?? ""} failed or mismatched; no coverage was recorded.`
            : `Payment ${intent?.id ?? ""} succeeded and coverage was recorded.`
        );
        await fireOutboxMail(getDb(c), c.env, c, `intent:${result.intentId}:settled`, {
          to: target.email,
          subject: msg.subject,
          text: msg.text,
        });
      }
    } catch {
      // Fall through to the normal 200 below.
    }
  }
  return ok(c, {
    processed: outcome.processed,
    activated: outcome.activated,
    duplicate: outcome.duplicate,
  });
}, validationHook);
