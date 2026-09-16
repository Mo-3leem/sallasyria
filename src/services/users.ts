import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";

// Minimal user reads shared by routes that must not inline SQL
// (tests/tenant-conventions.test.ts forbids SQL strings in src/routes).
// Authentication internals (hash compare, session joins) stay in B2's
// auth middleware/route; this file is existence/shape lookups only.

export async function userExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM users WHERE id = ?")
    .bind(id)
    .first<{ ok: number }>();
  return row !== null;
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
