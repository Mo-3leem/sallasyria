-- B12: persistent admin audit log.
--
-- Audit events were console-only (Workers Logs grep). The admin audit viewer
-- needs them queryable: this table stores exactly what auditLog() emits
-- (action/actor/store/result) plus a server timestamp. Additive only: no
-- existing table changes, no backfill (console history stays where it is).
-- Unbounded growth is handled by retention policy (maintenance purge), not
-- by this migration. D1 adaptations: plain CREATE TABLE + indexes, TEXT
-- timestamps in ISO-8601 UTC like every other table.

CREATE TABLE audit_logs (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    action     TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    store_id   TEXT,
    result     TEXT NOT NULL
);

CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_action_created ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
