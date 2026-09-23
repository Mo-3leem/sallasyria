-- P4: customer accounts, server carts, buyer sessions/tokens, mail outbox.
-- Customer accounts extend the existing customers row (guest rows have NULL
-- password_hash). Phone stays UNIQUE per store, so guest->account conversion
-- by same-phone is unambiguous and history is retained, never merged.

ALTER TABLE customers ADD COLUMN password_hash TEXT;
ALTER TABLE customers ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Buyer sessions: separate table from merchant sessions (different principal).
-- Authenticated via the ss_buyer host-only cookie (no Domain attribute, same
-- rule as ss_session); a merchant token never validates here and vice versa.
CREATE TABLE buyer_sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_buyer_sessions_customer ON buyer_sessions(customer_id);
CREATE INDEX idx_buyer_sessions_expiry ON buyer_sessions(expires_at);

-- Buyer email tokens (verify / reset), mirroring email_tokens for users.
CREATE TABLE buyer_tokens (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (purpose IN ('verify_email', 'reset_password'))
);
CREATE INDEX idx_buyer_tokens_customer ON buyer_tokens(customer_id);

-- Server carts: guest (customer_id NULL, capability = unguessable id) or
-- account-bound (one active row per store+customer). 30-day TTL; stock is
-- re-validated at checkout; consumption is a CAS claim (checked_out_at).
CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  checked_out_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_carts_store ON carts(store_id);
CREATE INDEX idx_carts_customer ON carts(store_id, customer_id);
CREATE INDEX idx_carts_expiry ON carts(expires_at);

CREATE TABLE cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 999),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (cart_id, product_id)
);
CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);

-- Mail outbox: exactly-once dispatch intent per event. The dedupe_key insert
-- is the CAS: concurrent triggers for the same event collapse to one row and
-- only the inserter dispatches. Retention-purged with idempotency keys.
CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'skipped')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_mail_outbox_created ON mail_outbox(created_at);
