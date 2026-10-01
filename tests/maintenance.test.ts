import { describe, expect, it } from "vitest";
import {
  AUDIT_RETENTION_MS,
  cutoffIso,
  purgeAuditLog,
} from "../src/services/maintenance.js";

// Focused unit tests for audit retention (roadmap B12 review finding):
// purgeAuditLog must delete only rows older than the cutoff and report the
// count. The fake D1 below implements just enough SQL semantics for the
// single fixed DELETE the function issues.
function fakeDb(rows: { created_at: string }[]) {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          seen.push({ sql, args });
          if (!sql.startsWith("DELETE FROM audit_logs WHERE created_at < ?")) {
            throw new Error(`unexpected SQL: ${sql}`);
          }
          const cutoff = String(args[0]);
          const before = rows.length;
          const kept = rows.filter((r) => !(r.created_at < cutoff));
          rows.length = 0;
          rows.push(...kept);
          return { meta: { changes: before - kept.length } };
        },
      }),
    }),
  };
  return { db: db as never, seen };
}

describe("audit retention purge", () => {
  it("deletes only rows older than the cutoff and reports the count", async () => {
    const rows = [
      { created_at: "2020-01-01T00:00:00Z" },
      { created_at: "2025-06-15T12:00:00Z" },
      { created_at: "2099-01-01T00:00:00Z" },
    ];
    const { db, seen } = fakeDb(rows);
    const deleted = await purgeAuditLog(db, "2026-01-01T00:00:00Z");
    expect(deleted).toBe(2);
    expect(rows.map((r) => r.created_at)).toEqual(["2099-01-01T00:00:00Z"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args).toEqual(["2026-01-01T00:00:00Z"]);
  });

  it("keeps recent rows and is a no-op on an empty table", async () => {
    const rows = [{ created_at: "2099-01-01T00:00:00Z" }];
    const { db } = fakeDb(rows);
    expect(await purgeAuditLog(db, "2026-01-01T00:00:00Z")).toBe(0);
    expect(rows).toHaveLength(1);
    const empty: { created_at: string }[] = [];
    const { db: emptyDb } = fakeDb(empty);
    expect(await purgeAuditLog(emptyDb, "2026-01-01T00:00:00Z")).toBe(0);
  });

  it("retention window is a documented 180 days", () => {
    expect(AUDIT_RETENTION_MS).toBe(180 * 24 * 3600 * 1000);
    // cutoffIso stays the shared helper: 180d before now, second precision.
    expect(cutoffIso(Date.parse("2026-07-01T00:00:00Z"), AUDIT_RETENTION_MS)).toBe(
      "2026-01-02T00:00:00Z"
    );
  });
});
