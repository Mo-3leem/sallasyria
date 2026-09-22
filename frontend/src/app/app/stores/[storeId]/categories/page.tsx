"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { categoriesApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import type { Category } from "@/types/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; categories: Category[] };

/** Store categories: list + delete (with detach flow on 409). */
export default function CategoriesPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingDelete, setPendingDelete] = useState<Category | null>(null);
  const [detachOffer, setDetachOffer] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    setState({ kind: "loading" });
    setActionError(null);
    try {
      const res = await categoriesApi.list(storeId);
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
          message: res.error.message || "تعذّر تحميل التصنيفات.",
        });
        return;
      }
      setState({ kind: "ready", categories: res.data.categories });
    } catch {
      setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function doDelete(category: Category, detach: boolean) {
    setDeleting(true);
    setActionError(null);
    try {
      const res = await categoriesApi.remove(storeId, category.id, detach);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found" || code === "category_not_found") {
          await load();
          return;
        }
        if (code === "subscription_inactive") {
          setActionError(
            "تعديل الكتالوج يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        if (code === "has_dependents" && !detach) {
          // Offer atomic detach instead of failing silently.
          setPendingDelete(null);
          setDetachOffer(category);
          return;
        }
        setActionError(authErrorMessage(res, 400));
        return;
      }
      setPendingDelete(null);
      setDetachOffer(null);
      await load();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setDeleting(false);
    }
  }

  const base = `/app/stores/${encodeURIComponent(storeId)}`;
  const parentName = (categories: Category[], id: string | null) =>
    id === null ? "—" : (categories.find((c) => c.id === id)?.name ?? "—");

  return (
    <>
      <div className="shell-page-head">
        <h1>التصنيفات</h1>
        <p>نظّم منتجات متجرك في تصنيفات رئيسية وفرعية.</p>
      </div>

      <div className="shell-card">
        {actionError && (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{actionError}</span>
          </div>
        )}
        {state.kind === "loading" ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري تحميل التصنيفات...
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
            title="تعذّر تحميل التصنيفات"
            description={state.message}
            action={
              <button type="button" className="btn btn-outline" onClick={load}>
                إعادة المحاولة
              </button>
            }
          />
        ) : state.categories.length === 0 ? (
          <EmptyState
            icon="fas fa-tags"
            title="لا توجد تصنيفات بعد"
            description="أنشئ تصنيفك الأول لتنظيم منتجاتك."
            action={
              <Link href={`${base}/categories/new`} className="btn btn-primary">
                <i className="fas fa-plus" aria-hidden="true"></i>
                إنشاء تصنيف
              </Link>
            }
          />
        ) : (
          <>
            <div className="shell-stack">
              {state.categories.map((category) => (
                <div key={category.id} className="store-row">
                  <span className="store-row-icon" aria-hidden="true">
                    <i className="fas fa-tag"></i>
                  </span>
                  <span className="store-row-body">
                    <span className="store-row-name">{category.name}</span>
                    <span className="store-row-meta">
                      <span dir="ltr">{category.slug}</span>
                      <span>·</span>
                      <span>الأب: {parentName(state.categories, category.parent_id)}</span>
                      <span>·</span>
                      <span>{category.is_active === 1 ? "نشط" : "غير نشط"}</span>
                    </span>
                  </span>
                  <span className="store-card-links">
                    <Link
                      href={`${base}/categories/${encodeURIComponent(category.id)}/edit`}
                      className="btn btn-ghost btn-shell-dark btn-sm"
                    >
                      تعديل
                    </Link>
                    <button
                      type="button"
                      className="btn btn-ghost btn-shell-dark btn-sm"
                      onClick={() => {
                        setActionError(null);
                        setPendingDelete(category);
                      }}
                    >
                      حذف
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16 }}>
              <Link href={`${base}/categories/new`} className="btn btn-outline">
                <i className="fas fa-plus" aria-hidden="true"></i>
                إنشاء تصنيف
              </Link>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف التصنيف؟"
        description={
          pendingDelete
            ? `سيتم حذف «${pendingDelete.name}» نهائياً. إذا كانت هناك منتجات أو تصنيفات فرعية مرتبطة به، سنعرض عليك فك ارتباطها أولاً.`
            : undefined
        }
        confirmLabel="حذف"
        confirming={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && doDelete(pendingDelete, false)}
      />

      <ConfirmDialog
        open={detachOffer !== null}
        title="التصنيف يحتوي منتجات أو تصنيفات فرعية."
        description="يمكن فك ارتباطها (تصبح بدون تصنيف/بدون أب) وحذف التصنيف في خطوة واحدة. لن تُحذف المنتجات نفسها."
        confirmLabel="فك الارتباط وحذف"
        confirming={deleting}
        onClose={() => {
          setDetachOffer(null);
          setPendingDelete(null);
        }}
        onConfirm={() => detachOffer && doDelete(detachOffer, true)}
      />
    </>
  );
}
