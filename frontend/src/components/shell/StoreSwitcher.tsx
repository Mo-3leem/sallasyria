"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStores } from "@/hooks/useStores";

/**
 * URL-first store switcher. The active store is derived from the current
 * pathname (/app/stores/[storeId]) — never stored in state or localStorage.
 * Switching navigates to the store URL, so refresh/deep-linking just works.
 */
export function StoreSwitcher() {
  const { stores, loading, error } = useStores();
  const pathname = usePathname();

  const activeId = pathname.startsWith("/app/stores/")
    ? decodeURIComponent(pathname.split("/")[3] ?? "")
    : null;
  const active = stores.find((s) => s.id === activeId) ?? null;

  return (
    <div className="store-switcher">
      <span className="store-switcher-label">المتجر</span>
      {loading ? (
        <span className="store-switcher-current store-switcher-muted">
          جاري تحميل المتاجر...
        </span>
      ) : error ? (
        <span className="store-switcher-current store-switcher-muted">
          تعذّر تحميل المتاجر
        </span>
      ) : stores.length === 0 ? (
        <span className="store-switcher-current store-switcher-muted">
          لا توجد متاجر بعد
        </span>
      ) : (
        <details className="store-switcher-menu">
          <summary className="store-switcher-current" aria-label="اختيار المتجر">
            <i className="fas fa-store" aria-hidden="true"></i>
            <span>{active ? active.name : "اختر متجراً"}</span>
            <i className="fas fa-chevron-down store-switcher-caret" aria-hidden="true"></i>
          </summary>
          <div className="store-switcher-list" role="menu">
            {stores.map((store) => (
              <Link
                key={store.id}
                href={`/app/stores/${encodeURIComponent(store.id)}`}
                className={`store-switcher-item${store.id === active?.id ? " active" : ""}`}
                role="menuitem"
                onClick={(e) => {
                  // Native <details> stays open after navigation (the shell
                  // header persists) — close it explicitly on selection.
                  const menu = e.currentTarget.closest("details");
                  if (menu) menu.removeAttribute("open");
                }}
              >
                <span className="store-switcher-item-name">{store.name}</span>
                <span className="store-switcher-item-slug" dir="ltr">
                  {store.slug}
                </span>
              </Link>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
