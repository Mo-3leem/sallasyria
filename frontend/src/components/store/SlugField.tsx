"use client";

import { FieldError } from "@/components/auth/FieldError";

/** Backend slug rule: lowercase alphanumeric groups joined by dashes. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && SLUG_RE.test(value);
}

/** Slug input with live kebab-case hint (availability is backend-confirmed). */
export function SlugField({
  value,
  onChange,
  error,
  id = "field-slug",
  label = "رابط المتجر",
  placeholder = "my-store",
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  id?: string;
  label?: string;
  placeholder?: string;
}) {
  const showHint = value.length > 0 && !error;
  const valid = isValidSlug(value);
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        dir="ltr"
        placeholder={placeholder}
        autoComplete="off"
        maxLength={200}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`auth-input${error ? " auth-input-error" : ""}`}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={`${id}-hint`}
      />
      {showHint && (
        <p id={`${id}-hint`} className="auth-hint">
          استخدم حروفًا صغيرة وأرقامًا وشرطات فقط. مثال: {placeholder} —{" "}
          {valid ? "التنسيق صحيح." : "التنسيق غير صحيح بعد."}
        </p>
      )}
      {!showHint && !error && (
        <p id={`${id}-hint`} className="auth-hint">
          استخدم حروفًا صغيرة وأرقامًا وشرطات فقط. مثال: {placeholder}
        </p>
      )}
      <FieldError id={id} message={error} />
    </div>
  );
}
