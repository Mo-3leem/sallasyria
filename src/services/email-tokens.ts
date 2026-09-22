import type { D1Database } from "@cloudflare/workers-types";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Single-use email tokens (verification + password reset). Security model
// mirrors sessions: 32 random bytes over the wire, SHA-256 hash at rest, so
// a DB read proves nothing without the raw token. Redemption is a
// compare-and-swap UPDATE (used_at IS NULL AND expires_at > now): concurrent
// redeems collapse to exactly one winner, every other outcome (unknown,
// expired, already-used) is indistinguishable null — no enumeration.

export type EmailTokenPurpose = "verify" | "reset";

export const VERIFY_TOKEN_TTL_MS = 24 * 3600 * 1000;
export const RESET_TOKEN_TTL_MS = 3600 * 1000;

export function newEmailToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashEmailToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function expiryIso(ttlMs: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + ttlMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Issues a token, retiring any live same-purpose tokens for the user first
// (one outstanding token per purpose: stale links die on re-request).
export async function issueEmailToken(
  db: D1Database,
  userId: string,
  purpose: EmailTokenPurpose,
  ttlMs: number,
  nowIso: string = touch()
): Promise<{ token: string }> {
  const token = newEmailToken();
  const tokenHash = await hashEmailToken(token);
  const id = uuidv7();
  await db.batch([
    db
      .prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL")
      .bind(nowIso, userId, purpose),
    db
      .prepare(
        "INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, userId, purpose, tokenHash, expiryIso(ttlMs), nowIso, nowIso),
  ]);
  return { token };
}

// Atomically claims a live token and returns its owner. Exactly one
// concurrent caller can win; everyone else (and every replay, expired, or
// forged token) gets null with no distinguishing signal.
export async function redeemEmailToken(
  db: D1Database,
  token: string,
  purpose: EmailTokenPurpose,
  nowIso: string = touch()
): Promise<{ userId: string } | null> {
  const tokenHash = await hashEmailToken(token);
  const claimed = await db
    .prepare(
      "UPDATE email_tokens SET used_at = ?, updated_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?"
    )
    .bind(nowIso, nowIso, tokenHash, purpose, nowIso)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return null;
  const row = await db
    .prepare("SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = ?")
    .bind(tokenHash, purpose)
    .first<{ user_id: string }>();
  if (!row) return null;
  return { userId: row.user_id };
}

export async function findUserByEmail(
  db: D1Database,
  email: string
): Promise<{ id: string; name: string; email: string | null } | null> {
  return db
    .prepare("SELECT id, name, email FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; name: string; email: string | null }>();
}
