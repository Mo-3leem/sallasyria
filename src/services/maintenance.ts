import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env.js";
import { dispatchMail, sendMail } from "./mail.js";
import { LOGIN_THROTTLE_RETENTION_MS } from "./login-throttle.js";
import { buildSubscriptionEmail, enqueueMail } from "./mail-outbox.js";

// Scheduled hygiene (roadmap B7). Three bounded purges keep tables that would
// otherwise grow forever (revoked/expired sessions; consumed idempotency
// keys; aged audit rows) within D1 limits. All are pure DELETEs by age — no
// business logic, no FK risk (sessions reference users with CASCADE; keys
// cascade from orders/stores, so orphans cannot exist to block either
// delete; audit rows reference nothing and are never referenced).

export const SESSION_RETENTION_MS = 30 * 24 * 3600 * 1000; // 30 days past end-of-life
export const IDEMPOTENCY_RETENTION_MS = 72 * 3600 * 1000; // 72 hours
// Audit trail retention (roadmap B12): 180 days. Long enough for security
// review and incident response, bounded so the table cannot grow forever.
// Anything older is console history only (Workers Logs retention applies).
export const AUDIT_RETENTION_MS = 180 * 24 * 3600 * 1000;

export function cutoffIso(nowMs: number, retentionMs: number): string {
  return new Date(nowMs - retentionMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function purgeSessions(db: D1Database, cutoffIsoValue: string): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
           OR expires_at < ?`
    )
    .bind(cutoffIsoValue, cutoffIsoValue)
    .run();
  return res.meta.changes ?? 0;
}

export async function purgeIdempotencyKeys(db: D1Database, cutoffIsoValue: string): Promise<number> {
  const res = await db
    .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
    .bind(cutoffIsoValue)
    .run();
  return res.meta.changes ?? 0;
}

export async function purgeAuditLog(db: D1Database, cutoffIsoValue: string): Promise<number> {
  const res = await db
    .prepare("DELETE FROM audit_logs WHERE created_at < ?")
    .bind(cutoffIsoValue)
    .run();
  return res.meta.changes ?? 0;
}

// Stale login-throttle rows (roadmap B4). Any row untouched this long is
// necessarily past its lockout window, so purging can never lift an active
// lock or hide an ongoing attack — it only bounds table growth from ghost
// identities and abandoned counters.
export async function purgeLoginThrottle(db: D1Database, cutoffIsoValue: string): Promise<number> {
  const res = await db
    .prepare("DELETE FROM login_throttle WHERE updated_at < ?")
    .bind(cutoffIsoValue)
    .run();
  return res.meta.changes ?? 0;
}

export interface MaintenanceSummary {
  sessionsPurged: number;
  idempotencyKeysPurged: number;
  auditPurged: number;
  loginThrottlePurged: number;
  trialNoticesQueued: number;
}

export const TRIAL_NOTICE_WINDOW_MS = 7 * 24 * 3600 * 1000; // T-7d

export interface TrialNotice {
  subId: string;
  storeId: string;
  storeName: string;
  email: string | null;
  endsAt: string;
}

// Trialing periods ending inside the notice window with no notice recorded
// yet (NOT EXISTS on the outbox dedupe key: a notice is sent at most once
// per subscription, and re-runs after a crash simply resume).
export async function scanTrialExpiries(db: D1Database, nowMs: number = Date.now()): Promise<TrialNotice[]> {
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const horizonIso = new Date(nowMs + TRIAL_NOTICE_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = await db
    .prepare(
      `SELECT sub.id AS subId, sub.store_id AS storeId, s.name AS storeName, u.email AS email, sub.ends_at AS endsAt
         FROM subscriptions sub
         JOIN stores s ON s.id = sub.store_id
         LEFT JOIN users u ON u.id = s.owner_id
        WHERE sub.status = 'trialing' AND sub.ends_at IS NOT NULL
          AND sub.ends_at > ? AND sub.ends_at <= ?
          AND NOT EXISTS (SELECT 1 FROM mail_outbox WHERE dedupe_key = 'trial-7d:' || sub.id)`
    )
    .bind(nowIso, horizonIso)
    .all<TrialNotice>();
  return res.results ?? [];
}

// Cron entrypoint (wired as scheduled() in src/index.ts; verified in B8).
// Retention windows are constants above — environment overrides are a
// deferred B8 ops concern, not silent behavior. Returns counts for logging.
export async function runScheduledMaintenance(env: Env, nowMs: number = Date.now()): Promise<MaintenanceSummary> {
  const sessionsPurged = await purgeSessions(env.DB, cutoffIso(nowMs, SESSION_RETENTION_MS));
  const idempotencyKeysPurged = await purgeIdempotencyKeys(env.DB, cutoffIso(nowMs, IDEMPOTENCY_RETENTION_MS));
  const auditPurged = await purgeAuditLog(env.DB, cutoffIso(nowMs, AUDIT_RETENTION_MS));
  const loginThrottlePurged = await purgeLoginThrottle(env.DB, cutoffIso(nowMs, LOGIN_THROTTLE_RETENTION_MS));
  let trialNoticesQueued = 0;
  try {
    const trials = await scanTrialExpiries(env.DB, nowMs);
    for (const t of trials) {
      if (!t.email) continue;
      const msg = buildSubscriptionEmail(
        t.storeName,
        "trial_expiring",
        `Your trial ends at ${t.endsAt}. Contact us to activate a paid period so your store stays online.`
      );
      let queued = false;
      try {
        queued = await enqueueMail(env.DB, `trial-7d:${t.subId}`, { to: t.email, subject: msg.subject, text: msg.text });
      } catch {
        queued = false;
      }
      if (queued) {
        // No execution context on the cron path: dispatchMail runs detached.
        dispatchMail(
          {},
          sendMail({ to: t.email, subject: msg.subject, text: msg.text }, { apiKey: env.SENDGRID_API_KEY, from: env.MAIL_FROM })
        );
        trialNoticesQueued += 1;
      }
    }
  } catch {
    // Trial notices never fail maintenance.
  }
  console.log(
    `maintenance sessions_purged=${sessionsPurged} idempotency_purged=${idempotencyKeysPurged} audit_purged=${auditPurged} login_throttle_purged=${loginThrottlePurged} trial_notices=${trialNoticesQueued}`
  );
  return { sessionsPurged, idempotencyKeysPurged, auditPurged, loginThrottlePurged, trialNoticesQueued };
}
