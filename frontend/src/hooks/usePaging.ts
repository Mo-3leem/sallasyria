"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Offset paging state (roadmap B11). Holds the current 1-based page and
 * resets to page 1 whenever a dependency (search text, filter value, scope
 * id) changes — a filtered result set must never strand the UI on a stale
 * page. Pass filter values via `resetKey`.
 */
export function usePaging(resetKey: string): {
  page: number;
  setPage: (page: number) => void;
} {
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [resetKey]);
  const setPageClamped = useCallback((p: number) => {
    setPage(Math.max(1, Math.floor(p) || 1));
  }, []);
  return { page, setPage: setPageClamped };
}
