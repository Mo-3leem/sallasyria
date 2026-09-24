"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { categoriesApi, productImagesApi, productsApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import {
  ImageForm,
  type ImageFormValues,
} from "@/components/catalog/ImageForm";
import type { Category, Product, ProductImage } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | {
      kind: "ready";
      product: Product;
      categories: Category[];
      images: ProductImage[];
    };

/** Product detail + image gallery (https attach only, URLs rendered as-is). */
export default function ProductDetailPage({
  params,
}: {
  params: { storeId: string; id: string };
}) {
  const { storeId, id } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [showAttach, setShowAttach] = useState(false);
  const [editingImage, setEditingImage] = useState<ProductImage | null>(null);
  const [pendingRetire, setPendingRetire] = useState<ProductImage | null>(null);
  const [imgFields, setImgFields] = useState<Record<string, string>>({});
  const [imgError, setImgError] = useState<string | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  async function load() {
    setState({ kind: "loading" });
    try {
      const [got, listed, imgs] = await Promise.all([
        productsApi.get(storeId, id),
        categoriesApi.list(storeId),
        productImagesApi.list(storeId, id),
      ]);
      for (const res of [got, listed, imgs]) {
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
        // Image list itself may 400 (missing product_id is impossible here)
        // or 404 while the product was just retired — degrade gracefully.
        images: imgs.ok ? imgs.data.images : [],
      });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, id]);

  function subGate(): null {
    setImgError(
      "تعديل الكتالوج يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
    );
    return null;
  }

  async function refreshImages(): Promise<boolean> {
    try {
      const res = await productImagesApi.list(storeId, id);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return false;
        }
        setImgError(authErrorMessage(res, 400));
        return false;
      }
      setState((prev) =>
        prev.kind === "ready" ? { ...prev, images: res.data.images } : prev
      );
      return true;
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
      return false;
    }
  }

  async function onAttach(values: ImageFormValues) {
    if (imgBusy) return;
    setImgFields({});
    setImgError(null);
    setImgBusy(true);
    try {
      const res = await productImagesApi.create(storeId, {
        product_id: id,
        ...values,
      });
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "product_not_found") {
          setImgError("المنتج غير موجود أو لا تملك صلاحية الوصول إليه.");
          return;
        }
        if (code === "subscription_inactive") {
          subGate();
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setImgFields(fields);
        setImgError(authErrorMessage(res, 400));
        return;
      }
      setShowAttach(false);
      await refreshImages();
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
    } finally {
      setImgBusy(false);
    }
  }

  async function onEditImage(image: ProductImage, values: ImageFormValues) {
    if (imgBusy) return;
    setImgFields({});
    setImgError(null);
    setImgBusy(true);
    try {
      // Partial edit: send url/alt/sort as provided by the form.
      const res = await productImagesApi.update(storeId, image.id, values);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (
          code === "store_not_found" ||
          code === "product_not_found" ||
          code === "image_not_found"
        ) {
          setImgError("الصورة غير موجودة — حدّث الصفحة وحاول مجدداً.");
          await refreshImages();
          return;
        }
        if (code === "subscription_inactive") {
          subGate();
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setImgFields(fields);
        setImgError(authErrorMessage(res, 400));
        return;
      }
      setEditingImage(null);
      await refreshImages();
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
    } finally {
      setImgBusy(false);
    }
  }

  async function doRetireImage(image: ProductImage) {
    setImgBusy(true);
    setImgError(null);
    setActionError(null);
    try {
      const res = await productImagesApi.remove(storeId, image.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "subscription_inactive") {
          subGate();
          return;
        }
        setImgError(authErrorMessage(res, 400));
        return;
      }
      setPendingRetire(null);
      await refreshImages();
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
    } finally {
      setImgBusy(false);
    }
  }

  async function doRestoreImage(image: ProductImage) {
    setImgBusy(true);
    setImgError(null);
    try {
      const res = await productImagesApi.restore(storeId, image.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "subscription_inactive") {
          subGate();
          return;
        }
        setImgError(authErrorMessage(res, 400));
        return;
      }
      await refreshImages();
    } catch {
      setImgError(NETWORK_ERROR_MESSAGE);
    } finally {
      setImgBusy(false);
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

  const { product, categories, images } = state;
  const retired = product.deleted_at !== null;
  const categoryName =
    product.category_id === null
      ? "بدون تصنيف"
      : (categories.find((c) => c.id === product.category_id)?.name ?? "—");
  const liveImages = images.filter((i) => i.deleted_at === null);
  const retiredImages = images.filter((i) => i.deleted_at !== null);

  return (
    <>
      <BackButton href={`${base}/products`} />
      <div className="shell-page-head">
        <h1>{product.name}</h1>
        <p>
          <Link href={`${base}/products`}>المنتجات</Link>
          {" / "}
          <span dir="ltr">{product.slug}</span>
          {retired && product.removed_at === null && (
            <>
              {" · "}
              <span className="sub-badge sub-badge-unknown">أرشيف</span>
            </>
          )}
          {product.removed_at !== null && (
            <>
              {" · "}
              <span className="sub-badge sub-badge-inactive">محذوف</span>
            </>
          )}
        </p>
      </div>

      {actionError && (
        <div className="shell-error" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>{actionError}</span>
        </div>
      )}

      <div className="shell-card">
        <h2 className="shell-card-title">بيانات المنتج</h2>
        <div className="info-row">
          <span className="key">السعر</span>
          <span className="value">{product.price.toLocaleString("ar-SY")} قرش</span>
        </div>
        <div className="info-row">
          <span className="key">المخزون</span>
          <span className="value">
            {product.stock_quantity === null
              ? "غير متتبع"
              : product.stock_quantity.toLocaleString("ar-SY")}
          </span>
        </div>
        <div className="info-row">
          <span className="key">التصنيف</span>
          <span className="value">{categoryName}</span>
        </div>
        <div className="info-row">
          <span className="key">الحالة</span>
          <span className="value">
            {retired ? "مؤرشف" : product.is_active === 1 ? "نشط" : "غير نشط"}
          </span>
        </div>
        {!retired && (
          <div style={{ marginTop: 16 }}>
            <Link
              href={`${base}/products/${encodeURIComponent(product.id)}/edit`}
              className="btn btn-outline"
            >
              تعديل المنتج
            </Link>
          </div>
        )}
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">صور المنتج</h2>
        {imgError && (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{imgError}</span>
          </div>
        )}
        {liveImages.length === 0 && retiredImages.length === 0 && !showAttach ? (
          <EmptyState
            icon="fas fa-image"
            title="لا توجد صور بعد"
            description="أرفق صورة عبر رابط https مباشر."
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowAttach(true)}
              >
                <i className="fas fa-plus" aria-hidden="true"></i>
                إرفاق صورة
              </button>
            }
          />
        ) : (
          <>
            <div className="shell-stack">
              {[...liveImages, ...retiredImages]
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((image) => {
                  const imgRetired = image.deleted_at !== null;
                  const isEditing = editingImage?.id === image.id;
                  return (
                    <div key={image.id} className="store-row">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={image.url}
                        alt={image.alt_text ?? product.name}
                        className="gallery-thumb"
                        loading="lazy"
                      />
                      <span className="store-row-body">
                        <span className="store-row-name" dir="ltr">
                          {image.alt_text ?? "بدون وصف"}
                        </span>
                        <span className="store-row-meta">
                          <span>الترتيب: {image.sort_order.toLocaleString("ar-SY")}</span>
                          {imgRetired && (
                            <>
                              <span>·</span>
                              <span className="sub-badge sub-badge-unknown">أرشيف</span>
                            </>
                          )}
                        </span>
                        {isEditing && (
                          <span style={{ marginTop: 12, display: "block" }}>
                            <ImageForm
                              initial={{
                                url: image.url,
                                alt_text: image.alt_text,
                                sort_order: image.sort_order,
                              }}
                              submitLabel="حفظ الصورة"
                              submitting={imgBusy}
                              fieldErrors={imgFields}
                              formError={null}
                              onSubmit={(v) => onEditImage(image, v)}
                            />
                            <button
                              type="button"
                              className="btn btn-ghost btn-shell-dark btn-sm"
                              style={{ marginTop: 8 }}
                              onClick={() => {
                                setEditingImage(null);
                                setImgFields({});
                              }}
                            >
                              إلغاء التعديل
                            </button>
                          </span>
                        )}
                      </span>
                      {!isEditing && (
                        <span className="store-card-links">
                          {!imgRetired && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-shell-dark btn-sm"
                              disabled={imgBusy}
                              onClick={() => {
                                setImgFields({});
                                setImgError(null);
                                setEditingImage(image);
                              }}
                            >
                              تعديل
                            </button>
                          )}
                          {imgRetired ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-shell-dark btn-sm"
                              disabled={imgBusy}
                              onClick={() => doRestoreImage(image)}
                            >
                              استعادة
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost btn-shell-dark btn-sm"
                              onClick={() => setPendingRetire(image)}
                            >
                              أرشفة
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
            {!showAttach && (
              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    setImgFields({});
                    setImgError(null);
                    setShowAttach(true);
                  }}
                >
                  <i className="fas fa-plus" aria-hidden="true"></i>
                  إرفاق صورة
                </button>
              </div>
            )}
          </>
        )}
        {showAttach && (
          <div style={{ marginTop: 16 }}>
            <ImageForm
              initial={{ url: "", alt_text: null, sort_order: images.length }}
              submitLabel="إرفاق الصورة"
              submitting={imgBusy}
              fieldErrors={imgFields}
              formError={null}
              onSubmit={onAttach}
            />
            <button
              type="button"
              className="btn btn-ghost btn-shell-dark btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                setShowAttach(false);
                setImgFields({});
              }}
            >
              إلغاء
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingRetire !== null}
        title="أرشفة الصورة؟"
        description="سيتم أرشفة الصورة بدل حذفها نهائياً، ويمكن استعادتها لاحقاً."
        confirmLabel="أرشفة"
        confirming={imgBusy}
        onClose={() => setPendingRetire(null)}
        onConfirm={() => {
          if (pendingRetire) {
            const img = pendingRetire;
            setPendingRetire(null);
            doRetireImage(img);
          }
        }}
      />
    </>
  );
}
