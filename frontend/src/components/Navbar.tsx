"use client";

import { useEffect, useState } from "react";

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
          <a href="/auth/login" className="btn btn-outline">
            تسجيل الدخول
          </a>
          <a href="/auth/register" className="btn btn-primary">
            ابدأ مجاناً
          </a>
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
