"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { previewApi, type PreviewPayload } from "@/lib/api";
import { getErrorCode, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { EmptyState } from "@/components/common/EmptyState";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; payload: PreviewPayload };

/**
 * Draft preview: token-gated public render of the CURRENT draft through
 * the same buyer markup/classes as the storefront (pixel-exact by
 * construction), with the draft palette applied as CSS overrides.
 * Unknown/expired tokens share one 404. noindex + no-store safe: this
 * page carries no crawler links and previews are never linked publicly.
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
  const draft = (theme.draft ?? {}) as {
    palette?: Partial<Record<"primary" | "background" | "accent" | "text", string>>;
    logo?: string | null;
    banners?: { image?: string; title?: string }[];
    sections?: { type?: string; order?: number; is_visible?: number }[];
  };
  const palette = {
    primary: "#16a34a",
    background: "#ffffff",
    accent: "#22c55e",
    text: "#0f172a",
    ...(draft.palette ?? {}),
  };
  const cssVars = {
    "--primary": palette.primary,
    "--primary-light": palette.accent,
    "--primary-dark": palette.primary,
  } as CSSProperties;
  const sections = (draft.sections ?? [])
    .filter((s) => s && typeof s === "object")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((s) => s.is_visible !== 0);
  const banners = (draft.banners ?? []).filter(
    (b) => b && typeof b.image === "string" && b.image.startsWith("https://")
  );

  return (
    <div className="shop" style={cssVars}>
      <div className="shell-notice" role="status" style={{ borderRadius: 0 }}>
        <i className="fas fa-eye" aria-hidden="true"></i>
        <span>معاينة مسودة — هكذا سيراها الزوار بعد النشر (صالحة ١٥ دقيقة).</span>
      </div>
      <header className="shop-header">
        <div className="shop-header-inner">
          <span className="shop-brand">
            {draft.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.logo} alt={store.name} className="logo-icon" aria-hidden="true" />
            ) : (
              <span className="logo-icon" aria-hidden="true">
                <i className="fas fa-shopping-bag"></i>
              </span>
            )}
            {store.name}
          </span>
          <nav className="shop-nav" aria-label="أقسام المتجر">
            {categories.slice(0, 5).map((c) => (
              <span key={c.id}>{c.name}</span>
            ))}
          </nav>
          <span className="shop-cart-link" aria-hidden="true">
            <i className="fas fa-shopping-cart"></i>
            السلة
          </span>
        </div>
      </header>
      <main className="shop-main" style={{ background: palette.background, color: palette.text }}>
        {sections.map((s, i) => {
          const key = `${s.type ?? "text"}-${i}`;
          if (s.type === "hero") {
            return (
              <div className="shop-hero" key={key}>
                <h1>أهلاً بك في {store.name}</h1>
              </div>
            );
          }
          if (s.type === "categories") {
            return (
              <div key={key}>
                <h2 className="shop-section-title">التصنيفات</h2>
                <div className="shop-grid">
                  {categories.map((c) => (
                    <div key={c.id} className="shop-card">
                      <span className="shop-card-name">{c.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (s.type === "products") {
            return (
              <div key={key}>
                <h2 className="shop-section-title">المنتجات</h2>
                <div className="shop-grid">
                  {products.map((p) => (
                    <div key={p.id} className="shop-card">
                      <span className="shop-card-name">{p.name}</span>
                      <span className="shop-card-price">
                        {p.price.toLocaleString("ar-SY")} قرش
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (s.type === "banner") {
            if (banners.length === 0) return null;
            return (
              <div key={key}>
                <h2 className="shop-section-title">مختارات</h2>
                <div className="shop-grid">
                  {banners.map((b, j) => (
                    <div key={j} className="shop-card">
                      <span className="shop-card-name">{b.title || "لافتة"}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <div className="shop-card" key={key}>
              <p className="shell-note">تسوّق منتجات {store.name} المختارة بعناية.</p>
            </div>
          );
        })}
        {sections.length === 0 && (
          <div className="shell-card">
            <p className="shell-note">لا توجد أقسام ظاهرة في هذه المسودة.</p>
          </div>
        )}
      </main>
      <footer className="shop-footer">
        {store.name} · {store.currency} · معاينة
      </footer>
    </div>
  );
}
