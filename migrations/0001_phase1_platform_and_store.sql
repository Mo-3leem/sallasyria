-- Phase 1: Platform & Store
-- Tables: users, stores, plans, subscriptions
-- Source of truth: sallasyria-db-structure.html (sections 3, 5, 6)
--
-- D1 ADAPTATIONS (approved — override the document where noted):
--   * No PRAGMA foreign_keys statement — D1 enforces FKs natively, pragmas
--     are not used to control this on D1.
--   * No AFTER UPDATE triggers for updated_at — updated_at is application-
--     managed by the Hono layer. created_at and the initial updated_at value
--     still default via strftime('%Y-%m-%dT%H:%M:%SZ','now') on INSERT.
--   * No BEGIN IMMEDIATE / busy_timeout / SQLITE_BUSY retry logic — not
--     applicable to D1; transactional multi-statement writes are done via
--     env.DB.batch() in application code, not in migrations.
--   * All ids are TEXT, generated in application code as UUIDv7/ULID. The
--     database never generates ids.

-- ============================================================
-- users
-- ============================================================
CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    phone         TEXT NOT NULL,
    email         TEXT,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'merchant'
                       CHECK (role IN ('merchant', 'admin')),
    is_active     INTEGER NOT NULL DEFAULT 1
                       CHECK (is_active IN (0, 1)),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX uq_users_phone ON users(phone);
CREATE UNIQUE INDEX uq_users_email ON users(email) WHERE email IS NOT NULL;

-- ============================================================
-- stores
-- ============================================================
CREATE TABLE stores (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL
                       REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    slug          TEXT NOT NULL,
    name          TEXT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'SYP',
    status        TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'paused', 'archived')),
    order_counter INTEGER NOT NULL DEFAULT 1000,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX uq_stores_slug ON stores(slug);

-- Required non-unique index (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_stores_owner_id ON stores(owner_id);

-- ============================================================
-- plans
-- ============================================================
CREATE TABLE plans (
    id            TEXT PRIMARY KEY,
    code          TEXT NOT NULL,
    name          TEXT NOT NULL,
    price_monthly INTEGER NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
    price_yearly  INTEGER NOT NULL DEFAULT 0 CHECK (price_yearly >= 0),
    max_products  INTEGER,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX uq_plans_code ON plans(code);

-- ============================================================
-- subscriptions
-- ============================================================
CREATE TABLE subscriptions (
    id                TEXT PRIMARY KEY,
    store_id          TEXT NOT NULL
                           REFERENCES stores(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    plan_id           TEXT NOT NULL
                           REFERENCES plans(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    status            TEXT NOT NULL
                           CHECK (status IN ('active', 'cancelled', 'expired', 'trialing')),
    billing_period    TEXT NOT NULL
                           CHECK (billing_period IN ('monthly', 'yearly')),
    price_amount      INTEGER NOT NULL DEFAULT 0 CHECK (price_amount >= 0),
    starts_at         TEXT NOT NULL,
    ends_at           TEXT,
    cancelled_at      TEXT,
    payment_reference TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CHECK (
        (status = 'cancelled' AND cancelled_at IS NOT NULL)
        OR (status != 'cancelled' AND cancelled_at IS NULL)
    )
);

-- Partial-unique: only one active subscription per store at a time
CREATE UNIQUE INDEX uq_subscriptions_store_active
    ON subscriptions(store_id) WHERE status = 'active';

-- Required non-unique indexes (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_subscriptions_plan_id ON subscriptions(plan_id);
CREATE INDEX idx_subscriptions_store_id ON subscriptions(store_id);
