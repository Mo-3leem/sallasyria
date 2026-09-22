"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ordersApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import {
  NEXT_ORDER_STATUSES,
  NEXT_PAYMENT_STATUSES,
  orderStatusLabel,
  paymentMethodLabel,
  paymentStatusLabel,
} from "@/lib/orders";
import { EmptyState } from "@/components/common/EmptyState";
import type { Order, OrderItem } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; order: Order; items: OrderItem[] };

/**
 * Order detail: frozen snapshots + server totals are displayed as returned,
 * never recomputed. Only backend-allowed next states are offered; the
 * backend re-validates every transition (409 otherwise).
 */
export default function OrderDetailPage({
  params,
}: {
  params: { storeId: string; id: string };
}) {
  const { storeId, id } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  async function load() {
    setState({ kind: "loading" });
    setActionError(null);
    try {
      const res = await ordersApi.get(storeId, id);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (getErrorCode(res) === "store_not_found") {
          setState({ kind: "missing" });
          return;
        }
        // order_not_found and foreign ids share the generic message.
        if (getErrorCode(res) === "order_not_found") {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "error",
          message: res.error.message || "تعذّر تحميل الطلب.",
        });
        return;
      }
      setState({ kind: "ready", order: res.data.order, items: res.data.items });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, id]);

  async function transition(
    kind: "status" | "payment",
    value: string,
    label: string
  ) {
    if (working) return;
    setWorking(`${kind}:${value}`);
    setActionError(null);
    try {
      const res =
        kind === "status"
          ? await ordersApi.transitionStatus(storeId, id, value)
          : await ordersApi.transitionPayment(storeId, id, value);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "order_not_found") {
          setState({ kind: "missing" });
          return;
        }
        if (code === "subscription_inactive") {
          setActionError(
            "تعديل الطلبات يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        if (code === "invalid_transition") {
          setActionError(`تعذّر الانتقال إلى «${label}» — غير مسموح من الحالة الحالية. حدّث الصفحة وحاول مجدداً.`);
          await load();
          return;
        }
        setActionError(authErrorMessage(res, 400));
        return;
      }
      await load();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setWorking(null);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="shell-loading">
        <span className="shell-spinner" aria-hidden="true"></span>
        جاري تحميل الطلب...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="الطلب غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href={`${base}/orders`} className="btn btn-primary">
              العودة إلى الطلبات
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
          title="تعذّر تحميل الطلب"
          description={state.message}
          action={
            <Link href={`${base}/orders`} className="btn btn-outline">
              العودة إلى الطلبات
            </Link>
          }
        />
      </div>
    );
  }

  const { order, items } = state;
  const nextStatuses = NEXT_ORDER_STATUSES[order.status] ?? [];
  const nextPayments = NEXT_PAYMENT_STATUSES[order.payment_status] ?? [];
  const money = (n: number) => `${n.toLocaleString("ar-SY")} قرش`;

  return (
    <>
      <div className="shell-page-head">
        <h1>
          <span dir="ltr">#{order.order_number.toLocaleString("ar-SY")}</span>
        </h1>
        <p>
          <Link href={`${base}/orders`}>الطلبات</Link>
          {" / "}
          {orderStatusLabel(order.status)} · {paymentStatusLabel(order.payment_status)}
        </p>
      </div>

      {actionError && (
        <div className="shell-error" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>{actionError}</span>
        </div>
      )}

      <div className="shell-card">
        <h2 className="shell-card-title">المشتري والتوصيل (لقطة مجمدة وقت الشراء)</h2>
        <div className="info-row">
          <span className="key">المشتري</span>
          <span className="value">{order.customer_name}</span>
        </div>
        <div className="info-row">
          <span className="key">هاتف المشتري</span>
          <span className="value" dir="ltr">{order.customer_phone}</span>
        </div>
        <div className="info-row">
          <span className="key">طريقة التوصيل</span>
          <span className="value">{order.shipping_method}</span>
        </div>
        <div className="info-row">
          <span className="key">المحافظة</span>
          <span className="value">{order.shipping_governorate}</span>
        </div>
        <div className="info-row">
          <span className="key">عنوان التوصيل</span>
          <span className="value">{order.shipping_address}</span>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">الأصناف</h2>
        <div className="shell-stack">
          {items.map((item) => (
            <div key={item.id} className="store-row">
              <span className="store-row-icon" aria-hidden="true">
                <i className="fas fa-box"></i>
              </span>
              <span className="store-row-body">
                <span className="store-row-name">{item.product_name}</span>
                <span className="store-row-meta">
                  <span>الكمية: {item.quantity.toLocaleString("ar-SY")}</span>
                  <span>·</span>
                  <span>سعر الوحدة: {money(item.unit_price)}</span>
                  <span>·</span>
                  <span>الإجمالي: {money(item.line_total)}</span>
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">الإجماليات (محسوبة من الخادم)</h2>
        <div className="info-row">
          <span className="key">المجموع الفرعي</span>
          <span className="value">{money(order.subtotal)}</span>
        </div>
        <div className="info-row">
          <span className="key">الخصم</span>
          <span className="value">{money(order.discount)}</span>
        </div>
        <div className="info-row">
          <span className="key">تكلفة الشحن</span>
          <span className="value">{money(order.shipping_cost)}</span>
        </div>
        <div className="info-row">
          <span className="key">الإجمالي</span>
          <span className="value">{money(order.total)}</span>
        </div>
        <div className="info-row">
          <span className="key">طريقة الدفع</span>
          <span className="value">{paymentMethodLabel(order.payment_method)}</span>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">حالة الطلب</h2>
        <p className="shell-note" style={{ marginBottom: 12 }}>
          الحالية: <strong>{orderStatusLabel(order.status)}</strong>
          {nextStatuses.length === 0 && " — حالة نهائية، لا انتقالات متاحة."}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {nextStatuses.map((s) => (
            <button
              key={s}
              type="button"
              className="btn btn-outline btn-sm"
              disabled={working !== null}
              onClick={() => transition("status", s, orderStatusLabel(s))}
            >
              {working === `status:${s}` ? "جاري..." : `→ ${orderStatusLabel(s)}`}
            </button>
          ))}
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">حالة الدفع</h2>
        <p className="shell-note" style={{ marginBottom: 12 }}>
          الحالية: <strong>{paymentStatusLabel(order.payment_status)}</strong>
          {nextPayments.length === 0 && " — حالة نهائية، لا انتقالات متاحة."}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {nextPayments.map((s) => (
            <button
              key={s}
              type="button"
              className="btn btn-outline btn-sm"
              disabled={working !== null}
              onClick={() => transition("payment", s, paymentStatusLabel(s))}
            >
              {working === `payment:${s}` ? "جاري..." : `→ ${paymentStatusLabel(s)}`}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
