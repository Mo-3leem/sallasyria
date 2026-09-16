-- DB-S1: Server-Side Sessions
-- Tables: sessions (new, additive only — 0001-0004 untouched)
-- Source of truth: Backend Roadmap v3 (DB-S1), structure doc sections 3/6 conventions.
--
-- D1 ADAPTATIONS (approved — same as Phases 1-4, override the document where noted):
--   * No PRAGMA foreign_keys statement — D1 enforces FKs natively.
--   * No AFTER UPDATE triggers for updated_at — application-managed by Hono.
--     created_at and the initial updated_at value still default via
--     strftime('%Y-%m-%dT%H:%M:%SZ','now') on INSERT.
--   * No BEGIN IMMEDIATE / busy_timeout / SQLITE_BUSY retry logic.
--     Transactional multi-statement writes use env.DB.batch() in app code.
--   * All ids are TEXT, generated in application code as UUIDv7/ULID.
--
-- DESIGN NOTES (explicitly approved):
--   * Sessions are user-scoped, NOT store-scoped: there is deliberately no
--     store_id column. Authentication (who) and tenant authorization (which
--     store, resolved per request in B3) stay separate concerns.
--   * Only SHA-256 hex of the opaque session token is stored (token_hash).
--     The raw token exists only in the client's HttpOnly cookie and is never
--     persisted, logged, or returned in API JSON.
--   * Expiry and revocation are enforced by application queries (B2):
--       valid  <=> revoked_at IS NULL AND expires_at > now
--     The database stores the timestamps; it does not police the clock.
--   * revoked_at preserves the row for audit instead of deleting it; a purge
--     job (B7) removes rows where the session is long expired/revoked.
--   * last_used_at supports idle timeout (B2); it is bumped at most every N
--     minutes by the app, never per request unconditionally.
--   * Escape-hatch note: a store export (WHERE store_id = ?) does NOT copy
--     sessions. Users simply re-authenticate against the isolated database;
--     no session state is required for the copy to be complete.
--
-- ============================================================
-- sessions
-- ============================================================
CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL
                      REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    token_hash   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    revoked_at   TEXT,
    last_used_at TEXT
);

-- Global lookup by token hash: exactly one session per token, so a presented
-- token can never resolve to two users and double-use is impossible.
CREATE UNIQUE INDEX uq_sessions_token_hash ON sessions(token_hash);

-- Per-user session listing/revocation (e.g. "log out everywhere else").
CREATE INDEX idx_sessions_user ON sessions(user_id);
