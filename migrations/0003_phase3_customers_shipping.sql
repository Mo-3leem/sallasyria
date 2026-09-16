-- Phase 3: Customers & Shipping
-- Tables: customers, customer_addresses, shipping_rates
-- Source of truth: sallasyria-db-structure.html (sections 3, 5, 6)
-- Builds on Phase 1 (0001_phase1_platform_and_store.sql): users, stores, plans, subscriptions.
-- Builds on Phase 2 (0002_phase2_catalog.sql): categories, products, product_images.
--
-- D1 ADAPTATIONS (approved — same as Phase 1 & 2, override the document where noted):
--   * No PRAGMA foreign_keys statement — D1 enforces FKs natively.
--   * No AFTER UPDATE triggers for updated_at — application-managed by Hono.
--     created_at and the initial updated_at value still default via
--     strftime('%Y-%m-%dT%H:%M:%SZ','now') on INSERT.
--   * No BEGIN IMMEDIATE / busy_timeout / SQLITE_BUSY retry logic.
--     Transactional multi-statement writes use env.DB.batch() in app code.
--   * All ids are TEXT, generated in application code as UUIDv7/ULID.
--
-- TENANT ISOLATION NOTE:
-- customer_addresses.customer_id is a composite FOREIGN KEY (store_id,
-- customer_id) REFERENCES customers(store_id, id), backed by the
-- UNIQUE(store_id, id) key defined on customers below — so an address can
-- never reference a customer belonging to a different store. This composite
-- FK uses ON DELETE CASCADE (not SET NULL), which does NOT hit the SQLite
-- composite-FK limitation noted in migrations/0002_phase2_catalog.sql: that
-- limitation is specific to SET NULL/SET DEFAULT actions setting every
-- child-key column (including a NOT NULL store_id); CASCADE instead removes
-- the whole child row, so there is nothing to partially null out. No
-- deviation needed for this migration.
--
-- GOVERNORATE ENFORCEMENT NOTE:
-- GOVERNORATES = ('Damascus','Rif Dimashq','Aleppo','Homs','Hama','Latakia',
-- 'Idlib','Al-Hasakah','Deir ez-Zor','Raqqa','Daraa','As-Suwayda','Quneitra',
-- 'Tartus') per the document's enforcement note. Applied here to
-- customer_addresses.governorate and shipping_rates.governorate. (The
-- document also applies this CHECK to orders.shipping_governorate, which is
-- out of scope for Phase 3.)
--
-- No changes to Phase 1 or Phase 2 tables were needed: stores is referenced
-- directly by id (not compositely) from customers.store_id /
-- customer_addresses.store_id / shipping_rates.store_id, and stores.id is
-- already a PRIMARY KEY. customers defines its own UNIQUE(store_id, id)
-- below to serve as the backing key for customer_addresses' composite FK.

-- ============================================================
-- customers
-- ============================================================
CREATE TABLE customers (
    id          TEXT NOT NULL,
    store_id    TEXT NOT NULL
                    REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (id),
    -- Supporting key for composite child FK (customer_addresses.customer_id).
    UNIQUE (store_id, id)
);

-- Store-scoped uniqueness: a customer's phone is unique within its store
-- (normalized to +963... in application code before insert).
CREATE UNIQUE INDEX uq_customers_store_phone ON customers(store_id, phone);

-- ============================================================
-- customer_addresses
-- ============================================================
CREATE TABLE customer_addresses (
    id             TEXT PRIMARY KEY,
    store_id       TEXT NOT NULL
                       REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    customer_id    TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    phone          TEXT NOT NULL,
    governorate    TEXT NOT NULL
                       CHECK (governorate IN (
                           'Damascus', 'Rif Dimashq', 'Aleppo', 'Homs', 'Hama',
                           'Latakia', 'Idlib', 'Al-Hasakah', 'Deir ez-Zor',
                           'Raqqa', 'Daraa', 'As-Suwayda', 'Quneitra', 'Tartus'
                       )),
    city           TEXT,
    address_line   TEXT NOT NULL,
    is_default     INTEGER NOT NULL DEFAULT 0
                       CHECK (is_default IN (0, 1)),
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- An address's customer must belong to the SAME store. ON DELETE
    -- CASCADE: removing a customer removes their saved addresses.
    FOREIGN KEY (store_id, customer_id) REFERENCES customers(store_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Partial-unique: only one default address per customer at a time.
CREATE UNIQUE INDEX uq_addresses_customer_default
    ON customer_addresses(customer_id) WHERE is_default = 1;

-- Required non-unique index (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_customer_addresses_store_customer
    ON customer_addresses(store_id, customer_id);

-- ============================================================
-- shipping_rates
-- ============================================================
CREATE TABLE shipping_rates (
    id              TEXT PRIMARY KEY,
    store_id        TEXT NOT NULL
                        REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    governorate     TEXT NOT NULL
                        CHECK (governorate IN (
                            'Damascus', 'Rif Dimashq', 'Aleppo', 'Homs', 'Hama',
                            'Latakia', 'Idlib', 'Al-Hasakah', 'Deir ez-Zor',
                            'Raqqa', 'Daraa', 'As-Suwayda', 'Quneitra', 'Tartus'
                        )),
    shipping_method TEXT NOT NULL,
    cost            INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
    is_active       INTEGER NOT NULL DEFAULT 1
                        CHECK (is_active IN (0, 1)),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Store-scoped uniqueness: one rate per governorate per store.
CREATE UNIQUE INDEX uq_shipping_rates_store_governorate
    ON shipping_rates(store_id, governorate);
