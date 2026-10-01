import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { getDb } from "../db.js";
import { resourceId, storeScope } from "../db/tenant.js";
import { AppError } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { z, validationHook } from "../http/validate.js";
import { failEnvelope, okOf } from "../openapi/envelope.js";
import { idParam, storeIdParam } from "../openapi/params.js";
import { checkPreviewLimit, clientIp } from "../lib/rate-limit.js";
import { auditEvent } from "../services/audit.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import { requireStoreAccess, resolveStore } from "../middleware/store.js";
import { requireActiveSubscription } from "../middleware/subscription.js";
import { listPublishedCategories, listPublishedProducts } from "../services/storefront.js";
import { getStoreById } from "../services/stores.js";
import {
  ensureTheme,
  issuePreviewToken,
  publishTheme,
  resolvePreviewToken,
  updateThemeDraft,
} from "../services/theme.js";

export const theme = new OpenAPIHono<AppEnv>();
export const themePreview = new OpenAPIHono<AppEnv>();

// NOTE (type-level boundary): zero SQL strings here; scoping only from
// storeScope(c). Draft edits are designer writes (subscription-gated);
// reads stay open per the matrix. Preview tokens authenticate the public
// preview endpoint instead of a session.

const authed = [requireAuth, resolveStore, requireStoreAccess] as const;
const mutating = [...authed, requireActiveSubscription] as const;

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be #rrggbb.")
  .openapi({ example: "#16a34a" });
const httpsUrl = z
  .string()
  .max(2048)
  .refine((u) => u.startsWith("https://"), "URL must use https.");

// Whitelisted draft keys only: unknown top-level keys are 400 (strict),
// matching the immutable-field philosophy of every other PATCH route.
// Every key below is optional: old drafts and old clients keep working, and
// omitted keys are preserved by the shallow merge in updateThemeDraft.
const flag = z.union([z.literal(0), z.literal(1)]);
const alignEnum = z.enum(["right", "center", "left"]);
const themeDraftSchema = z
  .object({
    palette: z
      .object({
        primary: hexColor.optional(),
        secondary: hexColor.optional(),
        background: hexColor.optional(),
        accent: hexColor.optional(),
        text: hexColor.optional(),
        button: hexColor.optional(),
      })
      .optional(),
    font: z.enum(["cairo", "system"]).optional(),
    logo: z.string().max(2048).nullable().optional(),
    header: z
      .object({
        show_name: flag.optional(),
        show_nav: flag.optional(),
        show_cart: flag.optional(),
        show_account: flag.optional(),
        background: hexColor.nullable().optional(),
      })
      .optional(),
    hero: z
      .object({
        title: z.string().max(200).optional(),
        description: z.string().max(500).optional(),
        cta_text: z.string().max(100).optional(),
        cta_visible: flag.optional(),
        align: alignEnum.optional(),
        background: hexColor.nullable().optional(),
        image: httpsUrl.nullable().optional(),
      })
      .optional(),
    banners: z
      .array(
        z.object({
          image: httpsUrl,
          title: z.string().max(200).optional(),
        })
      )
      .max(5)
      .optional(),
    sections: z
      .array(
        z.object({
          type: z.enum(["hero", "categories", "products", "banner", "text"]),
          order: z.number().int(),
          is_visible: z.union([z.literal(0), z.literal(1)]),
          title: z.string().max(200).optional(),
        })
      )
      .max(20)
      .optional(),
    products: z
      .object({
        show_names: flag.optional(),
        show_prices: flag.optional(),
      })
      .optional(),
    footer: z
      .object({
        visible: flag.optional(),
        background: hexColor.nullable().optional(),
        text: z.string().max(300).optional(),
      })
      .optional(),
  })
  .strict();

const themeDocSchema = z
  .object({
    store_id: z.string(),
    draft: z.record(z.string(), z.unknown()),
    published_snapshot: z.record(z.string(), z.unknown()).nullable(),
    published_at: z.string().nullable(),
    updated_at: z.string(),
  })
  .openapi("Theme");

const themeOkSchema = okOf(z.object({ theme: themeDocSchema }));
const idParams = z.object({ storeId: storeIdParam });

const getThemeRoute = createRoute({
  method: "get",
  path: "/",
  summary: "Get the store theme",
  description:
    "Draft plus published snapshot (if any). Owner/admin read; lazily creates an empty draft row.",
  middleware: [...authed],
  request: { params: idParams },
  responses: {
    200: { content: { "application/json": { schema: themeOkSchema } }, description: "The theme" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

theme.openapi(getThemeRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, { theme: await ensureTheme(getDb(c), storeId) });
}, validationHook);

const updateThemeRoute = createRoute({
  method: "patch",
  path: "/",
  summary: "Update the theme draft",
  description:
    "Shallow merge: provided top-level keys replace wholesale, omitted " +
    "keys are preserved. Unknown keys are 400. Merchant writes need an " +
    "active subscription; admins bypass (audited at the route for publish only).",
  middleware: [...mutating],
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: themeDraftSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: themeOkSchema } }, description: "Updated draft" },
    400: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid body" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

theme.openapi(updateThemeRoute, async (c) => {
  const { storeId } = storeScope(c);
  const patch = c.req.valid("json") as Record<string, unknown>;
  return ok(c, { theme: await updateThemeDraft(getDb(c), storeId, patch) });
}, validationHook);

const publishRoute = createRoute({
  method: "post",
  path: "/publish",
  summary: "Publish the theme draft",
  description:
    "Audited snapshot copy (draft stays editable); invalidates live " +
    "preview tokens. Merchant writes need an active subscription.",
  middleware: [...mutating],
  request: { params: idParams },
  responses: {
    200: { content: { "application/json": { schema: themeOkSchema } }, description: "Published theme" },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

theme.openapi(publishRoute, async (c) => {
  const { storeId } = storeScope(c);
  const themed = await publishTheme(getDb(c), storeId);
  await auditEvent(c, getDb(c),"store.theme.publish", { actor: currentUser(c).id, store: storeId, result: themed.published_at ?? "ok" });
  return ok(c, { theme: themed });
}, validationHook);

const issuePreviewRoute = createRoute({
  method: "post",
  path: "/preview",
  summary: "Issue a preview token",
  description:
    "Short-lived (15 min), single-purpose token rendering the CURRENT " +
    "draft. Retires previous live tokens (one-live-per-store).",
  middleware: [...mutating],
  request: { params: idParams },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(
            z.object({ token: z.string(), expires_at: z.string() })
          ),
        },
      },
      description: "Preview token (raw, exactly once)",
    },
    401: { content: { "application/json": { schema: failEnvelope } }, description: "Unauthenticated" },
    403: { content: { "application/json": { schema: failEnvelope } }, description: "Inactive subscription" },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Unknown store" },
  },
});

theme.openapi(issuePreviewRoute, async (c) => {
  const { storeId } = storeScope(c);
  return ok(c, await issuePreviewToken(getDb(c), storeId));
}, validationHook);

const previewParams = z.object({
  token: z.string().min(1).max(512).openapi({ example: "base64url-token" }),
});

const getPreviewRoute = createRoute({
  method: "get",
  path: "/:token",
  summary: "Render data for a preview token",
  description:
    "Public, token-gated (no session): returns the owning store, its " +
    "CURRENT draft, and its catalog in one payload. Unknown and expired " +
    "tokens answer with an identical 404.",
  request: { params: previewParams },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: okOf(
            z.object({
              store: z.object({
                id: z.string(),
                slug: z.string(),
                name: z.string(),
                currency: z.string(),
              }),
              theme: themeDocSchema,
              categories: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  slug: z.string(),
                  parent_id: z.string().nullable(),
                  sort_order: z.number(),
                })
              ),
              products: z.array(
                z.object({
                  id: z.string(),
                  category_id: z.string().nullable(),
                  name: z.string(),
                  slug: z.string(),
                  price: z.number(),
                  stock_quantity: z.number().nullable(),
                })
              ),
            })
          ),
        },
      },
      description: "Preview render payload",
    },
    404: { content: { "application/json": { schema: failEnvelope } }, description: "Invalid or expired token" },
    429: { content: { "application/json": { schema: failEnvelope } }, description: "Too many attempts" },
  },
});

themePreview.openapi(getPreviewRoute, async (c) => {
  // Abuse guard first: a valid token fans out to 4 parallel catalog queries
  // below. Generous per-IP budget; invalid tokens still 404 identically
  // unless the budget itself is exhausted.
  if (!checkPreviewLimit(clientIp(c))) {
    throw new AppError("rate_limited", 429, "Too many attempts. Try again later.");
  }
  const claimed = await resolvePreviewToken(getDb(c), resourceId(c, "token"));
  if (!claimed) throw new AppError("invalid_token", 404, "Invalid or expired token.");
  const db = getDb(c);
  const [store, themed, categories, products] = await Promise.all([
    getStoreById(db, claimed.storeId),
    ensureTheme(db, claimed.storeId),
    listPublishedCategories(db, claimed.storeId),
    listPublishedProducts(db, claimed.storeId),
  ]);
  if (!store) throw new AppError("store_not_found", 404, "Store not found.");
  return ok(c, {
    store: { id: store.id, slug: store.slug, name: store.name, currency: store.currency },
    theme: themed,
    categories,
    products,
  });
}, validationHook);
