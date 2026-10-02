import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { assertNoImmutableFields, z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam, storeIdParams } from "../openapi/params.js";
import { checkPublicFileLimit, checkUploadProductLimit, clientIp } from "../lib/rate-limit.js";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveStore, requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import {
  createImage,
  getImage,
  getImageByUrl,
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
  tombstoneImageR2,
  verifyImageUrl,
  type AllowedImageMime,
} from "../lib/uploads.js";
import { uuidv7 } from "../lib/ids.js";

export const productImages = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary, same as stores routes): this file contains zero
// SQL strings and reads scoping only from storeScope(c). All queries live in
// services/catalog.ts. Enforced by tests/tenant-conventions.test.ts.
//
// Trust boundary (roadmap B8): clients may only set `url` as an https string
// here; the Worker upload flow becomes the sole writer of R2 URLs later.
// product_id stays settable: the service re-scopes it to this store and 404s
// otherwise, so it can never link across tenants.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const mutating = [...authed, requireActiveSubscription, requireActiveStore] as const;

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

const imageDocSchema = z
  .object({
    id: z.string().openapi({ example: "img_01J..." }),
    store_id: z.string(),
    product_id: z.string(),
    url: z.string().openapi({ example: "https://cdn.example.com/a.jpg" }),
    alt_text: z.string().nullable(),
    sort_order: z.number(),
    deleted_at: z.string().nullable(),
  })
  .openapi("ProductImage");

const imageOkSchema = okOf(z.object({ image: imageDocSchema }));
const idParams = z.object({ storeId: storeIdParam, id: idParam });

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

// product_id stays a documented-but-optional query string on purpose: the
// manual missing-check below (with its exact message) remains the enforcer,
// so behavior is byte-identical to before documentation existed.
const listImagesRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List a product's images",
  description: "Images in display order. Managed (r2://) rows resolve to short-lived signed links.",
  middleware: [...authed],
  request: {
    params: z.object({ storeId: storeIdParam }),
    query: z.object({ product_id: z.string().optional().openapi({ example: "prod_01J..." }) }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: okOf(z.object({ images: z.array(imageDocSchema) })) },
      },
      description: "Images of the product (r2:// rows resolved to signed links)",
    },
    400: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Missing product_id query",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or product" },
  },
});

productImages.openapi(listImagesRoute, async (c) => {
  const { storeId } = storeScope(c);
  const productId = c.req.query("product_id");
  if (!productId) {
    throw new AppError("validation_failed", 400, "Missing product_id query.");
  }
  const rows = await listImages(getDb(c), storeId, productId);
  return ok(c, { images: await Promise.all(rows.map((r) => presentImage(c, r))) });
}, validationHook);

// NOTE: registered BEFORE /:id so the static "file" segment can never be
// captured as a resource id, regardless of router precedence rules.
const fileRoute = createRoute({
  method: "get",
  path: "/file/:key",
  summary: "Serve a private image file",
  description:
    "Public bearer-URL reader: the store-bound HMAC signature plus expiry are verified, " +
    "so links are unforgeable and short-lived. Missing, expired, or tampered links 404 identically.",
  middleware: [resolveStore],
  request: {
    params: z.object({
      storeId: storeIdParam,
      key: z.string().openapi({ param: { name: "key", in: "path" }, example: "01J....jpg" }),
    }),
    query: z.object({
      exp: z.string().optional().openapi({ example: "1758000000" }),
      sig: z.string().optional().openapi({ example: "9f2c..." }),
    }),
  },
  responses: {
    200: { description: "Image bytes (content-typed, private cache)" },
    404: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Missing, expired, or tampered link",
    },
    429: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Too many attempts",
    },
    503: {
      content: { "application/json": { schema: failEnvelope } },
      description: "Image storage is not configured",
    },
  },
});

productImages.openapi(fileRoute, async (c) => {
  // Abuse guard first: R2 egress is the expensive part below. Generous
  // per-IP budget shared with the avatar file route (same bearer-URL
  // egress boundary).
  if (!checkPublicFileLimit(clientIp(c))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
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
  // Liveness gate (roadmap B13-L2): retired rows must not serve bytes even
  // with a valid signature (tokens outlive retirement). Exact-match on the
  // managed URL keeps external-URL behavior unchanged; tombstoned objects
  // 404 naturally on the R2 read below.
  const live = await getImageByUrl(getDb(c), storeId, r2UrlFor(`${storeId}/${key}`));
  if (live !== null && live.deleted_at !== null) {
    throw new AppError("image_not_found", 404, "Image not found.");
  }
  // No-R2 production demo: fail closed with 503 (see upload route note).
  const r2 = c.env.R2;
  if (!r2) {
    throw new AppError("storage_unavailable", 503, "Image storage is not configured.");
  }
  const object = await r2.get(`${storeId}/${key}`);
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
}, validationHook);

const getImageRoute = createRoute({
  method: "get",
  path: "/:id",
  summary: "Get one product image",
  description: "404 for an unknown store or image.",
  middleware: [...authed],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: imageOkSchema } },
      description: "The image (r2:// rows resolved to a signed link)",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or image" },
    503: { content: { "application/json": { schema: failEnvelope } }, description: "Image serving is not configured" },
  },
});

productImages.openapi(getImageRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await getImage(getDb(c), storeId, resourceId(c));
  // Retired rows resolve only through restore (roadmap B13-L2).
  if (!row || row.deleted_at !== null) throw new AppError("image_not_found", 404, "Image not found.");
  return ok(c, { image: await presentImage(c, row) });
}, validationHook);

const createImageRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Attach an image URL to a product",
  description: "URL must use https; the product must belong to the same store.",
  middleware: [...mutating],
  request: {
    params: storeIdParams,
    body: { content: { "application/json": { schema: imageSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: imageOkSchema } },
      description: "Image record created",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or product" },
  },
});

productImages.openapi(createImageRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  return ok(c, { image: await createImage(getDb(c), storeId, c.req.valid("json")) }, 201);
}, validationHook);

const updateImageRoute = createRoute({
  method: "patch",
  path: "/:id",
  summary: "Update a product image",
  description: "Partial update of URL, alt text, or display order.",
  middleware: [...mutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: imagePatchSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: imageOkSchema } },
      description: "Updated image",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body or immutable field" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or image" },
  },
});

productImages.openapi(updateImageRoute, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  assertNoImmutableFields(raw, FORBIDDEN);
  const { storeId } = storeScope(c);
  const row = await updateImage(getDb(c), storeId, resourceId(c), c.req.valid("json"));
  if (!row) throw new AppError("image_not_found", 404, "Image not found.");
  return ok(c, { image: row });
}, validationHook);

// Soft retirement (idempotent), mirroring products.
const softDeleteImageRoute = createRoute({
  method: "delete",
  path: "/:id",
  summary: "Retire a product image (soft delete)",
  description: "Marks deleted_at instead of erasing. Idempotent.",
  middleware: [...mutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: imageOkSchema } },
      description: "Retired image",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or image" },
  },
});

productImages.openapi(softDeleteImageRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await softDeleteImage(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("image_not_found", 404, "Image not found.");
  // Tombstone best-effort (roadmap B13-L2): R2 reads fail closed on missing
  // objects, so deleting the bytes revokes outstanding signed links. Never
  // fails the retirement itself; skipped for non-R2 URLs and R2-less envs.
  await tombstoneImageR2(c.env.R2, storeId, row.url);
  return ok(c, { image: row });
}, validationHook);

const restoreImageRoute = createRoute({
  method: "post",
  path: "/:id/restore",
  summary: "Restore a retired product image",
  description: "Clears deleted_at.",
  middleware: [...mutating],
  request: { params: idParams },
  responses: {
    200: {
      content: { "application/json": { schema: imageOkSchema } },
      description: "Restored image",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or image" },
  },
});

productImages.openapi(restoreImageRoute, async (c) => {
  const { storeId } = storeScope(c);
  const row = await restoreImage(getDb(c), storeId, resourceId(c));
  if (!row) throw new AppError("image_not_found", 404, "Image not found.");
  return ok(c, { image: row });
}, validationHook);

// POST /upload — the ONLY writer of R2-managed image URLs (roadmap B8).
// Multipart field "file". Enforcement order: size cap (before buffering the
// whole body into memory twice) -> magic-byte sniff (claimed MIME ignored)
// -> metadata sanitize -> private R2 put under a random namespaced key ->
// catalog row with an r2:// reference (resolved to a signed link below).
// Deliberately NO createRoute body schema: multipart validation here is
// hand-rolled (File instance checks the schema language cannot express), and
// a declared schema would either reject valid uploads or duplicate the
// handler's exact checks. The route IS in the document via responses below.
// Multipart form shape for POST /upload — DOCUMENTATION-first (MVP fix:
// without a declared multipart body Swagger UI renders no file picker and
// its curl sends no body, so every Swagger upload died with "Multipart field
// 'file' is required."). Deliberately PERMISSIVE at runtime: declaring the
// body auto-wires a form validator, so both fields stay loose here (any file
// value, optional product_id) and the handler below remains the SOLE
// enforcer — missing file / oversize / bad magic bytes / missing product_id
// keep their exact current 400/413 errors. Tightening this schema would
// replace those specific errors with generic validation failures.
const uploadFormSchema = z.object({
  file: z
    .any()
    .openapi({
      type: "string",
      format: "binary",
      description: "Image file: PNG, JPEG, WebP, or GIF, max 5 MB. Required.",
    }),
  product_id: z
    .any()
    .optional()
    .openapi({
      type: "string",
      example: "prod_01J...",
      description: "ID of a product in this store. Required.",
    }),
});

const uploadRoute = createRoute({
  method: "post",
  path: "/upload",
  summary: "Upload and sanitize a product image file",
  description:
    "Multipart file + product_id. Enforces the 5 MB cap, verifies the real type by magic bytes " +
    "(claimed MIME ignored), strips metadata, and stores a private R2 object linked to the product. " +
    "503 without R2 binding.",
  middleware: [...mutating],
  request: {
    params: storeIdParams,
    body: {
      content: {
        "multipart/form-data": { schema: uploadFormSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: imageOkSchema } },
      description: "Uploaded, sanitized, and stored image (multipart file + product_id fields)",
    },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Missing fields or unsupported image" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store or product" },
    413: { content: { "application/json": { schema: failEnvelope } }, description: "Image exceeds the size limit" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Too many attempts" },
    503: { content: { "application/json": { schema: failEnvelope } }, description: "Image storage is not configured" },
  },
});

productImages.openapi(uploadRoute, async (c) => {
  // Abuse guard first: storeScope reads only middleware-set context, so it
  // is safe before body parsing. Rejects before multipart parse, buffering,
  // sanitize CPU, R2 PUT, and the DB row below.
  const { storeId } = storeScope(c);
  if (!checkUploadProductLimit(storeId)) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
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
  // storeId already resolved above (pre-body-parse abuse guard).
  // No-R2 production demo: fail closed with 503 (never a TypeError-500,
  // never a fake success). Remove this guard when the binding returns.
  const r2 = c.env.R2;
  if (!r2) {
    throw new AppError("storage_unavailable", 503, "Image storage is not configured.");
  }
  const fileName = `${uuidv7()}.${extensionFor(sniffed)}`;
  const objectKey = `${storeId}/${fileName}`;
  await r2.put(objectKey, clean.bytes, {
    httpMetadata: { contentType: sniffed },
  });
  const row = await createImage(getDb(c), storeId, {
    product_id: productId,
    url: r2UrlFor(objectKey),
  });
  return ok(c, { image: await presentImage(c, row) }, 201);
}, validationHook);
