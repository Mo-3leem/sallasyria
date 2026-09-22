"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { plansApi } from "@/lib/api";
import { isApiError } from "@/lib/auth-errors";
import { StatCard } from "@/components/common/StatCard";
import { SubscriptionBadge } from "@/components/common/SubscriptionBadge";
import { EmptyState } from "@/components/common/EmptyState";
import type { Plan } from "@/types/api";

function formatMoney(amount: number, currency = "ل.س"): string {
  return `${amount.toLocaleString("ar-SY")} ${currency}`;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { stores, loading: storesLoading, error: storesError, refresh: refreshStores } = useStores();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);

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

  const isAdmin = user?.role === "admin";

  return (
    <>
      <div className="shell-page-head">
        <h1>لوحة التحكم</h1>
        <p>
          مرحباً {user?.name ?? ""}،
          {isAdmin
            ? " هذه نظرة عامة على المنصة — لوحة الإدارة الكاملة في مرحلة لاحقة."
            : " هذه نظرة عامة على متاجرك وخطط الاشتراك."}
        </p>
      </div>

      <div className="shell-grid">
        <StatCard
          title="متاجري"
          value={storesLoading ? "…" : stores.length.toLocaleString("ar-SY")}
          icon="fas fa-store"
          hint={isAdmin ? "جميع متاجر المنصة" : "عدد المتاجر التي تملكها"}
        />
        <StatCard
          title="الدور"
          value={isAdmin ? "مدير المنصة" : "تاجر"}
          icon="fas fa-user-tag"
          hint={user?.email ?? ""}
        />
        <StatCard
          title="الخطط المتاحة"
          value={plansLoading ? "…" : plans.length.toLocaleString("ar-SY")}
          icon="fas fa-box-open"
          hint="كتالوج الخطط العام"
        />
      </div>

      <div className="shell-card" style={{ marginTop: 20 }}>
        <h2 className="shell-card-title">متاجري</h2>
        {storesLoading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل المتاجر...
          </div>
        ) : storesError ? (
          <>
            <div className="shell-error" role="alert">
              <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
              <span>{storesError}</span>
            </div>
            <button type="button" className="btn btn-outline" onClick={refreshStores}>
              إعادة المحاولة
            </button>
          </>
        ) : stores.length === 0 ? (
          <EmptyState
            icon="fas fa-store"
            title="لا توجد متاجر حتى الآن"
            description={
              isAdmin
                ? "لا توجد متاجر مسجلة على المنصة حتى الآن."
                : "أنشئ متجرك الأول للبدء."
            }
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
          <div className="shell-stack">
            {stores.map((store) => (
              <Link
                key={store.id}
                href={`/app/stores/${encodeURIComponent(store.id)}`}
                className="store-row"
              >
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-store"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name">{store.name}</span>
                  <span className="store-row-meta">
                    <span dir="ltr">{store.slug}</span>
                    <span>·</span>
                    <span>{store.currency}</span>
                    <span>·</span>
                    {/* No merchant-facing subscription-status endpoint exists:
                        status stays "unknown" with an honest explanation. */}
                    <SubscriptionBadge status="unknown" />
                  </span>
                </span>
                <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">خطط الاشتراك</h2>
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
          <>
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
                      : `حتى ${plan.max_products.toLocaleString("ar-SY")} منتج.`}{" "}
                    التفعيل يدوي عبر إدارة المنصة.
                  </p>
                </div>
              ))}
            </div>
            <p className="shell-note" style={{ marginTop: 16 }}>
              الكتابة على المتجر تتطلب اشتراكاً نشطاً؛ عند انتهائه ستظهر رسالة
              توضيحية بدلاً من الفشل الصامت.
            </p>
          </>
        )}
      </div>
    </>
  );
}
