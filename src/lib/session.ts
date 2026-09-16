// Opaque server-side session primitives (roadmap B2).
//
// Security model (binding):
// - Token: 32 cryptographically random bytes, base64url. The raw token is a
//   bearer secret: it travels ONLY in the Set-Cookie response and back in the
//   Cookie request header. Never in JSON, never in logs, never in the DB.
// - Stored: SHA-256 hex of the token (sessions.token_hash, UNIQUE). A DB read
//   proves nothing without the raw token, and one token maps to one row.
// - Lifetime: absolute expiry (expires_at) + idle expiry (last_used_at).
//   last_used_at writes are throttled (LAST_USED_WRITE_MS) so every request
//   does not cost a D1 write.
// - No store_id anywhere in this file: sessions authenticate WHO (user+role);
//   B3 resolves WHICH store per request. The two must never mix.

export const SESSION_COOKIE = "ss_session";
export const SESSION_ABSOLUTE_MS = 7 * 24 * 3600 * 1000; // 7 days
export const SESSION_IDLE_MS = 24 * 3600 * 1000; // 24h without use
export const LAST_USED_WRITE_MS = 15 * 60 * 1000; // touch at most every 15m

export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SessionRow {
  id: string;
  user_id: string;
  revoked_at: string | null;
  expires_at: string;
  last_used_at: string | null;
}

export type SessionStatus = "valid" | "revoked" | "expired" | "idle_expired";

// Pure decision over stored state + clock. Callers map every non-"valid"
// outcome to the same generic 401 (no oracle distinguishing revoked from
// expired from unknown).
export function sessionStatus(row: SessionRow, nowMs: number = Date.now()): SessionStatus {
  if (row.revoked_at !== null) return "revoked";
  if (Date.parse(row.expires_at) <= nowMs) return "expired";
  if (
    row.last_used_at !== null &&
    Date.parse(row.last_used_at) + SESSION_IDLE_MS <= nowMs
  ) {
    return "idle_expired";
  }
  return "valid";
}

export function shouldTouchLastUsed(row: SessionRow, nowMs: number = Date.now()): boolean {
  if (row.last_used_at === null) return true;
  return Date.parse(row.last_used_at) + LAST_USED_WRITE_MS <= nowMs;
}

export function sessionExpiryIso(nowMs: number = Date.now()): string {
  return new Date(nowMs + SESSION_ABSOLUTE_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Minimal cookie handling without dependencies. Parsing is strict: exactly
// one non-empty ss_session value, else null (fail-closed).
export function getCookieToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      const value = part.slice(idx + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function buildSetCookie(
  token: string,
  opts: { secure: boolean; maxAgeSec: number }
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${opts.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
