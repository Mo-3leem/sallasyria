"use client";

/** Single field-level error line (renders backend `details[]` entries). */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} className="auth-field-error" role="alert">
      {message}
    </p>
  );
}
