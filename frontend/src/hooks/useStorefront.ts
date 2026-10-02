"use client";

import { useEffect, useState } from "react";
import { storefrontApi } from "@/lib/api";
import { getErrorCode, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import type { PublicCategory, PublicProduct, PublicStore } from "@/lib/api";

export type ShopState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | {
      kind: "ready";
      store: PublicStore;
      categories: PublicCategory[];
      products: PublicProduct[];
      /** Published theme snapshot (null when never published). */
      theme: Record<string, unknown> | null;
    };

/**
 * Storefront bootstrap: slug → published store + catalog. Unknown and
 * draft slugs share the missing state (backend answers both 404).
 *
 * Products arrive through the cursor API: the hook walks every page so
 * downstream consumers (category filter, checkout lookup, home sections)
 * keep the full-catalog contract. Per-response size stays bounded by the
 * API limit; true per-page storefront browsing is B15 discovery work.
 */
export function useStorefront(slug: string): {
  state: ShopState;
  reload: () => void;
} {
  const [state, setState] = useState<ShopState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ kind: "loading" });
      try {
        const resolved = await storefrontApi.bySlug(slug);
        if (cancelled) return;
        if (!resolved.ok) {
          setState({ kind: "missing" });
          return;
        }
        const store = resolved.data.store;
        const [cats, prof] = await Promise.all([
          storefrontApi.categories(store.id),
          storefrontApi.store(store.id),
        ]);
        if (cancelled) return;
        if (!cats.ok) {
          if (getErrorCode(cats) === "store_not_found") {
            setState({ kind: "missing" });
            return;
          }
          setState({ kind: "error", message: "تعذّر تحميل المتجر." });
          return;
        }
        // Walk every cursor page (bounded: catalogs are small; the API
        // caps each response regardless of total size).
        const products: PublicProduct[] = [];
        let cursor: string | undefined = undefined;
        for (let page = 0; page < 50; page++) {
          const prods = await storefrontApi.products(store.id, { cursor });
          if (cancelled) return;
          if (!prods.ok) {
            if (getErrorCode(prods) === "store_not_found") {
              setState({ kind: "missing" });
              return;
            }
            setState({ kind: "error", message: "تعذّر تحميل المتجر." });
            return;
          }
          products.push(...prods.data.products);
          const next = prods.data.pagination.next_cursor;
          if (next === null) break;
          cursor = next;
        }
        setState({
          kind: "ready",
          store,
          categories: cats.data.categories,
          products,
          theme: prof.ok ? prof.data.theme : null,
        });
      } catch {
        if (!cancelled) setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, nonce]);

  return { state, reload: () => setNonce((n) => n + 1) };
}
