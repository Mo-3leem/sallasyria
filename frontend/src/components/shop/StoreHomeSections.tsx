"use client";

import Link from "next/link";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import {
  defaultSectionTitle,
  type SectionType,
  type StoreTheme,
} from "@/lib/theme-design";

export interface HomeSectionCategory {
  id: string;
  name: string;
  slug: string;
}

export interface HomeSectionProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  stock_quantity: number | null;
}

/**
 * Shared storefront home sections: hero, categories, products, banners,
 * text. Rendered by the public home page (published theme, real links),
 * the guest preview (draft, static), and the builder live preview (draft,
 * selectable). Same markup everywhere — only the theme source differs.
 */
export function StoreHomeSections({
  slug,
  storeName,
  categories,
  products,
  theme,
  live,
  selectable = false,
  selection = null,
  onSelect,
}: {
  slug: string;
  storeName: string;
  categories: HomeSectionCategory[];
  products: HomeSectionProduct[];
  theme: StoreTheme;
  /** Live pages render real category/product links; otherwise static. */
  live: boolean;
  /** Builder mode: sections are clickable with a selection outline. */
  selectable?: boolean;
  selection?: string | null;
  onSelect?: (key: string) => void;
}) {
  const sections = [...theme.sections]
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.is_visible === 1);

  function selectWrap(key: string, children: ReactNode): ReactNode {
    if (!selectable) return children;
    const selected = selection === key;
    function pick() {
      onSelect?.(key);
    }
    function onKey(e: KeyboardEvent<HTMLDivElement>) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect?.(key);
      }
    }
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`تحديد قسم ${key}`}
        aria-pressed={selected}
        className={`builder-pick${selected ? " is-selected" : ""}`}
        onClick={pick}
        onKeyDown={onKey}
      >
        {children}
      </div>
    );
  }

  function categoryCard(c: HomeSectionCategory): ReactNode {
    const inner = (
      <>
        <span className="shop-card-name">{c.name}</span>
        <span className="shop-card-meta">تصفح المنتجات ←</span>
      </>
    );
    return live ? (
      <Link key={c.id} href={`/s/${encodeURIComponent(slug)}/c/${encodeURIComponent(c.slug)}`} className="shop-card">
        {inner}
      </Link>
    ) : (
      <span key={c.id} className="shop-card">
        {inner}
      </span>
    );
  }

  function productCard(p: HomeSectionProduct): ReactNode {
    const inner = (
      <>
        {theme.products.show_names === 1 && <span className="shop-card-name">{p.name}</span>}
        {theme.products.show_prices === 1 && (
          <span className="shop-card-price">{p.price.toLocaleString("ar-SY")} قرش</span>
        )}
        {p.stock_quantity !== null && p.stock_quantity <= 0 && (
          <span className="shop-card-meta">نفد المخزون</span>
        )}
      </>
    );
    return live ? (
      <Link key={p.id} href={`/s/${encodeURIComponent(slug)}/p/${encodeURIComponent(p.slug)}`} className="shop-card">
        {inner}
      </Link>
    ) : (
      <span key={p.id} className="shop-card">
        {inner}
      </span>
    );
  }

  function sectionTitle(type: SectionType, override: string | undefined): string {
    return override !== undefined && override !== "" ? override : defaultSectionTitle(type);
  }

  return (
    <>
      {sections.map((s, i) => {
        const key = `section:${i}`;
        if (s.type === "hero") {
          const h = theme.hero;
          return selectWrap(
            key,
            <div
              key={key}
              className="shop-hero"
              style={{
                textAlign: h.align,
                background: h.background ?? undefined,
              }}
            >
              {h.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={h.image}
                  alt=""
                  aria-hidden="true"
                  style={{ maxWidth: "100%", borderRadius: 14, marginBottom: 16 }}
                />
              )}
              <h1>{h.title !== "" ? h.title : `أهلاً بك في ${storeName}`}</h1>
              <p>{h.description !== "" ? h.description : "تسوّق منتجاتنا المختارة بعناية."}</p>
              {h.cta_visible === 1 && (
                <a href="#store-products" className="btn btn-primary" style={{ background: theme.palette.button, borderColor: theme.palette.button }}>
                  {h.cta_text}
                </a>
              )}
            </div>
          );
        }
        if (s.type === "categories") {
          if (categories.length === 0) return null;
          return selectWrap(
            key,
            <div key={key}>
              <h2 className="shop-section-title">
                {sectionTitle(s.type, s.title)}
              </h2>
              <div className="shop-grid">{categories.map(categoryCard)}</div>
            </div>
          );
        }
        if (s.type === "products") {
          return selectWrap(
            key,
            <div key={key} id="store-products">
              <h2 className="shop-section-title">
                {sectionTitle(s.type, s.title)}
              </h2>
              {products.length === 0 ? (
                <EmptyState
                  icon="fas fa-box-open"
                  title="لا توجد منتجات"
                  description="لا توجد منتجات متاحة حالياً. عُد قريباً."
                />
              ) : (
                <div className="shop-grid">{products.map(productCard)}</div>
              )}
            </div>
          );
        }
        if (s.type === "banner") {
          const banners = theme.banners.filter(
            (b) => b.image.startsWith("https://")
          );
          if (banners.length === 0) return null;
          return selectWrap(
            key,
            <div key={key}>
              <h2 className="shop-section-title">
                {sectionTitle(s.type, s.title)}
              </h2>
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
        return selectWrap(
          key,
          <div className="shop-card" key={key}>
            <p className="shell-note">تسوّق منتجات {storeName} المختارة بعناية.</p>
          </div>
        );
      })}
      {sections.length === 0 && (
        <div className="shell-card">
          <p className="shell-note">لا توجد أقسام ظاهرة في هذا التصميم.</p>
        </div>
      )}
    </>
  );
}

/** CSS variables applying a theme palette onto shop-* classes. */
export function themeCssVars(theme: StoreTheme): CSSProperties {
  return {
    "--primary": theme.palette.primary,
    "--primary-light": theme.palette.accent,
    "--primary-dark": theme.palette.primary,
  } as CSSProperties;
}

/** Font family override (Cairo is the default inherited font). */
export function themeFont(theme: StoreTheme): CSSProperties {
  return theme.font === "system"
    ? { fontFamily: "Tahoma, Arial, sans-serif" }
    : {};
}

