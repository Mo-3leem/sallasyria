import { z } from "@hono/zod-openapi";

// Shared OpenAPI envelope schemas matching src/http/respond.ts EXACTLY:
//   success: { "ok": true, "data": ... }
//   failure: { "ok": false, "error": { "code": "...", "message": "..." } }
// These describe responses for documentation only — runtime behavior lives
// in respond.ts/errors.ts and is unchanged. Keep the two in sync by hand;
// tests/docs-render layer asserts the /doc output parses as OpenAPI.

export function okOf<T extends z.ZodTypeAny>(data: T) {
  return z.object({ ok: z.literal(true), data });
}

export const failEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    // Present only on validation_failed 400s: capped, fixed-message field
    // errors (see toValidationDetails in src/http/validate.ts). Optional so
    // every other error keeps its exact historical shape.
    details: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional(),
  }),
});
