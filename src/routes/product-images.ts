import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, zBodyValidator } from "../http/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createImage,
  getImage,
  listImages,
  restoreImage,
  softDeleteImage,
  updateImage,
  type ProductImageRow,
} from "../services/catalog.js";
import {
  ALLOWED_IMAGE_MIME,
  extensionFor,
  PRODUCT_IMAGE_MAX_BYTES,
  r2KeyFromUrl,
  r2UrlFor,
  resolveImageUrl,
  sanitizeImage,
  signingSecretOrThrow,
  sniffImageMime,
  verifyImageUrl,
  type AllowedImageMime,
} from "../lib/uploads.js";
import { uuidv7 } from "../lib/ids.js";

export const productImages = new Hono<AppEnv>();

// NOTE (type-level boundary, same as stores routes): this file contains zero
// SQL strings and reads scoping only from storeScope(c). All queries live in
// services/catalog.ts. Enforced by tests/tenant-conventions.test.ts.
//
// Trust boundary (roadmap B8): clients may only set `url` as an https string
// here; the Worker upload flow becomes the sole writer of R2 URLs later.
// product_id stays settable: the service re-scopes it to this store and 404s
// otherwise, so it can never link across tenants.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const mutating = [...authed, requireActiveSubscription] as const;

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith("https://"), "URL must use https.");

const imageSchema = z.object({
  product_id: z.string().min(1),
  url: httpsUrl,
  alt_text: z.string().max(500).nullable().default(null),
  sort_order: z.number().int().default(0),
});

const imagePatchSchema = z.object({
  url: httpsUrl.optional(),
  alt_text: z.string().max(500).nullable().optional(),
  sort_order: z.number().int().optional(),
});

const FORBIDDEN = ["store_id", "id", "deleted_at"] as const;

// Reads resolve managed (r2://) URLs to short-lived signed links; legacy
// external https rows pass through untouched. Signing needs
// URL_SIGNING_SECRET — absent means 503 fail-closed (never an unsigned or
// permanent private link). B4 https-only fixtures never touch this path.
async function presentImage(c: Context<AppEnv>, row: ProductImageRow): Promise<ProductImageRow> {
  if (r2KeyFromUrl(row.url) === null) return row;
  const secret = signingSecretOrThrow(c.env);
  const { storeId } = storeScope(c);
  return { ...row, url: await resolveImageUrl(row.url, storeId, secret) };
}

productImages.get("/", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const productId = c.req.query("product_id");
  if (!productId) {
    throw new AppError("validation_failed", 400, "Missing product_id query.");
  }
  const rows = await listImages(getDb(c), storeId, productId);
  return ok(c, { images: await Promise.all(rows.map((r) => presentImage(c, r))) });
});

// NOTE: registered BEFORE /:id so the static "file" segment can never be
// captured as a resource id, regardless of router precedence rules.
productImages.get("/file/:key", resolveStore, async (c) => {
  const { storeId } = storeScope(c);
  const key = resourceId(c, "key");
  const expRaw = c.req.query("exp");
  const sig = c.req.query("sig");
  // 503 on misconfiguration (loud for ops), 404 for every bad link below.
  const secret = signingSecretOrThrow(c.env);
  const exp = expRaw !== undefined ? Number(expRaw) : NaN;
  if (!sig || !Number.isInteger(exp)) {
    throw new AppError("image_not_found", 404, "Image not found.");
  }
  if (!(await verifyImageUrl(secret, storeId, key, exp, sig))) {
    throw new AppError("image_not_found", 404, "Image not found.");
  }
  const object = await c.env.R2.get(`${storeId}/${key}`);
  if (!object) {
    throw new AppError("image_not_found", 404, "Image not found.");
  }
  const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": `private, max-age=${remaining}`,
    },
  });
});

productImages.get("/:id", ...authed, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getImage(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("image_not_found", 404, "Image not found.");
  return ok(c, { image: await presentImage(c, row) });
});

productImages.post("/", ...mutating, zBodyValidator(imageSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { image: await createImage(getDb(c), storeId, c.req.valid("json")) }, 201);
});

productImages.patch("/:id", ...mutating, zBodyValidator(imagePatchSchema), async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateImage(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("image_not_found", 404, "Image not found.");
  return ok(c, { image: row });
});

// Soft retirement (idempotent), mirroring products.
productImages.delete("/:id", ...mutating, async (c) => {
  const { storeId } = storeScope(c);
  const row = await softDeleteImage(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("image_not_found", 404, "Image not found.");
  return ok(c, { image: row });
});

productImages.post("/:id/restore", ...mutating, async (c) => {
  const { storeId } = storeScope(c);
  const row = await restoreImage(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("image_not_found", 404, "Image not found.");
  return ok(c, { image: await presentImage(c, row) });
});

// POST /upload — the ONLY writer of R2-managed image URLs (roadmap B8).
// Multipart field "file". Enforcement order: size cap (before buffering the
// whole body into memory twice) -> magic-byte sniff (claimed MIME ignored)
// -> metadata sanitize -> private R2 put under a random namespaced key ->
// catalog row with an r2:// reference (resolved to a signed link below).
productImages.post("/upload", ...mutating, async (c) => {
  const secret = signingSecretOrThrow(c.env);
  const form = await c.req.parseBody().catch(() => ({}));
  const file = (form as Record<string, unknown>)["file"];
  if (!(file instanceof File)) {
    throw new AppError("validation_failed", 400, "Multipart field 'file' is required.");
  }
  if (file.size > PRODUCT_IMAGE_MAX_BYTES || file.size === 0) {
    throw new AppError("body_too_large", 413, "Image exceeds the size limit.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed: AllowedImageMime | null = sniffImageMime(bytes);
  if (sniffed === null || !(ALLOWED_IMAGE_MIME as readonly string[]).includes(sniffed)) {
    throw new AppError("invalid_image", 400, "Uploaded file is not a supported image.");
  }
  const clean = sanitizeImage(bytes, sniffed);
  const productId = (form as Record<string, unknown>)["product_id"];
  if (typeof productId !== "string" || productId.length === 0) {
    throw new AppError("validation_failed", 400, "Multipart field 'product_id' is required.");
  }
  const { storeId } = storeScope(c);
  const fileName = `${uuidv7()}.${extensionFor(sniffed)}`;
  const objectKey = `${storeId}/${fileName}`;
  await c.env.R2.put(objectKey, clean.bytes, {
    httpMetadata: { contentType: sniffed },
  });
  const row = await createImage(getDb(c), storeId, {
    product_id: productId,
    url: r2UrlFor(objectKey),
  });
  return ok(c, { image: await presentImage(c, row) }, 201);
});
