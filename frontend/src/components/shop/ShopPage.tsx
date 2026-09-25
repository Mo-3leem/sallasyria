"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useBuyer } from "@/hooks/useBuyer";
import { useAuth } from "@/hooks/useAuth";
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
  const { buyerFor, refresh, logout } = useBuyer();
  // Merchant/admin session reuses the root AuthProvider (GET /auth/me over
  // the existing ss_session HttpOnly cookie). The storefront never had a
  // reader for it — buyers (ss_buyer) and merchants stay fully separate.
  const { user: authUser, loading: authLoading, logout: authLogout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [merchantOpen, setMerchantOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [merchantLoggingOut, setMerchantLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const merchantRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    refresh(slug);
    ensure(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Customer menu: outside click / Escape / route change close it.
  useEffect(() => {
    if (!menuOpen && !merchantOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (merchantRef.current && !merchantRef.current.contains(e.target as Node)) {
        setMerchantOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setMerchantOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, merchantOpen]);

  useEffect(() => {
    setMenuOpen(false);
    setMerchantOpen(false);
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

  // Existing merchant logout behavior (server revocation + /auth/login);
  // context clears instantly so the navbar flips to guest state at once.
  async function handleMerchantLogout() {
    if (merchantLoggingOut) return;
    setMerchantLoggingOut(true);
    setMerchantOpen(false);
    try {
      await authLogout();
    } finally {
      setMerchantLoggingOut(false);
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
          {authLoading || buyer === undefined ? (
            <span className="shop-account-skeleton" role="status" aria-label="جاري التحقق من الجلسة"></span>
          ) : authUser ? (
            <div className="shop-user-wrap" ref={merchantRef}>
              <button
                type="button"
                className="shop-account-link shop-account-trigger"
                aria-haspopup="menu"
                aria-expanded={merchantOpen}
                aria-label="حساب التاجر"
                onClick={() => setMerchantOpen((open) => !open)}
              >
                {authUser.avatar_url ? (
                  <img src={authUser.avatar_url} alt="" className="shop-avatar-img" />
                ) : (
                  <span className="shop-avatar" aria-hidden="true">
                    {(authUser.name.trim()[0] ?? "م").toUpperCase()}
                  </span>
                )}
                {authUser.name.split(" ")[0]}
                <i className="fas fa-chevron-down shop-user-caret" aria-hidden="true"></i>
              </button>
              {merchantOpen && (
                <div className="shop-user-menu" role="menu" aria-label="قائمة التاجر">
                  <div className="shop-user-header">
                    {authUser.avatar_url ? (
                      <img src={authUser.avatar_url} alt="" className="shop-avatar-img" />
                    ) : (
                      <span className="shop-avatar" aria-hidden="true">
                        {(authUser.name.trim()[0] ?? "م").toUpperCase()}
                      </span>
                    )}
                    <span className="shop-user-header-text">
                      <strong>{authUser.name}</strong>
                      <small>{authUser.role === "admin" ? "مدير المنصة" : "تاجر"}</small>
                    </span>
                  </div>
                  <div className="shop-user-separator" role="separator" />
                  <Link
                    href="/app/dashboard"
                    role="menuitem"
                    className="shop-user-item"
                    onClick={() => setMerchantOpen(false)}
                  >
                    <i className="fas fa-th-large" aria-hidden="true"></i>
                    <span>لوحة التحكم</span>
                  </Link>
                  <Link
                    href={`/s/${encodeURIComponent(slug)}`}
                    role="menuitem"
                    className="shop-user-item"
                    onClick={() => setMerchantOpen(false)}
                  >
                    <i className="fas fa-store" aria-hidden="true"></i>
                    <span>عرض المتجر</span>
                  </Link>
                  <Link
                    href="/auth/profile"
                    role="menuitem"
                    className="shop-user-item"
                    onClick={() => setMerchantOpen(false)}
                  >
                    <i className="fas fa-id-card" aria-hidden="true"></i>
                    <span>الملف الشخصي</span>
                  </Link>
                  {buyer && (
                    <Link
                      href={`/s/${encodeURIComponent(slug)}/account`}
                      role="menuitem"
                      className="shop-user-item"
                      onClick={() => setMerchantOpen(false)}
                    >
                      <i className="fas fa-user" aria-hidden="true"></i>
                      <span>حسابي في المتجر</span>
                    </Link>
                  )}
                  <div className="shop-user-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="shop-user-item"
                    onClick={handleMerchantLogout}
                    disabled={merchantLoggingOut}
                  >
                    <i className="fas fa-sign-out-alt" aria-hidden="true"></i>
                    <span>{merchantLoggingOut ? "جاري الخروج..." : "تسجيل الخروج"}</span>
                  </button>
                </div>
              )}
            </div>
          ) : buyer ? (
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
          )}
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
