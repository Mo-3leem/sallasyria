import type { D1Database } from "@cloudflare/workers-types";
import { touch } from "../lib/time.js";
import { normalizeEmail } from "../lib/email.js";
import { normalizePhone } from "../lib/phone.js";
import { loginFailKey } from "../lib/rate-limit.js";

// Persistent per-account login throttle (roadmap B4). Replaces the old
// in-memory failure counter, which lost all state on worker restart (and
// never shared state across isolates): every consecutive wrong password
// now accumulates in D1 under the same canonical-identity key the login
// flow already computes, so brute force cannot out-wait a deploy.
// - 1-4 failures: normal login behavior.
// - 5-9 failures: Turnstile challenge required first (existing flow).
// - 10th failure: 15-minute lockout is established (this call still 401s).
// - While locked: generic 429, no credential check, lock never extended.
// - Any successful password outside a lockout clears the row.
// Unknown identities resolve to identical ghost rows, so misses cost one
// scrypt against the dummy hash exactly like the login path (no oracle).
// Storage note (accepted B4 design): login_throttle.identity holds the
// canonical login identity (normalized email or phone) in plaintext — the
// throttle key must equal the lookup key, and it lives under the same D1
// access controls as the users table, which holds the same values.
// Unknown identities create ghost rows holding attacker-supplied
// identifiers until the retention purge removes them. Only malformed-phone
// buckets hash their key material (SHA-256 of the client IP); real
// identity keys are never hashed — do not claim otherwise.
// Expiry does not forgive: fails stays 10 after locked_until passes, so
// the next wrong password re-locks immediately instead of restarting the
// 1-4 / 5-9 escalation. Only a success (or rotation/reset/change clearing)
// returns the identity to a clean slate.

export const LOGIN_LOCKOUT_AFTER = 10;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
// Stale throttle rows (no activity this long) are maintenance-purged. Well
// past any lockout window, so purging can never lift an active lock.
export const LOGIN_THROTTLE_RETENTION_MS = 7 * 24 * 3600 * 1000;

export interface ThrottleState {
  fails: number;
  lockedUntil: string | null;
}

const EMPTY: ThrottleState = { fails: 0, lockedUntil: null };

export async function getLoginThrottle(db: D1Database, key: string): Promise<ThrottleState> {
  const row = await db
    .prepare("SELECT fails, locked_until AS lockedUntil FROM login_throttle WHERE identity = ?")
    .bind(key)
    .first<{ fails: number; lockedUntil: string | null }>();
  if (!row) return { ...EMPTY };
  return { fails: row.fails, lockedUntil: row.lockedUntil };
}

/** Pure check: is this state locked right now? String compare is safe —
 *  all timestamps use the same second-precision UTC shape (see lib/time). */
export function isLockedState(state: ThrottleState, nowIso: string): boolean {
  return state.lockedUntil !== null && state.lockedUntil > nowIso;
}

export async function isLoginLocked(
  db: D1Database,
  key: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  return isLockedState(await getLoginThrottle(db, key), touch(nowMs));
}

/**
 * Record one wrong password. Returns the post-write state. Establishes the
 * lockout exactly when crossing the threshold on a request that was NOT
 * already locked — the login flow 429s locked identities before recording,
 * so locked_until is never extended by requests received while locked.
 * Concurrent failures may both observe the pre-lock count; both write the
 * same lockout outcome, so races converge instead of corrupting.
 */
export async function recordLoginFailure(
  db: D1Database,
  key: string,
  nowMs: number = Date.now()
): Promise<ThrottleState> {
  const now = touch(nowMs);
  const state = await getLoginThrottle(db, key);
  const fails = state.fails + 1;
  let lockedUntil = state.lockedUntil;
  if (fails >= LOGIN_LOCKOUT_AFTER && !isLockedState(state, now)) {
    lockedUntil = touch(nowMs + LOGIN_LOCKOUT_MS);
  }
  await db
    .prepare(
      `INSERT INTO login_throttle (identity, fails, locked_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(identity) DO UPDATE SET
         fails = excluded.fails,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`
    )
    .bind(key, fails, lockedUntil, now)
    .run();
  return { fails, lockedUntil };
}

/** Successful authentication (or password rotation) wipes the slate. */
export async function clearLoginThrottle(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_throttle WHERE identity = ?").bind(key).run();
}

/**
 * Clear every throttle row that could belong to this account (both the
 * normalized email and phone keys). Legacy raw-phone rows that no longer
 * normalize are skipped, never fatal: throttle hygiene must not fail a
 * password rotation. Identity-free (never fails) by construction.
 */
export async function clearLoginThrottleForUser(
  db: D1Database,
  user: { email: string | null; phone: string }
): Promise<void> {
  const keys = new Set<string>();
  if (user.email) {
    try {
      keys.add(loginFailKey(normalizeEmail(user.email)));
    } catch {
      // Un-normalizable stored value: nothing to clear under it.
    }
  }
  if (user.phone) {
    try {
      keys.add(loginFailKey(normalizePhone(user.phone)));
    } catch {
      // Legacy raw phone (see login fallback path): skip, never fail.
    }
  }
  for (const key of keys) {
    await clearLoginThrottle(db, key);
  }
}
