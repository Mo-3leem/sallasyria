"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { Loading } from "@/components/ui/Loading";

/**
 * UX-only protection for authenticated routes.
 * Unauthenticated visitors are sent to /auth/login?next=<current-path>.
 * The backend remains the authorization authority.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.replace(`/auth/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [loading, user, pathname, router]);

  if (loading) {
    return (
      <div className="auth-loading">
        <Loading text="جاري التحقق من الجلسة..." />
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}
