import { z } from "@hono/zod-openapi";

// Shared pagination primitives (roadmap B11). Offset for admin/merchant
// management lists (random access + totals); opaque keyset cursors for the
// public storefront catalog and buyer history (stable under inserts).
// No database code lives here — services own their SQL; this module only
// validates parameters, computes page math, and encodes/decodes cursors.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_CURSOR_LIMIT = 20;
export const MAX_CURSOR_LIMIT = 100;

// Offset query params: 1-based page, bounded page size. Non-numeric,
// fractional, zero, negative, and over-max values are 400 (never silently
// clamped): callers must not mistake a truncated page for a full one.
export const pageQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .openapi({ param: { name: "page", in: "query" }, example: 1 }),
  page_size: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .openapi({ param: { name: "page_size", in: "query" }, example: 20 }),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

// Cursor query params: opaque cursor (absent = first page) + bounded limit.
// Malformed cursors and invalid limits are 400.
export const cursorQuerySchema = z.object({
  cursor: z
    .string()
    .max(2048)
    .optional()
    .openapi({ param: { name: "cursor", in: "query" }, example: "eyJjIjoi..." }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CURSOR_LIMIT)
    .default(DEFAULT_CURSOR_LIMIT)
    .openapi({ param: { name: "limit", in: "query" }, example: 20 }),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

// Response metadata schemas (siblings of the array inside `data`, so the
// existing `{data:{<plural>:[...]}}` shape stays compatible).
export const pageMetaSchema = z
  .object({
    page: z.number().openapi({ example: 1 }),
    page_size: z.number().openapi({ example: 20 }),
    total: z.number().openapi({ example: 123 }),
    total_pages: z.number().openapi({ example: 7 }),
  })
  .openapi("PageMeta");

export type PageMeta = z.infer<typeof pageMetaSchema>;

export const cursorMetaSchema = z
  .object({
    next_cursor: z.string().nullable().openapi({ example: "eyJjIjoi..." }),
  })
  .openapi("CursorMeta");

export type CursorMeta = z.infer<typeof cursorMetaSchema>;

export function pageOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

export function pageMeta(total: number, page: number, pageSize: number): PageMeta {
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

// Opaque keyset cursor over a (sortKey, id) pair. sortKey is the row's
// position in the endpoint's deterministic ordering (e.g. created_at ISO
// string, or a name); id is the unique tie-breaker. base64url of a minimal
// JSON array — no table/column names, nothing authorizing. Tenant scoping
// always stays in SQL; the cursor is positioning only.
export interface PageCursor {
  c: string;
  id: string;
}

function base64UrlEncodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeText(raw: string): string | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeCursor(c: string, id: string): string {
  return base64UrlEncodeText(JSON.stringify([c, id]));
}

export function decodeCursor(raw: string): PageCursor | null {
  const text = base64UrlDecodeText(raw);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      return null;
    }
    return { c: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}
