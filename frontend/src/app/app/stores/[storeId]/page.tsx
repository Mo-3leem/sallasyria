"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { storesApi } from "@/lib/api";
import { isApiError } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { SubscriptionBadge } from "@/components/common/SubscriptionBadge";
import { EmptyState } from "@/components/common/EmptyState";
import type { Store } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; store: Store };

/**
 * Minimal store home: validates the URL storeId against GET /stores/:storeId.
 * Foreign/missing ids are 404 by backend contract — shown as not-found
 * without ever exposing another store's data (frontend checks are UX only).
 */
export default function StorePage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await storesApi.get(storeId);
        if (cancelled) return;
        if (!res.ok) {
          if (isApiError(res) && res.error.code === "unauthorized") {
            await refreshAuth();
            return;
          }
          if (isApiError(res) && res.error.code === "store_not_found") {
            setState({ kind: "missing" });
            return;
          }
          setState({
            kind: "error",
            message:
              isApiError(res) && res.error.message
                ? res.error.message
                : "تعذّر تحميل المتجر. حاول مجدداً.",
          });
          return;
        }
        if (!res.data.store) {
          setState({ kind: "missing" });
          return;
        }
        setState({ kind: "ready", store: res.data.store });
      } catch {
        if (!cancelled) {
          setState({ kind: "error", message: "تعذّر الاتصال بالخادم." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, refreshAuth]);

  if (state.kind === "loading") {
    return (
      <div className="shell-loading">
        <span className="shell-spinner" aria-hidden="true"></span>
        جاري تحميل المتجر...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="المتجر غير موجود"
          description="ربما حُذف هذا المتجر أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href="/app/dashboard" className="btn btn-primary">
              العودة إلى لوحة التحكم
            </Link>
          }
        />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-exclamation-triangle"
          title="تعذّر تحميل المتجر"
          description={state.message}
          action={
            <Link href="/app/dashboard" className="btn btn-outline">
              العودة إلى لوحة التحكم
            </Link>
          }
        />
      </div>
    );
  }

  const { store } = state;

  return (
    <>
      <div className="shell-page-head">
        <h1>{store.name}</h1>
        <p>
          <span dir="ltr">{store.slug}</span>
          {" · "}
          {store.currency}
          {" · "}
          <Link href={`/app/stores/${encodeURIComponent(store.id)}/settings`}>
            إعدادات المتجر
          </Link>
        </p>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">بيانات المتجر</h2>
        <div className="info-row">
          <span className="key">الاسم</span>
          <span className="value">{store.name}</span>
        </div>
        <div className="info-row">
          <span className="key">الرابط</span>
          <span className="value" dir="ltr">{store.slug}</span>
        </div>
        <div className="info-row">
          <span className="key">العملة</span>
          <span className="value">{store.currency}</span>
        </div>
        <div className="info-row">
          <span className="key">الحالة</span>
          <span className="value">{store.status}</span>
        </div>
        <div className="info-row">
          <span className="key">الاشتراك</span>
          <span className="value">
            {/* No merchant-facing subscription-status endpoint exists. */}
            <SubscriptionBadge status="unknown" />
          </span>
        </div>
        <p className="shell-note" style={{ marginTop: 16 }}>
          حالة الاشتراك التفصيلية غير متاحة عبر الواجهة حالياً؛ التفعيل
          والإدارة يتم يدوياً عبر إدارة المنصة.
        </p>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">أقسام المتجر</h2>
        <div className="soon-list" aria-label="أقسام المتجر">
          <Link
            href={`/app/stores/${encodeURIComponent(store.id)}/products`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-box"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">المنتجات</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <Link
            href={`/app/stores/${encodeURIComponent(store.id)}/categories`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-tags"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">التصنيفات</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <Link
            href={`/app/stores/${encodeURIComponent(store.id)}/customers`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-users"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">العملاء</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <Link
            href={`/app/stores/${encodeURIComponent(store.id)}/shipping-rates`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-truck"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">الشحن</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <Link
            href={`/app/stores/${encodeURIComponent(store.id)}/orders`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-shopping-cart"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">الطلبات</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <Link
            href={`/app/stores/${encodeURIComponent(store.id)}/design`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-palette"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">تصميم المتجر</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </Link>
          <a
            href={`/s/${encodeURIComponent(store.slug)}`}
            className="store-row"
          >
            <span className="store-row-icon" aria-hidden="true">
              <i className="fas fa-eye"></i>
            </span>
            <span className="store-row-body">
              <span className="store-row-name">عرض كزائر</span>
            </span>
            <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
          </a>
        </div>
      </div>
    </>
  );
}
