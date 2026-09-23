"use client";

import { useState, type InputHTMLAttributes } from "react";
import { FieldError } from "./FieldError";

interface PasswordInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  error?: string;
  hint?: string;
}

/** Password field with show/hide toggle (reused by login/register/reset/change). */
export function PasswordInput({ label, error, hint, id, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  // Same safe-latin fallback rationale as TextField.
  const inputId = id || "field-password";
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="password-wrap">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          className={`auth-input${error ? " auth-input-error" : ""}`}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
          aria-pressed={visible}
        >
          <i className={visible ? "fas fa-eye-slash" : "fas fa-eye"} aria-hidden="true"></i>
        </button>
      </div>
      {hint && !error && (
        <p id={`${inputId}-hint`} className="auth-hint">
          {hint}
        </p>
      )}
      <FieldError id={inputId} message={error} />
    </div>
  );
}
