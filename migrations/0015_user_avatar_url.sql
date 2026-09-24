-- User profile pictures (merchant/admin avatar).
--
-- Additive only: nullable TEXT holding an `r2://avatars/{userId}/{file}`
-- reference (same convention as product_images.url), resolved to a
-- short-lived signed URL on read — never a permanent public link.
-- Existing rows read as NULL (initials avatar), so current sessions,
-- profiles, and auth responses are unchanged. No backfill.
-- D1 ADAPTATIONS (same as prior phases): plain ADD COLUMN, no table
-- rebuild; nullable TEXT needs no default.

ALTER TABLE users ADD COLUMN avatar_url TEXT;

