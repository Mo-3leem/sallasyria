// Single validation entry point (roadmap B1 decision): zod schemas +
// @hono/zod-validator. Route code uses zBodyValidator — never zValidator
// directly — for two binding reasons:
//  1. The library's DEFAULT failure mode returns its own raw ZodError JSON
//     ({success:false, error:{name,message}}), bypassing errorHandler and
//     breaking the envelope contract clients depend on.
//  2. Raw Zod internals (paths, constraints) must not reach clients.
// The hook converts every validation failure into AppError, so errorHandler
// emits the standard {ok:false,error:{code,message}} envelope instead.
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { AppError } from "./errors.js";

export { z };

export function zBodyValidator<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("json", schema, (result) => {
    if (!result.success) {
      throw new AppError("validation_failed", 400, "Invalid request body.");
    }
  });
}

// Immutable-field guard (roadmap B3). Client bodies must never carry tenant
// ownership or identity: presence of ANY listed key is a 400 even when the
// value happens to match (fail-closed beats ignore-silently — a matching
// value today trains clients to send it, and a mismatching one tomorrow).
// Call with the RAW parsed body (c.req.valid() output is already stripped by
// zod, so checking it would prove nothing).
export function assertNoImmutableFields(
  raw: unknown,
  forbidden: readonly string[] = ["store_id", "id"]
): void {
  if (typeof raw !== "object" || raw === null) return;
  for (const key of forbidden) {
    if (key in raw) {
      throw new AppError(
        "immutable_field",
        400,
        `Field '${key}' cannot be set by clients.`
      );
    }
  }
}
