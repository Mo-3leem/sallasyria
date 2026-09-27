import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { normalizeEmail } from "../lib/email.js";
import { normalizePhone } from "../lib/phone.js";
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
  avatar_url: string | null;
  /** Admin surfaces only (merchant detail); absent elsewhere is fine. */
  is_active?: number;
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
    .prepare("SELECT id, phone, email, name, role, email_verified, avatar_url, is_active FROM users WHERE id = ?")
    .bind(id)
    .first<UserPublic>();
}

// --- Admin merchant management (platform admins only; routes enforce
// requireRole("admin") + audit). Merchants are role='merchant' rows; admin
// rows are never listed/edited/deleted through these helpers (404).

export interface MerchantPatch {
  name?: string;
  email?: string | null;
  phone?: string;
  is_active?: number;
}

/** Escape user input for a LIKE pattern (wildcards match literally). */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Server-side merchant search for the admin list. Partial (contains)
 * matching on the email (lowercased; SQLite LIKE is ASCII
 * case-insensitive) and on the phone: the raw typed fragment, the
 * canonical +963 form when the fragment normalizes, and the national
 * significant digits so national-format fragments also hit canonical
 * rows. Empty query lists everything (newest first). Capped LIMIT:
 * admin tooling, not a public API.
 */
export async function searchMerchants(
  db: D1Database,
  q: string | null
): Promise<UserPublic[]> {
  const needle = (q ?? "").trim();
  if (needle === "") {
    const res = await db
      .prepare(
        "SELECT id, phone, email, name, role, email_verified, avatar_url FROM users WHERE role = 'merchant' ORDER BY created_at DESC LIMIT 100"
      )
      .all<UserPublic>();
    return res.results ?? [];
  }
  const emailLike = `%${escapeLike(needle.toLowerCase())}%`;
  const rawLike = `%${escapeLike(needle)}%`;
  let canonicalLike = rawLike;
  let nationalLike = rawLike;
  try {
    const canonical = normalizePhone(needle);
    canonicalLike = `%${escapeLike(canonical)}%`;
    nationalLike = `%${escapeLike(canonical.replace(/^\+963/, ""))}%`;
  } catch {
    // Fragment does not normalize (e.g. too short): raw matching still applies.
  }
  const res = await db
    .prepare(
      `SELECT id, phone, email, name, role, email_verified, avatar_url FROM users
       WHERE role = 'merchant'
         AND (email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
              OR phone LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC LIMIT 100`
    )
    .bind(emailLike, rawLike, canonicalLike, nationalLike)
    .all<UserPublic>();
  return res.results ?? [];
}

export async function getMerchantPublic(
  db: D1Database,
  id: string
): Promise<UserPublic | null> {
  const row = await getUserPublic(db, id);
  if (!row || row.role !== "merchant") return null;
  return row;
}

/**
 * Admin merchant edit: name/email/phone with the same normalization and
 * uniqueness rules as self-service, plus the admin-only is_active toggle.
 * Role, password hash, and identity columns stay immutable (routes 400
 * them before this runs).
 */
export async function updateMerchantByAdmin(
  db: D1Database,
  id: string,
  patch: MerchantPatch,
  nowIso: string = touch()
): Promise<UserPublic | null> {
  const current = await getMerchantPublic(db, id);
  if (!current) return null;
  const activeRow = await db
    .prepare("SELECT is_active FROM users WHERE id = ?")
    .bind(id)
    .first<{ is_active: number }>();
  const next = {
    name: patch.name ?? current.name,
    email:
      patch.email === undefined
        ? current.email
        : patch.email === null
          ? null
          : normalizeEmail(patch.email),
    phone: patch.phone === undefined ? current.phone : normalizePhone(patch.phone),
    is_active: patch.is_active ?? activeRow?.is_active ?? 1,
  };
  if (next.phone !== current.phone && (await phoneTakenByOther(db, next.phone, id))) {
    throw new AppError("phone_taken", 409, "Phone number is already registered.");
  }
  if (next.email !== null && next.email !== current.email && (await emailTakenByOther(db, next.email, id))) {
    throw new AppError("email_taken", 409, "Email address is already registered.");
  }
  try {
    await db
      .prepare("UPDATE users SET name = ?, email = ?, phone = ?, is_active = ?, updated_at = ? WHERE id = ? AND role = 'merchant'")
      .bind(next.name, next.email, next.phone, next.is_active, nowIso, id)
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
  return getMerchantPublic(db, id);
}

/**
 * Permanent merchant deletion. Blocked while the merchant owns any store
 * (stores.owner_id RESTRICT): business history must never be destroyed
 * silently, and no store deletion exists. Sessions and email tokens
 * cascade automatically. Never targets admin rows or the caller's self —
 * routes decide those 404/403s before this runs.
 */
export async function deleteMerchant(db: D1Database, id: string): Promise<{ deleted: string }> {
  const current = await getMerchantPublic(db, id);
  if (!current) {
    throw new AppError("user_not_found", 404, "User not found.");
  }
  const owned = await db
    .prepare("SELECT 1 AS ok FROM stores WHERE owner_id = ? LIMIT 1")
    .bind(id)
    .first<{ ok: number }>();
  if (owned) {
    throw new AppError(
      "merchant_has_stores",
      409,
      "Merchant owns stores and cannot be deleted. Delete or transfer the stores first."
    );
  }
  await db.prepare("DELETE FROM users WHERE id = ? AND role = 'merchant'").bind(id).run();
  return { deleted: id };
}

// Avatar self-service writers (POST/DELETE /auth/me/avatar). The route owns
// authorization (requireAuth ⇒ session user id); these take only the
// resolved id plus the validated reference — never client-supplied identity.
export async function setUserAvatar(
  db: D1Database,
  id: string,
  avatarUrl: string,
  nowIso: string = touch()
): Promise<UserPublic | null> {
  await db
    .prepare("UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?")
    .bind(avatarUrl, nowIso, id)
    .run();
  return getUserPublic(db, id);
}

export async function clearUserAvatar(
  db: D1Database,
  id: string,
  nowIso: string = touch()
): Promise<UserPublic | null> {
  await db
    .prepare("UPDATE users SET avatar_url = NULL, updated_at = ? WHERE id = ?")
    .bind(nowIso, id)
    .run();
  return getUserPublic(db, id);
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
    .prepare("SELECT id, phone, email, name, role, email_verified, avatar_url FROM users WHERE id = ?")
    .bind(id)
    .first<UserPublic>();
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return row;
}

// Password-hash rotation WITHOUT session revocation (opt-out counterpart to
// resetUserPassword below). Used by user-initiated flows whose revocation is
// explicitly opt-in; the caller keeps every session either way.
export async function setPasswordHash(
  db: D1Database,
  targetId: string,
  newHash: string,
  nowIso: string
): Promise<void> {
  const res = await db
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .bind(newHash, nowIso, targetId)
    .run();
  if (!res.success) {
    throw new AppError("internal", 500, "Something went wrong.");
  }
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
