"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Reusable confirmation dialog for sensitive actions.
 * Rendered only; callers own the destructive behavior (Phase 2 adds no
 * destructive actions — this exists for later phases' honest use).
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "تأكيد",
  cancelLabel = "تراجع",
  confirming = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirming?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="confirm-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title">{title}</h3>
        {description && <p className="confirm-desc">{description}</p>}
        <div className="confirm-actions">
          <button
            type="button"
            className="btn btn-ghost btn-shell-dark"
            onClick={onClose}
            disabled={confirming}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={confirming}
            autoFocus
          >
            {confirming ? "جاري التنفيذ..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
