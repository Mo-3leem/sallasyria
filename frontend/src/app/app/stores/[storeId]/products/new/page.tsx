"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { categoriesApi, productsApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import {
  ProductForm,
  type ProductFormValues,
} from "@/components/catalog/ProductForm";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import type { Category } from "@/types/api";

/** Create product (plan limit + slug conflicts handled inline). */
export default function NewProductPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const router = useRouter();
  const { refresh: refreshAuth } = useAuth();
  const [categories, setCategories] = useState<Category[]>([]);
  const [storeMissing, setStoreMissing] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await categoriesApi.list(storeId);
        if (cancelled) return;
        if (!res.ok) {
          if (getErrorCode(res) === "unauthorized") await refreshAuth();
          else if (getErrorCode(res) === "store_not_found") setStoreMissing(true);
          return;
        }
        setCategories(res.data.categories);
      } catch {
        // Category select stays empty — product can still be uncategorized.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, refreshAuth]);

  async function onSubmit(values: ProductFormValues) {
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await productsApi.create(storeId, values);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "category_not_found") {
          setFormError("المتجر غير موجود أو لا تملك صلاحية الوصول إليه.");
          return;
        }
        if (code === "subscription_inactive") {
          setFormError(
            "تعديل الكتالوج يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        if (code === "plan_limit") {
          setFormError("تم بلوغ حد المنتجات في خطتك.");
          return;
        }
        const fields = getFieldErrors(res);
        if (code === "slug_taken") {
          fields.slug =
            fields.slug || "هذا الرابط مستخدم بالفعل، اختر رابطًا آخر.";
          if (Object.keys(fields).length > 0) setFieldErrors(fields);
          return;
        }
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      router.push(`${base}/products/${encodeURIComponent(res.data.product.id)}`);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  if (storeMissing) {
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

  return (
    <>
      <BackButton href={`${base}/products`} />
      <div className="shell-page-head">
        <h1>إنشاء منتج</h1>
        <p>
          <Link href={`${base}/products`}>المنتجات</Link>
          {" / "}
          منتج جديد
        </p>
      </div>
      <div className="shell-card">
        <ProductForm
          initial={{
            name: "",
            slug: "",
            category_id: null,
            description: null,
            price: 0,
            stock_quantity: null,
            is_active: 1,
          }}
          categories={categories}
          submitLabel="إنشاء المنتج"
          submitting={submitting}
          fieldErrors={fieldErrors}
          formError={formError}
          onSubmit={onSubmit}
        />
      </div>
    </>
  );
}
