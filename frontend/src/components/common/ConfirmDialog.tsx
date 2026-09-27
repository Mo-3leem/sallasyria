"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Reusable confirmation dialog for sensitive actions.
 * Rendered only; callers own the destructive behavior. Optional
 * `requireConfirmText` turns it into a retype-to-confirm dialog for
 * permanent deletions: confirming with empty input shows an inline
 * validation error, a mismatched value shows a mismatch error, and the
 * destructive action only runs on an exact match.
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
  emptyErrorText = "الرجاء إدخال القيمة المطلوبة للتأكيد.",
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
  emptyErrorText?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setTyped("");
    setCopied(false);
    setAttemptError(null);
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

  function handleConfirm() {
    if (requireConfirmText !== undefined && typed !== requireConfirmText) {
      setAttemptError(
        typed.trim() === ""
          ? emptyErrorText
          : "القيمة المدخلة غير مطابقة للقيمة المطلوبة. انسخها والصقها بدقة."
      );
      return;
    }
    onConfirm();
  }

  async function copyConfirmText() {
    if (requireConfirmText === undefined || copied) return;
    let done = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(requireConfirmText);
        done = true;
      }
    } catch {
      done = false;
    }
    if (!done) {
      try {
        const ta = document.createElement("textarea");
        ta.value = requireConfirmText;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        done = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        return;
      }
    }
    if (!done) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

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
              اكتب{" "}
              <button
                type="button"
                className="confirm-copy"
                dir="ltr"
                title="نسخ إلى الحافظة"
                aria-label={`نسخ ${requireConfirmText} إلى الحافظة`}
                onClick={() => void copyConfirmText()}
              >
                {requireConfirmText}
                <i
                  className={copied ? "fas fa-check" : "fas fa-copy"}
                  aria-hidden="true"
                ></i>
              </button>{" "}
              للتأكيد
            </label>
            <span className="confirm-copy-hint" role="status">
              {copied ? "تم النسخ — الصقه في الحقل أدناه" : "اضغط على القيمة لنسخها، ثم الصقها أدناه"}
            </span>
            <input
              id="confirm-retype"
              className="auth-input"
              dir="ltr"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setAttemptError(null);
              }}
              placeholder={requireConfirmPlaceholder}
              autoComplete="off"
              aria-invalid={attemptError !== null}
              aria-describedby={attemptError ? "confirm-retype-error" : undefined}
            />
            {attemptError && (
              <p id="confirm-retype-error" className="auth-field-error" role="alert">
                {attemptError}
              </p>
            )}
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
            onClick={handleConfirm}
            disabled={confirming}
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
