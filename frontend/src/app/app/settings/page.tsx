"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";

/** Phase 2 settings hub: account state + links to Phase 1 account screens. */
export default function SettingsPage() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    await logout();
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>الإعدادات</h1>
        <p>بيانات حسابك وإدارة الجلسات وكلمة المرور.</p>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">الحساب</h2>
        <div className="info-row">
          <span className="key">الاسم</span>
          <span className="value">{user?.name ?? "—"}</span>
        </div>
        <div className="info-row">
          <span className="key">البريد الإلكتروني</span>
          <span className="value" dir="ltr">{user?.email ?? "—"}</span>
        </div>
        <div className="info-row">
          <span className="key">الهاتف</span>
          <span className="value" dir="ltr">{user?.phone ?? "—"}</span>
        </div>
        <div className="info-row">
          <span className="key">الدور</span>
          <span className="value">{user?.role === "admin" ? "مدير المنصة" : "تاجر"}</span>
        </div>
        <div className="info-row">
          <span className="key">توثيق البريد</span>
          <span className="value">{user?.email_verified === 1 ? "موثّق" : "غير موثّق"}</span>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">إدارة الحساب</h2>
        <div className="shell-stack">
          <Link href="/auth/profile" className="store-row">
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-id-card"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">الملف الشخصي</span>
              <span className="store-row-meta">تعديل الاسم والبريد والهاتف</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <Link href="/auth/change-password" className="store-row">
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-key"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">كلمة المرور</span>
              <span className="store-row-meta">تدوير كلمة المرور وخيارات الجلسات</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <Link href="/auth/sessions" className="store-row">
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-laptop"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">الجلسات</span>
              <span className="store-row-meta">إنهاء الجلسات الأخرى</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">تسجيل الخروج</h2>
        <p className="shell-note" style={{ marginBottom: 16 }}>
          سيتم إنهاء جلستك الحالية على هذا الجهاز وإعادتك إلى صفحة الدخول.
        </p>
        <button
          type="button"
          className="btn btn-outline"
          onClick={handleLogout}
          disabled={loggingOut}
        >
          {loggingOut ? "جاري تسجيل الخروج..." : "تسجيل الخروج"}
        </button>
      </div>
    </>
  );
}
