import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env.js";

// Scheduled hygiene (roadmap B7). Two bounded purges keep tables that would
// otherwise grow forever (revoked/expired sessions; consumed idempotency
// keys) within D1 limits. Both are pure DELETEs by age — no business logic,
// no FK risk (sessions reference users with CASCADE; keys cascade from
// orders/stores, so orphans cannot exist to block either delete).

export const SESSION_RETENTION_MS = 30 * 24 * 3600 * 1000; // 30 days past end-of-life
export const IDEMPOTENCY_RETENTION_MS = 72 * 3600 * 1000; // 72 hours

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

export interface MaintenanceSummary {
  sessionsPurged: number;
  idempotencyKeysPurged: number;
}

// Cron entrypoint (wired as scheduled() in src/index.ts; verified in B8).
// Retention windows are constants above — environment overrides are a
// deferred B8 ops concern, not silent behavior. Returns counts for logging.
export async function runScheduledMaintenance(env: Env, nowMs: number = Date.now()): Promise<MaintenanceSummary> {
  const sessionsPurged = await purgeSessions(env.DB, cutoffIso(nowMs, SESSION_RETENTION_MS));
  const idempotencyKeysPurged = await purgeIdempotencyKeys(env.DB, cutoffIso(nowMs, IDEMPOTENCY_RETENTION_MS));
  console.log(
    `maintenance sessions_purged=${sessionsPurged} idempotency_purged=${idempotencyKeysPurged}`
  );
  return { sessionsPurged, idempotencyKeysPurged };
}
