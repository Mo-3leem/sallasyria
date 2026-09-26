"use client";

import Link from "next/link";

export type SaveState = "saved" | "dirty" | "saving" | "error";
export type Viewport = "desktop" | "tablet" | "mobile";

/** Builder top bar: back, save state, viewport switcher, guest/save/publish. */
export function BuilderToolbar({
  backHref,
  storeName,
  saveState,
  viewport,
  onViewport,
  onGuest,
  onSave,
  onPublish,
  issuingPreview,
  publishing,
  saving,
}: {
  backHref: string;
  storeName: string;
  saveState: SaveState;
  viewport: Viewport;
  onViewport: (v: Viewport) => void;
  onGuest: () => void;
  onSave: () => void;
  onPublish: () => void;
  issuingPreview: boolean;
  publishing: boolean;
  saving: boolean;
}) {
  const saveLabel =
    saveState === "saving"
      ? "حفظ تلقائي..."
      : saveState === "dirty"
        ? "تغييرات غير محفوظة"
        : saveState === "error"
          ? "تعذّر الحفظ — سيُعاد تلقائياً"
          : "محفوظ";
  return (
    <div className="builder-toolbar">
      <div className="builder-toolbar-start">
        <Link href={backHref} className="btn btn-ghost btn-shell-dark btn-sm" aria-label="رجوع إلى المتجر">
          <i className="fas fa-arrow-right" aria-hidden="true"></i>
          رجوع
        </Link>
        <span className="builder-toolbar-title">
          تصميم المتجر
          <small>{storeName}</small>
        </span>
      </div>
      <div className="builder-toolbar-center">
        <span
          className={`builder-save-state is-${saveState}`}
          role="status"
          aria-live="polite"
        >
          <i
            className={
              saveState === "saved"
                ? "fas fa-check-circle"
                : saveState === "error"
                  ? "fas fa-exclamation-circle"
                  : "fas fa-circle-notch fa-spin"
            }
            aria-hidden="true"
          ></i>
          {saveLabel}
        </span>
      </div>
      <div className="builder-toolbar-end">
        <div className="builder-viewport" role="group" aria-label="حجم المعاينة">
          {(
            [
              { value: "desktop", label: "شاشة", icon: "fas fa-desktop" },
              { value: "tablet", label: "لوحي", icon: "fas fa-tablet-alt" },
              { value: "mobile", label: "جوال", icon: "fas fa-mobile-alt" },
            ] as const
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              className={`builder-viewport-btn${viewport === o.value ? " is-active" : ""}`}
              aria-pressed={viewport === o.value}
              title={o.label}
              aria-label={`معاينة ${o.label}`}
              onClick={() => onViewport(o.value)}
            >
              <i className={o.icon} aria-hidden="true"></i>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={onGuest}
          disabled={issuingPreview || saving}
        >
          <i className="fas fa-eye" aria-hidden="true"></i>
          {issuingPreview ? "جاري التجهيز..." : "عرض كزائر"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-shell-dark btn-sm"
          onClick={onSave}
          disabled={saving || saveState === "saved"}
        >
          <i className="fas fa-save" aria-hidden="true"></i>
          حفظ
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onPublish}
          disabled={publishing || saving}
        >
          <i className="fas fa-rocket" aria-hidden="true"></i>
          {publishing ? "جاري النشر..." : "نشر التصميم"}
        </button>
      </div>
    </div>
  );
}
