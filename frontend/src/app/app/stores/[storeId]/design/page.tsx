"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { categoriesApi, productsApi, themeApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { BackButton } from "@/components/common/BackButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { BuilderToolbar, type Viewport } from "@/components/design/BuilderToolbar";
import { ToolsPanel } from "@/components/design/ToolsPanel";
import { PropsPanel } from "@/components/design/PropsPanel";
import type { Selection } from "@/components/design/selection";
import { StoreHomeView } from "@/components/shop/StoreHomeView";
import type { HomeSectionCategory, HomeSectionProduct } from "@/components/shop/StoreHomeSections";
import {
  coerceTheme,
  DEFAULT_THEME,
  themeToPayload,
  type StoreTheme,
  type ThemeSection,
} from "@/lib/theme-design";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready" };

/**
 * Visual store builder: tools panel, live draft preview (shared storefront
 * render), properties panel. Draft autosaves debounced; publish is manual
 * and audited; guest preview opens a signed token URL in a new tab.
 */
export default function DesignPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const { stores } = useStores();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState<StoreTheme>(DEFAULT_THEME);
  const [savedJson, setSavedJson] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [issuingPreview, setIssuingPreview] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [mobilePanel, setMobilePanel] = useState<null | "tools" | "props">(null);
  const [catalog, setCatalog] = useState<{
    categories: HomeSectionCategory[];
    products: HomeSectionProduct[];
    error: boolean;
  }>({ categories: [], products: [], error: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;
  const store = stores.find((s) => s.id === storeId);
  const storeName = store?.name ?? "متجرك";
  const currency = store?.currency ?? "SYP";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await themeApi.get(storeId);
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
          setState({ kind: "error", message: res.error.message || "تعذّر تحميل التصميم." });
          return;
        }
        const loaded = coerceTheme(res.data.theme.draft);
        setDraft(loaded);
        setSavedJson(JSON.stringify(themeToPayload(loaded)));
        setPublishedAt(res.data.theme.published_at);
        setState({ kind: "ready" });
      } catch {
        if (!cancelled) setState({ kind: "error", message: NETWORK_ERROR_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, refreshAuth]);

  const loadCatalog = useCallback(async () => {
    try {
      const cats = await categoriesApi.list(storeId);
      // Products are offset-paginated: walk every page so the picker sees
      // the complete live catalog. Termination comes from the server echo
      // (total_pages); ids are deduplicated defensively against concurrent
      // inserts shifting page boundaries mid-walk.
      const seen = new Map<
        string,
        {
          id: string;
          name: string;
          slug: string;
          price: number;
          stock_quantity: number | null;
          is_active: number;
          deleted_at: string | null;
          removed_at: string | null;
        }
      >();
      let page = 1;
      let totalPages = 1;
      do {
        const prods = await productsApi.list(storeId, { page });
        if (!prods.ok) {
          if (getErrorCode(prods) === "unauthorized") {
            await refreshAuth();
            return;
          }
          setCatalog((c) => ({ ...c, error: true }));
          return;
        }
        for (const p of prods.data.products) {
          if (!seen.has(p.id)) {
            seen.set(p.id, {
              id: p.id,
              name: p.name,
              slug: p.slug,
              price: p.price,
              stock_quantity: p.stock_quantity,
              is_active: p.is_active,
              deleted_at: p.deleted_at,
              removed_at: p.removed_at,
            });
          }
        }
        totalPages = prods.data.pagination.total_pages;
        page += 1;
      } while (page <= totalPages);
      if (!cats.ok) {
        setCatalog((c) => ({ ...c, error: true }));
        return;
      }
      setCatalog({
        categories: cats.data.categories
          .filter((c) => c.is_active === 1)
          .map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
        products: [...seen.values()]
          .filter((p) => p.is_active === 1 && p.deleted_at === null && p.removed_at === null)
          .map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            price: p.price,
            stock_quantity: p.stock_quantity,
          })),
        error: false,
      });
    } catch {
      setCatalog((c) => ({ ...c, error: true }));
    }
  }, [storeId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  async function saveNow(current: StoreTheme, baseline: string): Promise<boolean> {
    const payload = themeToPayload(current);
    if (JSON.stringify(payload) === baseline) return true;
    setSaveState("saving");
    setFormError(null);
    try {
      const res = await themeApi.update(storeId, payload);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          setSaveState("error");
          return false;
        }
        if (code === "subscription_inactive") {
          setFormError("تعديل التصميم يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة.");
        } else {
          const fields = getFieldErrors(res);
          setFormError(Object.values(fields)[0] ?? authErrorMessage(res, 400));
        }
        setSaveState("error");
        return false;
      }
      setSavedJson(JSON.stringify(themeToPayload(coerceTheme(res.data.theme.draft))));
      setSaveState("saved");
      return true;
    } catch {
      setSaveState("error");
      setFormError(NETWORK_ERROR_MESSAGE);
      return false;
    }
  }

  function scheduleSave(next: StoreTheme) {
    setDraft(next);
    setSaveState("dirty");
    setNotice(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void saveNow(next, savedJson);
    }, 1500);
  }

  /** All panel mutations flow through here (single autosave pipeline). */
  function patch(mut: (d: StoreTheme) => StoreTheme) {
    scheduleSave(mut(draft));
  }

  function moveSection(from: number, to: number) {
    if (to < 0) return;
    patch((d) => {
      const sections = [...d.sections].sort((a, b) => a.order - b.order);
      if (to >= sections.length) return d;
      const [moved] = sections.splice(from, 1);
      if (!moved) return d;
      sections.splice(to, 0, moved);
      return { ...d, sections: sections.map((s, i) => ({ ...s, order: i })) };
    });
  }

  function updateSectionAt(index: number, mut: (s: ThemeSection) => ThemeSection) {
    patch((d) => {
      const current = [...d.sections].sort((a, b) => a.order - b.order);
      const target = current[index];
      if (!target) return d;
      return {
        ...d,
        sections: d.sections.map((s) => (s === target ? mut({ ...s }) : s)),
      };
    });
  }

  async function doPublish() {
    if (publishing) return;
    setPublishing(true);
    setFormError(null);
    setNotice(null);
    try {
      const okSaved = await saveNow(draft, savedJson);
      if (!okSaved) return;
      const published = await themeApi.publish(storeId);
      if (!published.ok) {
        const code = getErrorCode(published);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "subscription_inactive") {
          setFormError("النشر يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة.");
          return;
        }
        setFormError(authErrorMessage(published, 400));
        return;
      }
      setPublishedAt(published.data.theme.published_at);
      setConfirmPublish(false);
      setNotice("تم نشر تصميم المتجر بنجاح.");
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setPublishing(false);
    }
  }

  async function doPreview() {
    if (issuingPreview) return;
    setIssuingPreview(true);
    setFormError(null);
    try {
      const okSaved = await saveNow(draft, savedJson);
      if (!okSaved) return;
      const res = await themeApi.issuePreview(storeId);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        setFormError(authErrorMessage(res, 400));
        return;
      }
      window.open(`/s/preview/${encodeURIComponent(res.data.token)}`, "_blank", "noopener");
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIssuingPreview(false);
    }
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  // Warn on accidental navigation with unsaved work.
  useEffect(() => {
    if (saveState !== "dirty" && saveState !== "saving") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState]);

  if (state.kind === "loading") {
    return (
      <div className="shell-loading">
        <span className="shell-spinner" aria-hidden="true"></span>
        جاري تحميل التصميم...
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <>
        <BackButton href={base} />
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
      </>
    );
  }

  if (state.kind === "error") {
    return (
      <>
        <BackButton href={base} />
        <div className="shell-card">
          <EmptyState
            icon="fas fa-exclamation-triangle"
            title="تعذّر تحميل التصميم"
            description={state.message}
          />
        </div>
      </>
    );
  }

  const viewportWidth =
    viewport === "mobile" ? 390 : viewport === "tablet" ? 768 : undefined;

  return (
    <div className="builder">
      <BuilderToolbar
        backHref={base}
        storeName={storeName}
        saveState={saveState}
        viewport={viewport}
        onViewport={setViewport}
        onGuest={doPreview}
        onSave={() => void saveNow(draft, savedJson)}
        onPublish={() => setConfirmPublish(true)}
        issuingPreview={issuingPreview}
        publishing={publishing}
        saving={saveState === "saving"}
      />

      {formError && (
        <div className="shell-error" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>{formError}</span>
        </div>
      )}
      {notice && (
        <div className="shell-success" role="status">
          <i className="fas fa-check-circle" aria-hidden="true"></i>
          <span>{notice}</span>
        </div>
      )}

      <div className="builder-layout">
        <aside className={`builder-tools${mobilePanel === "tools" ? " is-open" : ""}`} aria-label="أدوات التصميم">
          <ToolsPanel
            draft={draft}
            selection={selection}
            onSelect={(s) => {
              setSelection(s);
              setMobilePanel(null);
            }}
            patch={patch}
            moveSection={moveSection}
          />
        </aside>

        <div className="builder-preview-wrap">
          {catalog.error ? (
            <div className="shell-card">
              <EmptyState
                icon="fas fa-exclamation-triangle"
                title="تعذّر تحميل بيانات المعاينة"
                description="يمكنك تعديل التصميم، لكن المعاينة تحتاج بيانات المتجر."
                action={
                  <button type="button" className="btn btn-outline" onClick={() => void loadCatalog()}>
                    إعادة المحاولة
                  </button>
                }
              />
            </div>
          ) : (
            <div
              className={`builder-preview is-${viewport}`}
              style={viewportWidth ? { maxWidth: viewportWidth } : undefined}
            >
              <StoreHomeView
                storeName={storeName}
                currency={currency}
                categories={catalog.categories}
                products={catalog.products}
                theme={draft}
                selectable
                selection={selection}
                onSelect={(k) => setSelection(k as Selection)}
              />
            </div>
          )}
          <p className="builder-preview-hint">
            {publishedAt ? `آخر نشر: ${publishedAt}` : "لم يُنشر أي تصميم بعد — الزوار يرون الواجهة الافتراضية."}
          </p>
        </div>

        <aside className={`builder-props${mobilePanel === "props" ? " is-open" : ""}`} aria-label="خصائص العنصر">
          <PropsPanel
            draft={draft}
            selection={selection}
            onSelect={setSelection}
            patch={patch}
            moveSection={moveSection}
            updateSectionAt={updateSectionAt}
          />
        </aside>
      </div>

      <div className="builder-mobile-bar">
        <button
          type="button"
          className="btn btn-outline btn-sm"
          aria-expanded={mobilePanel === "tools"}
          onClick={() => setMobilePanel((p) => (p === "tools" ? null : "tools"))}
        >
          <i className="fas fa-sliders-h" aria-hidden="true"></i>
          الأدوات
        </button>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          aria-expanded={mobilePanel === "props"}
          onClick={() => setMobilePanel((p) => (p === "props" ? null : "props"))}
        >
          <i className="fas fa-cog" aria-hidden="true"></i>
          الخصائص
        </button>
      </div>

      {mobilePanel !== null && (
        <div
          className="builder-scrim"
          aria-hidden="true"
          onClick={() => setMobilePanel(null)}
        />
      )}

      <ConfirmDialog
        open={confirmPublish}
        title="نشر التصميم؟"
        description="سيظهر التصميم الحالي لجميع الزوار فوراً، وتُلغى روابط المعاينة السابقة."
        confirmLabel="نشر التصميم"
        confirming={publishing}
        onClose={() => setConfirmPublish(false)}
        onConfirm={doPublish}
      />
    </div>
  );
}
