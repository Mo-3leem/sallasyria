"use client";

/**
 * Shared offset pager (roadmap B11). Page numbers with previous/next,
 * RTL-aware text labels (no directional icons to mirror). Renders nothing
 * when there is a single page or less.
 */
export function Pagination({
  page,
  totalPages,
  onPage,
  disabled,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  disabled?: boolean;
}) {
  if (totalPages <= 1) return null;
  // Compact window around the current page (always first + last).
  const pages = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const visible = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  return (
    <nav className="pager" aria-label="ترقيم الصفحات">
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={disabled || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        السابق
      </button>
      {visible.map((p, i) => (
        <span key={p}>
          {i > 0 && visible[i - 1] !== undefined && p - (visible[i - 1] as number) > 1 && (
            <span className="pager-ellipsis" aria-hidden="true">
              …
            </span>
          )}
          <button
            type="button"
            className={p === page ? "btn btn-primary btn-sm" : "btn btn-outline btn-sm"}
            disabled={disabled || p === page}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onPage(p)}
          >
            {p.toLocaleString("ar-SY")}
          </button>
        </span>
      ))}
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={disabled || page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        التالي
      </button>
    </nav>
  );
}
