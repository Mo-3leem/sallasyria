"use client";

import { useEffect, useState } from "react";
import { billingApi, plansApi } from "@/lib/api";
import { isApiError } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { SubscriptionBadge } from "@/components/common/SubscriptionBadge";
import { EmptyState } from "@/components/common/EmptyState";
import type { Plan, Subscription } from "@/types/api";

function formatMoney(amount: number): string {
  return `${amount.toLocaleString("ar-SY")} ل.س`;
}

function daysLeft(endsAt: string | null): number | null {
  if (!endsAt) return null;
  const ms = Date.parse(endsAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / (24 * 3600 * 1000));
}

function formatDate(value: string | null): string {
  if (!value) return "غير محدد";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "غير محدد";
  return d.toLocaleDateString("ar-SY", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Full period readout from already-fetched data — no new requests. */
function PeriodDetails({
  period,
  planName,
}: {
  period: Subscription;
  planName?: string;
}) {
  return (
    <span className="store-row-meta" style={{ marginTop: 6 }}>
      <span>الخطة: {planName ?? "—"}</span>
      <span>·</span>
      <span>
        الفترة: {period.billing_period === "yearly" ? "سنوية" : "شهرية"}
      </span>
      <span>·</span>
      <span>البدء: {formatDate(period.starts_at)}</span>
      <span>·</span>
      <span>الانتهاء: {formatDate(period.ends_at)}</span>
      <span>·</span>
      <span>
        المبلغ: {period.price_amount.toLocaleString("ar-SY")} ل.س
      </span>
    </span>
  );
}

/**
 * Merchant billing: plan catalog with self-serve Subscribe (redirect to
 * the provider) + the store's real periods (unknown only when the read
 * itself fails). Prices always come from the server; the return page
 * polls the intent — outcomes are never fabricated client-side.
 */
export default function BillingPage() {
  const { refresh: refreshAuth } = useAuth();
  const { stores, loading: storesLoading, error: storesError } = useStores();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [periods, setPeriods] = useState<Record<string, Subscription[]>>({});
  const [periodsLoading, setPeriodsLoading] = useState(true);
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

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

  useEffect(() => {
    if (storesLoading) return;
    let cancelled = false;
    (async () => {
      const out: Record<string, Subscription[]> = {};
      for (const store of stores) {
        try {
          const res = await billingApi.storeSubscriptions(store.id);
          if (!res.ok) {
            if (isApiError(res) && res.error.code === "unauthorized") {
              await refreshAuth();
              return;
            }
            continue;
          }
          out[store.id] = res.data.subscriptions;
        } catch {
          // Per-store failure degrades to the unknown badge below.
        }
      }
      if (!cancelled) {
        setPeriods(out);
        setPeriodsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stores, storesLoading, refreshAuth]);

  async function subscribe(storeId: string, plan: Plan, period: "monthly" | "yearly") {
    if (checkoutBusy) return;
    setCheckoutBusy(`${storeId}:${plan.id}:${period}`);
    setCheckoutError(null);
    try {
      const res = await billingApi.checkout(storeId, {
        plan_id: plan.id,
        billing_period: period,
      });
      if (!res.ok) {
        if (isApiError(res) && res.error.code === "unauthorized") {
          await refreshAuth();
          return;
        }
        setCheckoutError(
          isApiError(res) && res.error.message
            ? res.error.message
            : "تعذّر بدء الدفع. حاول مجدداً."
        );
        return;
      }
      // Hosted flow: leave our servers for the provider return page.
      window.location.assign(res.data.redirect_url);
    } catch {
      setCheckoutError("تعذّر الاتصال بالخادم.");
    } finally {
      setCheckoutBusy(null);
    }
  }

  const coveringOf = (storeId: string): Subscription | null => {
    const list = periods[storeId];
    if (!list) return null;
    const now = Date.now();
    return (
      list.find(
        (s) =>
          (s.status === "active" || s.status === "trialing") &&
          (!s.ends_at || Date.parse(s.ends_at) > now)
      ) ?? null
    );
  };

  return (
    <>
      <div className="shell-page-head">
        <h1>الخطط والاشتراك</h1>
        <p>اشترك لمتجرك بالدفع الإلكتروني — التفعيل تلقائي بعد نجاح الدفع.</p>
      </div>

      {checkoutError && (
        <div className="shell-error" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>{checkoutError}</span>
        </div>
      )}

      <div className="shell-card">
        <h2 className="shell-card-title">اشتراكات متاجري</h2>
        {storesLoading || periodsLoading ? (
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
            {stores.map((store) => {
              const covering = coveringOf(store.id);
              const known = store.id in periods;
              const left = covering ? daysLeft(covering.ends_at) : null;
              // Newest history row for the inactive case (backend orders
              // periods by starts_at DESC).
              const last = known ? (periods[store.id][0] ?? null) : null;
              return (
                <div key={store.id} className="store-row">
                  <span className="store-row-icon" aria-hidden="true">
                    <i className="fas fa-store"></i>
                  </span>
                  <span className="store-row-body">
                    <span className="store-row-name">{store.name}</span>
                    <span className="store-row-meta">
                      {!known ? (
                        <SubscriptionBadge status="unknown" />
                      ) : covering ? (
                        <>
                          <SubscriptionBadge
                            status={
                              covering.status === "trialing" ? "trialing" : "active"
                            }
                            planName={
                              plans.find((p) => p.id === covering.plan_id)?.name
                            }
                          />
                          {covering.status === "trialing" && (
                            <span className="soon-tag">
                              بقي {left ?? 0} يوم
                            </span>
                          )}
                        </>
                      ) : (
                        <SubscriptionBadge status="inactive" />
                      )}
                    </span>
                    {known && (covering || last) && (
                      <PeriodDetails
                        period={(covering ?? last)!}
                        planName={plans.find(
                          (p) => p.id === (covering ?? last)!.plan_id
                        )?.name}
                      />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <p className="shell-note" style={{ marginTop: 16 }}>
          لا يوجد تجديد تلقائي — كل دفعة عملية شراء مستقلة. الفوترة اليدوية
          عبر الإدارة ما تزال متاحة عند الحاجة.
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
                {stores.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div className="auth-field">
                      <label
                        className="auth-label"
                        htmlFor={`sub-store-${plan.id}`}
                      >
                        اشترك لمتجر
                      </label>
                      <select
                        id={`sub-store-${plan.id}`}
                        className="auth-input"
                        defaultValue=""
                        onChange={(e) => {
                          const [sid, per] = e.target.value.split("|");
                          if (sid && (per === "monthly" || per === "yearly")) {
                            subscribe(sid, plan, per);
                          }
                          e.target.value = "";
                        }}
                      >
                        <option value="">اختر المتجر والفترة...</option>
                        {stores.map((s) => (
                          <optgroup key={s.id} label={s.name}>
                            <option value={`${s.id}|monthly`}>
                              {s.name} — شهرية ({formatMoney(plan.price_monthly)})
                            </option>
                            <option value={`${s.id}|yearly`}>
                              {s.name} — سنوية ({formatMoney(plan.price_yearly)})
                            </option>
                          </optgroup>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
