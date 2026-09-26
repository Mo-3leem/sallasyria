"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Reusable confirmation dialog for sensitive actions.
 * Rendered only; callers own the destructive behavior. Optional
 * `requireConfirmText` turns it into a retype-to-confirm dialog for
 * permanent deletions: confirm stays disabled until the typed value
 * matches exactly.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "تأكيد",
  cancelLabel = "تراجع",
  confirming = false,
  requireConfirmText,
  requireConfirmPlaceholder,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirming?: boolean;
  requireConfirmText?: string;
  requireConfirmPlaceholder?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) return;
    setTyped("");
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
  const blocked = confirming || (requireConfirmText !== undefined && typed !== requireConfirmText);

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
        {requireConfirmText !== undefined && (
          <div className="auth-field" style={{ marginTop: 12 }}>
            <label className="auth-label" htmlFor="confirm-retype">
              اكتب <strong dir="ltr">{requireConfirmText}</strong> للتأكيد
            </label>
            <input
              id="confirm-retype"
              className="auth-input"
              dir="ltr"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireConfirmPlaceholder}
              autoComplete="off"
            />
          </div>
        )}
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
            disabled={blocked}
            autoFocus={requireConfirmText === undefined}
          >
            {confirming ? "جاري التنفيذ..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
