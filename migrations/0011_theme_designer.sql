-- P3: merchant theme designer (draft/published) + signed preview tokens.
--
-- Design decisions (approved plan):
-- - Draft is the working copy; published_snapshot is byte-for-byte what
--   buyers render. Publish = audited snapshot copy, never a mutation of
--   history (there is no theme history table in MVP — only current draft
--   plus current published snapshot).
-- - Preview tokens are hashed at rest (like email tokens), single-purpose
--   ("preview"), 15-minute TTL, one-live-per-store (new publish or new
--   token request retires live ones).
-- - Deleting a store cascades both tables (tenant cleanup, no orphans).
CREATE TABLE themes (
    store_id          TEXT PRIMARY KEY
                          REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    draft             TEXT NOT NULL DEFAULT '{}',
    published_snapshot TEXT,
    published_at      TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE theme_previews (
    id          TEXT PRIMARY KEY,
    store_id    TEXT NOT NULL
                    REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    purpose     TEXT NOT NULL DEFAULT 'preview' CHECK (purpose = 'preview'),
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_theme_previews_store ON theme_previews(store_id);
