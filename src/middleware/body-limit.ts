import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";
import type { AppEnv } from "../env.js";
import { AppError } from "../http/errors.js";
import { PRODUCT_IMAGE_MAX_BYTES } from "../lib/uploads.js";

// Global request body cap (audit F3). 1 MB is generous for JSON APIs
// (checkout with hundreds of lines is still kilobytes) while bounding worker
// memory on hostile input. Exceeding it is a 413 envelope, never a crash.
export const BODY_LIMIT_MAX_SIZE = 1024 * 1024;

// Multipart framing adds ~hundreds of bytes around the file; without slack a
// file of exactly PRODUCT_IMAGE_MAX_BYTES would trip the middleware cap while
// the handler would accept it. 64 KiB keeps the documented maximum reachable
// while memory stays bounded (~5 MB worst case per upload request).
const UPLOAD_LIMIT_MAX_SIZE = PRODUCT_IMAGE_MAX_BYTES + 64 * 1024;

// Suffix of the single multipart route (POST /stores/:storeId/product-images/upload).
const UPLOAD_PATH_SUFFIX = "/product-images/upload";

export function bodyLimitMw() {
  const jsonLimit = bodyLimit({
    maxSize: BODY_LIMIT_MAX_SIZE,
    onError: () => {
      throw new AppError("body_too_large", 413, "Request body too large.");
    },
  });
  // The upload path gets its own cap: the route handler stays the
  // authoritative validator (magic bytes, exact 5 MB file check), the
  // middleware only bounds memory with the same 413 code/message the handler
  // uses so oversize uploads report identically from either layer.
  const uploadLimit = bodyLimit({
    maxSize: UPLOAD_LIMIT_MAX_SIZE,
    onError: () => {
      throw new AppError(
        "body_too_large",
        413,
        "Image exceeds the size limit.",
      );
    },
  });

  return async function bodyLimitDispatch(c: Context<AppEnv>, next: Next) {
    if (c.req.path.endsWith(UPLOAD_PATH_SUFFIX)) {
      return uploadLimit(c, next);
    }
    return jsonLimit(c, next);
  };
}
