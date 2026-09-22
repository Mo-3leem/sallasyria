"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { StoreCard } from "@/components/store/StoreCard";
import { EmptyState } from "@/components/common/EmptyState";

/** Merchant store list (admins see every store, per backend contract). */
export default function StoresPage() {
  const { user } = useAuth();
  const { stores, loading, error, refresh } = useStores();
  const isAdmin = user?.role === "admin";

  return (
    <>
      <div className="shell-page-head">
        <h1>{isAdmin ? "متاجر المنصة" : "متاجري"}</h1>
        <p>
          {isAdmin
            ? "جميع متاجر المنصة (صلاحية المدير)."
            : "جميع المتاجر التي تملكها — اختر متجراً لإدارته."}
        </p>
      </div>

      <div className="shell-card">
        {loading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل المتاجر...
          </div>
        ) : error ? (
          <>
            <div className="shell-error" role="alert">
              <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
              <span>{error}</span>
            </div>
            <button type="button" className="btn btn-outline" onClick={refresh}>
              إعادة المحاولة
            </button>
          </>
        ) : stores.length === 0 ? (
          <EmptyState
            icon="fas fa-store"
            title="لا توجد متاجر حتى الآن"
            description="أنشئ متجرك الأول للبدء."
            action={
              isAdmin ? undefined : (
                <Link href="/app/stores/new" className="btn btn-primary">
                  <i className="fas fa-plus" aria-hidden="true"></i>
                  إنشاء متجر
                </Link>
              )
            }
          />
        ) : (
          <>
            <div className="shell-stack">
              {stores.map((store) => (
                <StoreCard key={store.id} store={store} />
              ))}
            </div>
            {!isAdmin && (
              <div style={{ marginTop: 16 }}>
                <Link href="/app/stores/new" className="btn btn-outline">
                  <i className="fas fa-plus" aria-hidden="true"></i>
                  إنشاء متجر جديد
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
