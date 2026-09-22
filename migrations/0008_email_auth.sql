-- 0008: email-based authentication identity + email tokens.
--
-- Design (email-login migration):
--   * users.email_verified records verification; informational only, gates
--     nothing (login/checkout never read it).
--   * email stays NULLABLE with the existing partial UNIQUE index: registration
--     requires an email at the application layer, but existing rows without
--     one (possible from earlier phone-only flows) keep working. Phone stays
--     NOT NULL UNIQUE and is still collected at registration as contact
--     identity — it simply no longer authenticates.
--   * email_tokens holds single-use hashed tokens for verification, resend,
--     and password reset, distinguished by purpose. Tokens are redeemed with
--     a compare-and-swap UPDATE (used_at IS NULL AND expires_at > now) so
--     concurrent redeems collapse to exactly one winner; hash-only storage
--     means a DB read proves nothing without the raw token (same model as
--     sessions).
--   * Order/status emails need no table: confirmation sends only when the
--     checkout result is not a replay, and transition emails only on a
--     CAS-applied 200 (retried PATCHes 409 and send nothing).
--
-- D1 ADAPTATIONS (same as all prior phases): no PRAGMA, no triggers, no
-- BEGIN/COMMIT (migration runner handles transactions).

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0
    CHECK (email_verified IN (0, 1));

CREATE TABLE email_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX uq_email_tokens_hash ON email_tokens(token_hash);
CREATE INDEX idx_email_tokens_user_purpose ON email_tokens(user_id, purpose);
