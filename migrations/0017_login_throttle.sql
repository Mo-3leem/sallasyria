-- B4: persistent per-account login throttle.
--
-- The brute-force escalation counter used to live in worker memory, so a
-- restart (or a second isolate) silently reset every attacker's progress.
-- This table makes consecutive-failure counting and the 15-minute lockout
-- durable per canonical identity. Unknown identities get identical ghost
-- rows keyed by the same identity string, so misses cost nothing extra and
-- reveal nothing. Additive only: no existing table changes, no backfill.
-- Stale rows (no recent activity) are removed by the maintenance purge.

CREATE TABLE login_throttle (
    identity     TEXT PRIMARY KEY,
    fails        INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),
    locked_until TEXT,
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_login_throttle_updated ON login_throttle(updated_at);
