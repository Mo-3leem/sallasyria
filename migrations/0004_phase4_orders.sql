-- Phase 4 (final): Orders & Fulfillment
-- Tables: orders, order_items
-- Source of truth: sallasyria-db-structure.html (sections 3, 5, 6)
-- Builds on Phase 1 (0001_phase1_platform_and_store.sql): users, stores, plans, subscriptions.
-- Builds on Phase 2 (0002_phase2_catalog.sql): categories, products, product_images.
-- Builds on Phase 3 (0003_phase3_customers_shipping.sql): customers, customer_addresses, shipping_rates.
--
-- D1 ADAPTATIONS (approved — same as Phase 1, 2 & 3, override the document where noted):
--   * No PRAGMA foreign_keys statement — D1 enforces FKs natively.
--   * No AFTER UPDATE triggers for updated_at — application-managed by Hono.
--     created_at and the initial updated_at value still default via
--     strftime('%Y-%m-%dT%H:%M:%SZ','now') on INSERT.
--   * No BEGIN IMMEDIATE / busy_timeout / SQLITE_BUSY retry logic.
--     Transactional multi-statement writes use env.DB.batch() in app code.
--   * All ids are TEXT, generated in application code as UUIDv7/ULID.
--
-- TENANT ISOLATION NOTE:
-- orders.store_id and order_items.store_id reference stores(id) directly
-- (single column, not composite) per the document — stores.id is already a
-- PRIMARY KEY, so no supporting UNIQUE(store_id, id) was needed on stores.
-- orders.customer_id is a composite FOREIGN KEY (store_id, customer_id)
-- REFERENCES customers(store_id, id), backed by the UNIQUE(store_id, id) key
-- defined on customers in Phase 3 — an order can never reference a customer
-- belonging to a different store. order_items.order_id is a composite
-- FOREIGN KEY (store_id, order_id) REFERENCES orders(store_id, id), backed by
-- the UNIQUE(store_id, id) key defined on orders below. order_items.product_id
-- is a composite FOREIGN KEY (store_id, product_id) REFERENCES
-- products(store_id, id), backed by the existing UNIQUE(store_id, id) key
-- defined on products in Phase 2 — see DEVIATION note below for why its
-- ON DELETE action differs from the document.
--
-- No changes to Phase 1, 2, or 3 tables were needed. orders defines its own
-- UNIQUE(store_id, id) below to serve as the backing key for
-- order_items.order_id.
--
-- GOVERNORATE ENFORCEMENT NOTE:
-- GOVERNORATES = ('Damascus','Rif Dimashq','Aleppo','Homs','Hama','Latakia',
-- 'Idlib','Al-Hasakah','Deir ez-Zor','Raqqa','Daraa','As-Suwayda','Quneitra',
-- 'Tartus') per the document's enforcement note, applied here to
-- orders.shipping_governorate — the same frozen list already applied to
-- customer_addresses.governorate and shipping_rates.governorate in Phase 3.
--
-- DEVIATION FROM THE DOCUMENT (flagged, not silent): the document specifies
-- ON DELETE SET NULL for order_items.product_id. Two independent reasons
-- this migration uses ON DELETE RESTRICT instead, on a composite FK:
--   (a) SQLite engine limitation (same as the Phase 2 categories/products
--       deviation): "SET NULL" on a composite FOREIGN KEY (store_id,
--       product_id) sets EVERY child key column to NULL, including
--       store_id, which is NOT NULL on order_items — so the action fails
--       outright. This is confirmed against sqlite.org's own foreign key
--       documentation, not a D1 quirk.
--   (b) Even if the engine limitation did not exist, SET NULL would be the
--       wrong behavior here: products.deleted_at is a soft-deletion marker
--       (see Phase 2) — products are never hard-deleted while order history
--       references them. order_items already carries full snapshot columns
--       (product_name, unit_price, line_total, selected_options) precisely
--       so that past orders remain correct even after a product is retired.
--       A hard DELETE FROM products attempted while order_items still
--       reference it must be BLOCKED, not silently allowed to null out the
--       link — that would sever traceability from a historical order line
--       back to the product record. Soft-deleting a product (UPDATE
--       products SET deleted_at = ... WHERE id = ?) is unaffected by this FK
--       entirely and always succeeds, since the product row itself is not
--       removed.
-- Decision (explicitly approved): keep the composite FK for full cross-store
-- protection and use ON DELETE RESTRICT instead of SET NULL for
-- order_items.product_id. Practical effect: a product with order_items still
-- referencing it cannot be hard-deleted; the application soft-deletes
-- products instead (as already established in Phase 2), which never engages
-- this FK's delete action at all. order_items.product_id can still be
-- *created* as NULL (e.g. a manual/custom line with no catalog product),
-- since NULL child-key columns are always exempt from FK enforcement in
-- SQLite.
--
-- CHECKOUT TRANSACTION CONTRACT (D1 version — see Connection Contract note
-- below for what does NOT carry over from the document):
--   1. In the Hono checkout handler, increment stores.order_counter, insert
--      the order, and insert all order_items in ONE single env.DB.batch()
--      call, so a later failure in the batch rolls back every statement in
--      it and order numbers are never skipped. D1's batch() executes all
--      statements in one implicit transaction; there is no BEGIN IMMEDIATE
--      and no manual COMMIT/ROLLBACK in application code.
--   2. The counter increment is issued as
--      UPDATE stores SET order_counter = order_counter + 1
--      WHERE id = ? RETURNING order_counter
--      as one of the statements in that same batch — never a separate
--      SELECT followed by UPDATE, so two concurrent checkouts can never read
--      and reuse the same counter value.
--   3. order_number for the new order is exactly the value RETURNING'd by
--      that UPDATE.
--   4. The customer row is upserted with
--      INSERT INTO customers (...) VALUES (...)
--      ON CONFLICT(store_id, phone) DO UPDATE SET ...
--      rather than check-then-insert, so a concurrent double-submit by the
--      same buyer resolves atomically instead of surfacing a UNIQUE
--      constraint error.
--   5. order_items.line_total is computed in application code as
--      quantity * unit_price, and orders.total is computed in application
--      code as subtotal - discount + shipping_cost, both before the batch is
--      built — the database cannot check these across the orders/order_items
--      boundary, so the app is the source of truth for this arithmetic and
--      the CHECK constraints below only guard against negative values.
--   6. No BEGIN IMMEDIATE, no PRAGMA busy_timeout, no SQLITE_BUSY retry loop
--      is used anywhere in this contract — env.DB.batch() is D1's own
--      transactional primitive and supersedes that part of the document's
--      Connection Contract entirely on D1.

-- ============================================================
-- orders
-- ============================================================
CREATE TABLE orders (
    id                     TEXT NOT NULL,
    store_id               TEXT NOT NULL
                               REFERENCES stores(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    customer_id            TEXT NOT NULL,
    order_number           INTEGER NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                   'pending', 'confirmed', 'processing',
                                   'shipped', 'delivered', 'cancelled'
                               )),
    subtotal               INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    discount               INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
    total                  INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
    payment_method         TEXT NOT NULL DEFAULT 'cod'
                               CHECK (payment_method IN ('cod', 'bank_transfer', 'wallet')),
    payment_status         TEXT NOT NULL DEFAULT 'pending'
                               CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
    payment_reference      TEXT,
    tracking_number        TEXT,
    customer_name          TEXT NOT NULL,
    customer_phone         TEXT NOT NULL,
    shipping_method        TEXT NOT NULL,
    shipping_cost          INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
    shipping_governorate   TEXT NOT NULL
                               CHECK (shipping_governorate IN (
                                   'Damascus', 'Rif Dimashq', 'Aleppo', 'Homs', 'Hama',
                                   'Latakia', 'Idlib', 'Al-Hasakah', 'Deir ez-Zor',
                                   'Raqqa', 'Daraa', 'As-Suwayda', 'Quneitra', 'Tartus'
                               )),
    shipping_address       TEXT NOT NULL,
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (id),
    -- Supporting key for composite child FK (order_items.order_id).
    UNIQUE (store_id, id),
    -- An order's customer must belong to the SAME store. ON DELETE RESTRICT:
    -- a customer with orders cannot be removed (order history is never
    -- orphaned).
    FOREIGN KEY (store_id, customer_id) REFERENCES customers(store_id, id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Order numbers are unique per store, issued from the store's own counter —
-- never globally unique.
CREATE UNIQUE INDEX uq_orders_store_order_number ON orders(store_id, order_number);

-- Required non-unique indexes (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_orders_store_customer ON orders(store_id, customer_id);
CREATE INDEX idx_orders_store_status ON orders(store_id, status);
CREATE INDEX idx_orders_store_created_at ON orders(store_id, created_at);

-- ============================================================
-- order_items
-- ============================================================
CREATE TABLE order_items (
    id                TEXT PRIMARY KEY,
    store_id          TEXT NOT NULL
                          REFERENCES stores(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    order_id          TEXT NOT NULL,
    product_id        TEXT,
    quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    product_name      TEXT NOT NULL,
    selected_options  TEXT,
    unit_price        INTEGER NOT NULL CHECK (unit_price >= 0),
    line_total        INTEGER NOT NULL CHECK (line_total >= 0),
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- A line's order must belong to the SAME store. ON DELETE CASCADE:
    -- removing an order removes its lines.
    FOREIGN KEY (store_id, order_id) REFERENCES orders(store_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- A line's product must belong to the SAME store. ON DELETE RESTRICT
    -- (see DEVIATION note above, not the document's SET NULL): a product
    -- with order_items still referencing it cannot be hard-deleted; the
    -- application soft-deletes products instead, which does not engage this
    -- FK's delete action at all. product_id may still be NULL (no catalog
    -- product / custom line), since NULL is always exempt from FK checks.
    FOREIGN KEY (store_id, product_id) REFERENCES products(store_id, id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Required non-unique index (FK columns are not auto-indexed by SQLite/D1)
CREATE INDEX idx_order_items_store_order ON order_items(store_id, order_id);
