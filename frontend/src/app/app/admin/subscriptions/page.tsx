"use client";

import { useEffect, useState } from "react";
import { adminApi, billingApi, plansApi, storesApi, type PageMeta } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { usePaging } from "@/hooks/usePaging";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Pagination } from "@/components/common/Pagination";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import type { Plan, Store, Subscription } from "@/types/api";

type Filter = "all" | "active" | "cancelled" | "expired";

const FILTER_LABELS: Record<Filter, string> = {
  all: "الكل",
  active: "نشط",
  cancelled: "ملغي",
  expired: "منتهي",
};

/**
 * Admin subscriptions: list (server-side status filter), activate, cancel
 * (idempotent), renew (append-only new period). Billing is manual — price
 * and payment reference are recorded as given.
 */
export default function AdminSubscriptionsPage() {
  const { refresh: refreshAuth } = useAuth();
  const { stores } = useStores();
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [pagination, setPagination] = useState<PageMeta | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const { page, setPage } = usePaging(filter);
  const [pendingCancel, setPendingCancel] = useState<Subscription | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Activate form
  const [storeId, setStoreId] = useState("");
  const [planId, setPlanId] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [price, setPrice] = useState("0");
  const [reference, setReference] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function load(targetPage: number, targetFilter: Filter) {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([
        adminApi.subscriptions.list({
          page: targetPage,
          ...(targetFilter === "all" ? {} : { status: targetFilter }),
        }),
        plansApi.list(),
      ]);
      for (const res of [s, p]) {
        if (!res.ok && getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
      }
      if (!s.ok) {
        setError(s.error.message || "تعذّر تحميل الاشتراكات.");
        return;
      }
      setSubs(s.data.subscriptions);
      setPagination(s.data.pagination);
      if (p.ok) setPlans(p.data.plans);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(page, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filter]);

  async function onActivate() {
    if (submitting) return;
    setFormError(null);
    setNotice(null);
    if (!storeId || !planId) {
      setFormError("اختر المتجر والخطة أولاً.");
      return;
    }
    if (!/^\d+$/.test(price.trim())) {
      setFormError("السعر رقم صحيح ≥ 0 بالقرش.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await adminApi.subscriptions.activate({
        store_id: storeId,
        plan_id: planId,
        billing_period: period,
        price_amount: Number(price.trim()),
        payment_reference: reference.trim() === "" ? null : reference.trim(),
      });
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "subscription_active_exists") {
          setFormError("المتجر لديه اشتراك نشط بالفعل — ألغه أولاً قبل التفعيل.");
          return;
        }
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setNotice(`تم التفعيل: ${res.data.subscription.id} (${res.data.subscription.status}).`);
      setReference("");
      await load(page, filter);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  async function doCancel(sub: Subscription) {
    setWorking(`cancel:${sub.id}`);
    setNotice(null);
    try {
      // Idempotent: cancelling an already-cancelled period is a 200 no-op.
      const res = await adminApi.subscriptions.cancel(sub.id, {});
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setNotice(null);
        setError(authErrorMessage(res, 400));
        return;
      }
      setPendingCancel(null);
      setNotice(`تم إلغاء الفترة ${sub.id}.`);
      await load(page, filter);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setWorking(null);
    }
  }

  async function doRenew(sub: Subscription) {
    setWorking(`renew:${sub.id}`);
    setNotice(null);
    try {
      // Append-only: renewal creates a new period, never mutates history.
      const res = await adminApi.subscriptions.renew(sub.id, {});
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (getErrorCode(res) === "subscription_active_exists") {
          setError("المتجر لديه اشتراك نشط بالفعل — لا يمكن فتح فترة جديدة قبل إلغائه.");
          return;
        }
        setError(authErrorMessage(res, 400));
        return;
      }
      setNotice(`فترة جديدة: ${res.data.subscription.id}.`);
      await load(page, filter);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setWorking(null);
    }
  }

  // Server-side status filter (backend ?status=): the list below is the
  // current page as returned, no client re-filtering.
  const visible = subs;
  const storeName = (store: Store) => `${store.name} (${store.slug})`;

  return (
    <>
      <div className="shell-card">
        <h2 className="shell-card-title">تفعيل اشتراك لمتجر</h2>
        <FormError message={formError} />
        {notice && (
          <div className="shell-success" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>{notice}</span>
          </div>
        )}
        <div className="auth-form">
          <div className="auth-field">
            <label className="auth-label" htmlFor="sub-store">المتجر</label>
            <select
              id="sub-store"
              className="auth-input"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
            >
              <option value="">اختر متجراً...</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {storeName(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="auth-field">
            <label className="auth-label" htmlFor="sub-plan">الخطة</label>
            <select
              id="sub-plan"
              className="auth-input"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
            >
              <option value="">اختر خطة...</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </select>
          </div>
          <div className="auth-field">
            <label className="auth-label" htmlFor="sub-period">الفترة</label>
            <select
              id="sub-period"
              className="auth-input"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="monthly">شهرية</option>
              <option value="yearly">سنوية</option>
            </select>
          </div>
          <TextField
            label="السعر (بالقرش)"
            id="field-price"
            dir="ltr"
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <TextField
            label="مرجع الدفع (اختياري)"
            id="field-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-lg auth-submit"
            disabled={submitting}
            onClick={onActivate}
          >
            {submitting ? "جاري التفعيل..." : "تفعيل الاشتراك"}
          </button>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">الفترات المسجلة</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }} role="group" aria-label="تصفية حسب الحالة">
          {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-outline"}`}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري التحميل...
          </div>
        ) : error ? (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{error}</span>
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="fas fa-file-contract"
            title="لا توجد فترات بهذه الحالة"
          />
        ) : (
          <div className="shell-stack">
            {visible.map((sub) => (
              <div key={sub.id} className="store-row">
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-file-contract"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name" dir="ltr">{sub.id}</span>
                  <span className="store-row-meta">
                    <span>{sub.status}</span>
                    <span>·</span>
                    <span>{sub.billing_period}</span>
                    <span>·</span>
                    <span>{sub.price_amount.toLocaleString("ar-SY")} قرش</span>
                    {sub.payment_reference && (
                      <>
                        <span>·</span>
                        <span dir="ltr">{sub.payment_reference}</span>
                      </>
                    )}
                  </span>
                </span>
                <span className="store-card-links">
                  {sub.status !== "cancelled" && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-shell-dark btn-sm"
                      disabled={working !== null}
                      onClick={() => setPendingCancel(sub)}
                    >
                      إلغاء
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-shell-dark btn-sm"
                    disabled={working !== null}
                    onClick={() => doRenew(sub)}
                  >
                    {working === `renew:${sub.id}` ? "جاري..." : "تجديد"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        {pagination !== null && !loading && !error && (
          <Pagination
            page={pagination.page}
            totalPages={pagination.total_pages}
            onPage={(p) => setPage(p)}
          />
        )}
      </div>

      <ConfirmDialog
        open={pendingCancel !== null}
        title="إلغاء الاشتراك؟"
        description="سيتم إلغاء الفترة الحالية. السجل يبقى محفوظاً، والإلغاء المكرر عملية آمنة."
        confirmLabel="إلغاء الاشتراك"
        confirming={working !== null}
        onClose={() => setPendingCancel(null)}
        onConfirm={() => pendingCancel && doCancel(pendingCancel)}
      />

      <AdminIntentsCard />
    </>
  );
}

function AdminIntentsCard() {
  const { refresh: refreshAuth } = useAuth();
  const [intents, setIntents] = useState<
    { id: string; store_id: string; status: string; amount: number; currency: string }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await billingApi.adminIntents();
        if (cancelled) return;
        if (!res.ok) {
          if (getErrorCode(res) === "unauthorized") await refreshAuth();
          return;
        }
        setIntents(res.data.intents);
      } catch {
        // Readout degrades to empty; subscriptions above stay authoritative.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAuth]);

  return (
    <div className="shell-card">
      <h2 className="shell-card-title">محاولات الدفع الأخيرة</h2>
      {loading ? (
        <div className="shell-loading">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري التحميل...
        </div>
      ) : intents.length === 0 ? (
        <EmptyState
          icon="fas fa-credit-card"
          title="لا توجد محاولات دفع بعد"
        />
      ) : (
        <div className="shell-stack">
          {intents.slice(0, 10).map((intent) => (
            <div key={intent.id} className="store-row">
              <span className="store-row-icon" aria-hidden="true">
                <i className="fas fa-credit-card"></i>
              </span>
              <span className="store-row-body">
                <span className="store-row-name" dir="ltr">{intent.id}</span>
                <span className="store-row-meta">
                  <span>{intent.status}</span>
                  <span>·</span>
                  <span>{intent.amount.toLocaleString("ar-SY")} {intent.currency}</span>
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
