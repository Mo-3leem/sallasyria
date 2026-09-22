"use client";

import Link from "next/link";
import type { Store } from "@/types/api";

/** Reusable store row: name/slug/currency/status + dashboard/settings links. */
export function StoreCard({ store }: { store: Store }) {
  const href = `/app/stores/${encodeURIComponent(store.id)}`;
  return (
    <div className="store-row">
      <span className="store-row-icon" aria-hidden="true">
        <i className="fas fa-store"></i>
      </span>
      <span className="store-row-body">
        <Link href={href} className="store-row-name">
          {store.name}
        </Link>
        <span className="store-row-meta">
          <span dir="ltr">{store.slug}</span>
          <span>·</span>
          <span>{store.currency}</span>
          <span>·</span>
          <span>{store.status}</span>
        </span>
      </span>
      <span className="store-card-links">
        <Link href={href} className="btn btn-ghost btn-shell-dark btn-sm">
          المتجر
        </Link>
        <Link href={`${href}/settings`} className="btn btn-ghost btn-shell-dark btn-sm">
          الإعدادات
        </Link>
      </span>
    </div>
  );
}
