"use client";

import Link from "next/link";
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
import { EmptyState } from "@/components/common/EmptyState";
import type { Category, Product } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; product: Product; categories: Category[] };

/** Edit product: diff-only PATCH, unchanged shows "no changes". */
export default function EditProductPage({
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
          productsApi.get(storeId, id),
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
          if (code === "store_not_found" || code === "product_not_found") {
            setState({ kind: "missing" });
            return;
          }
          setState({
            kind: "error",
            message: got.error.message || "تعذّر تحميل المنتج.",
          });
          return;
        }
        setState({
          kind: "ready",
          product: got.data.product,
          categories: listed.ok ? listed.data.categories : [],
        });
      } catch {
        if (!cancelled) setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, id, refreshAuth]);

  async function onSubmit(values: ProductFormValues) {
    if (state.kind !== "ready" || submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);
    setNoChanges(false);
    const diff: {
      name?: string;
      slug?: string;
      category_id?: string | null;
      price?: number;
      stock_quantity?: number | null;
      is_active?: 0 | 1;
    } = {};
    if (values.name !== state.product.name) diff.name = values.name;
    if (values.slug !== state.product.slug) diff.slug = values.slug;
    if (values.category_id !== state.product.category_id)
      diff.category_id = values.category_id;
    if (values.price !== state.product.price) diff.price = values.price;
    if (values.stock_quantity !== state.product.stock_quantity)
      diff.stock_quantity = values.stock_quantity;
    if (values.is_active !== state.product.is_active)
      diff.is_active = values.is_active;
    if (Object.keys(diff).length === 0) {
      setNoChanges(true);
      return;
    }
    setSubmitting(true);
    try {
      const res = await productsApi.update(storeId, id, diff);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "product_not_found") {
          setState({ kind: "missing" });
          return;
        }
        if (code === "subscription_inactive") {
          setFormError(
            "تعديل الكتالوج يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        if (code === "category_not_found") {
          setFormError("التصنيف المختار غير موجود — حدّث الصفحة وحاول مجدداً.");
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
      setState({
        kind: "ready",
        product: res.data.product,
        categories: state.categories,
      });
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
        جاري تحميل المنتج...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="المنتج غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href={`${base}/products`} className="btn btn-primary">
              العودة إلى المنتجات
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
          title="تعذّر تحميل المنتج"
          description={state.message}
          action={
            <Link href={`${base}/products`} className="btn btn-outline">
              العودة إلى المنتجات
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>تعديل المنتج</h1>
        <p>
          <Link href={`${base}/products`}>المنتجات</Link>
          {" / "}
          {state.product.name}
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
        <ProductForm
          key={`${state.product.id}:${state.product.name}:${state.product.slug}:${state.product.category_id}:${state.product.price}:${state.product.stock_quantity}:${state.product.is_active}`}
          initial={{
            name: state.product.name,
            slug: state.product.slug,
            category_id: state.product.category_id,
            price: state.product.price,
            stock_quantity: state.product.stock_quantity,
            is_active: state.product.is_active === 1 ? 1 : 0,
          }}
          categories={state.categories}
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
