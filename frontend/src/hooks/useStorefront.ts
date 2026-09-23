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
    };

/**
 * Storefront bootstrap: slug → published store + catalog. Unknown and
 * draft slugs share the missing state (backend answers both 404).
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
        const [cats, prods] = await Promise.all([
          storefrontApi.categories(store.id),
          storefrontApi.products(store.id),
        ]);
        if (cancelled) return;
        if (!cats.ok || !prods.ok) {
          if (
            (!cats.ok && getErrorCode(cats) === "store_not_found") ||
            (!prods.ok && getErrorCode(prods) === "store_not_found")
          ) {
            setState({ kind: "missing" });
            return;
          }
          setState({ kind: "error", message: "تعذّر تحميل المتجر." });
          return;
        }
        setState({
          kind: "ready",
          store,
          categories: cats.data.categories,
          products: prods.data.products,
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
