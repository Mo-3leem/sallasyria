"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { customersApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import {
  CustomerForm,
  type CustomerFormValues,
} from "@/components/buyers/CustomerForm";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import type { Customer } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; customer: Customer };

/** Edit customer: diff-only PATCH (phone clashes surface as 409). */
export default function EditCustomerPage({
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
        const res = await customersApi.get(storeId, id);
        if (cancelled) return;
        if (!res.ok) {
          if (getErrorCode(res) === "unauthorized") {
            await refreshAuth();
            return;
          }
          const code = getErrorCode(res);
          if (code === "store_not_found" || code === "customer_not_found") {
            setState({ kind: "missing" });
            return;
          }
          setState({
            kind: "error",
            message: res.error.message || "تعذّر تحميل العميل.",
          });
          return;
        }
        setState({ kind: "ready", customer: res.data.customer });
      } catch {
        if (!cancelled) setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, id, refreshAuth]);

  async function onSubmit(values: CustomerFormValues) {
    if (state.kind !== "ready" || submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);
    setNoChanges(false);
    const diff: { name?: string; phone?: string; email?: string | null } = {};
    if (values.name !== state.customer.name) diff.name = values.name;
    if (values.phone !== state.customer.phone) diff.phone = values.phone;
    if (values.email !== state.customer.email) diff.email = values.email;
    if (Object.keys(diff).length === 0) {
      setNoChanges(true);
      return;
    }
    // Backend quirk (do NOT rely on diff-only here): the PATCH email schema
    // carries .default(null), so omitting email would CLEAR it server-side
    // despite the "partial update" docs. Send the complete triple whenever
    // anything changed; the no-changes gate above still avoids empty writes.
    diff.name = values.name;
    diff.phone = values.phone;
    diff.email = values.email;
    setSubmitting(true);
    try {
      const res = await customersApi.update(storeId, id, diff);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "customer_not_found") {
          setState({ kind: "missing" });
          return;
        }
        if (code === "subscription_inactive") {
          setFormError(
            "تعديل بيانات العملاء يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        const fields = getFieldErrors(res);
        if (code === "phone_taken") {
          fields.phone = fields.phone || "رقم مستخدم لعميل آخر.";
        }
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setState({ kind: "ready", customer: res.data.customer });
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
        جاري تحميل العميل...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="العميل غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href={`${base}/customers`} className="btn btn-primary">
              العودة إلى العملاء
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
          title="تعذّر تحميل العميل"
          description={state.message}
          action={
            <Link href={`${base}/customers`} className="btn btn-outline">
              العودة إلى العملاء
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <BackButton href={`${base}/customers/${encodeURIComponent(id)}`} />
      <div className="shell-page-head">
        <h1>تعديل العميل</h1>
        <p>
          <Link href={`${base}/customers`}>العملاء</Link>
          {" / "}
          {state.customer.name}
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
        <CustomerForm
          key={`${state.customer.id}:${state.customer.name}:${state.customer.phone}:${state.customer.email}`}
          initial={{
            name: state.customer.name,
            phone: state.customer.phone,
            email: state.customer.email,
          }}
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
