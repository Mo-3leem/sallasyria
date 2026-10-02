import { AppError } from "../http/errors.js";

// Product-image upload hardening (roadmap B8). Defense in layers, all
// enforced server-side (client MIME/extension claims are never trusted):
//   1. Size cap (DoS bound).
//   2. Magic-byte sniffing (real type, not claimed type; mismatch rejected).
//   3. Metadata stripping (EXIF GPS leak is the marketplace threat: retired
//      merchant photos must not carry home coordinates).
//   4. Private-by-default R2 objects under random keys; reads only through
//      short-lived HMAC-signed URLs (no public bucket, no permanent links).
//
// Scope note: JPEG APP1/APP13, PNG textual chunks, GIF comment blocks, and
// WebP EXIF/XMP chunks are stripped (container sizes repaired where the
// format requires it). Anything unparseable is REJECTED, not stored
// (fail-closed); anything parseable-but-unknown is preserved bit-for-bit so
// valid images are never corrupted.

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

const EXT_BY_MIME: Record<AllowedImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function extensionFor(mime: AllowedImageMime): string {
  return EXT_BY_MIME[mime];
}

// Magic-byte sniffing. Returns the TRUE type or null (unknown/rejected).
export function sniffImageMime(bytes: Uint8Array): AllowedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  return null;
}

function failInvalid(): never {
  throw new AppError("invalid_image", 400, "Uploaded file is not a supported image.");
}

// JPEG: walk segments from SOI; drop APP1 (Exif) and APP13 (Photoshop/IPTC);
// copy everything else verbatim; SOS onward is scan data (copied whole).
function stripJpeg(bytes: Uint8Array): { bytes: Uint8Array; stripped: boolean } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) failInvalid();
  const out: number[] = [0xff, 0xd8];
  let stripped = false;
  let i = 2;
  const push = (from: number, to: number) => {
    for (let j = from; j < to; j++) out.push(bytes[j]!);
  };
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) failInvalid();
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xff) m++; // fill bytes
    if (m >= bytes.length) failInvalid();
    const marker = bytes[m]!;
    if (marker === 0xda) {
      // SOS: header + entropy-coded scan to EOI; copy the tail untouched.
      push(i, bytes.length);
      return { bytes: Uint8Array.from(out), stripped };
    }
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      // EOI or standalone RSTn: no length field.
      push(i, m + 1);
      i = m + 1;
      continue;
    }
    if (m + 2 >= bytes.length) failInvalid();
    const len = (bytes[m + 1]! << 8) | bytes[m + 2]!;
    if (len < 2 || m + 1 + len > bytes.length) failInvalid();
    if (marker === 0xe1 || marker === 0xed) {
      stripped = true; // drop APP1 / APP13
    } else {
      push(i, m + 1 + len);
    }
    i = m + 1 + len;
  }
  return { bytes: Uint8Array.from(out), stripped };
}

// PNG: drop textual chunks (tEXt/zTXt/iTXt); survivors keep original CRCs.
function stripPng(bytes: Uint8Array): { bytes: Uint8Array; stripped: boolean } {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let k = 0; k < 8; k++) {
    if (bytes[k] !== SIG[k]) failInvalid();
  }
  const out: number[] = [...SIG];
  let stripped = false;
  let i = 8;
  const push = (from: number, to: number) => {
    for (let j = from; j < to; j++) out.push(bytes[j]!);
  };
  const dec = new TextDecoder();
  while (i + 8 <= bytes.length) {
    const len =
      (bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (len < 0 || i + 12 + len > bytes.length) failInvalid();
    const type = dec.decode(bytes.slice(i + 4, i + 8));
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      stripped = true;
    } else {
      push(i, i + 12 + len);
    }
    i += 12 + len;
    if (type === "IEND") break;
  }
  return { bytes: Uint8Array.from(out), stripped };
}

// GIF89a: drop comment extensions (0x21 0xFE + sub-blocks); keep the rest.
function stripGif(bytes: Uint8Array): { bytes: Uint8Array; stripped: boolean } {
  const out: number[] = [];
  const push = (from: number, to: number) => {
    for (let j = from; j < to; j++) out.push(bytes[j]!);
  };
  let stripped = false;
  let i = 0;
  const skipSubBlocks = (): void => {
    while (i < bytes.length) {
      const n = bytes[i]!;
      i++;
      if (n === 0) return;
      i += n;
      if (i > bytes.length) failInvalid();
    }
  };
  push(0, 6); // header
  i = 6;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === 0x21 && i + 1 < bytes.length && bytes[i + 1] === 0xfe) {
      i += 2;
      skipSubBlocks();
      stripped = true;
      continue;
    }
    if (b === 0x3b) {
      push(i, i + 1); // trailer
      break;
    }
    push(i, i + 1);
    i++;
  }
  return { bytes: Uint8Array.from(out), stripped };
}

// WebP RIFF: drop EXIF/XMP metadata chunks and repair the container size.
// Layout: "RIFF" + u32LE(size = fileLen-8) + "WEBP" + chunks(FourCC + u32LE
// size + data + pad-to-even). Survivors keep their bytes; the size field is
// rewritten to the new length (parsers require it; miswriting it WOULD
// corrupt, so it is asserted afterwards).
function stripWebp(bytes: Uint8Array): { bytes: Uint8Array; stripped: boolean } {
  if (bytes.length < 12) failInvalid();
  const dec = new TextDecoder();
  if (dec.decode(bytes.slice(0, 4)) !== "RIFF" || dec.decode(bytes.slice(8, 12)) !== "WEBP") {
    failInvalid();
  }
  const out: number[] = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  const push = (from: number, to: number) => {
    for (let j = from; j < to; j++) out.push(bytes[j]!);
  };
  let stripped = false;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = dec.decode(bytes.slice(i, i + 4));
    const size =
      bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24);
    if (size < 0 || i + 8 + size > bytes.length) failInvalid();
    const end = i + 8 + size + (size % 2);
    if (end > bytes.length) failInvalid();
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      stripped = true;
    } else {
      push(i, end);
    }
    i = end;
  }
  const fixed = out.length - 8;
  out[4] = fixed & 0xff;
  out[5] = (fixed >> 8) & 0xff;
  out[6] = (fixed >> 16) & 0xff;
  out[7] = (fixed >> 24) & 0xff;
  return { bytes: Uint8Array.from(out), stripped };
}

export function sanitizeImage(
  bytes: Uint8Array,
  mime: AllowedImageMime
): { bytes: Uint8Array; stripped: boolean } {
  switch (mime) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/gif":
      return stripGif(bytes);
    case "image/webp":
      return stripWebp(bytes);
  }
}

// ------------------------------------------------------------------ URLs ---

// Stored DB form for Worker-managed objects. Legacy/external https URLs pass
// through untouched everywhere; only r2:// references resolve to signatures.
export const R2_URL_PREFIX = "r2://images/";

export function r2UrlFor(objectKey: string): string {
  return `${R2_URL_PREFIX}${objectKey}`;
}

export function r2KeyFromUrl(url: string): string | null {
  if (!url.startsWith(R2_URL_PREFIX)) return null;
  const key = url.slice(R2_URL_PREFIX.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,180}$/.test(key) || key.includes("..")) return null;
  return key;
}

// Best-effort R2 tombstone for retired images (roadmap B13-L2). Deletes the
// managed object so outstanding signed links stop resolving (the file route
// fails closed on missing objects). Returns whether a delete was issued.
// Never throws: tombstoning must not fail the retirement itself. Skipped
// for non-R2 URLs (external rows have no object) and R2-less environments.
// The derived key must live under the calling store's prefix: a row whose
// embedded store disagrees with the path store is never deleted (defense
// against mislabeled rows deleting a foreign store's bytes).
export async function tombstoneImageR2(
  r2: { delete(key: string): Promise<unknown> } | undefined | null,
  storeId: string,
  url: string
): Promise<boolean> {
  if (r2 === undefined || r2 === null) return false;
  const key = r2KeyFromUrl(url);
  if (key === null || !key.startsWith(`${storeId}/`)) return false;
  try {
    await r2.delete(key);
    return true;
  } catch {
    return false;
  }
}

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

export function r2FileFromUrl(url: string): { storeId: string; file: string } | null {
  const inner = r2KeyFromUrl(url);
  if (inner === null) return null;
  const idx = inner.lastIndexOf("/");
  if (idx <= 0 || idx === inner.length - 1) return null;
  const file = inner.slice(idx + 1);
  if (!FILE_RE.test(file)) return null;
  return { storeId: inner.slice(0, idx), file };
}

export const IMAGE_URL_TTL_SEC = 15 * 60;

// Fail-closed secret accessor shared by upload + serve + read paths: without
// a signing secret the service answers 503, never an unsigned or permanent
// private link.
export function signingSecretOrThrow(env: { URL_SIGNING_SECRET?: string }): string {
  if (!env.URL_SIGNING_SECRET) {
    throw new AppError("url_signing_misconfigured", 503, "Image upload is not configured.");
  }
  return env.URL_SIGNING_SECRET;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)!;
  }
  return diff === 0;
}

// Short-lived read URL for a private object. The signature binds
// storeId + file + expiry, so a URL minted for one store cannot be replayed
// against another store's file route (the route re-verifies with its own id).
export async function signImageUrl(
  secret: string,
  storeId: string,
  file: string,
  expUnixSec: number
): Promise<string> {
  const sig = await hmacHex(secret, `${storeId}/${file}/${expUnixSec}`);
  const path = `/stores/${storeId}/product-images/file/${encodeURIComponent(file)}`;
  return `${path}?exp=${expUnixSec}&sig=${sig}`;
}

export async function verifyImageUrl(
  secret: string,
  storeId: string,
  file: string,
  expUnixSec: number,
  sig: string
): Promise<boolean> {
  if (!Number.isInteger(expUnixSec) || expUnixSec * 1000 <= Date.now()) return false;
  if (!FILE_RE.test(file)) return false;
  const expected = await hmacHex(secret, `${storeId}/${file}/${expUnixSec}`);
  return constantTimeEqualHex(expected, sig);
}

// Resolve a stored product_images.url for API responses: managed objects
// become short-lived signed URLs; anything else passes through verbatim.
// An embedded store prefix disagreeing with the path store refuses (treat as
// missing): rows must never resolve across tenants, even if mislabeled.
export async function resolveImageUrl(
  storedUrl: string,
  storeId: string,
  secret: string,
  nowMs: number = Date.now(),
  ttlSec: number = IMAGE_URL_TTL_SEC
): Promise<string> {
  const ref = r2FileFromUrl(storedUrl);
  if (ref === null) return storedUrl;
  if (ref.storeId !== storeId) {
    throw new AppError("image_not_found", 404, "Image not found.");
  }
  return signImageUrl(secret, storeId, ref.file, Math.floor(nowMs / 1000) + ttlSec);
}

// ---------------------------------------------------------------------------
// User avatars (merchant/admin profile pictures). Same security posture as
// product images — private R2 objects, magic-byte validation, short-lived
// HMAC links — but scoped to a USER id instead of a store id, because
// avatars belong to accounts, not storefronts. R2 key layout:
// avatars/{userId}/{file}; the stored DB reference is the r2:// URL below.
// The file route authenticates via the signature itself (bearer-style, like
// product files), so <img> tags work without session cookies.

// Stored DB reference prefix for user avatars (parallels R2_URL_PREFIX).
export const AVATAR_R2_PREFIX = "r2://avatars/";

export function avatarRefFor(userId: string, file: string): string {
  return `${AVATAR_R2_PREFIX}${userId}/${file}`;
}

// Parse a stored avatar reference back into its parts. Strict shape
// (userId/file, FILE_RE filename, no traversal): anything else is null and
// the caller treats it as missing — never resolved, never served.
export function avatarKeyFromUrl(url: string): { userId: string; file: string } | null {
  if (!url.startsWith(AVATAR_R2_PREFIX)) return null;
  const inner = url.slice(AVATAR_R2_PREFIX.length);
  const idx = inner.indexOf("/");
  if (idx <= 0 || idx === inner.length - 1) return null;
  const userId = inner.slice(0, idx);
  const file = inner.slice(idx + 1);
  if (file.includes("/") || !FILE_RE.test(file)) return null;
  return { userId, file };
}

// Short-lived read URL for a private avatar object. The signature binds
// userId + file + expiry, so a URL minted for one user cannot be replayed
// for another user's file (the route re-verifies with its own uid).
export async function signAvatarUrl(
  secret: string,
  userId: string,
  file: string,
  expUnixSec: number
): Promise<string> {
  const sig = await hmacHex(secret, `avatar/${userId}/${file}/${expUnixSec}`);
  const path = `/auth/avatar/file/${encodeURIComponent(file)}`;
  return `${path}?uid=${encodeURIComponent(userId)}&exp=${expUnixSec}&sig=${sig}`;
}

export async function verifyAvatarUrl(
  secret: string,
  userId: string,
  file: string,
  expUnixSec: number,
  sig: string
): Promise<boolean> {
  if (!Number.isInteger(expUnixSec) || expUnixSec * 1000 <= Date.now()) return false;
  if (userId.length === 0 || !FILE_RE.test(file)) return false;
  const expected = await hmacHex(secret, `avatar/${userId}/${file}/${expUnixSec}`);
  return constantTimeEqualHex(expected, sig);
}

// Resolve a stored users.avatar_url for API responses: managed references
// become short-lived signed URLs; a userId mismatch refuses (treat as
// missing): rows must never resolve across accounts, even if mislabeled.
// A null secret (signing not configured) resolves to null — fail-closed
// display rather than an unsigned or permanent private link.
export async function resolveAvatarUrl(
  storedUrl: string | null,
  userId: string,
  secret: string | undefined,
  nowMs: number = Date.now(),
  ttlSec: number = IMAGE_URL_TTL_SEC
): Promise<string | null> {
  if (!storedUrl) return null;
  const ref = avatarKeyFromUrl(storedUrl);
  if (ref === null || ref.userId !== userId) return null;
  if (!secret) return null;
  return signAvatarUrl(secret, userId, ref.file, Math.floor(nowMs / 1000) + ttlSec);
}
