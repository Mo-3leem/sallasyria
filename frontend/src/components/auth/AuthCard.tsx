"use client";

import type { ReactNode } from "react";

/** Brand-consistent card shell for all auth screens (Cairo, RTL, green brand). */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-card">
      <div className="auth-card-head">
        <span className="auth-logo" aria-hidden="true">
          <i className="fas fa-shopping-bag"></i>
        </span>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
      </div>
      {children}
      {footer && <div className="auth-footer">{footer}</div>}
    </div>
  );
}
