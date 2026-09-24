import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";
import { normalizePhone } from "../lib/phone.js";
import { hashPassword, verifyPassword, dummyHash } from "../lib/password.js";
import {
  newSessionToken,
  hashSessionToken,
  sessionStatus,
  shouldTouchLastUsed,
  sessionExpiryIso,
} from "../lib/session.js";
import type { SessionRow } from "../lib/session.js";

// Buyer accounts (P4). Accounts extend the customers row: guest rows (from
// checkout/address capture) carry password_hash NULL and can never log in.
// Registration with the phone of a guest row CONVERTS it to an account, so
// order/address history is retained in place; registration with the phone of
// an existing account is 409 user_exists. Email, when supplied, must be
// unused by any account in the same store (409). Sessions live in
// buyer_sessions and authenticate via the ss_buyer cookie only.

export interface BuyerRow {
  id: string;
  store_id: string;
  name: string;
  phone: string;
  email: string | null;
  password_hash: string | null;
  email_verified: number;
}

export interface PublicBuyer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  email_verified: boolean;
}

export function publicBuyer(row: BuyerRow): PublicBuyer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    email_verified: row.email_verified === 1,
  };
}

const BUYER_COLS =
  "id, store_id, name, phone, email, password_hash, email_verified";

export async function registerBuyer(
  db: D1Database,
  storeId: string,
  input: { name: string; phone: string; email?: string | null; password: string },
  nowIso: string = touch()
): Promise<{ buyer: BuyerRow; converted: boolean }> {
  const phone = normalizePhone(input.phone);
  const email = (input.email ?? null)?.toLowerCase() ?? null;
  const existing = await db
    .prepare(`SELECT ${BUYER_COLS} FROM customers WHERE store_id = ? AND phone = ?`)
    .bind(storeId, phone)
    .first<BuyerRow>();
  if (existing && existing.password_hash !== null) {
    throw new AppError("user_exists", 409, "An account with this phone already exists.");
  }
  if (email !== null) {
    const clash = await db
      .prepare(
        "SELECT id FROM customers WHERE store_id = ? AND email = ? AND password_hash IS NOT NULL LIMIT 1"
      )
      .bind(storeId, email)
      .first<{ id: string }>();
    if (clash && (!existing || clash.id !== existing.id)) {
      throw new AppError("email_taken", 409, "This email is already registered in this store.");
    }
  }
  const passwordHash = await hashPassword(input.password);
  if (existing) {
    // Guest -> account conversion: history (orders, addresses) stays linked.
    const row = await db
      .prepare(
        `UPDATE customers SET name = ?, email = ?, password_hash = ?, email_verified = 0, updated_at = ?
         WHERE id = ? RETURNING ${BUYER_COLS}`
      )
      .bind(input.name, email, passwordHash, nowIso, existing.id)
      .first<BuyerRow>();
    if (!row) throw new AppError("conflict", 409, "Account was modified concurrently.");
    return { buyer: row, converted: true };
  }
  const id = uuidv7();
  const row = await db
    .prepare(
      `INSERT INTO customers (id, store_id, name, phone, email, password_hash, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING ${BUYER_COLS}`
    )
    .bind(id, storeId, input.name, phone, email, passwordHash, nowIso, nowIso)
    .first<BuyerRow>();
  if (!row) throw new AppError("conflict", 409, "Registration collided, retry.");
  return { buyer: row, converted: false };
}

export async function loginBuyer(
  db: D1Database,
  storeId: string,
  identity: string,
  password: string
): Promise<BuyerRow> {
  const trimmed = identity.trim();
  const isEmail = trimmed.includes("@");
  const row = isEmail
    ? await db
        .prepare(
          `SELECT ${BUYER_COLS} FROM customers WHERE store_id = ? AND email = ? LIMIT 1`
        )
        .bind(storeId, trimmed.toLowerCase())
        .first<BuyerRow>()
    : await db
        .prepare(`SELECT ${BUYER_COLS} FROM customers WHERE store_id = ? AND phone = ?`)
        .bind(storeId, normalizePhone(trimmed))
        .first<BuyerRow>();
  // Accounts only: guest rows have no password and can never authenticate.
  // A dummy check keeps timing indistinguishable either way.
  const hashToCheck = row?.password_hash ?? dummyHash();
  const ok = row?.password_hash !== null && (await verifyPassword(password, hashToCheck));
  if (!ok || !row) throw new AppError("user_not_found", 404, "Invalid credentials.");
  return row;
}

export interface BuyerSession {
  id: string;
  buyer: BuyerRow;
}

export async function createBuyerSession(
  db: D1Database,
  buyerId: string,
  nowIso: string = touch()
): Promise<{ token: string; expiresAt: string }> {
  const token = newSessionToken();
  const tokenHash = await hashSessionToken(token);
  const expiresAt = sessionExpiryIso();
  await db
    .prepare(
      "INSERT INTO buyer_sessions (id, customer_id, token_hash, expires_at, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(uuidv7(), buyerId, tokenHash, expiresAt, nowIso, nowIso, nowIso)
    .run();
  return { token, expiresAt };
}

export async function resolveBuyerSession(
  db: D1Database,
  rawToken: string,
  nowMs: number = Date.now()
): Promise<BuyerSession | null> {
  const tokenHash = await hashSessionToken(rawToken);
  const row = await db
    .prepare(
      `SELECT s.id AS sid, s.customer_id, s.expires_at, s.revoked_at, s.last_used_at,
              c.id, c.store_id, c.name, c.phone, c.email, c.password_hash, c.email_verified
       FROM buyer_sessions s JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first<{
      sid: string;
      customer_id: string;
      expires_at: string;
      revoked_at: string | null;
      last_used_at: string | null;
      id: string;
      store_id: string;
      name: string;
      phone: string;
      email: string | null;
      password_hash: string | null;
      email_verified: number;
    }>();
  if (!row || row.password_hash === null) return null;
  const sess: SessionRow = {
    id: row.sid,
    user_id: row.customer_id,
    revoked_at: row.revoked_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
  };
  const status = sessionStatus(sess, nowMs);
  if (status !== "valid") return null;
  if (shouldTouchLastUsed(sess, nowMs)) {
    await db
      .prepare("UPDATE buyer_sessions SET last_used_at = ? WHERE id = ?")
      .bind(new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"), row.sid)
      .run();
  }
  return {
    id: row.sid,
    buyer: {
      id: row.id,
      store_id: row.store_id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      password_hash: row.password_hash,
      email_verified: row.email_verified,
    },
  };
}

export async function revokeBuyerSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare("UPDATE buyer_sessions SET revoked_at = ? WHERE id = ?")
    .bind(touch(), sessionId)
    .run();
}

export async function updateBuyerName(
  db: D1Database,
  buyerId: string,
  name: string,
  nowIso: string = touch()
): Promise<BuyerRow> {
  const row = await db
    .prepare(`UPDATE customers SET name = ?, updated_at = ? WHERE id = ? RETURNING ${BUYER_COLS}`)
    .bind(name, nowIso, buyerId)
    .first<BuyerRow>();
  if (!row) throw new AppError("user_not_found", 404, "Account not found.");
  return row;
}

export async function markBuyerVerified(db: D1Database, buyerId: string): Promise<void> {
  await db
    .prepare("UPDATE customers SET email_verified = 1, updated_at = ? WHERE id = ?")
    .bind(touch(), buyerId)
    .run();
}
export async function setBuyerPassword(
  db: D1Database,
  buyerId: string,
  password: string,
  nowIso: string = touch()
): Promise<void> {
  const hash = await hashPassword(password);
  await db.batch([
    db.prepare("UPDATE customers SET password_hash = ?, updated_at = ? WHERE id = ?").bind(hash, nowIso, buyerId),
    db
      .prepare("UPDATE buyer_sessions SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL")
      .bind(nowIso, buyerId),
  ]);
}

// Self-service password change (POST /:slug/account/change-password).
// Verifies the current password (same invalid_credentials code as merchant
// change-password: no oracle), stores the new hash. Unlike setBuyerPassword
// (reset flow), the caller's session — and every other session — survives,
// mirroring the merchant default (logout_other_sessions false).
export async function changeBuyerPassword(
  db: D1Database,
  storeId: string,
  buyerId: string,
  currentPassword: string,
  newPassword: string,
  nowIso: string = touch()
): Promise<void> {
  const row = await db
    .prepare("SELECT password_hash FROM customers WHERE store_id = ? AND id = ?")
    .bind(storeId, buyerId)
    .first<{ password_hash: string | null }>();
  if (!row?.password_hash || !(await verifyPassword(currentPassword, row.password_hash))) {
    throw new AppError("invalid_credentials", 401, "Invalid email or password.");
  }
  await db
    .prepare("UPDATE customers SET password_hash = ?, updated_at = ? WHERE store_id = ? AND id = ?")
    .bind(await hashPassword(newPassword), nowIso, storeId, buyerId)
    .run();
}

// Store that owns a customer (token-store binding check for verify/reset).
export async function buyerStoreOf(db: D1Database, customerId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT store_id FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ store_id: string }>();
  return row?.store_id ?? null;
}

// Account lookup for password reset: accounts only (guests never reset),
// email-exact within the store. Returns the deliverable address or null;
// callers keep the outcome indistinguishable either way.
export async function findAccountByEmail(
  db: D1Database,
  storeId: string,
  email: string
): Promise<{ id: string; email: string; name: string } | null> {
  const row = await db
    .prepare(
      "SELECT id, email, name FROM customers WHERE store_id = ? AND email = ? AND password_hash IS NOT NULL LIMIT 1"
    )
    .bind(storeId, email.toLowerCase())
    .first<{ id: string; email: string | null; name: string }>();
  if (!row || !row.email) return null;
  return { id: row.id, email: row.email, name: row.name };
}
