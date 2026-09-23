import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";
import { sendMail, dispatchMail } from "./mail.js";
import type { Env } from "../env.js";

// Mail outbox (P4): exactly-once dispatch intents. The dedupe_key INSERT is
// the CAS — concurrent triggers for the same event collapse to one row and
// only the inserter dispatches (via dispatchMail post-commit). Never throws:
// mail can never fail checkout, transitions, or billing. Absent recipient
// (no email on file) means skip, never fabricate.

export interface OutboxMail {
  to: string;
  subject: string;
  text: string;
}

export async function enqueueMail(
  db: D1Database,
  dedupeKey: string,
  mail: OutboxMail,
  nowIso: string = touch()
): Promise<boolean> {
  if (!mail.to) return false;
  const res = await db
    .prepare(
      "INSERT INTO mail_outbox (id, dedupe_key, recipient, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING"
    )
    .bind(uuidv7(), dedupeKey, mail.to, mail.subject, mail.text, nowIso)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export function markOutboxSent(db: D1Database, dedupeKey: string): D1PreparedStatement {
  return db.prepare("UPDATE mail_outbox SET status = 'sent' WHERE dedupe_key = ?").bind(dedupeKey);
}

// Post-commit fire helper: CAS-enqueues the intent, and only the inserter
// dispatches (fire-and-log, never throws, never awaits). All trigger sites
// (checkout, transitions, billing, trial scan) funnel here so the
// exactly-once rule has one implementation.
export async function fireOutboxMail(
  db: D1Database,
  env: Env,
  c: unknown,
  dedupeKey: string,
  mail: OutboxMail
): Promise<boolean> {
  let queued = false;
  try {
    queued = await enqueueMail(db, dedupeKey, mail);
  } catch {
    return false;
  }
  if (!queued) return false;
  dispatchMail(
    c,
    sendMail({ to: mail.to, subject: mail.subject, text: mail.text }, { apiKey: env.SENDGRID_API_KEY, from: env.MAIL_FROM })
  );
  return true;
}

export function buildSubscriptionEmail(
  storeName: string,
  event: "activated" | "cancelled" | "renewed" | "trial_expiring" | "payment_failed",
  detail: string
): { subject: string; text: string } {
  const subjects: Record<string, string> = {
    activated: `Subscription activated for ${storeName}`,
    cancelled: `Subscription cancelled for ${storeName}`,
    renewed: `Subscription renewed for ${storeName}`,
    trial_expiring: `Trial ending soon for ${storeName}`,
    payment_failed: `Payment failed for ${storeName}`,
  };
  return {
    subject: subjects[event] ?? `Subscription update for ${storeName}`,
    text: `${subjects[event] ?? "Subscription update"}.\n\n${detail}\n\nThank you for using Salla Syria.\n`,
  };
}
