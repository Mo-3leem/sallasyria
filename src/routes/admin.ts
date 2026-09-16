import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
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

export const admin = new Hono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Enforced by tests/tenant-conventions.test.ts.
// Every route here is admin-only (requireRole) and every mutation is audited.
// No tenant scoping applies: admins operate cross-store by design, which is
// exactly why each action emits an audit event.

// --- subscriptions (manual Syrian billing: activate/renew/cancel) ---

const authedAdmin = [requireAuth, requireRole("admin")] as const;

const isoDateTime = z.string().datetime({ offset: true }).max(32);
const billingPeriod = z.enum(["monthly", "yearly"]);

admin.get("/subscriptions", ...authedAdmin, async (c) => {
  // No store filter: admin counts are small at MVP and every query-param
  // filter is a future tenant-confusion surface. Client filters instead.
  return ok(c, { subscriptions: await listSubscriptions(getDb(c)) });
});

const activateSchema = z.object({
  store_id: z.string().min(1),
  plan_id: z.string().min(1),
  billing_period: billingPeriod,
  starts_at: isoDateTime.optional(),
  ends_at: isoDateTime.nullable().default(null),
  price_amount: z.number().int().min(0).default(0),
  payment_reference: z.string().max(200).nullable().default(null),
});

admin.post("/subscriptions", ...authedAdmin, zBodyValidator(activateSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["id", "status", "cancelled_at"]);
  const sub = await activateSubscription(getDb(c), c.req.valid("json"));
  auditLog("admin.subscription.activate", { actor: currentUser(c).id, store: sub.store_id, result: sub.id });
  return ok(c, { subscription: sub }, 201);
});

const cancelSchema = z.object({
  cancelled_at: isoDateTime.optional(),
});

admin.post("/subscriptions/:id/cancel", ...authedAdmin, zBodyValidator(cancelSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["id", "status", "store_id", "plan_id"]);
  const sub = await cancelSubscription(getDb(c), resourceId(c), c.req.valid("json").cancelled_at);
  auditLog("admin.subscription.cancel", { actor: currentUser(c).id, store: sub.store_id, result: sub.id });
  return ok(c, { subscription: sub });
});

const renewSchema = z.object({
  billing_period: billingPeriod.optional(),
  starts_at: isoDateTime.optional(),
  ends_at: isoDateTime.nullable().optional(),
  price_amount: z.number().int().min(0).optional(),
  payment_reference: z.string().max(200).nullable().optional(),
});

admin.post("/subscriptions/:id/renew", ...authedAdmin, zBodyValidator(renewSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, ["id", "status", "cancelled_at", "store_id", "plan_id"]);
  const sub = await renewSubscription(getDb(c), resourceId(c), c.req.valid("json"));
  auditLog("admin.subscription.renew", { actor: currentUser(c).id, store: sub.store_id, result: sub.id });
  return ok(c, { subscription: sub }, 201);
});

admin.get("/subscriptions/:id", ...authedAdmin, async (c) => {
  const sub = await getSubscription(getDb(c), resourceId(c));
  if (!sub) throw new AppError("subscription_not_found", 404, "Subscription not found.");
  return ok(c, { subscription: sub });
});

// --- assisted password reset (no email/SMS infra in MVP) ---

const resetSchema = z.object({
  new_password: z.string().min(PASSWORD_RULES.minNewChars).max(PASSWORD_RULES.maxChars),
});

// Sets a user's password and revokes ALL of their sessions including the
// caller's own if self-targeted (fail-closed for compromise; the admin
// re-logs in). Audited.
admin.post("/users/:id/password", ...authedAdmin, zBodyValidator(resetSchema), async (c) => {
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
});

// --- local-only maintenance (purge) ---

const purgeSchema = z.object({
  sessions_older_than_days: z.number().int().min(1).max(3650).default(30),
  idempotency_older_than_days: z.number().int().min(1).max(3650).default(3),
});

// Runs the same purge functions as the production cron, but ONLY in
// development: in any other environment this route does not exist (404), so
// there is no remote mass-delete surface to audit or abuse.
admin.post("/maintenance/purge", requireAuth, requireRole("admin"), zBodyValidator(purgeSchema), async (c) => {
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
});
