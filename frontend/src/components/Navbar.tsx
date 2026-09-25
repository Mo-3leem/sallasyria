"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";

const NAV_LINKS = [
  { href: "#sectors", label: "القطاعات" },
  { href: "#features", label: "المميزات" },
  { href: "#payments", label: "المدفوعات" },
  { href: "#about", label: "عن سلة" },
  { href: "#partners", label: "الشركاء" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeHash, setActiveHash] = useState<string | null>(null);
  // Existing merchant/admin session (ss_session HttpOnly cookie, hydrated
  // once by the root AuthProvider via GET /auth/me). No new auth system.
  const { user, loading, logout } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  // Account dropdown: outside click / Escape / route action closes it.
  useEffect(() => {
    if (!accountOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setAccountOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountOpen]);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setAccountOpen(false);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  // 1. Navbar scroll effect (reference main.js §1)
  useEffect(() => {
    const updateNavbar = () => setScrolled(window.scrollY > 60);
    updateNavbar();
    window.addEventListener("scroll", updateNavbar, { passive: true });
    return () => window.removeEventListener("scroll", updateNavbar);
  }, []);

  // 5. Smooth active nav link on scroll (reference main.js §5)
  useEffect(() => {
    const sections = document.querySelectorAll("section[id], footer[id]");
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveHash("#" + entry.target.getAttribute("id"));
          }
        });
      },
      { threshold: 0.35 }
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  return (
    <header className={`navbar${scrolled ? " scrolled" : ""}`} id="navbar">
      <div className="container navbar-inner">
        <a href="#" className="logo" aria-label="سلة سوريا - الصفحة الرئيسية">
          <span className="logo-icon">
            <i className="fas fa-shopping-bag" aria-hidden="true"></i>
          </span>
          <span className="logo-text">
            سلة <span className="logo-sub">سوريا</span>
          </span>
        </a>

        <nav
          className={`nav-links${menuOpen ? " open" : ""}`}
          id="navLinks"
          aria-label="التنقل الرئيسي"
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={activeHash === link.href ? "active-nav" : ""}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav-actions">
          {loading ? (
            <span className="platform-account-skeleton" role="status" aria-label="جاري التحقق من الجلسة"></span>
          ) : user ? (
            <div className="platform-account-wrap" ref={accountRef}>
              <button
                type="button"
                className="platform-account-trigger"
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                aria-label="حساب المستخدم"
                onClick={() => setAccountOpen((open) => !open)}
              >
                {user.avatar_url ? (
                  <img src={user.avatar_url} alt="" className="platform-avatar-img" />
                ) : (
                  <span className="platform-avatar" aria-hidden="true">
                    {(user.name.trim()[0] ?? "م").toUpperCase()}
                  </span>
                )}
                {user.name.split(" ")[0]}
                <i className="fas fa-chevron-down platform-account-caret" aria-hidden="true"></i>
              </button>
              {accountOpen && (
                <div className="platform-menu" role="menu" aria-label="قائمة الحساب">
                  <div className="platform-menu-header">
                    {user.avatar_url ? (
                      <img src={user.avatar_url} alt="" className="platform-avatar-img" />
                    ) : (
                      <span className="platform-avatar" aria-hidden="true">
                        {(user.name.trim()[0] ?? "م").toUpperCase()}
                      </span>
                    )}
                    <span className="platform-menu-header-text">
                      <strong>{user.name}</strong>
                      <small>{user.role === "admin" ? "مدير المنصة" : "تاجر"}</small>
                    </span>
                  </div>
                  <div className="platform-menu-separator" role="separator" />
                  {[
                    { href: "/app/dashboard", label: "لوحة التحكم", icon: "fas fa-th-large" },
                    { href: "/app/stores", label: "متاجري", icon: "fas fa-store" },
                    { href: "/app/stores/new", label: "إنشاء متجر", icon: "fas fa-plus" },
                    { href: "/auth/profile", label: "الملف الشخصي", icon: "fas fa-id-card" },
                  ].map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      className="platform-menu-item"
                      onClick={() => setAccountOpen(false)}
                    >
                      <i className={item.icon} aria-hidden="true"></i>
                      <span>{item.label}</span>
                    </a>
                  ))}
                  <div className="platform-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="platform-menu-item"
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
            <>
              <a href="/auth/login" className="btn btn-outline">
                تسجيل الدخول
              </a>
              <a href="/auth/register" className="btn btn-primary">
                ابدأ مجاناً
              </a>
            </>
          )}
          <button
            className="hamburger"
            id="hamburger"
            type="button"
            aria-label="القائمة"
            aria-expanded={menuOpen}
            aria-controls="navLinks"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
        </div>
      </div>
    </header>
  );
}
