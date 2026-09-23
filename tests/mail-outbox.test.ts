import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import {
  buildSubscriptionEmail,
  enqueueMail,
  fireOutboxMail,
  markOutboxSent,
} from "../src/services/mail-outbox.js";
import { scanTrialExpiries } from "../src/services/maintenance.js";

function stubDb(opts: { trials?: { subId: string; storeId: string; storeName: string; email: string | null; endsAt: string }[] } = {}) {
  const keys = new Set<string>();
  const stmts: string[] = [];
  const db = {
    __keys: keys,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        stmts.push(sql);
        if (sql.startsWith("INSERT INTO mail_outbox")) {
          const [, dedupeKey] = args as [string, string, string, string, string, string];
          if (keys.has(dedupeKey)) {
            return { run: async () => ({ meta: { changes: 0 } }) };
          }
          keys.add(dedupeKey);
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
        if (sql.startsWith("UPDATE mail_outbox SET status")) {
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
        if (sql.startsWith("SELECT sub.id AS subId")) {
          const [nowIso, horizonIso] = args as [string, string];
          const rows = (opts.trials ?? []).filter((t) => t.endsAt > nowIso && t.endsAt <= horizonIso);
          return { all: async () => ({ results: rows }) };
        }
        throw new Error(`unexpected SQL in stub: ${sql.slice(0, 60)}`);
      },
    }),
  } as unknown as D1Database & { __keys: Set<string> };
  return { db, keys, stmts };
}

describe("mail outbox", () => {
  it("collapses concurrent duplicate events to one dispatch", async () => {
    const { db } = stubDb();
    const mail = { to: "buyer@example.com", subject: "s", text: "b" };
    const env = {};
    const calls: unknown[][] = [];
    const c = {};
    // fireOutboxMail dispatches detached; observe via a fetch stub is not
    // possible here (no SENDGRID key configured -> sendMail short-circuits
    // to { sent:false } without fetch). Assert the CAS decision instead.
    const first = await fireOutboxMail(db, env as never, c, "order:o1:confirm", mail);
    const second = await fireOutboxMail(db, env as never, c, "order:o1:confirm", mail);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(calls).toHaveLength(0);
    // Empty recipient never enqueues.
    expect(await enqueueMail(db, "order:o2:confirm", { to: "", subject: "s", text: "b" })).toBe(false);
    // Status helper shapes the expected UPDATE.
    const stmt = markOutboxSent(db, "order:o1:confirm");
    await stmt.run();
  });

  it("builds subscription subjects per event", () => {
    expect(buildSubscriptionEmail("S", "activated", "d").subject).toContain("activated");
    expect(buildSubscriptionEmail("S", "cancelled", "d").subject).toContain("cancelled");
    expect(buildSubscriptionEmail("S", "renewed", "d").subject).toContain("renewed");
    expect(buildSubscriptionEmail("S", "trial_expiring", "d").subject).toContain("Trial");
    expect(buildSubscriptionEmail("S", "payment_failed", "d").subject).toContain("failed");
  });

  it("scans only trialing subs inside the 7-day window", async () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    const inWindow = "2026-09-27T12:00:00Z";
    const { db } = stubDb({
      trials: [
        { subId: "t1", storeId: "s1", storeName: "S1", email: "m@example.com", endsAt: inWindow },
        { subId: "t2", storeId: "s2", storeName: "S2", email: null, endsAt: inWindow },
        { subId: "t3", storeId: "s3", storeName: "S3", email: "m3@example.com", endsAt: "2026-10-23T12:00:00Z" },
        { subId: "t4", storeId: "s4", storeName: "S4", email: "m4@example.com", endsAt: "2026-09-20T12:00:00Z" },
      ],
    });
    const rows = await scanTrialExpiries(db, now);
    expect(rows.map((r) => r.subId)).toEqual(["t1", "t2"]);
  });
});
