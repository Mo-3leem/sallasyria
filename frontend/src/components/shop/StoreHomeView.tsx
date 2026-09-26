"use client";

import type { CSSProperties } from "react";
import {
  StoreHomeSections,
  themeCssVars,
  themeFont,
  type HomeSectionCategory,
  type HomeSectionProduct,
} from "@/components/shop/StoreHomeSections";
import type { StoreTheme } from "@/lib/theme-design";

/**
 * Full static storefront home: header + sections + footer driven by a
 * theme. Used by the guest preview (draft) and the builder live preview
 * (draft, selectable). No buyer state, no merchant identity, no editing
 * controls — those belong to the live storefront and the builder chrome.
 */
export function StoreHomeView({
  storeName,
  currency,
  categories,
  products,
  theme,
  selectable = false,
  selection = null,
  onSelect,
}: {
  storeName: string;
  currency: string;
  categories: HomeSectionCategory[];
  products: HomeSectionProduct[];
  theme: StoreTheme;
  selectable?: boolean;
  selection?: string | null;
  onSelect?: (key: string) => void;
}) {
  const h = theme.header;
  const cssVars: CSSProperties = { ...themeCssVars(theme), ...themeFont(theme) };
  const selected = (key: string) => selectable && selection === key;

  function pick(key: string) {
    if (selectable) onSelect?.(key);
  }

  return (
    <div className="shop" style={cssVars}>
      <header
        className={`shop-header${selected("header") ? " builder-pick is-selected" : ""}`}
        style={h.background ? { background: h.background } : undefined}
        onClick={selectable ? () => pick("header") : undefined}
        role={selectable ? "button" : undefined}
        tabIndex={selectable ? 0 : undefined}
        aria-label={selectable ? "تحديد الترويسة" : undefined}
        onKeyDown={
          selectable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick("header");
                }
              }
            : undefined
        }
      >
        <div className="shop-header-inner">
          <span className="shop-brand">
            {theme.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={theme.logo} alt={storeName} className="logo-icon" aria-hidden="true" />
            ) : (
              <span className="logo-icon" aria-hidden="true">
                <i className="fas fa-shopping-bag"></i>
              </span>
            )}
            {h.show_name === 1 && storeName}
          </span>
          {h.show_nav === 1 && (
            <nav className="shop-nav" aria-label="أقسام المتجر">
              {categories.slice(0, 5).map((c) => (
                <span key={c.id}>{c.name}</span>
              ))}
            </nav>
          )}
          {h.show_account === 1 && (
            <span className="shop-account-link" aria-hidden="true">
              <i className="fas fa-user"></i>
              دخول
            </span>
          )}
          {h.show_cart === 1 && (
            <span className="shop-cart-link" aria-hidden="true">
              <i className="fas fa-shopping-cart"></i>
              السلة
            </span>
          )}
        </div>
      </header>
      <main
        className="shop-main"
        style={{ background: theme.palette.background, color: theme.palette.text }}
      >
        <StoreHomeSections
          slug=""
          storeName={storeName}
          categories={categories}
          products={products}
          theme={theme}
          live={false}
          selectable={selectable}
          selection={selection}
          onSelect={onSelect}
        />
      </main>
      {theme.footer.visible === 1 && (
        <footer
          className="shop-footer"
          style={theme.footer.background ? { background: theme.footer.background } : undefined}
        >
          {theme.footer.text !== "" ? theme.footer.text : `${storeName} · ${currency} · تسوق آمن`}
        </footer>
      )}
    </div>
  );
}
