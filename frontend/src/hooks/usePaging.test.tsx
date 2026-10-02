// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePaging } from "./usePaging.js";

afterEach(cleanup);

describe("usePaging", () => {
  it("starts on page 1", () => {
    const { result } = renderHook(() => usePaging("store-1"));
    expect(result.current.page).toBe(1);
  });

  it("sets pages and clamps invalid input to valid pages", () => {
    const { result } = renderHook(() => usePaging("store-1"));
    act(() => result.current.setPage(5));
    expect(result.current.page).toBe(5);
    act(() => result.current.setPage(0));
    expect(result.current.page).toBe(1);
    act(() => result.current.setPage(-4));
    expect(result.current.page).toBe(1);
    act(() => result.current.setPage(2.9));
    expect(result.current.page).toBe(2);
    act(() => result.current.setPage(Number.NaN));
    expect(result.current.page).toBe(1);
  });

  it("resets to page 1 only when the reset key changes", () => {
    const { result, rerender } = renderHook(({ key }) => usePaging(key), {
      initialProps: { key: "store-1:q" },
    });
    act(() => result.current.setPage(4));
    expect(result.current.page).toBe(4);
    rerender({ key: "store-1:q" });
    expect(result.current.page).toBe(4);
    rerender({ key: "store-1:other" });
    expect(result.current.page).toBe(1);
  });
});
