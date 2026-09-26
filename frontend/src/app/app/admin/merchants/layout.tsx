import type { ReactNode } from "react";

// Edge runtime for every dynamic route below this segment (merchant detail
// + nested customer detail). Inherited per Next.js route-segment-config
// rules, so no per-page duplication. Required by the Cloudflare Pages
// adapter: both are authenticated client shells with browser fetch only (no
// Node-only imports), safe for the Edge Runtime.
export const runtime = "edge";

export default function AdminMerchantsSegmentLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
