"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { storesApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { StoreForm, type StoreFormValues } from "@/components/store/StoreForm";
import { EmptyState } from "@/components/common/EmptyState";
import type { Store } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; store: Store };

/**
 * Store settings: GET loads, PATCH saves name/slug/currency only.
 * Foreign/missing ids are 404 — shown as not-found-or-no-access without
 * distinguishing (backend contract; no ownership probing).
 */
export default function StoreSettingsPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const { refresh: refreshStores } = useStores();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [noChanges, setNoChanges] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await storesApi.get(storeId);
        if (cancelled) return;
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
            message:
              res.error.message || "تعذّر تحميل المتجر. حاول مجدداً.",
          });
          return;
        }
        if (!res.data.store) {
          setState({ kind: "missing" });
          return;
        }
        setState({ kind: "ready", store: res.data.store });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "تعذّر الاتصال بالخادم." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, refreshAuth]);

  async function onSubmit(values: StoreFormValues) {
    if (state.kind !== "ready" || submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);
    setNoChanges(false);
    // PATCH is partial: send only editable fields that actually changed.
    const diff: { name?: string; slug?: string; currency?: string } = {};
    if (values.name !== state.store.name) diff.name = values.name;
    if (values.slug !== state.store.slug) diff.slug = values.slug;
    if (values.currency !== state.store.currency) diff.currency = values.currency;
    if (Object.keys(diff).length === 0) {
      setNoChanges(true);
      return;
    }
    setSubmitting(true);
    try {
      const res = await storesApi.update(storeId, diff);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found") {
          setState({ kind: "missing" });
          return;
        }
        if (code === "subscription_inactive") {
          setFormError(
            "تعديل المتجر يتطلب اشتراكاً نشطاً. التفعيل يتم يدوياً عبر إدارة المنصة."
          );
          return;
        }
        const fields = getFieldErrors(res);
        if (code === "slug_taken") {
          fields.slug =
            fields.slug || "هذا الرابط مستخدم بالفعل، اختر رابطًا آخر.";
          // Inline field error suffices — suppress the generic message.
          if (Object.keys(fields).length > 0) setFieldErrors(fields);
          return;
        }
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      if (res.data.store) setState({ kind: "ready", store: res.data.store });
      await refreshStores();
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
        جاري تحميل إعدادات المتجر...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="المتجر غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href="/app/stores" className="btn btn-primary">
              العودة إلى المتاجر
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
          title="تعذّر تحميل إعدادات المتجر"
          description={state.message}
          action={
            <Link href="/app/stores" className="btn btn-outline">
              العودة إلى المتاجر
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>إعدادات المتجر</h1>
        <p>{state.store.name} — تعديل الاسم والرابط والعملة فقط.</p>
      </div>
      <div className="shell-card">
        {saved && (
          <div className="shell-success" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>تم تحديث المتجر بنجاح.</span>
          </div>
        )}
        {noChanges && (
          <div className="shell-notice" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-info-circle" aria-hidden="true"></i>
            <span>لا توجد تغييرات.</span>
          </div>
        )}
        <StoreForm
          // Remount on fresh data so a saved rename/slug change replaces the
          // form's initial values instead of leaving stale ones behind.
          key={`${state.store.id}:${state.store.name}:${state.store.slug}:${state.store.currency}`}
          initial={{
            name: state.store.name,
            slug: state.store.slug,
            currency: state.store.currency,
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
