-- Product description (merchant catalog copy).
--
-- Additive only: nullable TEXT, no default, no backfill — existing rows
-- read as NULL (no description), so current listings, storefront reads,
-- and order snapshots are byte-identical. Displayed on the merchant
-- product detail page; never required at checkout.
-- D1 ADAPTATIONS (same as prior phases): plain ADD COLUMN, no table
-- rebuild; nullable TEXT needs no default.

ALTER TABLE products ADD COLUMN description TEXT;
