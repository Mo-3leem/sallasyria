"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { customersApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import type { Customer } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; customers: Customer[] };

/**
 * Store customers (merchant-private reads; creation is a public buyer
 * upsert, so no create UI here). Delete is blocked by the backend while
 * orders reference the customer.
 */
export default function CustomersPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingDelete, setPendingDelete] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  async function load() {
    setState({ kind: "loading" });
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await customersApi.list(storeId);
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
          message: res.error.message || "تعذّر تحميل العملاء.",
        });
        return;
      }
      setState({ kind: "ready", customers: res.data.customers });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function doDelete(customer: Customer) {
    setDeleting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await customersApi.remove(storeId, customer.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "customer_not_found") {
          await load();
          return;
        }
        if (code === "subscription_inactive") {
          setActionError(
            "تعديل بيانات العملاء يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        if (code === "customer_has_orders") {
          // Stays undeleted by design — order history must survive.
          setActionError("العميل له طلبات لا يمكن حذفه.");
          return;
        }
        setActionError(authErrorMessage(res, 400));
        return;
      }
      setPendingDelete(null);
      setActionNotice(`تم حذف «${customer.name}».`);
      await load();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>العملاء</h1>
        <p>عملاء متجرك المسجلون عند الشراء — لا يوجد دخول للمشترين.</p>
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
            جاري تحميل العملاء...
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
            title="تعذّر تحميل العملاء"
            description={state.message}
            action={
              <button type="button" className="btn btn-outline" onClick={load}>
                إعادة المحاولة
              </button>
            }
          />
        ) : state.customers.length === 0 ? (
          <EmptyState
            icon="fas fa-users"
            title="لا يوجد عملاء بعد"
            description="يُسجَّل العملاء تلقائياً عند إتمام الشراء من متجرك."
          />
        ) : (
          <div className="shell-stack">
            {state.customers.map((customer) => (
              <div key={customer.id} className="store-row">
                <span className="store-row-icon" aria-hidden="true">
                  <i className="fas fa-user"></i>
                </span>
                <span className="store-row-body">
                  <span className="store-row-name">
                    <Link href={`${base}/customers/${encodeURIComponent(customer.id)}`}>
                      {customer.name}
                    </Link>
                  </span>
                  <span className="store-row-meta">
                    <span dir="ltr">{customer.phone}</span>
                    {customer.email && (
                      <>
                        <span>·</span>
                        <span dir="ltr">{customer.email}</span>
                      </>
                    )}
                  </span>
                </span>
                <span className="store-card-links">
                  <Link
                    href={`${base}/customers/${encodeURIComponent(customer.id)}/edit`}
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
                      setPendingDelete(customer);
                    }}
                  >
                    حذف
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف العميل؟"
        description={
          pendingDelete
            ? `سيتم حذف «${pendingDelete.name}» نهائياً. العملاء الذين لديهم طلبات لا يمكن حذفهم وستبقى بياناتهم.`
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
