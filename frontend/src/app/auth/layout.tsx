import type { ReactNode } from "react";
import "./auth.css";

/** Auth section shell: brand header + centered content (landing page untouched). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <a href="/" className="auth-brand" aria-label="سلة سوريا - الصفحة الرئيسية">
        <span className="logo-icon" aria-hidden="true">
          <i className="fas fa-shopping-bag"></i>
        </span>
        <span>
          سلة <span className="auth-brand-sub">سوريا</span>
        </span>
      </a>
      <main>{children}</main>
    </div>
  );
}
