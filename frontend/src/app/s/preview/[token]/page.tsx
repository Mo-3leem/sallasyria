"use client";

import { useEffect, useState } from "react";
import { previewApi, type PreviewPayload } from "@/lib/api";
import { NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { EmptyState } from "@/components/common/EmptyState";
import { StoreHomeView } from "@/components/shop/StoreHomeView";
import { coerceTheme } from "@/lib/theme-design";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; payload: PreviewPayload };

/**
 * Draft preview: token-gated public render of the CURRENT draft through the
 * shared storefront view (pixel-consistent with the live storefront by
 * construction). Unknown/expired tokens share one 404. noindex + no-store
 * safe: this page carries no crawler links and previews are never linked
 * publicly. No buyer state, no merchant identity, no editing controls.
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
    <StoreHomeView
      storeName={store.name}
      currency={store.currency}
      categories={categories}
      products={products}
      theme={coerceTheme(theme.draft)}
      notice="معاينة مسودة — هكذا سيراها الزوار بعد النشر (صالحة ١٥ دقيقة)."
    />
  );
}
