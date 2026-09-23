-- P1 (path-based program): storefront visibility flag.
--
-- Draft invisibility is enforced by middleware (resolvePublishedStore),
-- not by CHECK surgery: SQLite cannot ALTER a CHECK, and rebuilding the
-- stores table would endanger every composite FK in phases 2-4. A plain
-- flag column keeps the change additive and backfillable.
-- Semantics: is_published = 1 means buyers may resolve the store through
-- public routes; 0 means drafts (merchant-private routes ignore the flag —
-- owners always manage their own stores). All pre-existing stores predate
-- drafts and are therefore published.
ALTER TABLE stores ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0 CHECK(is_published IN (0, 1));

UPDATE stores SET is_published = 1;

CREATE INDEX idx_stores_published ON stores(is_published);
