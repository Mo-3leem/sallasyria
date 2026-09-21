// Email identity normalization. Single choke point: every authentication
// surface (register, login, forgot-password, verification lookup, PATCH /me
// email change) normalizes before any database read/write, so
// "Test@Example.com", " test@example.com " and "TEST@EXAMPLE.COM" address
// the SAME user row (and the same UNIQUE slot / rate-limit bucket).
// Deliberately minimal: trim + lowercase only. No provider-specific
// transformations (Gmail dot-stripping, plus-address folding) — those would
// merge distinct mailboxes the provider treats separately.

import { AppError } from "../http/errors.js";

export function normalizeEmail(raw: string): string {
  if (typeof raw !== "string") {
    throw new AppError("invalid_email", 400, "Invalid email address.");
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254) {
    throw new AppError("invalid_email", 400, "Invalid email address.");
  }
  return normalized;
}
