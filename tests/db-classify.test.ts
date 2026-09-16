import { describe, expect, it } from "vitest";
import { classifyDbError } from "../src/db.js";

// B6 bounded retry depends on this classification. The load-bearing property
// is default-deny: anything unrecognized must NOT be retryable.
describe("classifyDbError", () => {
  it("marks writer contention transient + retryable", () => {
    expect(classifyDbError(new Error("SQLITE_BUSY: database is locked"))).toEqual({
      kind: "transient",
      retryable: true,
    });
    expect(classifyDbError("database is locked: SQLITE_BUSY")).toEqual({
      kind: "transient",
      retryable: true,
    });
  });

  it("marks timeouts/transport failures transient", () => {
    expect(classifyDbError(new Error("query timed out"))).toEqual({
      kind: "transient",
      retryable: true,
    });
    expect(classifyDbError(new Error("fetch failed"))).toEqual({
      kind: "transient",
      retryable: true,
    });
  });

  it("never retries constraint/business errors", () => {
    for (const msg of [
      "UNIQUE constraint failed: users.phone",
      "FOREIGN KEY constraint failed",
      "CHECK constraint failed: status",
      "NOT NULL constraint failed: orders.id",
    ]) {
      expect(classifyDbError(new Error(msg))).toEqual({
        kind: "constraint",
        retryable: false,
      });
    }
  });

  it("default-denies unknown shapes", () => {
    expect(classifyDbError(new Error("something entirely new"))).toEqual({
      kind: "unknown",
      retryable: false,
    });
    expect(classifyDbError({ weird: ["object"] })).toEqual({
      kind: "unknown",
      retryable: false,
    });
    expect(classifyDbError(undefined)).toEqual({
      kind: "unknown",
      retryable: false,
    });
  });
});
