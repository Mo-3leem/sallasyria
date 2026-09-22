"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { EmptyState } from "@/components/common/EmptyState";
import type { Category } from "@/types/api";

/** Create category (subscription-gated write, honest 403 message). */
export default function NewCategoryPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const router = useRouter();
  const { refresh: refreshAuth } = useAuth();
  const [parents, setParents] = useState<Category[]>([]);
  const [parentsFailed, setParentsFailed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await categoriesApi.list(storeId);
        if (!cancelled && res.ok) setParents(res.data.categories);
        if (!cancelled && !res.ok) {
          if (getErrorCode(res) === "unauthorized") await refreshAuth();
          else setParentsFailed(true);
        }
      } catch {
        if (!cancelled) setParentsFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, refreshAuth]);

  async function onSubmit(values: CategoryFormValues) {
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await categoriesApi.create(storeId, values);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "parent_not_found") {
          setFormError(
            code === "parent_not_found"
              ? "التصنيف الأب غير موجود — حدّث الصفحة وحاول مجدداً."
              : "المتجر غير موجود أو لا تملك صلاحية الوصول إليه."
          );
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
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      router.push(`${base}/categories`);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>إنشاء تصنيف</h1>
        <p>
          <Link href={`${base}/categories`}>التصنيفات</Link>
          {" / "}
          تصنيف جديد
        </p>
      </div>
      <div className="shell-card">
        {parentsFailed && (
          <div className="shell-notice" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-info-circle" aria-hidden="true"></i>
            <span>تعذّر تحميل قائمة التصنيفات الأب — يمكنك المتابعة بدون أب.</span>
          </div>
        )}
        <CategoryForm
          initial={{ name: "", slug: "", parent_id: null, sort_order: 0, is_active: 1 }}
          parents={parents}
          submitLabel="إنشاء التصنيف"
          submitting={submitting}
          fieldErrors={fieldErrors}
          formError={formError}
          onSubmit={onSubmit}
        />
      </div>
    </>
  );
}
