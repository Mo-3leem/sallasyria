"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { categoriesApi, productsApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import type { Category, Product } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; products: Product[]; categories: Category[] };

/** Store products (live + retired), retire/restore inline. */
export default function ProductsPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingRetire, setPendingRetire] = useState<Product | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  async function load() {
    setState({ kind: "loading" });
    setActionError(null);
    setActionNotice(null);
    try {
      const [prods, cats] = await Promise.all([
        productsApi.list(storeId),
        categoriesApi.list(storeId),
      ]);
      for (const res of [prods, cats]) {
        if (!res.ok && getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
      }
      if (!prods.ok) {
        if (getErrorCode(prods) === "store_not_found") {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "error",
          message: prods.error.message || "تعذّر تحميل المنتجات.",
        });
        return;
      }
      setState({
        kind: "ready",
        products: prods.data.products,
        categories: cats.ok ? cats.data.categories : [],
      });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  function subGate(): boolean {
    setActionError(
      "تعديل الكتالوج يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
    );
    return false;
  }

  async function doRetire(product: Product) {
    setWorking(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await productsApi.remove(storeId, product.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "product_not_found") {
          await load();
          return;
        }
        if (code === "subscription_inactive") {
          subGate();
          return;
        }
        setActionError(authErrorMessage(res, 400));
        return;
      }
      setPendingRetire(null);
      setActionNotice(`تمت أرشفة «${product.name}» — رابطه أصبح متاحاً لمنتج آخر.`);
      await load();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setWorking(false);
    }
  }

  async function doRestore(product: Product) {
    setWorking(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await productsApi.restore(storeId, product.id);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "product_not_found") {
          await load();
          return;
        }
        if (code === "subscription_inactive") {
          subGate();
          return;
        }
        if (code === "slug_taken") {
          // Partial-unique rule: rename first, then restore.
          setActionError(
            `تعذّر الاستعادة: يوجد منتج نشط بالرابط «${product.slug}». غيّر رابط هذا المنتج أولاً من صفحة التعديل ثم أعد الاستعادة.`
          );
          return;
        }
        setActionError(authErrorMessage(res, 400));
        return;
      }
      setActionNotice(`تمت استعادة «${product.name}».`);
      await load();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setWorking(false);
    }
  }

  const categoryName = (categories: Category[], id: string | null) =>
    id === null ? "بدون تصنيف" : (categories.find((c) => c.id === id)?.name ?? "—");

  return (
    <>
      <div className="shell-page-head">
        <h1>المنتجات</h1>
        <p>جميع منتجات المتجر بما فيها المؤرشفة.</p>
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
            جاري تحميل المنتجات...
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
            title="تعذّر تحميل المنتجات"
            description={state.message}
            action={
              <button type="button" className="btn btn-outline" onClick={load}>
                إعادة المحاولة
              </button>
            }
          />
        ) : state.products.length === 0 ? (
          <EmptyState
            icon="fas fa-box"
            title="لا توجد منتجات بعد"
            description="أنشئ منتجك الأول وابدأ البيع."
            action={
              <Link href={`${base}/products/new`} className="btn btn-primary">
                <i className="fas fa-plus" aria-hidden="true"></i>
                إنشاء منتج
              </Link>
            }
          />
        ) : (
          <>
            <div className="shell-stack">
              {state.products.map((product) => {
                const retired = product.deleted_at !== null;
                return (
                  <div key={product.id} className="store-row">
                    <span className="store-row-icon" aria-hidden="true">
                      <i className={`fas ${retired ? "fa-archive" : "fa-box"}`}></i>
                    </span>
                    <span className="store-row-body">
                      <span className="store-row-name">
                        <Link href={`${base}/products/${encodeURIComponent(product.id)}`}>
                          {product.name}
                        </Link>{" "}
                        {retired && <span className="sub-badge sub-badge-unknown">أرشيف</span>}
                        {product.is_active !== 1 && !retired && (
                          <span className="sub-badge sub-badge-inactive">غير نشط</span>
                        )}
                      </span>
                      <span className="store-row-meta">
                        <span dir="ltr">{product.slug}</span>
                        <span>·</span>
                        <span>{product.price.toLocaleString("ar-SY")} قرش</span>
                        <span>·</span>
                        <span>
                          {product.stock_quantity === null
                            ? "مخزون غير متتبع"
                            : `المخزون: ${product.stock_quantity.toLocaleString("ar-SY")}`}
                        </span>
                        <span>·</span>
                        <span>{categoryName(state.categories, product.category_id)}</span>
                      </span>
                    </span>
                    <span className="store-card-links">
                      <Link
                        href={`${base}/products/${encodeURIComponent(product.id)}/edit`}
                        className="btn btn-ghost btn-shell-dark btn-sm"
                      >
                        تعديل
                      </Link>
                      {retired ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          disabled={working}
                          onClick={() => doRestore(product)}
                        >
                          استعادة
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          onClick={() => {
                            setActionError(null);
                            setActionNotice(null);
                            setPendingRetire(product);
                          }}
                        >
                          أرشفة
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 16 }}>
              <Link href={`${base}/products/new`} className="btn btn-outline">
                <i className="fas fa-plus" aria-hidden="true"></i>
                إنشاء منتج
              </Link>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingRetire !== null}
        title="أرشفة المنتج؟"
        description={
          pendingRetire
            ? `سيتم أرشفة «${pendingRetire.name}»: يختفي من البيع ويصبح رابطه متاحاً، مع بقاء سجل الطلبات سليماً. يمكن استعادته لاحقاً.`
            : undefined
        }
        confirmLabel="أرشفة"
        confirming={working}
        onClose={() => setPendingRetire(null)}
        onConfirm={() => pendingRetire && doRetire(pendingRetire)}
      />
    </>
  );
}
