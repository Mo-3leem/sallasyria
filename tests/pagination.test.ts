import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  pageMeta,
  pageOffset,
  pageQuerySchema,
  cursorQuerySchema,
} from "../src/lib/pagination.js";

describe("page math", () => {
  it("computes offsets and metadata including the empty edge", () => {
    expect(pageOffset(1, 20)).toBe(0);
    expect(pageOffset(3, 10)).toBe(20);
    expect(pageMeta(25, 1, 20)).toEqual({ page: 1, page_size: 20, total: 25, total_pages: 2 });
    expect(pageMeta(20, 1, 20)).toEqual({ page: 1, page_size: 20, total: 20, total_pages: 1 });
    expect(pageMeta(0, 1, 20)).toEqual({ page: 1, page_size: 20, total: 0, total_pages: 0 });
  });

  it("rejects invalid offset params instead of clamping", () => {
    expect(pageQuerySchema.safeParse({}).success).toBe(true);
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, page_size: 20 });
    for (const bad of [
      { page: 0 },
      { page: -1 },
      { page: 1.5 },
      { page: "abc" },
      { page_size: 0 },
      { page_size: 101 },
      { page_size: "xyz" },
    ]) {
      expect(pageQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(pageQuerySchema.parse({ page: "3", page_size: "10" })).toEqual({ page: 3, page_size: 10 });
  });

  it("validates cursor params", () => {
    expect(cursorQuerySchema.safeParse({}).success).toBe(true);
    expect(cursorQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ limit: "nope" }).success).toBe(false);
  });
});

describe("opaque cursors", () => {
  it("round-trips ASCII and non-ASCII sort keys", () => {
    for (const [c, id] of [
      ["2026-02-01T00:00:00Z", "order_01JABC"],
      ["منتج عربي", "prod_01JXYZ"],
      ["", "x"],
    ] as const) {
      const enc = encodeCursor(c, id);
      if (c !== "") expect(enc).not.toContain(c);
      expect(decodeCursor(enc)).toEqual({ c, id });
    }
  });

  it("rejects malformed cursors", () => {
    for (const bad of ["!!!", "bm90LWpzb24=", "bnVsbA==", "W10=", "WyJvbmx5LW9uZSJd", "e30=", ""]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
  });
});
