-- Phase 8: self-serve billing intents (provider-agnostic).
--
-- A billing_intent is a merchant-initiated checkout attempt for one store +
-- plan + period. The row carries the SERVER-resolved price (client money is
-- rejected at the route), an idempotency key scoped per store, and a
-- terminal state machine: pending -> succeeded | failed | expired.
-- Webhook success appends an `active` subscription period (never mutates
-- history); the partial-unique index on subscriptions collapses concurrent
-- double-pays into exactly one active period (idempotent success).
CREATE TABLE billing_intents (
    id              TEXT PRIMARY KEY,
    store_id        TEXT NOT NULL
                        REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    plan_id         TEXT NOT NULL
                        REFERENCES plans(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    billing_period  TEXT NOT NULL
                        CHECK (billing_period IN ('monthly', 'yearly')),
    amount          INTEGER NOT NULL CHECK (amount >= 0),
    currency        TEXT NOT NULL DEFAULT 'SYP',
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed', 'expired')),
    provider        TEXT NOT NULL,
    provider_ref    TEXT,
    event_id        TEXT,
    idempotency_key TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    return_url      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Same key in one store always resolves to the same intent (replay-safe);
-- key strings are independent per store.
CREATE UNIQUE INDEX uq_intents_store_key ON billing_intents(store_id, idempotency_key);

-- Required non-unique indexes (SQLite does not auto-index FK columns).
CREATE INDEX idx_intents_store ON billing_intents(store_id, created_at);
