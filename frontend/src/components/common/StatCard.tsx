"use client";

import type { ReactNode } from "react";

/** Generic statistic card — no business assumptions, just title/value. */
export function StatCard({
  title,
  value,
  icon,
  hint,
}: {
  title: string;
  value: ReactNode;
  icon?: string;
  hint?: string;
}) {
  return (
    <div className="stat-card">
      {icon && (
        <span className="stat-card-icon" aria-hidden="true">
          <i className={icon}></i>
        </span>
      )}
      <div className="stat-card-body">
        <span className="stat-card-title">{title}</span>
        <span className="stat-card-value">{value}</span>
        {hint && <span className="stat-card-hint">{hint}</span>}
      </div>
    </div>
  );
}
