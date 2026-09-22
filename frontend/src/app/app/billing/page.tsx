"use client";

import { useEffect, useState } from "react";
import { plansApi } from "@/lib/api";
import { isApiError } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { SubscriptionBadge } from "@/components/common/SubscriptionBadge";
import { EmptyState } from "@/components/common/EmptyState";
import type { Plan } from "@/types/api";

function formatMoney(amount: number): string {
  return `${amount.toLocaleString("ar-SY")} ل.س`;
}

/**
 * Merchant billing: public plan catalog + per-store coverage shown
 * honestly. There is NO merchant-facing subscription-status endpoint, so
 * per-store status stays "unknown" (never guessed); activation and billing
 * are manual via the platform admin — no payment integration exists.
 */
export default function BillingPage() {
  const { user } = useAuth();
  const { stores, loading: storesLoading, error: storesError } = useStores();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await plansApi.list();
        if (cancelled) return;
        if (!res.ok) {
          setPlansError(
            isApiError(res) && res.error.message
              ? res.error.message
              : "تعذّر تحميل الخطط."
          );
          return;
        }
        setPlans(res.data.plans);
      } catch {
        if (!cancelled) setPlansError("تعذّر الاتصال بالخادم.");
      } finally {
        if (!cancelled) setPlansLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="shell-page-head">
        <h1>الخطط والاشتراك</h1>
        <p>خطط المنصة وحالة اشتراك متاجرك — التفعيل والفوترة يدوياً عبر الإدارة.</p>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">اشتراكات متاجري</h2>
        {storesLoading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري التحميل...
          </div>
        ) : storesError ? (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{storesError}</span>
          </div>
        ) : stores.length === 0 ? (
          <EmptyState
            icon="fas fa-store"
            title="لا توجد متاجر"
            description="الاشتراكات تُمنح لكل متجر على حدة."
          />
        ) : (
          <div className="shell-stack">
            {stores.map((store) => (
              <div key={store.id} className="store-row">
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-store"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name">{store.name}</span>
                  <span className="store-row-meta">
                    {/* No merchant subscription-status endpoint exists. */}
                    <SubscriptionBadge status="unknown" />
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="shell-note" style={{ marginTop: 16 }}>
          لا توجد واجهة لعرض حالة الاشتراك التفصيلية — الكتابة على المتجر
          تتطلب اشتراكاً نشطاً يفعّله مدير المنصة يدوياً. عند انتهاء الاشتراك
          ستظهر رسالة توضيحية على صفحات التعديل.
          {isAdmin && " بصفتك مديراً يمكنك الإدارة من قسم الإدارة."}
        </p>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">خطط المنصة</h2>
        {plansLoading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل الخطط...
          </div>
        ) : plansError ? (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{plansError}</span>
          </div>
        ) : plans.length === 0 ? (
          <EmptyState
            icon="fas fa-box-open"
            title="لا توجد خطط منشورة"
            description="لم تنشر المنصة أي خطة اشتراك بعد."
          />
        ) : (
          <div className="shell-grid-2">
            {plans.map((plan) => (
              <div key={plan.id} className="shell-card" style={{ marginTop: 0 }}>
                <h3 className="shell-card-title">{plan.name}</h3>
                <p className="plan-price">
                  <strong>{formatMoney(plan.price_monthly)}</strong> / شهرياً
                </p>
                <p className="plan-price">
                  <strong>{formatMoney(plan.price_yearly)}</strong> / سنوياً
                </p>
                <p className="shell-note" style={{ marginTop: 12 }}>
                  {plan.max_products === null
                    ? "عدد منتجات غير محدود."
                    : `حتى ${plan.max_products.toLocaleString("ar-SY")} منتج.`}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
