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
import { BackButton } from "@/components/common/BackButton";
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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived" | "deleted">("all");
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);

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

  async function doDelete(product: Product) {
    setWorking(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await productsApi.deleteProduct(storeId, product.id);
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
      setPendingDelete(null);
      setActionNotice(`تم حذف «${product.name}» من الكتالوج — بيانات الطلبات السابقة محفوظة.`);
      await load();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setWorking(false);
    }
  }

  const categoryName = (categories: Category[], id: string | null) =>
    id === null ? "بدون تصنيف" : (categories.find((c) => c.id === id)?.name ?? "—");

  // Client-side search + status filter over the already-loaded list (no extra
  // API calls). Active = live row; archived = retired (deleted_at set,
  // removed_at unset); deleted = business-removed (removed_at set).
  const readyProducts = state.kind === "ready" ? state.products : [];
  const needle = query.trim().toLowerCase();
  const matched = readyProducts.filter(
    (p) =>
      (statusFilter === "all" ||
        (statusFilter === "active"
          ? p.deleted_at === null && p.removed_at === null
          : statusFilter === "archived"
            ? p.deleted_at !== null && p.removed_at === null
            : p.removed_at !== null)) &&
      (needle === "" || p.name.toLowerCase().includes(needle))
  );
  const activeVisible = matched.filter((p) => p.deleted_at === null && p.removed_at === null);
  const archivedVisible = matched.filter((p) => p.deleted_at !== null && p.removed_at === null);
  const deletedVisible = matched.filter((p) => p.removed_at !== null);
  const showActiveSection = statusFilter !== "archived" && statusFilter !== "deleted" && activeVisible.length > 0;
  const showArchivedSection =
    statusFilter !== "active" && statusFilter !== "deleted" && archivedVisible.length > 0;
  const showDeletedSection = statusFilter !== "active" && statusFilter !== "archived" && deletedVisible.length > 0;

  function renderProductRow(product: Product, categories: Category[]) {
    const retired = product.deleted_at !== null;
    const removed = product.removed_at !== null;
    const askDelete = () => {
      setActionError(null);
      setActionNotice(null);
      setPendingDelete(product);
    };
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
            {retired && !removed && <span className="sub-badge sub-badge-unknown">أرشيف</span>}
            {removed && <span className="sub-badge sub-badge-inactive">محذوف</span>}
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
            <span>{categoryName(categories, product.category_id)}</span>
          </span>
        </span>
        <span className="store-card-links">
          <Link
            href={`${base}/products/${encodeURIComponent(product.id)}/edit`}
            className="btn btn-ghost btn-shell-dark btn-sm"
          >
            تعديل
          </Link>
          {removed ? (
            <button
              type="button"
              className="btn btn-ghost btn-shell-dark btn-sm"
              disabled={working}
              onClick={() => doRestore(product)}
            >
              استعادة
            </button>
          ) : retired ? (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-shell-dark btn-sm"
                disabled={working}
                onClick={() => doRestore(product)}
              >
                استعادة
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-shell-dark btn-sm"
                onClick={askDelete}
              >
                حذف
              </button>
            </>
          ) : (
            <>
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
              <button
                type="button"
                className="btn btn-ghost btn-shell-dark btn-sm"
                onClick={askDelete}
              >
                حذف
              </button>
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <>
      <BackButton href={`${base}/settings`} label="العودة إلى إعدادات المتجر" />
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
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <input
                type="search"
                className="auth-input"
                style={{ flex: "1 1 200px" }}
                placeholder="ابحث عن منتج..."
                aria-label="ابحث عن منتج"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                <span>الحالة:</span>
                <select
                  className="auth-input"
                  style={{ width: "auto" }}
                  aria-label="الحالة"
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as "all" | "active" | "archived" | "deleted")
                  }
                >
                  <option value="all">الكل</option>
                  <option value="active">نشطة</option>
                  <option value="archived">مؤرشفة</option>
                  <option value="deleted">محذوفة</option>
                </select>
              </label>
              <Link href={`${base}/products/new`} className="btn btn-primary">
                <i className="fas fa-plus" aria-hidden="true"></i>
                إضافة منتج
              </Link>
            </div>
            {matched.length === 0 ? (
              <EmptyState
                icon="fas fa-search"
                title="لا توجد منتجات مطابقة للفلاتر الحالية."
                description="المتجر يحتوي على منتجات، لكن لا شيء منها يطابق البحث أو فلتر الحالة الحالي."
                action={
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => {
                      setQuery("");
                      setStatusFilter("all");
                    }}
                  >
                    مسح الفلاتر
                  </button>
                }
              />
            ) : (
              <>
            {showActiveSection && (
              <div className="shell-stack">
                {activeVisible.map((product) =>
                  renderProductRow(product, state.categories)
                )}
              </div>
            )}
            {showActiveSection && showArchivedSection && (
              <hr
                aria-hidden="true"
                style={{
                  border: "none",
                  borderTop: "1px solid var(--gray-5)",
                  margin: "20px 0 4px",
                }}
              />
            )}
            {showArchivedSection && (
              <>
                <h2 className="shell-card-title" style={{ marginTop: showActiveSection ? 12 : 0 }}>
                  المنتجات المؤرشفة
                </h2>
                <div className="shell-stack">
                  {archivedVisible.map((product) =>
                    renderProductRow(product, state.categories)
                  )}
                </div>
              </>
            )}
            {(showActiveSection || showArchivedSection) && showDeletedSection && (
              <hr
                aria-hidden="true"
                style={{
                  border: "none",
                  borderTop: "1px solid var(--gray-5)",
                  margin: "20px 0 4px",
                }}
              />
            )}
            {showDeletedSection && (
              <>
                <h2 className="shell-card-title" style={{ marginTop: showActiveSection || showArchivedSection ? 12 : 0 }}>
                  المنتجات المحذوفة
                </h2>
                <div className="shell-stack">
                  {deletedVisible.map((product) =>
                    renderProductRow(product, state.categories)
                  )}
                </div>
              </>
            )}
              </>
            )}
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

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف المنتج"
        description={
          pendingDelete
            ? `هل أنت متأكد من حذف «${pendingDelete.name}»؟ سيتم إخفاء المنتج من الكتالوج والمتجر، ولن يتم حذف بيانات الطلبات السابقة المرتبطة به.`
            : undefined
        }
        confirmLabel="حذف المنتج"
        cancelLabel="تراجع"
        confirming={working}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && doDelete(pendingDelete)}
      />
    </>
  );
}
