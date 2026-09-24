import type { Context, Next } from "hono";
import { getDb } from "../db.js";
import type { AppEnv, AuthUser } from "../env.js";
import { AppError } from "../http/errors.js";
import { verifyPassword } from "../lib/password.js";
import { touch } from "../lib/time.js";
import {
  getCookieToken,
  hashSessionToken,
  sessionStatus,
  shouldTouchLastUsed,
} from "../lib/session.js";

export type { AuthUser };

type AuthedContext = Context<AppEnv>;

interface SessionJoinRow {
  sid: string;
  revoked_at: string | null;
  expires_at: string;
  last_used_at: string | null;
  uid: string;
  role: string;
  phone: string;
  email: string | null;
  name: string;
  email_verified: number | null;
  avatar_url: string | null;
  is_active: number;
  password_hash: string;
}

// Rotation-exempt endpoints (B7): with a bootstrap credential still active,
// an admin may ONLY rotate it, inspect identity, or log out. Everything else
// is 403 until rotation. The exemption list is closed and exact-matched.
const ROTATION_EXEMPT = new Set([
  "POST /auth/change-password",
  "POST /auth/logout",
  "GET /auth/me",
]);

// requireAuth: cookie -> hash -> single JOIN lookup -> status checks ->
// c.set("user"). Every failure mode maps to the same generic 401 so callers
// cannot distinguish unknown/invalid/expired/revoked/disabled.
export async function requireAuth(c: AuthedContext, next: Next): Promise<void> {
  await authenticate(c);
  await next();
}

// requireRole("admin"): composes requireAuth, then enforces least privilege.
// 401 (who are you) vs 403 (known but not allowed) stay distinct on purpose.
// NOTE: must NOT call requireAuth(c, next) here — that would dispatch
// downstream before the role check. Authenticate first, authorize, then next.
export function requireRole(role: "admin") {
  return async (c: AuthedContext, next: Next): Promise<void> => {
    const user = await authenticate(c);
    if (user.role !== role) {
      throw new AppError("forbidden", 403, "Admin privileges required.");
    }
    await next();
  };
}

async function authenticate(c: AuthedContext): Promise<AuthUser> {
  const token = getCookieToken(c.req.header("Cookie") ?? null);
  if (token === null) {
    throw new AppError("unauthorized", 401, "Authentication required.");
  }
  const tokenHash = await hashSessionToken(token);
  const row = await getDb(c)
    .prepare(
      `SELECT s.id AS sid, s.revoked_at, s.expires_at, s.last_used_at,
              u.id AS uid, u.role, u.phone, u.email, u.name, u.email_verified, u.avatar_url, u.is_active,
              u.password_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first<SessionJoinRow>();
  if (row === null || row.is_active !== 1) {
    throw new AppError("unauthorized", 401, "Authentication required.");
  }
  const nowMs = Date.now();
  const status = sessionStatus(
    {
      id: row.sid,
      user_id: row.uid,
      revoked_at: row.revoked_at,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
    },
    nowMs
  );
  if (status !== "valid") {
    throw new AppError("unauthorized", 401, "Authentication required.");
  }
  // Forced bootstrap rotation (B7): while ADMIN_BOOTSTRAP_PASSWORD is set and
  // still verifies against this admin's stored hash, nothing but rotation,
  // identity, and logout may proceed. Costs one extra scrypt per admin
  // request while the bootstrap value exists — unset it after rotation (the
  // check then short-circuits on the missing secret).
  const bootstrap = c.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (row.role === "admin" && bootstrap) {
    const routeKey = `${c.req.method} ${c.req.path}`;
    if (!ROTATION_EXEMPT.has(routeKey) && verifyPassword(bootstrap, row.password_hash)) {
      throw new AppError(
        "credentials_rotation_required",
        403,
        "Admin password rotation required before continuing."
      );
    }
  }
  if (
    shouldTouchLastUsed(
      { id: row.sid, user_id: row.uid, revoked_at: null, expires_at: row.expires_at, last_used_at: row.last_used_at },
      nowMs
    )
  ) {
    await getDb(c)
      .prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
      .bind(touch(nowMs), row.sid)
      .run();
  }
  const user: AuthUser = { id: row.uid, role: row.role, phone: row.phone, email: row.email, name: row.name, email_verified: row.email_verified ?? 0, avatar_url: row.avatar_url };
  c.set("user", user);
  c.set("sessionId", row.sid);
  return user;
}

export function currentUser(c: AuthedContext): AuthUser {
  return c.get("user") as AuthUser;
}

export function currentSessionId(c: AuthedContext): string {
  return c.get("sessionId") as string;
}
