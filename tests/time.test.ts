import { describe, expect, it } from "vitest";
import { isIsoUtc, nowIso, touch } from "../src/lib/time.js";

describe("timestamps", () => {
  it("nowIso matches the DB strftime shape (UTC, no millis)", () => {
    expect(isIsoUtc(nowIso())).toBe(true);
    expect(nowIso()).not.toContain(".");
    expect(nowIso().endsWith("Z")).toBe(true);
  });

  it("encodes the provided instant", () => {
    expect(nowIso(Date.UTC(2026, 8, 15, 18, 2, 3, 123))).toBe(
      "2026-09-15T18:02:03Z"
    );
  });

  it("touch() returns an updated_at-ready value", () => {
    expect(isIsoUtc(touch())).toBe(true);
  });

  it("rejects local-time and millis shapes", () => {
    expect(isIsoUtc("2026-09-15T18:02:03.123Z")).toBe(false);
    expect(isIsoUtc("2026-09-15 18:02:03")).toBe(false);
    expect(isIsoUtc("")).toBe(false);
  });
});
