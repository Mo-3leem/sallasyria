"use client";

import { HTMLAttributes, forwardRef } from "react";

export interface PageHeaderProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  breadcrumb?: Array<{ label: string; href?: string }>;
}

export const PageHeader = forwardRef<HTMLDivElement, PageHeaderProps>(
  (
    {
      title,
      subtitle,
      action,
      breadcrumb,
      className = "",
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      className={`mb-8 ${className}`}
      {...props}
    >
      {breadcrumb && breadcrumb.length > 0 && (
        <nav
          className="flex items-center gap-2 text-sm text-gray-500 mb-4"
          aria-label="المسار"
        >
          <ol className="flex items-center gap-2">
            {breadcrumb.map((item, index) => (
              <li key={item.label} className="flex items-center gap-2">
                {index > 0 && (
                  <svg
                    className="w-4 h-4 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                )}
                {item.href ? (
                  <a
                    href={item.href}
                    className="hover:text-gray-900 transition-colors"
                  >
                    {item.label}
                  </a>
                ) : (
                  <span className="text-gray-900 font-medium" aria-current="page">
                    {item.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
          {subtitle && (
            <p className="mt-1 text-gray-600">{subtitle}</p>
          )}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
    </div>
  )
);

PageHeader.displayName = "PageHeader";