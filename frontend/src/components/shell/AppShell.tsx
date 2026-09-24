"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { StoreSwitcher } from "./StoreSwitcher";

const NAV_ITEMS = [
  { href: "/app/dashboard", label: "لوحة التحكم", icon: "fas fa-th-large" },
  { href: "/app/stores", label: "متاجري", icon: "fas fa-store" },
  { href: "/app/billing", label: "الخطط والاشتراك", icon: "fas fa-file-contract" },
  { href: "/app/settings", label: "الإعدادات", icon: "fas fa-cog" },
];

/** Admin entry: UX-only visibility; RequireAdmin + backend own the gate. */
const ADMIN_NAV_ITEM = { href: "/app/admin", label: "الإدارة", icon: "fas fa-shield-alt" };

/**
 * Authenticated application shell: desktop sidebar, mobile drawer,
 * header (store switcher + account area), main content.
 * Must be rendered inside <RequireAuth> (see app/app/layout.tsx).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    await logout();
  }

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  // Per-store section links, derived from the URL (no global selection).
  const storeMatch = pathname.match(/^\/app\/stores\/([^/]+)/);
  const storeId = storeMatch ? decodeURIComponent(storeMatch[1] ?? "") : null;
  const storeBase =
    storeId !== null ? `/app/stores/${encodeURIComponent(storeId)}` : null;

  const sidebar = (
    <div className="shell-sidebar-inner">
      <Link
        href="/app/dashboard"
        className="shell-brand"
        aria-label="سلة سوريا - لوحة التحكم"
        onClick={() => setDrawerOpen(false)}
      >
        <span className="logo-icon" aria-hidden="true">
          <i className="fas fa-shopping-bag"></i>
        </span>
        <span className="shell-brand-text">
          سلة <span className="shell-brand-sub">سوريا</span>
        </span>
      </Link>

      <nav className="shell-nav" aria-label="تنقل التطبيق">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`shell-nav-item${isActive(item.href) ? " active" : ""}`}
            aria-current={isActive(item.href) ? "page" : undefined}
            onClick={() => setDrawerOpen(false)}
          >
            <i className={item.icon} aria-hidden="true"></i>
            <span>{item.label}</span>
          </Link>
        ))}
        {user?.role === "admin" && (
          <Link
            href={ADMIN_NAV_ITEM.href}
            className={`shell-nav-item${isActive(ADMIN_NAV_ITEM.href) ? " active" : ""}`}
            aria-current={isActive(ADMIN_NAV_ITEM.href) ? "page" : undefined}
            onClick={() => setDrawerOpen(false)}
          >
            <i className={ADMIN_NAV_ITEM.icon} aria-hidden="true"></i>
            <span>{ADMIN_NAV_ITEM.label}</span>
          </Link>
        )}
        {storeBase && (
          <>
            <span className="shell-nav-section">المتجر الحالي</span>
            {[
              { href: `${storeBase}/products`, label: "المنتجات", icon: "fas fa-box" },
              { href: `${storeBase}/categories`, label: "التصنيفات", icon: "fas fa-tags" },
              { href: `${storeBase}/customers`, label: "العملاء", icon: "fas fa-users" },
              { href: `${storeBase}/shipping-rates`, label: "الشحن", icon: "fas fa-truck" },
              { href: `${storeBase}/orders`, label: "الطلبات", icon: "fas fa-shopping-cart" },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`shell-nav-item${isActive(item.href) ? " active" : ""}`}
                aria-current={isActive(item.href) ? "page" : undefined}
                onClick={() => setDrawerOpen(false)}
              >
                <i className={item.icon} aria-hidden="true"></i>
                <span>{item.label}</span>
              </Link>
            ))}
          </>
        )}
        <a
          href="/"
          className="shell-nav-item"
          onClick={() => setDrawerOpen(false)}
        >
          <i className="fas fa-globe" aria-hidden="true"></i>
          <span>عرض الموقع</span>
        </a>
      </nav>

      <div className="shell-account">
        <div className="shell-account-info">
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className="shell-account-avatar-img" />
          ) : (
            <span className="shell-account-avatar" aria-hidden="true">
              <i className="fas fa-user"></i>
            </span>
          )}
          <span className="shell-account-text">
            <strong>{user?.name ?? "…"}</strong>
            <small>
              {user?.role === "admin" ? "مدير المنصة" : "تاجر"}
              {user?.email ? ` · ${user.email}` : ""}
            </small>
          </span>
        </div>
        <div className="shell-account-actions">
          <Link href="/auth/profile" className="btn btn-ghost btn-shell">
            حسابي
          </Link>
          <button
            type="button"
            className="btn btn-ghost btn-shell"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? "جاري الخروج..." : "خروج"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="shell">
      <aside className="shell-sidebar" aria-label="الشريط الجانبي">
        {sidebar}
      </aside>

      {drawerOpen && (
        <div
          className="shell-drawer-overlay"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`shell-drawer${drawerOpen ? " open" : ""}`}
        aria-label="قائمة التطبيق"
        aria-hidden={!drawerOpen}
      >
        {sidebar}
      </aside>

      <div className="shell-main">
        <header className="shell-header">
          <button
            type="button"
            className="shell-menu-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="فتح القائمة"
            aria-expanded={drawerOpen}
          >
            <i className="fas fa-bars" aria-hidden="true"></i>
          </button>
          <StoreSwitcher />
          <span className="shell-header-user" title={user?.name ?? ""}>
            <i className="fas fa-user-circle" aria-hidden="true"></i>
            <span>{user?.name ?? ""}</span>
          </span>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
