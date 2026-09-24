"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { categoriesApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import {
  CategoryForm,
  type CategoryFormValues,
} from "@/components/catalog/CategoryForm";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import type { Category } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; category: Category; parents: Category[] };

/** Edit category: diff-only PATCH, unchanged shows "no changes". */
export default function EditCategoryPage({
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
        const [got, listed] = await Promise.all([
          categoriesApi.get(storeId, id),
          categoriesApi.list(storeId),
        ]);
        if (cancelled) return;
        for (const res of [got, listed]) {
          if (!res.ok && getErrorCode(res) === "unauthorized") {
            await refreshAuth();
            return;
          }
        }
        if (!got.ok) {
          const code = getErrorCode(got);
          if (code === "store_not_found" || code === "category_not_found") {
            setState({ kind: "missing" });
            return;
          }
          setState({
            kind: "error",
            message: got.error.message || "تعذّر تحميل التصنيف.",
          });
          return;
        }
        setState({
          kind: "ready",
          category: got.data.category,
          parents: listed.ok ? listed.data.categories : [],
        });
      } catch {
        if (!cancelled) setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, id, refreshAuth]);

  async function onSubmit(values: CategoryFormValues) {
    if (state.kind !== "ready" || submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);
    setNoChanges(false);
    const diff: {
      name?: string;
      slug?: string;
      parent_id?: string | null;
      sort_order?: number;
      is_active?: 0 | 1;
    } = {};
    if (values.name !== state.category.name) diff.name = values.name;
    if (values.slug !== state.category.slug) diff.slug = values.slug;
    if (values.parent_id !== state.category.parent_id) diff.parent_id = values.parent_id;
    if (values.sort_order !== state.category.sort_order) diff.sort_order = values.sort_order;
    if (values.is_active !== state.category.is_active) diff.is_active = values.is_active;
    if (Object.keys(diff).length === 0) {
      setNoChanges(true);
      return;
    }
    setSubmitting(true);
    try {
      const res = await categoriesApi.update(storeId, id, diff);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "category_not_found") {
          setState({ kind: "missing" });
          return;
        }
        if (code === "subscription_inactive") {
          setFormError(
            "تعديل الكتالوج يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        const fields = getFieldErrors(res);
        if (code === "slug_taken") {
          fields.slug =
            fields.slug || "هذا الرابط مستخدم بالفعل، اختر رابطًا آخر.";
          if (Object.keys(fields).length > 0) setFieldErrors(fields);
          return;
        }
        if (code === "invalid_parent") {
          setFormError("تعيين الأب غير صالح (تسلسل دائري أو عمق زائد).");
          return;
        }
        if (code === "parent_not_found") {
          setFormError("التصنيف الأب غير موجود — حدّث الصفحة وحاول مجدداً.");
          return;
        }
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setState({ kind: "ready", category: res.data.category, parents: state.parents });
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
        جاري تحميل التصنيف...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="التصنيف غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href={`${base}/categories`} className="btn btn-primary">
              العودة إلى التصنيفات
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
          title="تعذّر تحميل التصنيف"
          description={state.message}
          action={
            <Link href={`${base}/categories`} className="btn btn-outline">
              العودة إلى التصنيفات
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <BackButton href={`${base}/categories`} />
      <div className="shell-page-head">
        <h1>تعديل التصنيف</h1>
        <p>
          <Link href={`${base}/categories`}>التصنيفات</Link>
          {" / "}
          {state.category.name}
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
        <CategoryForm
          key={`${state.category.id}:${state.category.name}:${state.category.slug}:${state.category.parent_id}:${state.category.sort_order}:${state.category.is_active}`}
          initial={{
            name: state.category.name,
            slug: state.category.slug,
            parent_id: state.category.parent_id,
            sort_order: state.category.sort_order,
            is_active: state.category.is_active === 1 ? 1 : 0,
          }}
          parents={state.parents}
          excludeId={state.category.id}
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
