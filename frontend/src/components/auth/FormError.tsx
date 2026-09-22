"use client";

/** Form-level error box (backend code → Arabic message). */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="auth-form-error" role="alert">
      <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
      <span>{message}</span>
    </div>
  );
}
