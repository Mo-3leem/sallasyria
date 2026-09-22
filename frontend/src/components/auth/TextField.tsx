"use client";

import type { InputHTMLAttributes } from "react";
import { FieldError } from "./FieldError";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

/** Label + input + hint/error wiring (reused by every auth form). */
export function TextField({ label, error, hint, id, ...props }: TextFieldProps) {
  // Safe latin fallback: labels are Arabic (spaces, non-latin) and invalid
  // as id values. Callers pass explicit ids (field-name, field-slug, ...).
  const inputId = id || "field-input";
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={`auth-input${error ? " auth-input-error" : ""}`}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
        {...props}
      />
      {hint && !error && (
        <p id={`${inputId}-hint`} className="auth-hint">
          {hint}
        </p>
      )}
      <FieldError id={inputId} message={error} />
    </div>
  );
}
