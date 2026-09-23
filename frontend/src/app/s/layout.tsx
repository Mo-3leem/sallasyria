import type { ReactNode } from "react";
import { BuyerProvider } from "@/hooks/useBuyer";
import { CartProvider } from "@/hooks/useCart";
import "./storefront.css";
// Single source of truth for form base styles (mirrors the approved /app
// fix): buyer forms render auth-form/field/label/input classes whose base
// definitions live in app/auth/auth.css — without this import, /s/*
// surfaces render those classes unstyled. Scoped .shop overrides in
// storefront.css keep winning by higher specificity; merchant auth pages
// are untouched (shared classes, additive only).
import "../auth/auth.css";

// Edge runtime for every public storefront route below this segment
// (/s/[slug] + c/[cat] + p/[product] + checkout + account/* + preview).
// Inherited per Next.js route-segment-config rules, so no per-page
// duplication. Required by the Cloudflare Pages adapter: all 11 are
// client shells with browser fetch only (no Node-only imports), safe for
// the Edge Runtime. Without this, next-on-pages refuses the production
// build ("routes were not configured to run with the Edge Runtime") and
// the site keeps serving the previous deployment (framework 404 on /s/*).
export const runtime = "edge";

/** Public buyer area: no auth guard, buyer identity + server cart state. */
export default function StorefrontLayout({ children }: { children: ReactNode }) {
  return (
    <BuyerProvider>
      <CartProvider>
        <div className="shop">{children}</div>
      </CartProvider>
    </BuyerProvider>
  );
}
