import type { D1Database } from "@cloudflare/workers-types";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";
import {
  newEmailToken,
  hashEmailToken,
  VERIFY_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_MS,
} from "./email-tokens.js";

// Buyer email tokens (customer account verify + reset). Same security model
// as user email tokens (hash at rest, CAS redeem, indistinguishable null),
// namespaced to the buyer_tokens table keyed by customer_id.

export type BuyerTokenPurpose = "verify_email" | "reset_password";

export { VERIFY_TOKEN_TTL_MS, RESET_TOKEN_TTL_MS };

export interface BuyerTokenRow {
  id: string;
  customer_id: string;
  purpose: BuyerTokenPurpose;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
}

export async function issueBuyerToken(
  db: D1Database,
  customerId: string,
  purpose: BuyerTokenPurpose,
  ttlMs: number,
  nowIso: string = touch()
): Promise<{ token: string }> {
  const token = newEmailToken();
  const tokenHash = await hashEmailToken(token);
  const id = uuidv7();
  await db.batch([
    db
      .prepare(
        "UPDATE buyer_tokens SET used_at = ? WHERE customer_id = ? AND purpose = ? AND used_at IS NULL"
      )
      .bind(nowIso, customerId, purpose),
    db
      .prepare(
        "INSERT INTO buyer_tokens (id, customer_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        customerId,
        purpose,
        tokenHash,
        new Date(Date.now() + ttlMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
        nowIso
      ),
  ]);
  return { token };
}

export async function redeemBuyerToken(
  db: D1Database,
  token: string,
  purpose: BuyerTokenPurpose,
  nowIso: string = touch()
): Promise<BuyerTokenRow | null> {
  const tokenHash = await hashEmailToken(token);
  const row = await db
    .prepare(
      "SELECT id, customer_id, purpose, token_hash, expires_at, used_at FROM buyer_tokens WHERE token_hash = ? AND purpose = ?"
    )
    .bind(tokenHash, purpose)
    .first<BuyerTokenRow>();
  if (!row || row.used_at !== null || row.expires_at <= nowIso) return null;
  const claimed = await db
    .prepare("UPDATE buyer_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(nowIso, row.id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return row;
}
