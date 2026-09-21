import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Minimal user reads shared by routes that must not inline SQL
// (tests/tenant-conventions.test.ts forbids SQL strings in src/routes).
// Authentication internals (hash compare, session joins) stay in B2's
// auth middleware/route; this file is existence/shape lookups only.

export interface UserPublic {
  id: string;
  phone: string;
  email: string | null;
  name: string;
  role: string;
  email_verified: number;
}

export interface MerchantRegistration {
  phone: string;
  email: string | null;
  name: string;
  passwordHash: string;
}

export interface ProfilePatch {
  name?: string;
  email?: string | null;
  phone?: string;
}

export async function userExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM users WHERE id = ?")
    .bind(id)
    .first<{ ok: number }>();
  return row !== null;
}

export async function phoneTaken(db: D1Database, phone: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM users WHERE phone = ?")
    .bind(phone)
    .first<{ ok: number }>();
  return row !== null;
}

// Email-identity lookups for email-based authentication. Callers pass the
// already-normalized address; uniqueness races fall back to the partial
// UNIQUE index exactly like the phone path below.
export async function emailTaken(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM users WHERE email = ?")
    .bind(email)
    .first<{ ok: number }>();
  return row !== null;
}

export async function getUserByEmail(
  db: D1Database,
  email: string
): Promise<{ id: string; name: string; email: string | null } | null> {
  return db
    .prepare("SELECT id, name, email FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; name: string; email: string | null }>();
}

async function phoneTakenByOther(db: D1Database, phone: string, selfId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM users WHERE phone = ? AND id != ?")
    .bind(phone, selfId)
    .first<{ ok: number }>();
  return row !== null;
}

async function emailTakenByOther(db: D1Database, email: string, selfId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM users WHERE email = ? AND id != ?")
    .bind(email, selfId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function getUserPublic(db: D1Database, id: string): Promise<UserPublic | null> {
  return db
    .prepare("SELECT id, phone, email, name, role, email_verified FROM users WHERE id = ?")
    .bind(id)
    .first<UserPublic>();
}

// Self-service profile update (PATCH /me). Only name/email/phone reach
// here — id/role/is_active/password_hash are 400d by the route on the raw
// body first. Uniqueness is pre-checked for exact codes; the partial UNIQUE
// indexes stay the race backstop (column parsed from the constraint text so
// a phone/email race maps to the right 409).
export async function updateUserProfile(
  db: D1Database,
  id: string,
  patch: ProfilePatch,
  nowIso: string = touch()
): Promise<UserPublic | null> {
  const current = await getUserPublic(db, id);
  if (!current) return null;
  const next = {
    name: patch.name ?? current.name,
    email: patch.email !== undefined ? patch.email : current.email,
    phone: patch.phone ?? current.phone,
  };
  if (next.phone !== current.phone && (await phoneTakenByOther(db, next.phone, id))) {
    throw new AppError("phone_taken", 409, "Phone number is already registered.");
  }
  if (next.email !== null && next.email !== current.email && (await emailTakenByOther(db, next.email, id))) {
    throw new AppError("email_taken", 409, "Email address is already registered.");
  }
  try {
    await db
      .prepare("UPDATE users SET name = ?, email = ?, phone = ?, updated_at = ? WHERE id = ?")
      .bind(next.name, next.email, next.phone, nowIso, id)
      .run();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed: users\.phone/i.test(text)) {
      throw new AppError("phone_taken", 409, "Phone number is already registered.");
    }
    if (/UNIQUE constraint failed: users\.email/i.test(text)) {
      throw new AppError("email_taken", 409, "Email address is already registered.");
    }
    if (/UNIQUE constraint failed/i.test(text)) {
      throw new AppError("conflict", 409, "Profile value is already in use.");
    }
    throw err;
  }
  const row = await getUserPublic(db, id);
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

// Self-service merchant registration (MVP): role is HARDCODED to
// 'merchant' — callers pass no role, so no request path can mint an admin.
// The phone/email UNIQUE indexes stay the race backstop behind the pre-checks
// (column parsed from the constraint text so an email race maps to the right
// 409 instead of phone_taken).
export async function createMerchant(
  db: D1Database,
  input: MerchantRegistration,
  nowIso: string = touch()
): Promise<UserPublic> {
  const id = uuidv7();
  try {
    await db
      .prepare(
        "INSERT INTO users (id, phone, email, name, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'merchant', 1, ?, ?)"
      )
      .bind(id, input.phone, input.email, input.name, input.passwordHash, nowIso, nowIso)
      .run();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed: users\.email/i.test(text)) {
      throw new AppError("email_taken", 409, "Email address is already registered.");
    }
    if (/UNIQUE constraint failed/i.test(text)) {
      throw new AppError("phone_taken", 409, "Phone number is already registered.");
    }
    throw err;
  }
  const row = await db
    .prepare("SELECT id, phone, email, name, role, email_verified FROM users WHERE id = ?")
    .bind(id)
    .first<UserPublic>();
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

// Assisted password reset body (admin route): swaps the hash and revokes ALL
// of the target's live sessions atomically (fail-closed for compromise; the
// admin re-logs in if self-targeted). Caller audits.
export async function resetUserPassword(
  db: D1Database,
  targetId: string,
  newHash: string,
  nowIso: string
): Promise<void> {
  const batch = await db.batch([
    db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .bind(newHash, nowIso, targetId),
    db
      .prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(nowIso, nowIso, targetId),
  ]);
  if (!batch.every((r) => r.success)) {
    throw new AppError("internal", 500, "Something went wrong.");
  }
}
