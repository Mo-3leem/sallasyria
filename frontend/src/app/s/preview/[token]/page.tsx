"use client";

import { useEffect, useState } from "react";
import { previewApi, type PreviewPayload } from "@/lib/api";
import { NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { EmptyState } from "@/components/common/EmptyState";
import { ShopShell } from "@/components/shop/ShopPage";
import { StoreHomeSections } from "@/components/shop/StoreHomeSections";
import { coerceTheme } from "@/lib/theme-design";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; payload: PreviewPayload };

/**
 * Draft guest preview: the exact storefront shell (header, buyer menu,
 * cart, footer, responsive behavior) fed with token payload data and the
 * CURRENT draft theme. Same components as the real storefront — only the
 * theme source differs. No builder controls, no merchant identity, and no
 * preview banner of any kind. Unknown/expired tokens share one 404.
 */
export default function PreviewPage({
  params,
}: {
  params: { token: string };
}) {
  const { token } = params;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await previewApi.get(token);
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: "missing" });
          return;
        }
        setState({ kind: "ready", payload: res.data });
      } catch {
        if (!cancelled)
          setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "loading") {
    return (
      <div className="shop">
        <main className="shop-main">
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل المعاينة...
          </div>
        </main>
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shop">
        <main className="shop-main">
          <div className="shell-card">
            <EmptyState
              icon="fas fa-eye-slash"
              title="رابط المعاينة غير صالح أو منتهي"
              description="اطلب رابط معاينة جديداً من صفحة التصميم."
            />
          </div>
        </main>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="shop">
        <main className="shop-main">
          <div className="shell-card">
            <EmptyState
              icon="fas fa-exclamation-triangle"
              title="تعذّر التحميل"
              description={state.message}
            />
          </div>
        </main>
      </div>
    );
  }

  const { store, theme, categories, products } = state.payload;
  return (
    <ShopShell
      slug={store.slug}
      ready={{
        store: { id: store.id, slug: store.slug, name: store.name, currency: store.currency },
        categories,
        products,
        theme: theme.draft,
      }}
    >
      {() => (
        <StoreHomeSections
          slug={store.slug}
          storeName={store.name}
          categories={categories}
          products={products}
          theme={coerceTheme(theme.draft)}
          live
        />
      )}
    </ShopShell>
  );
}
