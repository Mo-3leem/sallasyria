import type { D1Database } from "@cloudflare/workers-types";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";
import { auditLog, type AuditAction } from "../lib/audit.js";

// Persistent audit trail (roadmap B12). Every auditLog() console line is
// mirrored into audit_logs so the admin viewer can query it; the console
// format stays byte-identical for existing alert grep. Rows carry ids only
// (same no-PII rule as the log lines).

export interface AuditRow {
  id: string;
  created_at: string;
  action: string;
  actor_id: string;
  store_id: string | null;
  result: string;
}

export interface AuditFields {
  actor: string;
  store?: string;
  result: string;
}

export async function insertAuditRow(
  db: D1Database,
  action: AuditAction,
  fields: AuditFields,
  nowIso: string = touch()
): Promise<AuditRow> {
  const row: AuditRow = {
    id: uuidv7(),
    created_at: nowIso,
    action,
    actor_id: fields.actor,
    store_id: fields.store ?? null,
    result: fields.result,
  };
  await db
    .prepare(
      "INSERT INTO audit_logs (id, created_at, action, actor_id, store_id, result) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(row.id, row.created_at, row.action, row.actor_id, row.store_id, row.result)
    .run();
  return row;
}

export interface AuditFilters {
  action?: string | null;
  actor?: string | null;
  store?: string | null;
  since?: string | null;
  until?: string | null;
}

export interface AuditPage {
  events: AuditRow[];
  total: number;
}

// Admin audit viewer query (roadmap B12): newest first with id tie-break,
// offset page + filtered total from the same predicates. Date bounds are
// ISO-8601 strings compared lexicographically (TEXT timestamps sort).
export async function listAuditLog(
  db: D1Database,
  filters: AuditFilters,
  opts: { page: number; pageSize: number }
): Promise<AuditPage> {
  const args: unknown[] = [];
  const clauses: string[] = [];
  if (filters.action != null && filters.action !== "") {
    clauses.push("action = ?");
    args.push(filters.action);
  }
  if (filters.actor != null && filters.actor !== "") {
    clauses.push("actor_id = ?");
    args.push(filters.actor);
  }
  if (filters.store != null && filters.store !== "") {
    clauses.push("store_id = ?");
    args.push(filters.store);
  }
  if (filters.since != null && filters.since !== "") {
    clauses.push("created_at >= ?");
    args.push(filters.since);
  }
  if (filters.until != null && filters.until !== "") {
    clauses.push("created_at <= ?");
    args.push(filters.until);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (opts.page - 1) * opts.pageSize;
  const res = await db
    .prepare(
      `SELECT id, created_at, action, actor_id, store_id, result FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .bind(...args, opts.pageSize, offset)
    .all<AuditRow>();
  const counted = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`)
    .bind(...args)
    .first<{ n: number }>();
  return { events: res.results ?? [], total: counted?.n ?? 0 };
}

// Dual-sink audit emit (roadmap B12): console line first (existing alert
// grep keeps working even if persistence fails), then a D1 insert. In the
// Worker the insert rides executionCtx.waitUntil so responses are not
// delayed — which means persistence can become visible slightly AFTER the
// request completes; a viewer read in the next millisecond may not show the
// just-written row yet. Without an execution context (in-process tests) it
// awaits inline, so tests observe durable rows deterministically. Insert
// failures are logged loudly but never fail the business operation that
// triggered them.
export async function auditEvent(
  c: unknown,
  db: D1Database,
  action: AuditAction,
  fields: AuditFields
): Promise<void> {
  auditLog(action, fields);
  const task = insertAuditRow(db, action, fields).then(
    () => undefined,
    (err: unknown) => {
      console.error(
        `audit persist failed action=${action} actor=${fields.actor} error=${err instanceof Error ? err.message : String(err)}`
      );
    }
  );
  try {
    const ctx = (c as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } } | null)
      ?.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
      return;
    }
  } catch {
    // No execution context: fall through to inline await below.
  }
  await task;
}
