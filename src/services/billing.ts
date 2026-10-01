import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { appUrl, type Env } from "../env.js";
import { auditEvent } from "./audit.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";
import { configuredProvider } from "../lib/billing/registry.js";
import type { WebhookResult } from "../lib/billing/provider.js";
import { getPlan } from "./plans.js";
import {
  activateSubscription,
  hasCoveringSubscription,
  type SubscriptionRow,
} from "./subscriptions.js";

// Self-serve billing intents (Phase 8). Invariants (binding):
// - Prices are server-resolved from plans; client money is rejected upstream.
// - (store_id, idempotency_key) replays the same intent; differing bodies
//   on the same key are 422 (mirrors checkout), never a second charge.
// - Webhook success appends ONE active period; a concurrent double-pay
//   collapses on the partial-unique index into idempotent success.
// - History is append-only: intents only move pending -> terminal, periods
//   are only INSERTed. Nothing here UPDATEs a subscription row.

export type IntentStatus = "pending" | "succeeded" | "failed" | "expired";

export interface BillingIntentRow {
  id: string;
  store_id: string;
  plan_id: string;
  billing_period: string;
  amount: number;
  currency: string;
  status: IntentStatus;
  provider: string;
  provider_ref: string | null;
  event_id: string | null;
  idempotency_key: string;
  expires_at: string;
  return_url: string | null;
  created_at: string;
  updated_at: string;
}

const INTENT_TTL_MS = 30 * 60 * 1000; // 30 minutes to pay

function expiryIso(ttlMs: number, nowMs: number): string {
  return new Date(nowMs + ttlMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function getIntent(
  db: D1Database,
  id: string
): Promise<BillingIntentRow | null> {
  return db
    .prepare("SELECT * FROM billing_intents WHERE id = ?")
    .bind(id)
    .first<BillingIntentRow>();
}

export async function getIntentForStore(
  db: D1Database,
  storeId: string,
  id: string
): Promise<BillingIntentRow | null> {
  return db
    .prepare("SELECT * FROM billing_intents WHERE store_id = ? AND id = ?")
    .bind(storeId, id)
    .first<BillingIntentRow>();
}

// Existence probe for the billing-intent rate limiter (roadmap B7b): the
// route must know whether an idempotency key is a replay BEFORE deciding to
// consume quota, but routes cannot hold SQL (tenant conventions). Narrowly
// scoped to existence — replay/conflict semantics stay solely inside
// createBillingIntent below; this function duplicates none of them.
export async function hasIntentWithKey(
  db: D1Database,
  storeId: string,
  idempotencyKey: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM billing_intents WHERE store_id = ? AND idempotency_key = ?")
    .bind(storeId, idempotencyKey)
    .first<{ id: string }>();
  return row !== null;
}

export async function listIntentsForStore(
  db: D1Database,
  storeId: string,
  limit = 20
): Promise<BillingIntentRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM billing_intents WHERE store_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .bind(storeId, limit)
    .all<BillingIntentRow>();
  return res.results ?? [];
}

export async function listAllIntents(
  db: D1Database,
  limit = 50
): Promise<BillingIntentRow[]> {
  const res = await db
    .prepare("SELECT * FROM billing_intents ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<BillingIntentRow>();
  return res.results ?? [];
}

export interface NewIntent {
  storeId: string;
  planId: string;
  billingPeriod: "monthly" | "yearly";
  idempotencyKey?: string | null;
  returnUrl?: string | null;
}

export async function createBillingIntent(
  db: D1Database,
  env: Env,
  input: NewIntent,
  nowMs: number = Date.now()
): Promise<{ intent: BillingIntentRow; redirectUrl: string; replayed: boolean }> {
  const nowIso = touch(nowMs);
  const store = await db
    .prepare("SELECT id, name FROM stores WHERE id = ?")
    .bind(input.storeId)
    .first<{ id: string; name: string }>();
  if (!store) throw new AppError("store_not_found", 404, "Store not found.");
  const plan = await getPlan(db, input.planId);
  if (!plan) throw new AppError("plan_not_found", 404, "Plan not found.");
  const amount =
    input.billingPeriod === "monthly" ? plan.price_monthly : plan.price_yearly;
  const key = input.idempotencyKey ?? uuidv7(nowMs);
  const provider = configuredProvider(env);
  const returnUrl =
    input.returnUrl ??
    `${appUrl(env)}/billing/return?store=${encodeURIComponent(input.storeId)}`;

  const id = uuidv7(nowMs);
  try {
    await db
      .prepare(
        `INSERT INTO billing_intents
           (id, store_id, plan_id, billing_period, amount, currency, status,
            provider, provider_ref, event_id, idempotency_key, expires_at,
            return_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'SYP', 'pending', ?, NULL, NULL, ?, ?, ?, ?, ?)`
      )
      .bind(
        id, input.storeId, input.planId, input.billingPeriod, amount,
        provider.name, key, expiryIso(INTENT_TTL_MS, nowMs), returnUrl,
        nowIso, nowIso
      )
      .run();
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      const existing = await db
        .prepare(
          "SELECT * FROM billing_intents WHERE store_id = ? AND idempotency_key = ?"
        )
        .bind(input.storeId, key)
        .first<BillingIntentRow>();
      if (
        existing &&
        existing.plan_id === input.planId &&
        existing.billing_period === input.billingPeriod &&
        existing.amount === amount
      ) {
        const redirect = await provider.createIntent(
          {
            intentId: existing.id,
            storeId: input.storeId,
            storeName: store.name,
            planId: input.planId,
            planName: plan.name,
            billingPeriod: input.billingPeriod,
            amount,
            currency: "SYP",
            returnUrl: existing.return_url ?? returnUrl,
            cancelUrl: existing.return_url ?? returnUrl,
          },
          env
        );
        return { intent: existing, redirectUrl: redirect.redirectUrl, replayed: true };
      }
      throw new AppError(
        "intent_conflict",
        422,
        "Idempotency key already used with a different checkout."
      );
    }
    throw err;
  }
  const created = await getIntent(db, id);
  if (!created) throw new AppError("internal", 500, "Something went wrong.");
  const redirect = await provider.createIntent(
    {
      intentId: id,
      storeId: input.storeId,
      storeName: store.name,
      planId: input.planId,
      planName: plan.name,
      billingPeriod: input.billingPeriod,
      amount,
      currency: "SYP",
      returnUrl,
      cancelUrl: returnUrl,
    },
    env
  );
  return { intent: created, redirectUrl: redirect.redirectUrl, replayed: false };
}

export interface SettleOutcome {
  processed: boolean;
  activated: boolean;
  duplicate: boolean;
  subscription: SubscriptionRow | null;
}

// Settles one verified webhook result. Always safe to call twice with the
// same event (replay cache) and safe under concurrency (partial-unique
// collapse). Unknown/expired/duplicate deliveries resolve 200 upstream.
export async function settleWebhook(
  db: D1Database,
  result: WebhookResult,
  nowIso: string = touch()
): Promise<SettleOutcome> {
  const intent = await getIntent(db, result.intentId);
  if (!intent) return { processed: false, activated: false, duplicate: false, subscription: null };
  if (intent.status === "succeeded" || intent.status === "failed") {
    return { processed: false, activated: intent.status === "succeeded", duplicate: true, subscription: null };
  }
  if (intent.event_id !== null && intent.event_id === result.eventId) {
    return { processed: false, activated: false, duplicate: true, subscription: null };
  }
  if (intent.expires_at <= nowIso) {
    await db
      .prepare("UPDATE billing_intents SET status = 'expired', updated_at = ? WHERE id = ?")
      .bind(nowIso, intent.id)
      .run();
    return { processed: false, activated: false, duplicate: false, subscription: null };
  }
  if (!result.success) {
    await db
      .prepare(
        "UPDATE billing_intents SET status = 'failed', event_id = ?, provider_ref = ?, updated_at = ? WHERE id = ?"
      )
      .bind(result.eventId, result.providerRef ?? null, nowIso, intent.id)
      .run();
    await auditEvent(null, db,"billing.webhook.failed", { actor: "billing:webhook", store: intent.store_id, result: intent.id });
    return { processed: true, activated: false, duplicate: false, subscription: null };
  }
  // Amount integrity: a reported mismatch can never activate a period.
  if (result.amount !== undefined && result.amount !== intent.amount) {
    await db
      .prepare(
        "UPDATE billing_intents SET status = 'failed', event_id = ?, provider_ref = ?, updated_at = ? WHERE id = ?"
      )
      .bind(result.eventId, result.providerRef ?? null, nowIso, intent.id)
      .run();
    await auditEvent(null, db,"billing.webhook.amount_mismatch", { actor: "billing:webhook", store: intent.store_id, result: intent.id });
    return { processed: true, activated: false, duplicate: false, subscription: null };
  }
  if (result.currency !== undefined && result.currency !== intent.currency) {
    await db
      .prepare(
        "UPDATE billing_intents SET status = 'failed', event_id = ?, provider_ref = ?, updated_at = ? WHERE id = ?"
      )
      .bind(result.eventId, result.providerRef ?? null, nowIso, intent.id)
      .run();
    await auditEvent(null, db,"billing.webhook.amount_mismatch", { actor: "billing:webhook", store: intent.store_id, result: intent.id });
    return { processed: true, activated: false, duplicate: false, subscription: null };
  }
  try {
    const results = await db.batch([
      db
        .prepare(
          "UPDATE billing_intents SET status = 'succeeded', event_id = ?, provider_ref = ?, updated_at = ? WHERE id = ?"
        )
        .bind(result.eventId, result.providerRef ?? null, nowIso, intent.id),
      db
        .prepare(
          `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at, ends_at, cancelled_at, payment_reference, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, NULL, ?, ?, ?)`
        )
        .bind(
          uuidv7(), intent.store_id, intent.plan_id, intent.billing_period,
          intent.amount, nowIso, `provider:${intent.provider}:${intent.id}`,
          nowIso, nowIso
        ),
    ]);
    if (!results.every((r) => r.success))
      throw new AppError("internal", 500, "Something went wrong.");
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      // Concurrent double-pay: another delivery already activated a period.
      // Mark this intent succeeded (money did move) without duplicating it.
      await db
        .prepare(
          "UPDATE billing_intents SET status = 'succeeded', event_id = ?, provider_ref = ?, updated_at = ? WHERE id = ?"
        )
        .bind(result.eventId, result.providerRef ?? null, nowIso, intent.id)
        .run();
      const covering = await db
        .prepare(
          `SELECT * FROM subscriptions WHERE store_id = ? AND status = 'active'
           ORDER BY starts_at DESC LIMIT 1`
        )
        .bind(intent.store_id)
        .first<SubscriptionRow>();
      await auditEvent(null, db,"billing.webhook.duplicate", { actor: "billing:webhook", store: intent.store_id, result: intent.id });
      return { processed: true, activated: true, duplicate: true, subscription: covering };
    }
    throw err;
  }
  const activated = await db
    .prepare(
      `SELECT * FROM subscriptions WHERE store_id = ? AND status = 'active'
       ORDER BY starts_at DESC LIMIT 1`
    )
    .bind(intent.store_id)
    .first<SubscriptionRow>();
  await auditEvent(null, db,"billing.webhook.success", { actor: "billing:webhook", store: intent.store_id, result: intent.id });
  return { processed: true, activated: true, duplicate: false, subscription: activated };
}

// Trial grant (store creation hook). Idempotent per store: skipped when any
// covering period already exists. The trial references TRIAL_PLAN_CODE
// (default "basic"); a missing plan skips the trial WITHOUT failing store
// creation. Price is always 0 — trials are free by definition.
export async function grantTrial(
  db: D1Database,
  env: Env,
  storeId: string,
  actorId: string,
  nowIso: string = touch()
): Promise<{ trial: SubscriptionRow | null; skipped: boolean }> {
  const daysRaw = env.TRIAL_DAYS ?? "14";
  const days = Number.parseInt(daysRaw, 10);
  if (!Number.isFinite(days) || days <= 0) return { trial: null, skipped: true };
  if (await hasCoveringSubscription(db, storeId, nowIso)) {
    return { trial: null, skipped: true };
  }
  const code = env.TRIAL_PLAN_CODE ?? "basic";
  const plan = await db
    .prepare("SELECT id FROM plans WHERE code = ?")
    .bind(code)
    .first<{ id: string }>();
  if (!plan) return { trial: null, skipped: true };
  let trial: SubscriptionRow;
  try {
    trial = await activateSubscription(
      db,
      {
        store_id: storeId,
        plan_id: plan.id,
        billing_period: "monthly",
        starts_at: nowIso,
        ends_at: expiryIso(days * 24 * 3600 * 1000, Date.parse(nowIso)),
        price_amount: 0,
        payment_reference: "trial",
      },
      nowIso
    );
  } catch (err) {
    // Lost a concurrent trial race (or an activation landed first):
    // the store is covered either way — skip instead of failing creation.
    if (err instanceof AppError && err.code === "subscription_active_exists") {
      return { trial: null, skipped: true };
    }
    throw err;
  }
  // activateSubscription only ever inserts "active"; flip THIS row to
  // trialing (the partial-unique index covers active only, so no clash).
  // NOTE: the terminal .run() is load-bearing — prepare().bind() alone
  // executes nothing on D1 (a missing .run() here once shipped a trial
  // response while the row stayed active; caught by live repro, not by
  // the response shape, which must always be re-read below, never built).
  await db
    .prepare("UPDATE subscriptions SET status = 'trialing', updated_at = ? WHERE id = ?")
    .bind(nowIso, trial.id)
    .run();
  const row = await db
    .prepare("SELECT * FROM subscriptions WHERE id = ?")
    .bind(trial.id)
    .first<SubscriptionRow>();
  if (!row || row.status !== "trialing") {
    // Fail-closed: the grant response must reflect the stored row, never a
    // constructed one — a mismatch here means the flip did not persist.
    throw new AppError("internal", 500, "Something went wrong.");
  }
  await auditEvent(null, db,"store.trial.grant", { actor: actorId, store: storeId, result: trial.id });
  return { trial: row, skipped: false };
}
