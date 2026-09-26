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

  // Background re-sync after a reorder: never flashes the loader and never
  // clears a just-set action error; returns whether the server state applied.
  async function loadQuiet(): Promise<boolean> {
    try {
      const res = await categoriesApi.list(storeId);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") await refreshAuth();
        return false;
      }
      setState({ kind: "ready", categories: res.data.categories });
      return true;
    } catch {
      return false;
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

  // ---- Visual ordering (drag and drop + touch movers) ----
  // The server returns siblings ordered by (sort_order, created_at); groups
  // below preserve that order. Reordering never changes parent_id — only
  // positions within one sibling list. Persistence reuses PATCH sort_order
  // (one batch per drop, changed rows only, then a quiet re-sync).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const allCategories = state.kind === "ready" ? state.categories : [];
  const roots = allCategories.filter((c) => c.parent_id === null);
  const childrenOf = (pid: string) => allCategories.filter((c) => c.parent_id === pid);
  const dragged =
    dragId !== null ? (allCategories.find((c) => c.id === dragId) ?? null) : null;
  const shownIds = new Set<string>();
  roots.forEach((r) => {
    shownIds.add(r.id);
    childrenOf(r.id).forEach((ch) => shownIds.add(ch.id));
  });
  const orphans = allCategories.filter((c) => !shownIds.has(c.id));

  function moveBefore(siblings: Category[], fromId: string, toId: string): Category[] {
    const moved = siblings.find((c) => c.id === fromId);
    if (!moved) return siblings;
    const next = siblings.filter((c) => c.id !== fromId);
    const to = next.findIndex((c) => c.id === toId);
    next.splice(to < 0 ? next.length : to, 0, moved);
    return next;
  }

  function moveBy(siblings: Category[], id: string, delta: -1 | 1): Category[] {
    const from = siblings.findIndex((c) => c.id === id);
    const to = from + delta;
    const moved = from >= 0 ? siblings[from] : undefined;
    if (from < 0 || to < 0 || to >= siblings.length || moved === undefined) return siblings;
    const next = siblings.filter((c) => c.id !== id);
    next.splice(to, 0, moved);
    return next;
  }

  async function persistOrder(ordered: Category[]) {
    if (state.kind !== "ready" || savingOrder) return;
    const current = new Map(state.categories.map((c) => [c.id, c.sort_order]));
    const changed = ordered
      .map((c, i) => ({ id: c.id, sort: i }))
      .filter((x) => current.get(x.id) !== x.sort);
    // Optimistic: show the new order immediately.
    setState((prev) =>
      prev.kind === "ready"
        ? {
            ...prev,
            categories: prev.categories.map((c) => {
              const pos = ordered.findIndex((o) => o.id === c.id);
              return pos >= 0 ? { ...c, sort_order: pos } : c;
            }),
          }
        : prev
    );
    if (changed.length === 0) return;
    setSavingOrder(true);
    setActionError(null);
    try {
      const results = await Promise.all(
        changed.map((x) => categoriesApi.update(storeId, x.id, { sort_order: x.sort }))
      );
      for (const res of results) {
        if (res.ok) continue;
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          throw new Error("auth");
        }
        if (code === "subscription_inactive") throw new Error("sub");
        if (code === "store_not_found" || code === "category_not_found") throw new Error("missing");
        throw new Error("save");
      }
      await loadQuiet();
    } catch (e) {
      if (e instanceof Error && e.message === "sub") {
        setActionError("تعديل الكتالوج يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة.");
      } else if (!(e instanceof Error && e.message === "auth")) {
        setActionError("تعذّر حفظ الترتيب. أُعيد تحميل الترتيب المحفوظ.");
      }
      await loadQuiet();
    } finally {
      setSavingOrder(false);
      setDragId(null);
      setDropId(null);
    }
  }

  function renderCategoryRow(category: Category, siblings: Category[]) {
    const sortable = siblings.length > 1 && !savingOrder;
    const isDragging = dragId === category.id;
    const isDropTarget = dropId === category.id;
    const canDrop =
      dragged !== null && dragged.parent_id === category.parent_id && dragged.id !== category.id;
    return (
      <div
        key={category.id}
        className={`store-row cat-row${isDragging ? " cat-row-dragging" : ""}${isDropTarget && canDrop ? " cat-row-drop" : ""}`}
        onDragOver={(e) => {
          if (!canDrop) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropId(category.id);
        }}
        onDragLeave={() => {
          if (dropId === category.id) setDropId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!canDrop || !dragged) return;
          void persistOrder(moveBefore(siblings, dragged.id, category.id));
        }}
      >
        <span
          className="cat-handle"
          aria-hidden="true"
          draggable={sortable}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", category.id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(category.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropId(null);
          }}
        >
          <i className="fas fa-grip-vertical" aria-hidden="true"></i>
        </span>
        <span className="store-row-icon" aria-hidden="true">
          <i className="fas fa-tag"></i>
        </span>
        <span className="store-row-body">
          <span className="store-row-name">{category.name}</span>
          <span className="store-row-meta">
            <span dir="ltr">{category.slug}</span>
            <span>·</span>
            <span>الأب: {parentName(allCategories, category.parent_id)}</span>
            <span>·</span>
            <span>{category.is_active === 1 ? "نشط" : "غير نشط"}</span>
          </span>
        </span>
        <span className="cat-movers" role="group" aria-label="تحريك الترتيب">
          <button
            type="button"
            className="btn btn-ghost btn-shell-dark btn-sm"
            aria-label={`تحريك ${category.name} للأعلى`}
            disabled={savingOrder}
            onClick={() => void persistOrder(moveBy(siblings, category.id, -1))}
          >
            <i className="fas fa-chevron-up" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-shell-dark btn-sm"
            aria-label={`تحريك ${category.name} للأسفل`}
            disabled={savingOrder}
            onClick={() => void persistOrder(moveBy(siblings, category.id, 1))}
          >
            <i className="fas fa-chevron-down" aria-hidden="true"></i>
          </button>
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
    );
  }

  function renderEndDrop(groupKey: string, siblings: Category[]) {
    if (!dragged || savingOrder) return null;
    const groupParent = groupKey === "roots" ? null : groupKey;
    if (dragged.parent_id !== groupParent) return null;
    const active = dropId === `end:${groupKey}`;
    return (
      <div
        className={`cat-end-drop${active ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropId(`end:${groupKey}`);
        }}
        onDragLeave={() => {
          if (dropId === `end:${groupKey}`) setDropId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const next = siblings.filter((c) => c.id !== dragged.id);
          next.push(dragged);
          void persistOrder(next);
        }}
      >
        <span>أفلت هنا للنقل إلى النهاية</span>
      </div>
    );
  }

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
            {savingOrder && (
              <p className="shell-note" role="status" style={{ marginBottom: 12 }}>
                جاري حفظ الترتيب...
              </p>
            )}
            <div className="shell-stack">
              {roots.map((root) => {
                const kids = childrenOf(root.id);
                return (
                  <div key={root.id} className="cat-group">
                    {renderCategoryRow(root, roots)}
                    {kids.map((child) => (
                      <div key={child.id} className="cat-child">
                        {renderCategoryRow(child, kids)}
                      </div>
                    ))}
                    {renderEndDrop(root.id, kids)}
                  </div>
                );
              })}
              {renderEndDrop("roots", roots)}
              {orphans.map((orphan) => renderCategoryRow(orphan, [orphan]))}
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
