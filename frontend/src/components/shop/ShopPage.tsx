"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useBuyer } from "@/hooks/useBuyer";
import { useAuth } from "@/hooks/useAuth";
import { useCart } from "@/hooks/useCart";
import { useStorefront } from "@/hooks/useStorefront";
import { coerceTheme } from "@/lib/theme-design";
import { themeCssVars, themeFont } from "@/components/shop/StoreHomeSections";
import { EmptyState } from "@/components/common/EmptyState";
import type { PublicCategory, PublicProduct, PublicStore } from "@/lib/api";

export interface ShopReady {
  store: PublicStore;
  categories: PublicCategory[];
  products: PublicProduct[];
  theme: Record<string, unknown> | null;
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
  const { buyerFor, refresh, logout } = useBuyer();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    refresh(slug);
    ensure(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Customer menu: outside click / Escape / route change close it.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setMenuOpen(false);
    try {
      await logout(slug);
    } finally {
      setLoggingOut(false);
      router.replace(`/s/${encodeURIComponent(slug)}/account/login`);
    }
  }

  if (state.kind === "loading") {
    return (
      <main className="shop-main">
        <div className="shell-loading" role="status">
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
  // Published theme drives header/footer presentation only; buyer menu,
  // cart, and auth behavior below are untouched.
  const theme = coerceTheme(state.kind === "ready" ? state.theme : null);
  const themeVars = { ...themeCssVars(theme), ...themeFont(theme) };

  return (
    <>
      <header
        className="shop-header"
        style={{
          ...themeVars,
          ...(theme.header.background ? { background: theme.header.background } : {}),
        }}
      >
        <div className="shop-header-inner">
          <Link href={`/s/${encodeURIComponent(slug)}`} className="shop-brand">
            {theme.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={theme.logo} alt={state.store.name} className="logo-icon" aria-hidden="true" />
            ) : (
              <span className="logo-icon" aria-hidden="true">
                <i className="fas fa-shopping-bag"></i>
              </span>
            )}
            {theme.header.show_name === 1 && state.store.name}
          </Link>
          {theme.header.show_nav === 1 && (
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
          )}
          {theme.header.show_account === 1 &&
            (buyer ? (
              <div className="shop-user-wrap" ref={menuRef}>
              <button
                type="button"
                className="shop-account-link shop-account-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="حساب العميل"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <i className="fas fa-user" aria-hidden="true"></i>
                {buyer.name.split(" ")[0]}
                <i className="fas fa-chevron-down shop-user-caret" aria-hidden="true"></i>
              </button>
              {menuOpen && (
                <div className="shop-user-menu" role="menu" aria-label="قائمة العميل">
                  {[
                    { href: `/s/${encodeURIComponent(slug)}/account`, label: "حسابي", icon: "fas fa-id-card" },
                    { href: `/s/${encodeURIComponent(slug)}/account#settings`, label: "إعدادات الحساب", icon: "fas fa-cog" },
                    { href: `/s/${encodeURIComponent(slug)}/account/change-password`, label: "تغيير كلمة المرور", icon: "fas fa-key" },
                  ].map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      className="shop-user-item"
                      onClick={() => setMenuOpen(false)}
                    >
                      <i className={item.icon} aria-hidden="true"></i>
                      <span>{item.label}</span>
                    </Link>
                  ))}
                  <div className="shop-user-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="shop-user-item"
                    onClick={handleLogout}
                    disabled={loggingOut}
                  >
                    <i className="fas fa-sign-out-alt" aria-hidden="true"></i>
                    <span>{loggingOut ? "جاري الخروج..." : "تسجيل الخروج"}</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              href={`/s/${encodeURIComponent(slug)}/account`}
              className="shop-account-link"
              aria-label="تسجيل الدخول"
            >
              <i className="fas fa-user" aria-hidden="true"></i>
              دخول
            </Link>
          ))}
          {theme.header.show_cart === 1 && (
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
          )}
        </div>
      </header>
      <main className="shop-main" style={themeVars}>
        {title && (
          <div className="shop-hero">
            <h1>{title}</h1>
          </div>
        )}
        {children({
          store: state.store,
          categories: state.categories,
          products: state.products,
          theme: state.theme,
        })}
      </main>
      {theme.footer.visible === 1 && (
        <footer
          className="shop-footer"
          style={{
            ...themeVars,
            ...(theme.footer.background ? { background: theme.footer.background } : {}),
          }}
        >
          {theme.footer.text !== ""
            ? theme.footer.text
            : `${state.store.name} · ${state.store.currency} · تسوق آمن`}
        </footer>
      )}
    </>
  );
}
