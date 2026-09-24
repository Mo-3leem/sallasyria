"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { shippingRatesApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import {
  ShippingRateForm,
  type ShippingRateFormValues,
} from "@/components/buyers/ShippingRateForm";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import type { ShippingRate } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; rate: ShippingRate };

/**
 * Edit rate: method/cost/active only. Governorate is immutable by backend
 * contract (400) — the form hides the selector and explains delete+recreate.
 */
export default function EditShippingRatePage({
  params,
}: {
  params: { storeId: string; id: string };
}) {
  const { storeId, id } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [noChanges, setNoChanges] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await shippingRatesApi.get(storeId, id);
        if (cancelled) return;
        if (!res.ok) {
          if (getErrorCode(res) === "unauthorized") {
            await refreshAuth();
            return;
          }
          const code = getErrorCode(res);
          if (code === "store_not_found" || code === "rate_not_found") {
            setState({ kind: "missing" });
            return;
          }
          setState({
            kind: "error",
            message: res.error.message || "تعذّر تحميل السعر.",
          });
          return;
        }
        setState({ kind: "ready", rate: res.data.rate });
      } catch {
        if (!cancelled) setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, id, refreshAuth]);

  async function onSubmit(values: ShippingRateFormValues) {
    if (state.kind !== "ready" || submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);
    setNoChanges(false);
    const diff: { shipping_method?: string; cost?: number; is_active?: 0 | 1 } = {};
    if (values.shipping_method !== state.rate.shipping_method)
      diff.shipping_method = values.shipping_method;
    if (values.cost !== state.rate.cost) diff.cost = values.cost;
    if (values.is_active !== state.rate.is_active) diff.is_active = values.is_active;
    if (Object.keys(diff).length === 0) {
      setNoChanges(true);
      return;
    }
    setSubmitting(true);
    try {
      const res = await shippingRatesApi.update(storeId, id, diff);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "rate_not_found") {
          setState({ kind: "missing" });
          return;
        }
        if (code === "subscription_inactive") {
          setFormError(
            "تعديل الشحن يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setState({ kind: "ready", rate: res.data.rate });
      setSaved(true);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="shell-loading">
        <span className="shell-spinner" aria-hidden="true"></span>
        جاري تحميل السعر...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="السعر غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href={`${base}/shipping-rates`} className="btn btn-primary">
              العودة إلى الشحن
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
          title="تعذّر تحميل السعر"
          description={state.message}
          action={
            <Link href={`${base}/shipping-rates`} className="btn btn-outline">
              العودة إلى الشحن
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <BackButton href={`${base}/shipping-rates`} />
      <div className="shell-page-head">
        <h1>تعديل سعر الشحن</h1>
        <p>
          <Link href={`${base}/shipping-rates`}>الشحن</Link>
          {" / "}
          {state.rate.governorate}
        </p>
      </div>
      <div className="shell-card">
        {saved && (
          <div className="shell-success" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>تم التحديث بنجاح.</span>
          </div>
        )}
        {noChanges && (
          <div className="shell-notice" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-info-circle" aria-hidden="true"></i>
            <span>لا توجد تغييرات.</span>
          </div>
        )}
        <ShippingRateForm
          key={`${state.rate.id}:${state.rate.shipping_method}:${state.rate.cost}:${state.rate.is_active}`}
          initial={{
            governorate: state.rate.governorate,
            shipping_method: state.rate.shipping_method,
            cost: state.rate.cost,
            is_active: state.rate.is_active === 1 ? 1 : 0,
          }}
          allowGovernorate={false}
          submitLabel="حفظ التغييرات"
          submitting={submitting}
          fieldErrors={fieldErrors}
          formError={formError}
          onSubmit={onSubmit}
        />
      </div>
    </>
  );
}
