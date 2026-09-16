-- B6: Checkout Idempotency Keys
-- Tables: idempotency_keys (new, additive only — 0001-0005 untouched)
-- Source of truth: Backend Roadmap v3 (B6) + validated second-pass review.
--
-- D1 ADAPTATIONS (approved — same as all prior phases):
--   * No PRAGMA foreign_keys statement — D1 enforces FKs natively.
--   * No AFTER UPDATE triggers for updated_at — application-managed by Hono.
--   * No BEGIN IMMEDIATE / busy_timeout / SQLITE_BUSY retry logic.
--   * All ids are TEXT, generated in application code as UUIDv7/ULID.
--
-- DESIGN NOTES (validated; this table is load-bearing for exactly-once):
--   * KV alone CANNOT do this: check-then-act across KV+D1 races under
--     concurrency. Only a UNIQUE constraint evaluated INSIDE the checkout
--     batch guarantees exactly one order per key: the loser's whole batch
--     (counter, stock, order, items) rolls back on the conflict.
--   * Claim shape: the key row is INSERTed as the FIRST statement of the
--     checkout batch, carrying the pre-generated order id. Replay reads the
--     row back and returns the stored order; no second order can exist.
--   * request_hash (SHA-256 of the canonical request body) distinguishes
--     legitimate retry (same key + same body -> replay) from key reuse with
--     a different payload (-> 422, never silently complied).
--   * status exists for forward-compat (async futures); by construction only
--     'completed' rows ever persist — anything else rolls back with its batch.
--     No CHECK constrains it to one value; the application is the enforcer.
--   * order_id is nullable so the shape also supports claim-before-order
--     patterns later; in current flow it is always set. NULL composite-FK
--     parts are exempt from enforcement (verified, DB track).
--   * ON DELETE CASCADE on both FKs: deleting an order removes its key claim
--     (the same key then retries as fresh); deleting a store removes its keys.
--     Orders with history are never deleted in normal flow (RESTRICT above).
--   * TTL: rows older than the retention window (24-72h, B7 purge cron) are
--     deleted by (store_id, created_at) via the index below. Replaying a
--     purged key simply creates a new order — documented and acceptable.
--
-- ============================================================
-- idempotency_keys
-- ============================================================
CREATE TABLE idempotency_keys (
    key          TEXT PRIMARY KEY,
    store_id     TEXT NOT NULL
                      REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    order_id     TEXT,
    request_hash TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'completed',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- A key's order must belong to the SAME store. ON DELETE CASCADE:
    -- removing an order removes its key claim (see design note).
    FOREIGN KEY (store_id, order_id) REFERENCES orders(store_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Purge support: retention-window deletes scan one store's keys by age.
CREATE INDEX idx_idempotency_store_created ON idempotency_keys(store_id, created_at);
