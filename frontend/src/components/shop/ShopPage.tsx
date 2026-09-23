"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { useBuyer } from "@/hooks/useBuyer";
import { useCart } from "@/hooks/useCart";
import { useStorefront } from "@/hooks/useStorefront";
import { EmptyState } from "@/components/common/EmptyState";
import type { PublicCategory, PublicProduct, PublicStore } from "@/lib/api";

export interface ShopReady {
  store: PublicStore;
  categories: PublicCategory[];
  products: PublicProduct[];
}

/**
 * Storefront page shell: resolves the slug once, then renders header
 * (brand + category nav + cart), content via render prop, and footer.
 * Loading/missing/error states are handled here for every shop page.
 */
export function ShopPage({
  slug,
  title,
  children,
}: {
  slug: string;
  title?: string;
  children: (ready: ShopReady) => ReactNode;
}) {
  const { state, reload } = useStorefront(slug);
  const { countFor, ensure } = useCart();
  const { buyerFor, refresh } = useBuyer();

  useEffect(() => {
    refresh(slug);
    ensure(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (state.kind === "loading") {
    return (
      <main className="shop-main">
        <div className="shell-loading">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري تحميل المتجر...
        </div>
      </main>
    );
  }
  if (state.kind === "missing") {
    return (
      <main className="shop-main">
        <div className="shell-card">
          <EmptyState
            icon="fas fa-store-slash"
            title="المتجر غير موجود"
            description="ربما أُغلق هذا المتجر أو تغيّر رابطه."
          />
        </div>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="shop-main">
        <div className="shell-card">
          <EmptyState
            icon="fas fa-exclamation-triangle"
            title="تعذّر تحميل المتجر"
            description={state.message}
            action={
              <button type="button" className="btn btn-outline" onClick={reload}>
                إعادة المحاولة
              </button>
            }
          />
        </div>
      </main>
    );
  }

  const count = countFor(slug);
  const buyer = buyerFor(slug);

  return (
    <>
      <header className="shop-header">
        <div className="shop-header-inner">
          <Link href={`/s/${encodeURIComponent(slug)}`} className="shop-brand">
            <span className="logo-icon" aria-hidden="true">
              <i className="fas fa-shopping-bag"></i>
            </span>
            {state.store.name}
          </Link>
          <nav className="shop-nav" aria-label="أقسام المتجر">
            {state.categories.slice(0, 5).map((c) => (
              <Link
                key={c.id}
                href={`/s/${encodeURIComponent(slug)}/c/${encodeURIComponent(c.slug)}`}
              >
                {c.name}
              </Link>
            ))}
          </nav>
          <Link
            href={`/s/${encodeURIComponent(slug)}/account`}
            className="shop-account-link"
            aria-label={buyer ? "حسابي" : "تسجيل الدخول"}
          >
            <i className="fas fa-user" aria-hidden="true"></i>
            {buyer ? buyer.name.split(" ")[0] : "دخول"}
          </Link>
          <Link
            href={`/s/${encodeURIComponent(slug)}/checkout`}
            className="shop-cart-link"
            aria-label={`السلة (${count})`}
          >
            <i className="fas fa-shopping-cart" aria-hidden="true"></i>
            السلة
            {count > 0 && (
              <span className="shop-cart-count">{count.toLocaleString("ar-SY")}</span>
            )}
          </Link>
        </div>
      </header>
      <main className="shop-main">
        {title && (
          <div className="shop-hero">
            <h1>{title}</h1>
          </div>
        )}
        {children({
          store: state.store,
          categories: state.categories,
          products: state.products,
        })}
      </main>
      <footer className="shop-footer">
        {state.store.name} · {state.store.currency} · تسوق آمن
      </footer>
    </>
  );
}
