-- Phase 2: Catalog
-- Tables: categories, products, product_images
-- Source of truth: sallasyria-db-structure.html (sections 3, 5, 6)
-- Builds on Phase 1 (0001_phase1_platform_and_store.sql): users, stores, plans, subscriptions.
--
-- D1 ADAPTATIONS (approved — same as Phase 1, override the document where noted):
--   * No PRAGMA foreign_keys statement — D1 enforces FKs natively.
--   * No AFTER UPDATE triggers for updated_at — application-managed by Hono.
--     created_at and the initial updated_at value still default via
--     strftime('%Y-%m-%dT%H:%M:%SZ','now') on INSERT.
--   * No BEGIN IMMEDIATE / busy_timeout / SQLITE_BUSY retry logic.
--     Transactional multi-statement writes use env.DB.batch() in app code.
--   * All ids are TEXT, generated in application code as UUIDv7/ULID.
--
-- TENANT ISOLATION NOTE:
-- Every child-of-child foreign key here is a composite
-- FOREIGN KEY (store_id, ref_id) REFERENCES parent(store_id, id), backed by a
-- UNIQUE(store_id, id) key on the parent — so a child row can never reference
-- a parent belonging to a different store. categories and products each
-- define their own UNIQUE(store_id, id) below to serve as that backing key.
-- No changes to Phase 1 tables were needed: stores is referenced directly by
-- id (not compositely) from categories.store_id / products.store_id /
-- product_images.store_id, and stores.id is already a PRIMARY KEY.
--
-- DEVIATION FROM THE DOCUMENT (flagged, not silent): the document specifies
-- ON DELETE SET NULL for categories.parent_id and products.category_id.
-- SQLite composite foreign keys do not support setting only ONE column of a
-- multi-column child key to NULL on delete — "SET NULL" on a composite FK
-- sets EVERY child key column to NULL, including store_id, which is NOT
-- NULL, so the action fails outright (this is a SQLite engine limitation,
-- confirmed against sqlite.org's own foreign key documentation, not a D1
-- quirk). A plain single-column FK would work around this but would drop
-- database-level enforcement that the referenced parent belongs to the same
-- store — unacceptable given the document's core tenant-isolation guarantee.
-- Decision (explicitly approved): keep the composite FK for full cross-store
-- protection and change the action to ON DELETE RESTRICT instead of SET
-- NULL for both categories.parent_id and products.category_id. Practical
-- effect: a category with child categories, or a category with products
-- still assigned to it, cannot be deleted until the children/products are
-- first re-parented/re-categorised (or deleted) by the application. Products
-- and categories can still be *created* with category_id/parent_id = NULL
-- (uncategorised), since NULL child-key columns are always exempt from FK
-- enforcement in SQLite.

-- ============================================================
-- categories
-- ============================================================
CREATE TABLE categories (
    id          TEXT NOT NULL,
    store_id    TEXT NOT NULL
                    REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    parent_id   TEXT,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1
                    CHECK (is_active IN (0, 1)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (id),
    -- Supporting key for composite child FKs (products.category_id, and
    -- categories.parent_id itself, self-referencing).
    UNIQUE (store_id, id),
    -- Self-referencing composite FK: a category's parent must be a category
    -- in the SAME store. ON DELETE RESTRICT (see DEVIATION note above): a
    -- parent category with children cannot be deleted until the app
    -- re-parents or removes the children first.
    FOREIGN KEY (store_id, parent_id) REFERENCES categories(store_id, id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Store-scoped uniqueness: a category's slug is unique within its store.
CREATE UNIQUE INDEX uq_categories_store_slug ON categories(store_id, slug);

-- Required non-unique index (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_categories_store_parent ON categories(store_id, parent_id);

-- ============================================================
-- products
-- ============================================================
CREATE TABLE products (
    id             TEXT NOT NULL,
    store_id       TEXT NOT NULL
                       REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    category_id    TEXT,
    name           TEXT NOT NULL,
    slug           TEXT NOT NULL,
    price          INTEGER NOT NULL CHECK (price >= 0),
    stock_quantity INTEGER CHECK (stock_quantity >= 0),
    is_active      INTEGER NOT NULL DEFAULT 1
                       CHECK (is_active IN (0, 1)),
    deleted_at     TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (id),
    -- Supporting key for composite child FKs (product_images.product_id).
    UNIQUE (store_id, id),
    -- A product's category must belong to the SAME store. ON DELETE
    -- RESTRICT (see DEVIATION note above): a category with products still
    -- assigned to it cannot be deleted until the app re-categorises or
    -- removes those products first.
    FOREIGN KEY (store_id, category_id) REFERENCES categories(store_id, id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Store-scoped uniqueness, live products only: soft-deleted products release
-- their slug for reuse (partial unique index, not an inline constraint).
CREATE UNIQUE INDEX uq_products_store_slug_live
    ON products(store_id, slug) WHERE deleted_at IS NULL;

-- Required non-unique indexes (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_products_store_category ON products(store_id, category_id);
CREATE INDEX idx_products_store_active_deleted
    ON products(store_id, is_active, deleted_at);

-- ============================================================
-- product_images
-- ============================================================
CREATE TABLE product_images (
    id          TEXT PRIMARY KEY,
    store_id    TEXT NOT NULL
                    REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    product_id  TEXT NOT NULL,
    url         TEXT NOT NULL,
    alt_text    TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- An image's product must belong to the SAME store. ON DELETE CASCADE:
    -- removing a product removes its gallery.
    FOREIGN KEY (store_id, product_id) REFERENCES products(store_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Required non-unique index (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_product_images_store_product_sort
    ON product_images(store_id, product_id, sort_order);
