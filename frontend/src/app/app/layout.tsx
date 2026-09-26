import type { ReactNode } from "react";
import { RequireAuth } from "@/components/guards/RequireAuth";
import { StoresProvider } from "@/hooks/useStores";
import { AppShell } from "@/components/shell/AppShell";
import "./app-shell.css";
// Auth form styles (.auth-form/.auth-field/.auth-label/.auth-input/...).
// Option A: every selector in auth.css is scoped under .auth-*/.password-*
// classes (verified — zero bare-element/global rules), and the page/card
// classes (.auth-page/.auth-card/.auth-brand/...) are simply unused under
// /app, so nothing leaks. Single source of truth, no duplication.
import "../auth/auth.css";
// Storefront surface styles for the theme builder live preview. Same
// scoping argument: every selector lives under .shop/.account-*/.checkout-*
// (verified — zero bare-element rules outside @media), so merchant pages
// are unaffected; the builder preview reuses the exact buyer markup.
import "../s/storefront.css";

/** Authenticated application area: guard + shared stores + shell. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <StoresProvider>
        <AppShell>{children}</AppShell>
      </StoresProvider>
    </RequireAuth>
  );
}
