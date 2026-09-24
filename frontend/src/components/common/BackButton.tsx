import Link from "next/link";

/**
 * Consistent back navigation for detail/nested pages (RTL: the arrow
 * points right, i.e. backwards). Always links to an explicit parent
 * route — never history.back() — so pages opened directly from a URL
 * still land correctly. Uses globally-defined button classes so it
 * renders identically inside the app shell and on auth screens.
 */
export function BackButton({ href, label = "رجوع" }: { href: string; label?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Link href={href} className="btn btn-outline" aria-label={label}>
        <i className="fas fa-arrow-right" aria-hidden="true"></i>
        {label}
      </Link>
    </div>
  );
}
