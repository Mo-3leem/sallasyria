import { bodyLimit } from "hono/body-limit";
import { AppError } from "../http/errors.js";

// Global request body cap (audit F3). 1 MB is generous for JSON APIs
// (checkout with hundreds of lines is still kilobytes) while bounding worker
// memory on hostile input. Exceeding it is a 413 envelope, never a crash.
export const BODY_LIMIT_MAX_SIZE = 1024 * 1024;

export function bodyLimitMw() {
  return bodyLimit({
    maxSize: BODY_LIMIT_MAX_SIZE,
    onError: () => {
      throw new AppError("body_too_large", 413, "Request body too large.");
    },
  });
}
