import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../http/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { touch } from "../lib/time.js";

// Merchant theme designer (P3): draft working copy + published snapshot.
// Publish is an audited snapshot COPY (draft stays editable afterwards).
// Preview tokens are hashed at rest, single-purpose, 15-minute TTL,
// one-live-per-store (new issuance expires previous ones).

export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface ThemeRow {
  store_id: string;
  draft: string;
  published_snapshot: string | null;
  published_at: string | null;
  updated_at: string;
}

export interface ParsedTheme {
  store_id: string;
  draft: Record<string, unknown>;
  published_snapshot: Record<string, unknown> | null;
  published_at: string | null;
  updated_at: string;
}

function parseThemeObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function present(row: ThemeRow): ParsedTheme {
  return {
    store_id: row.store_id,
    draft: parseThemeObject(row.draft) ?? {},
    published_snapshot: parseThemeObject(row.published_snapshot),
    published_at: row.published_at,
    updated_at: row.updated_at,
  };
}

export async function ensureTheme(
  db: D1Database,
  storeId: string,
  nowIso: string = touch()
): Promise<ParsedTheme> {
  await db
    .prepare(
      "INSERT INTO themes (store_id, draft, created_at, updated_at) VALUES (?, '{}', ?, ?) ON CONFLICT(store_id) DO NOTHING"
    )
    .bind(storeId, nowIso, nowIso)
    .run();
  const row = await db
    .prepare("SELECT * FROM themes WHERE store_id = ?")
    .bind(storeId)
    .first<ThemeRow>();
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return present(row);
}

export async function getTheme(
  db: D1Database,
  storeId: string
): Promise<ParsedTheme | null> {
  const row = await db
    .prepare("SELECT * FROM themes WHERE store_id = ?")
    .bind(storeId)
    .first<ThemeRow>();
  return row ? present(row) : null;
}

// Shallow merge: provided top-level keys replace wholesale, omitted keys
// are preserved. Deep-merge would silently resurrect deleted banners.
export async function updateThemeDraft(
  db: D1Database,
  storeId: string,
  patch: Record<string, unknown>,
  nowIso: string = touch()
): Promise<ParsedTheme> {
  const current = await ensureTheme(db, storeId, nowIso);
  const merged = { ...current.draft, ...patch };
  await db
    .prepare("UPDATE themes SET draft = ?, updated_at = ? WHERE store_id = ?")
    .bind(JSON.stringify(merged), nowIso, storeId)
    .run();
  const row = await db
    .prepare("SELECT * FROM themes WHERE store_id = ?")
    .bind(storeId)
    .first<ThemeRow>();
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return present(row);
}

export async function publishTheme(
  db: D1Database,
  storeId: string,
  nowIso: string = touch()
): Promise<ParsedTheme> {
  const current = await ensureTheme(db, storeId, nowIso);
  await db.batch([
    db
      .prepare(
        "UPDATE themes SET published_snapshot = ?, published_at = ?, updated_at = ? WHERE store_id = ?"
      )
      .bind(JSON.stringify(current.draft), nowIso, nowIso, storeId),
    // Publishing invalidates live preview tokens (draft changed meaning).
    db
      .prepare("UPDATE theme_previews SET expires_at = ? WHERE store_id = ? AND expires_at > ?")
      .bind(nowIso, storeId, nowIso),
  ]);
  const row = await db
    .prepare("SELECT * FROM themes WHERE store_id = ?")
    .bind(storeId)
    .first<ThemeRow>();
  if (!row) throw new AppError("internal", 500, "Something went wrong.");
  return present(row);
}

export function newPreviewToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashPreviewToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function previewExpiryIso(nowMs: number): string {
  return new Date(nowMs + PREVIEW_TOKEN_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function issuePreviewToken(
  db: D1Database,
  storeId: string,
  nowIso: string = touch(),
  nowMs: number = Date.now()
): Promise<{ token: string; expires_at: string }> {
  const token = newPreviewToken();
  const tokenHash = await hashPreviewToken(token);
  const expiresAt = previewExpiryIso(nowMs);
  await db.batch([
    db
      .prepare("UPDATE theme_previews SET expires_at = ? WHERE store_id = ? AND expires_at > ?")
      .bind(nowIso, storeId, nowIso),
    db
      .prepare(
        "INSERT INTO theme_previews (id, store_id, token_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(uuidv7(nowMs), storeId, tokenHash, expiresAt, nowIso, nowIso),
  ]);
  return { token, expires_at: expiresAt };
}

// Multi-view within TTL (no consumption): unknown, expired tokens resolve
// null with no distinguishing signal.
export async function resolvePreviewToken(
  db: D1Database,
  token: string,
  nowIso: string = touch()
): Promise<{ storeId: string } | null> {
  const tokenHash = await hashPreviewToken(token);
  const row = await db
    .prepare(
      "SELECT store_id FROM theme_previews WHERE token_hash = ? AND expires_at > ?"
    )
    .bind(tokenHash, nowIso)
    .first<{ store_id: string }>();
  return row ? { storeId: row.store_id } : null;
}
