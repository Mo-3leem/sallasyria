-- 0007: scope idempotency keys per store.
--
-- Design change (validated review of the B6 exactly-once mechanism):
--   * BEFORE: key TEXT PRIMARY KEY made every key globally unique, so two
--     stores could never independently reuse the same key string -- the
--     second store's checkout failed 422 idempotency_conflict even for a
--     completely unrelated order.
--   * AFTER: PRIMARY KEY (store_id, key). Same key in different stores are
--     independent rows; same key in the same store keeps the exact
--     check-then-claim-inside-batch semantics (loser's batch still aborts on
--     the composite UNIQUE, then replays the winner).
--
-- Migration safety:
--   * Data-preserving: every existing row is copied verbatim (same columns,
--     same values). Global key uniqueness implies (store_id, key)
--     uniqueness, so the copy cannot violate the new PRIMARY KEY.
--   * Nothing else references idempotency_keys (it is a leaf: keys point at
--     stores/orders, never the reverse), so DROP is safe.
--   * FKs are re-declared identically (stores CASCADE, orders composite
--     CASCADE) and enforced during the copy.
--
-- D1 ADAPTATIONS (same as all prior phases):
--   * No PRAGMA, no BEGIN/COMMIT (migration runner handles transactions).
--   * No triggers; created_at keeps its strftime default.

CREATE TABLE idempotency_keys_new (
    key          TEXT NOT NULL,
    store_id     TEXT NOT NULL
                      REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    order_id     TEXT,
    request_hash TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'completed',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (store_id, key),
    -- A key's order must belong to the SAME store. ON DELETE CASCADE:
    -- removing an order removes its key claim (see 0006 design notes).
    FOREIGN KEY (store_id, order_id) REFERENCES orders(store_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO idempotency_keys_new (key, store_id, order_id, request_hash, status, created_at)
    SELECT key, store_id, order_id, request_hash, status, created_at FROM idempotency_keys;

DROP TABLE idempotency_keys;

ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys;

CREATE INDEX idx_idempotency_store_created ON idempotency_keys(store_id, created_at);
