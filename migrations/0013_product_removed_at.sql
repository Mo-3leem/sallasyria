-- Product business-delete marker (archive vs delete separation).
--
-- Until now products.deleted_at meant "archived/retired" (the DELETE route
-- is a soft retirement). The business now needs a separate Deleted state:
-- removed from the catalog permanently from a business perspective, but the
-- row must stay because order_items references it (composite FK
-- ON DELETE RESTRICT, see 0004).
--
-- Design (additive, zero data rewrite):
--   * deleted_at keeps its exact meaning: archived (or deleted — delete
--     always sets deleted_at too, see below).
--   * removed_at NULL  = not deleted; NOT NULL = business-deleted.
--   * Delete sets deleted_at AND removed_at AND is_active = 0 atomically,
--     so every existing deleted_at IS NULL guard (storefront, checkout,
--     cart, plan limit, live-slug partial index) automatically excludes
--     deleted products with zero query changes.
--   * Lifecycle: active (both NULL) -> archived (deleted_at set) ->
--     deleted (both set); direct active -> deleted allowed. Restore clears
--     both flags (slug-clash 409 preserved via the existing partial index).
--   * Existing rows are untouched: removed_at defaults NULL, so every
--     current active product stays active and every archived one stays
--     (only) archived.
-- D1 ADAPTATIONS (same as prior phases): plain ADD COLUMN, no table
-- rebuild; nullable TEXT needs no default.

ALTER TABLE products ADD COLUMN removed_at TEXT;

CREATE INDEX idx_products_store_removed ON products(store_id, removed_at);
