// UTC timestamp utilities. DB columns use TEXT ISO-8601 UTC in the exact
// strftime('%Y-%m-%dT%H:%M:%SZ','now') shape (no fractional seconds), so the
// app produces the same shape — never local time, never millis.

// "2026-09-15T18:02:03.123Z" -> "2026-09-15T18:02:03Z"
export function nowIso(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Value to write into updated_at on every application-side UPDATE
// (no DB triggers by design — see D1 adaptations).
export function touch(nowMs: number = Date.now()): string {
  return nowIso(nowMs);
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_RE.test(value);
}
