import { describe, expect, it } from "vitest";
import {
  clearLoginThrottle,
  clearLoginThrottleForUser,
  getLoginThrottle,
  isLockedState,
  isLoginLocked,
  LOGIN_LOCKOUT_AFTER,
  LOGIN_LOCKOUT_MS,
  LOGIN_THROTTLE_RETENTION_MS,
  recordLoginFailure,
} from "../src/services/login-throttle.js";
import { cutoffIso, purgeLoginThrottle } from "../src/services/maintenance.js";

// Focused unit tests for the persistent login throttle (roadmap B4).
// The fake D1 below implements just enough SQL semantics for the fixed
// statements these functions issue (keyed SELECT, upsert, keyed DELETE,
// age-gated purge DELETE).

interface ThrottleRow {
  fails: number;
  locked_until: string | null;
  updated_at: string;
}

function fakeDb(initial: Record<string, ThrottleRow> = {}) {
  const rows = new Map<string, ThrottleRow>(Object.entries(initial));
  const seen: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          seen.push(sql);
          if (!sql.includes("FROM login_throttle WHERE identity = ?")) {
            throw new Error(`unexpected SELECT: ${sql}`);
          }
          const row = rows.get(String(args[0]));
          return row ? { fails: row.fails, lockedUntil: row.locked_until } : null;
        },
        run: async () => {
          seen.push(sql);
          if (sql.includes("ON CONFLICT(identity) DO UPDATE")) {
            const [identity, fails, lockedUntil, updatedAt] = args as [string, number, string | null, string];
            rows.set(identity, { fails, locked_until: lockedUntil, updated_at: updatedAt });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM login_throttle WHERE identity = ?")) {
            const existed = rows.delete(String(args[0]));
            return { meta: { changes: existed ? 1 : 0 } };
          }
          if (sql.startsWith("DELETE FROM login_throttle WHERE updated_at < ?")) {
            const cutoff = String(args[0]);
            let n = 0;
            for (const [k, r] of rows) {
              if (r.updated_at < cutoff) {
                rows.delete(k);
                n += 1;
              }
            }
            return { meta: { changes: n } };
          }
          throw new Error(`unexpected write: ${sql}`);
        },
      }),
    }),
  };
  return { db: db as never, rows, seen };
}

const T0 = Date.parse("2026-03-01T00:00:00Z");

describe("login throttle thresholds", () => {
  it("locks on the 10th consecutive failure, not before", async () => {
    expect(LOGIN_LOCKOUT_AFTER).toBe(10);
    expect(LOGIN_LOCKOUT_MS).toBe(15 * 60 * 1000);
    const { db } = fakeDb();
    for (let i = 1; i <= 9; i++) {
      const state = await recordLoginFailure(db, "login-fail:a@example.com", T0 + i * 1000);
      expect(state.fails).toBe(i);
      expect(state.lockedUntil).toBeNull();
      expect(await isLoginLocked(db, "login-fail:a@example.com", T0 + i * 1000)).toBe(false);
    }
    const tenth = await recordLoginFailure(db, "login-fail:a@example.com", T0 + 10_000);
    expect(tenth.fails).toBe(10);
    expect(tenth.lockedUntil).toBe("2026-03-01T00:15:10Z");
    expect(await isLoginLocked(db, "login-fail:a@example.com", T0 + 10_000)).toBe(true);
  });

  it("never extends the lockout on requests received while locked", async () => {
    const { db } = fakeDb();
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(db, "login-fail:b@example.com", T0 + i * 1000);
    }
    const established = (await getLoginThrottle(db, "login-fail:b@example.com")).lockedUntil;
    expect(established).not.toBeNull();
    // Further recordings (as if a code path recorded despite the lock):
    // the original deadline must survive untouched.
    for (let i = 0; i < 3; i++) {
      const state = await recordLoginFailure(db, "login-fail:b@example.com", T0 + (i + 1) * 60_000);
      expect(state.lockedUntil).toBe(established);
    }
    // Just before expiry: still locked. Just after: free.
    expect(await isLoginLocked(db, "login-fail:b@example.com", Date.parse(established!) - 1000)).toBe(true);
    expect(await isLoginLocked(db, "login-fail:b@example.com", Date.parse(established!) + 1000)).toBe(false);
  });

  it("isLockedState compares second-precision UTC shapes", () => {
    expect(isLockedState({ fails: 10, lockedUntil: null }, "2026-03-01T00:00:00Z")).toBe(false);
    expect(isLockedState({ fails: 10, lockedUntil: "2026-03-01T00:15:00Z" }, "2026-03-01T00:15:00Z")).toBe(false);
    expect(isLockedState({ fails: 10, lockedUntil: "2026-03-01T00:15:01Z" }, "2026-03-01T00:15:00Z")).toBe(true);
  });

  it("missing rows read as a clean slate", async () => {
    const { db } = fakeDb();
    expect(await getLoginThrottle(db, "login-fail:nobody@example.com")).toEqual({
      fails: 0,
      lockedUntil: null,
    });
    expect(await isLoginLocked(db, "login-fail:nobody@example.com", T0)).toBe(false);
  });

  it("clear wipes the row; per-user clear covers email and phone keys", async () => {
    const { db } = fakeDb();
    await recordLoginFailure(db, "login-fail:c@example.com", T0);
    await clearLoginThrottle(db, "login-fail:c@example.com");
    expect(await getLoginThrottle(db, "login-fail:c@example.com")).toEqual({
      fails: 0,
      lockedUntil: null,
    });
    await recordLoginFailure(db, "login-fail:c@example.com", T0);
    await recordLoginFailure(db, "login-fail:+963911111111", T0);
    await clearLoginThrottleForUser(db, { email: " C@Example.com ", phone: "+963 911 111 111" });
    expect((await getLoginThrottle(db, "login-fail:c@example.com")).fails).toBe(0);
    expect((await getLoginThrottle(db, "login-fail:+963911111111")).fails).toBe(0);
  });

  it("per-user clear skips un-normalizable values instead of failing", async () => {
    const { db } = fakeDb();
    await clearLoginThrottleForUser(db, { email: null, phone: "not-a-phone!!!" });
    // Unknown identities behave like fresh accounts (ghost rows on demand).
    expect(await getLoginThrottle(db, "login-fail:ghost@example.com")).toEqual({
      fails: 0,
      lockedUntil: null,
    });
  });
});

describe("login throttle retention purge", () => {
  it("deletes only rows older than the cutoff and reports the count", async () => {
    const { db, rows } = fakeDb({
      old: { fails: 10, locked_until: "2020-01-01T00:15:00Z", updated_at: "2020-01-01T00:00:00Z" },
      fresh: { fails: 3, locked_until: null, updated_at: "2099-01-01T00:00:00Z" },
    });
    expect(LOGIN_THROTTLE_RETENTION_MS).toBe(7 * 24 * 3600 * 1000);
    const deleted = await purgeLoginThrottle(db, cutoffIso(Date.parse("2026-07-01T00:00:00Z"), LOGIN_THROTTLE_RETENTION_MS));
    expect(deleted).toBe(1);
    expect([...rows.keys()]).toEqual(["fresh"]);
  });
});
