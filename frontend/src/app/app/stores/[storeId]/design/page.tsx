"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { themeApi } from "@/lib/api";
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
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import type { ThemeData } from "@/lib/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready" };

interface Palette {
  primary: string;
  background: string;
  accent: string;
  text: string;
}

interface DraftBanner {
  image: string;
  title: string;
}

interface DraftSection {
  type: "hero" | "categories" | "products" | "banner" | "text";
  order: number;
  is_visible: 0 | 1;
}

interface Draft {
  palette: Palette;
  logo: string;
  banners: DraftBanner[];
  sections: DraftSection[];
}

const SECTION_TYPES = [
  { type: "hero", label: "الواجهة" },
  { type: "categories", label: "التصنيفات" },
  { type: "products", label: "المنتجات" },
  { type: "banner", label: "اللافتات" },
  { type: "text", label: "نص ترحيبي" },
] as const;

const DEFAULT_DRAFT: Draft = {
  palette: { primary: "#16a34a", background: "#ffffff", accent: "#22c55e", text: "#0f172a" },
  logo: "",
  banners: [],
  sections: [
    { type: "hero", order: 0, is_visible: 1 },
    { type: "categories", order: 1, is_visible: 1 },
    { type: "products", order: 2, is_visible: 1 },
    { type: "banner", order: 3, is_visible: 1 },
    { type: "text", order: 4, is_visible: 0 },
  ],
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function coerceDraft(raw: Record<string, unknown>): Draft {
  const d = raw as Partial<Record<string, unknown>>;
  const palette = (d.palette ?? {}) as Partial<Palette>;
  const color = (v: unknown, fallback: string) =>
    typeof v === "string" && HEX_RE.test(v) ? v : fallback;
  const banners = Array.isArray(d.banners)
    ? d.banners
        .filter(
          (b): b is Record<string, unknown> =>
            typeof b === "object" && b !== null
        )
        .slice(0, 5)
        .map((b) => ({
          image: typeof b.image === "string" ? b.image : "",
          title: typeof b.title === "string" ? b.title : "",
        }))
    : [];
  const sections = Array.isArray(d.sections)
    ? d.sections
        .filter(
          (s): s is Record<string, unknown> =>
            typeof s === "object" && s !== null
        )
        .slice(0, 20)
        .map((s, i): DraftSection => ({
          type: (["hero", "categories", "products", "banner", "text"] as const).includes(
            s.type as (typeof SECTION_TYPES)[number]["type"]
          )
            ? (s.type as DraftSection["type"])
            : "text",
          order: typeof s.order === "number" ? s.order : i,
          is_visible: s.is_visible === 0 ? 0 : 1,
        }))
    : DEFAULT_DRAFT.sections;
  return {
    palette: {
      primary: color(palette.primary, DEFAULT_DRAFT.palette.primary),
      background: color(palette.background, DEFAULT_DRAFT.palette.background),
      accent: color(palette.accent, DEFAULT_DRAFT.palette.accent),
      text: color(palette.text, DEFAULT_DRAFT.palette.text),
    },
    logo: typeof d.logo === "string" ? d.logo : "",
    banners,
    sections,
  };
}

function toPayload(draft: Draft): Record<string, unknown> {
  return {
    palette: { ...draft.palette },
    logo: draft.logo === "" ? null : draft.logo,
    banners: draft.banners.map((b) => ({
      image: b.image,
      ...(b.title !== "" ? { title: b.title } : {}),
    })),
    sections: draft.sections.map((s) => ({
      type: s.type,
      order: s.order,
      is_visible: s.is_visible,
    })),
  };
}

/**
 * Theme designer: draft editing with debounced autosave, audited publish,
 * and signed preview tokens. Autosave sends the full draft (the backend
 * shallow-merges); the form never fabricates server state.
 */
export default function DesignPage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const { refresh: refreshAuth } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [savedJson, setSavedJson] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [issuingPreview, setIssuingPreview] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

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
        const loaded = coerceDraft(res.data.theme.draft);
        setDraft(loaded);
        setSavedJson(JSON.stringify(toPayload(loaded)));
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

  async function saveNow(current: Draft, baseline: string): Promise<boolean> {
    const payload = toPayload(current);
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
          setFormError(
            "تعديل التصميم يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
        } else {
          const fields = getFieldErrors(res);
          setFormError(
            Object.values(fields)[0] ?? authErrorMessage(res, 400)
          );
        }
        setSaveState("error");
        return false;
      }
      setSavedJson(JSON.stringify(toPayload(coerceDraft(res.data.theme.draft))));
      setSaveState("saved");
      return true;
    } catch {
      setSaveState("error");
      setFormError(NETWORK_ERROR_MESSAGE);
      return false;
    }
  }

  function scheduleSave(next: Draft) {
    setDraft(next);
    setSaveState("dirty");
    setNotice(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void saveNow(next, savedJson);
    }, 1500);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

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
          setFormError(
            "النشر يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        setFormError(authErrorMessage(published, 400));
        return;
      }
      setPublishedAt(published.data.theme.published_at);
      setConfirmPublish(false);
      setNotice("تم النشر بنجاح — متجرك يعرض التصميم الجديد الآن.");
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

  if (state.kind === "error") {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-exclamation-triangle"
          title="تعذّر تحميل التصميم"
          description={state.message}
        />
      </div>
    );
  }

  const saveLabel =
    saveState === "saving"
      ? "حفظ تلقائي..."
      : saveState === "dirty"
        ? "تغييرات غير محفوظة"
        : saveState === "error"
          ? "تعذّر الحفظ — سيُعاد تلقائياً"
          : "محفوظ";

  const setPalette = (key: keyof Palette, value: string) =>
    scheduleSave({ ...draft, palette: { ...draft.palette, [key]: value } });

  const moveSection = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= draft.sections.length) return;
    const sections = draft.sections.map((s, i) => ({ ...s }));
    const [moved] = sections.splice(index, 1);
    sections.splice(target, 0, moved!);
    sections.forEach((s, i) => {
      s.order = i;
    });
    scheduleSave({ ...draft, sections });
  };

  const toggleSection = (index: number) => {
    const sections = draft.sections.map((s, i) =>
      i === index ? { ...s, is_visible: (s.is_visible === 1 ? 0 : 1) as 0 | 1 } : { ...s }
    );
    scheduleSave({ ...draft, sections });
  };

  return (
    <>
      <BackButton href={base} />
      <div className="shell-page-head">
        <h1>تصميم المتجر</h1>
        <p>خصّص الألوان واللافتات والأقسام — الحفظ تلقائي، والنشر يدوي.</p>
      </div>

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

      <div className="shell-card">
        <h2 className="shell-card-title">الألوان والشعار</h2>
        <div className="shell-grid-2">
          {(Object.keys(draft.palette) as (keyof Palette)[]).map((key) => (
            <div className="auth-field" key={key}>
              <label className="auth-label" htmlFor={`palette-${key}`}>
                {key === "primary" ? "الأساسي" : key === "background" ? "الخلفية" : key === "accent" ? "المميز" : "النص"}
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  id={`palette-${key}`}
                  type="color"
                  value={HEX_RE.test(draft.palette[key]) ? draft.palette[key] : "#16a34a"}
                  onChange={(e) => setPalette(key, e.target.value)}
                  style={{ width: 44, height: 40, border: "none", background: "none", cursor: "pointer" }}
                  aria-label={key}
                />
                <input
                  className="auth-input"
                  dir="ltr"
                  value={draft.palette[key]}
                  maxLength={7}
                  onChange={(e) => setPalette(key, e.target.value)}
                  aria-label={`${key} hex`}
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <TextFieldLike
            label="رابط الشعار (اختياري)"
            id="field-logo"
            dir="ltr"
            value={draft.logo}
            onChange={(v) => scheduleSave({ ...draft, logo: v })}
          />
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">اللافتات (حتى 5)</h2>
        {draft.banners.length === 0 && (
          <p className="shell-note">لا توجد لافتات بعد.</p>
        )}
        <div className="shell-stack">
          {draft.banners.map((b, i) => (
            <div key={i} className="store-row">
              <span className="store-row-icon" aria-hidden="true">
                <i className="fas fa-image"></i>
              </span>
              <span className="store-row-body">
                <span className="store-row-name" dir="ltr">{b.image || "—"}</span>
                <span className="store-row-meta">{b.title || "بدون عنوان"}</span>
              </span>
              <span className="store-card-links">
                <button
                  type="button"
                  className="btn btn-ghost btn-shell-dark btn-sm"
                  onClick={() =>
                    scheduleSave({
                      ...draft,
                      banners: draft.banners.filter((_, j) => j !== i),
                    })
                  }
                >
                  حذف
                </button>
              </span>
            </div>
          ))}
        </div>
        {draft.banners.length < 5 && (
          <BannerAdder
            onAdd={(banner) =>
              scheduleSave({ ...draft, banners: [...draft.banners, banner] })
            }
          />
        )}
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">الأقسام</h2>
        <div className="shell-stack">
          {draft.sections.map((s, i) => (
            <div key={`${s.type}-${i}`} className="store-row">
              <span className="store-row-body">
                <span className="store-row-name">
                  {SECTION_TYPES.find((t) => t.type === s.type)?.label ?? s.type}
                </span>
                <span className="store-row-meta">
                  {s.is_visible === 1 ? "ظاهر" : "مخفي"}
                </span>
              </span>
              <span className="store-card-links">
                <button
                  type="button"
                  className="btn btn-ghost btn-shell-dark btn-sm"
                  disabled={i === 0}
                  onClick={() => moveSection(i, -1)}
                  aria-label="تحريك للأعلى"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-shell-dark btn-sm"
                  disabled={i === draft.sections.length - 1}
                  onClick={() => moveSection(i, 1)}
                  aria-label="تحريك للأسفل"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-shell-dark btn-sm"
                  onClick={() => toggleSection(i)}
                >
                  {s.is_visible === 1 ? "إخفاء" : "إظهار"}
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">النشر والمعاينة</h2>
        <p className="shell-note" style={{ marginBottom: 12 }}>
          الحالة: {saveLabel}
          {publishedAt && (
            <>
              {" · "}آخر نشر: {new Date(publishedAt).toLocaleDateString("ar-SY")}
            </>
          )}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={publishing}
            onClick={() => setConfirmPublish(true)}
          >
            {publishing ? "جاري النشر..." : "نشر التصميم"}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={issuingPreview}
            onClick={doPreview}
          >
            {issuingPreview ? "جاري..." : "معاينة المسودة"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmPublish}
        title="نشر التصميم؟"
        description="سيظهر التصميم الحالي لجميع الزوار فوراً، وتُلغى روابط المعاينة السابقة."
        confirmLabel="نشر"
        confirming={publishing}
        onClose={() => setConfirmPublish(false)}
        onConfirm={doPublish}
      />
    </>
  );
}

function TextFieldLike(props: {
  label: string;
  id: string;
  dir?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        dir={props.dir}
        className="auth-input"
        value={props.value}
        maxLength={2048}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

function BannerAdder(props: { onAdd: (b: { image: string; title: string }) => void }) {
  const [image, setImage] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="auth-field">
        <label className="auth-label" htmlFor="banner-image">رابط صورة اللافتة (https)</label>
        <input
          id="banner-image"
          dir="ltr"
          className="auth-input"
          value={image}
          maxLength={2048}
          onChange={(e) => {
            setImage(e.target.value);
            setError(null);
          }}
        />
      </div>
      <div className="auth-field" style={{ marginTop: 8 }}>
        <label className="auth-label" htmlFor="banner-title">عنوان اللافتة (اختياري)</label>
        <input
          id="banner-title"
          className="auth-input"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {error && <FieldErrorLike message={error} />}
      <button
        type="button"
        className="btn btn-outline btn-sm"
        style={{ marginTop: 8 }}
        onClick={() => {
          if (!image.trim().startsWith("https://")) {
            setError("الرابط يجب أن يبدأ بـ https://");
            return;
          }
          props.onAdd({ image: image.trim(), title: title.trim() });
          setImage("");
          setTitle("");
          setError(null);
        }}
      >
        إضافة اللافتة
      </button>
    </div>
  );
}

function FieldErrorLike(props: { message: string }) {
  return (
    <p className="auth-field-error" role="alert">
      {props.message}
    </p>
  );
}
