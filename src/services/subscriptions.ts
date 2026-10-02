import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Subscription administration (roadmap B7). Manual Syrian billing model:
// transfers/wallets are verified out-of-band; an admin records the outcome
// here with a payment_reference. No payment integration exists or is planned
// for MVP.
//
// Iron rules (append-only history):
// - Periods are only ever INSERTed (activate/renew). Status of an existing
//   row changes exactly once: anything -> cancelled (cancel endpoint).
// - No function here UPDATEs status except cancel, and nothing ever sets a
//   row back to active — restores go through the same partial-unique + CHECK
//   gauntlet as creation (verified, DB track).
// - Activating while another active period exists fails 409 (partial unique):
//   the admin cancels the old period first. Explicit beats implicit.

export interface SubscriptionRow {
  id: string;
  store_id: string;
  plan_id: string;
  status: string;
  billing_period: string;
  price_amount: number;
  starts_at: string;
  ends_at: string | null;
  cancelled_at: string | null;
  payment_reference: string | null;
}

// Subscription gate query (roadmap B3, used by requireActiveSubscription):
// true iff an active-or-trialing period covers `nowIso`. Reads stay open by
// design (the gate mounts on mutating routes only); history rows never count.
export async function hasCoveringSubscription(
  db: D1Database,
  storeId: string,
  nowIso: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM subscriptions
        WHERE store_id = ?
          AND status IN ('active', 'trialing')
          AND starts_at <= ?
          AND (ends_at IS NULL OR ends_at > ?)
        LIMIT 1`
    )
    .bind(storeId, nowIso, nowIso)
    .first<{ ok: number }>();
  return row !== null;
}

export interface PeriodInput {
  store_id: string;
  plan_id: string;
  billing_period: "monthly" | "yearly";
  starts_at?: string;
  ends_at?: string | null;
  price_amount?: number;
  payment_reference?: string | null;
}

async function requireStoreAndPlan(db: D1Database, storeId: string, planId: string): Promise<void> {
  // FKs would reject ghosts with a bare 500; pre-check for exact 404s (and
  // to keep cross-entity existence answers scoped: both must simply exist).
  const store = await db
    .prepare("SELECT 1 AS ok FROM stores WHERE id = ?")
    .bind(storeId)
    .first<{ ok: number }>();
  if (!store) throw new AppError("store_not_found", 404, "Store not found.");
  const plan = await db
    .prepare("SELECT 1 AS ok FROM plans WHERE id = ?")
    .bind(planId)
    .first<{ ok: number }>();
  if (!plan) throw new AppError("plan_not_found", 404, "Plan not found.");
}

export async function getSubscription(
  db: D1Database,
  id: string
): Promise<SubscriptionRow | null> {
  return db
    .prepare("SELECT * FROM subscriptions WHERE id = ?")
    .bind(id)
    .first<SubscriptionRow>();
}

export type SubscriptionStatusFilter = "active" | "cancelled" | "expired" | "trialing";

export interface SubscriptionPage {
  subscriptions: SubscriptionRow[];
  total: number;
}

// Admin subscription directory (roadmap B11): optional store scope and
// server-side status filter, deterministic newest-first ordering with id
// tie-break, offset page + filtered total from the same predicates.
export async function listSubscriptionsPage(
  db: D1Database,
  opts: { storeId?: string | null; status?: SubscriptionStatusFilter | null; page: number; pageSize: number }
): Promise<SubscriptionPage> {
  const args: unknown[] = [];
  const clauses: string[] = [];
  if (opts.storeId != null) {
    clauses.push("store_id = ?");
    args.push(opts.storeId);
  }
  if (opts.status != null) {
    clauses.push("status = ?");
    args.push(opts.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (opts.page - 1) * opts.pageSize;
  const res = await db
    .prepare(`SELECT * FROM subscriptions ${where} ORDER BY starts_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...args, opts.pageSize, offset)
    .all<SubscriptionRow>();
  const counted = await db
    .prepare(`SELECT COUNT(*) AS n FROM subscriptions ${where}`)
    .bind(...args)
    .first<{ n: number }>();
  return { subscriptions: res.results ?? [], total: counted?.n ?? 0 };
}

export async function listSubscriptions(
  db: D1Database,
  storeId?: string
): Promise<SubscriptionRow[]> {
  const res = storeId
    ? await db
        .prepare("SELECT * FROM subscriptions WHERE store_id = ? ORDER BY starts_at DESC")
        .bind(storeId)
        .all<SubscriptionRow>()
    : await db.prepare("SELECT * FROM subscriptions ORDER BY starts_at DESC").all<SubscriptionRow>();
  return res.results ?? [];
}

async function insertPeriod(
  db: D1Database,
  input: PeriodInput,
  status: "active",
  nowIso: string
): Promise<SubscriptionRow> {
  await requireStoreAndPlan(db, input.store_id, input.plan_id);
  const id = uuidv7();
  try {
    await db
      .prepare(
        `INSERT INTO subscriptions (id, store_id, plan_id, status, billing_period, price_amount, starts_at, ends_at, cancelled_at, payment_reference, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .bind(
        id, input.store_id, input.plan_id, status, input.billing_period,
        input.price_amount ?? 0, input.starts_at ?? nowIso, input.ends_at ?? null,
        input.payment_reference ?? null, nowIso, nowIso
      )
      .run();
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      throw new AppError(
        "subscription_active_exists",
        409,
        "Store already has an active subscription. Cancel it first."
      );
    }
    throw err;
  }
  const row = await getSubscription(db, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

export async function activateSubscription(
  db: D1Database,
  input: PeriodInput,
  nowIso: string = touch()
): Promise<SubscriptionRow> {
  return insertPeriod(db, input, "active", nowIso);
}

// Renewal = brand-new period copying the source row's store+plan (defaults
// overridable). The source row is never modified: history stays append-only.
export async function renewSubscription(
  db: D1Database,
  id: string,
  patch: {
    billing_period?: "monthly" | "yearly";
    ends_at?: string | null;
    price_amount?: number;
    payment_reference?: string | null;
    starts_at?: string;
  },
  nowIso: string = touch()
): Promise<SubscriptionRow> {
  const source = await getSubscription(db, id);
  if (!source) {
    throw new AppError("subscription_not_found", 404, "Subscription not found.");
  }
  return insertPeriod(
    db,
    {
      store_id: source.store_id,
      plan_id: source.plan_id,
      billing_period: patch.billing_period ?? (source.billing_period as "monthly" | "yearly"),
      starts_at: patch.starts_at ?? nowIso,
      ends_at: patch.ends_at === undefined ? source.ends_at : patch.ends_at,
      price_amount: patch.price_amount ?? source.price_amount,
      payment_reference: patch.payment_reference ?? null,
    },
    "active",
    nowIso
  );
}

export async function cancelSubscription(
  db: D1Database,
  id: string,
  cancelledAt?: string,
  nowIso: string = touch()
): Promise<SubscriptionRow> {
  const current = await getSubscription(db, id);
  if (!current) {
    throw new AppError("subscription_not_found", 404, "Subscription not found.");
  }
  if (current.status === "cancelled") return current; // idempotent
  const at = cancelledAt ?? nowIso;
  await db
    .prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?")
    .bind(at, nowIso, id)
    .run();
  const updated = await getSubscription(db, id);
  if (!updated) throw new AppError("internal", 500, "Something went wrong.");
  return updated;
}

// Merchant notification target: the store owner's email on file (null when
// the owner never set one — callers skip, never fabricate) plus the store
// name for the message.
export interface SubscriptionNotifyTarget {
  email: string | null;
  storeName: string;
}

export async function storeOwnerNotifyTarget(
  db: D1Database,
  storeId: string
): Promise<SubscriptionNotifyTarget | null> {
  const row = await db
    .prepare(
      `SELECT u.email AS email, s.name AS storeName
         FROM stores s LEFT JOIN users u ON u.id = s.owner_id
        WHERE s.id = ?`
    )
    .bind(storeId)
    .first<SubscriptionNotifyTarget>();
  return row ?? null;
}

export async function subscriptionNotifyTarget(
  db: D1Database,
  subscriptionId: string
): Promise<(SubscriptionNotifyTarget & { storeId: string }) | null> {
  const sub = await getSubscription(db, subscriptionId);
  if (!sub) return null;
  const target = await storeOwnerNotifyTarget(db, sub.store_id);
  if (!target) return null;
  return { ...target, storeId: sub.store_id };
}
