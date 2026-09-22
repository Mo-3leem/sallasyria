import type { ReactNode } from "react";

// Edge runtime for every dynamic [storeId] route below this segment
// (categories/customers/orders/products/settings pages + new/edit/detail
// variants — 17 routes). Inherited per Next.js route-segment-config rules,
// so no per-page duplication. Required by the Cloudflare Pages adapter:
// all 17 are authenticated client shells with browser fetch only (no
// Node-only imports), safe for the Edge Runtime. Static routes elsewhere
// are intentionally untouched.
export const runtime = "edge";

export default function StoreSegmentLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
