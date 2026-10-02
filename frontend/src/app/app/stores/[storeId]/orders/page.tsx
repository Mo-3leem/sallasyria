"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ordersApi, type PageMeta } from "@/lib/api";
import { getErrorCode, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { usePaging } from "@/hooks/usePaging";
import {
  ORDER_STATUS_LABELS,
  orderStatusLabel,
  paymentStatusLabel,
} from "@/lib/orders";
import { EmptyState } from "@/components/common/EmptyState";
import { BackButton } from "@/components/common/BackButton";
import { Pagination } from "@/components/common/Pagination";
import type { Order } from "@/types/api";

type OrderStatusFilter =
  | ""
  | "pending"
  | "confirmed"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; orders: Order[]; pagination: PageMeta };

/** Store orders, newest first (read-only list; transitions live on detail). */
export default function OrdersPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const [status, setStatus] = useState<OrderStatusFilter>("");
  const { page, setPage } = usePaging(`${storeId}:${status}`);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  async function load(targetPage: number) {
    setState({ kind: "loading" });
    try {
      const res = await ordersApi.list(storeId, {
        page: targetPage,
        ...(status === "" ? {} : { status }),
      });
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
          message: res.error.message || "تعذّر تحميل الطلبات.",
        });
        return;
      }
      setState({ kind: "ready", orders: res.data.orders, pagination: res.data.pagination });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, status, page]);

  return (
    <>
      <BackButton href={`${base}/settings`} label="العودة إلى إعدادات المتجر" />
      <div className="shell-page-head">
        <h1>الطلبات</h1>
        <p>طلبات متجرك من الأحدث — التفاصيل والتحويلات من صفحة الطلب.</p>
      </div>

      <div className="shell-card" style={{ marginBottom: 16 }}>
        <label className="auth-field" style={{ marginBottom: 0 }}>
          <span>تصفية حسب الحالة</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as OrderStatusFilter)}
          >
            <option value="">الكل</option>
            {(Object.keys(ORDER_STATUS_LABELS) as Exclude<OrderStatusFilter, "">[]).map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="shell-card">
        {state.kind === "loading" ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل الطلبات...
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
            title="تعذّر تحميل الطلبات"
            description={state.message}
            action={
              <button type="button" className="btn btn-outline" onClick={() => load(page)}>
                إعادة المحاولة
              </button>
            }
          />
        ) : state.orders.length === 0 ? (
          <EmptyState
            icon="fas fa-shopping-cart"
            title="لا توجد طلبات بعد"
            description="ستظهر هنا طلبات عملائك فور إتمام الشراء."
          />
        ) : (
          <div className="shell-stack">
            {state.orders.map((order) => (
              <Link
                key={order.id}
                href={`${base}/orders/${encodeURIComponent(order.id)}`}
                className="store-row"
              >
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-receipt"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name" dir="ltr">
                    #{order.order_number.toLocaleString("ar-SY")} · {order.customer_name}
                  </span>
                  <span className="store-row-meta">
                    <span>{orderStatusLabel(order.status)}</span>
                    <span>·</span>
                    <span>{paymentStatusLabel(order.payment_status)}</span>
                    <span>·</span>
                    <span>{order.total.toLocaleString("ar-SY")} قرش</span>
                  </span>
                </span>
                <i className="fas fa-chevron-left" aria-hidden="true" style={{ color: "var(--gray-3)" }}></i>
              </Link>
            ))}
          </div>
        )}
        {state.kind === "ready" && (
          <Pagination
            page={state.pagination.page}
            totalPages={state.pagination.total_pages}
            onPage={(p) => {
              setPage(p);
            }}
          />
        )}
      </div>
    </>
  );
}
