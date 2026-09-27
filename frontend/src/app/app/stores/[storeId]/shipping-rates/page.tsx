"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { shippingRatesApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";
import { BackButton } from "@/components/common/BackButton";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import type { ShippingRate } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; rates: ShippingRate[] };

/** Per-governorate delivery rates (one rate per governorate). */
export default function ShippingRatesPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingDelete, setPendingDelete] = useState<ShippingRate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  async function load() {
    setState({ kind: "loading" });
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await shippingRatesApi.list(storeId);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (getErrorCode(res) === "store_not_found") {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "error",
          message: res.error.message || "تعذّر تحميل أسعار الشحن.",
        });
        return;
      }
      setState({ kind: "ready", rates: res.data.rates });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function doDelete(rate: ShippingRate) {
    setDeleting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await shippingRatesApi.remove(storeId, rate.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "rate_not_found") {
          await load();
          return;
        }
        if (code === "subscription_inactive") {
          setActionError(
            "تعديل الشحن يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        setActionError(authErrorMessage(res, 400));
        return;
      }
      setPendingDelete(null);
      setActionNotice(`تم حذف سعر ${rate.governorate}.`);
      await load();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <BackButton href={`${base}/settings`} label="العودة إلى إعدادات المتجر" />
      <div className="shell-page-head">
        <h1>الشحن</h1>
        <p>أسعار التوصيل لكل محافظة — سعر واحد لكل محافظة.</p>
      </div>

      <div className="shell-card">
        {actionError && (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{actionError}</span>
          </div>
        )}
        {actionNotice && (
          <div className="shell-success" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>{actionNotice}</span>
          </div>
        )}
        {state.kind === "loading" ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل أسعار الشحن...
          </div>
        ) : state.kind === "missing" ? (
          <EmptyState
            icon="fas fa-store-slash"
            title="المتجر غير موجود أو لا تملك صلاحية الوصول إليه."
            action={
              <Link href="/app/stores" className="btn btn-primary">
                العودة إلى المتاجر
              </Link>
            }
          />
        ) : state.kind === "error" ? (
          <EmptyState
            icon="fas fa-exclamation-triangle"
            title="تعذّر تحميل أسعار الشحن"
            description={state.message}
            action={
              <button type="button" className="btn btn-outline" onClick={load}>
                إعادة المحاولة
              </button>
            }
          />
        ) : state.rates.length === 0 ? (
          <EmptyState
            icon="fas fa-truck"
            title="لا توجد أسعار شحن بعد"
            description="أضف سعر توصيل لكل محافظة تخدمها."
            action={
              <Link href={`${base}/shipping-rates/new`} className="btn btn-primary">
                <i className="fas fa-plus" aria-hidden="true"></i>
                إضافة سعر
              </Link>
            }
          />
        ) : (
          <>
            <div className="shell-stack">
              {state.rates.map((rate) => (
                <div key={rate.id} className="store-row">
                  <span className="store-row-icon" aria-hidden="true">
                    <i className="fas fa-truck"></i>
                  </span>
                  <span className="store-row-body">
                    <span className="store-row-name">{rate.governorate}</span>
                    <span className="store-row-meta">
                      <span>{rate.shipping_method}</span>
                      <span>·</span>
                      <span>{rate.cost.toLocaleString("ar-SY")} قرش</span>
                      <span>·</span>
                      <span>{rate.is_active === 1 ? "نشط" : "غير نشط"}</span>
                    </span>
                  </span>
                  <span className="store-card-links">
                    <Link
                      href={`${base}/shipping-rates/${encodeURIComponent(rate.id)}/edit`}
                      className="btn btn-ghost btn-shell-dark btn-sm"
                    >
                      تعديل
                    </Link>
                    <button
                      type="button"
                      className="btn btn-ghost btn-shell-dark btn-sm"
                      onClick={() => {
                        setActionError(null);
                        setActionNotice(null);
                        setPendingDelete(rate);
                      }}
                    >
                      حذف
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16 }}>
              <Link href={`${base}/shipping-rates/new`} className="btn btn-outline">
                <i className="fas fa-plus" aria-hidden="true"></i>
                إضافة سعر
              </Link>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف سعر الشحن؟"
        description={
          pendingDelete
            ? `سيتم حذف سعر التوصيل لمحافظة ${pendingDelete.governorate} نهائياً.`
            : undefined
        }
        confirmLabel="حذف"
        confirming={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && doDelete(pendingDelete)}
      />
    </>
  );
}
