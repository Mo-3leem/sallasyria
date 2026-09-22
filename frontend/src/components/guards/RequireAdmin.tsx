"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { Loading } from "@/components/ui/Loading";

/**
 * UX-only admin guard. Merchants never see admin UI (sent to their
 * profile); unauthenticated visitors go to login. Backend stays
 * authoritative (every /admin/* endpoint enforces requireRole).
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace(`/auth/login?next=${encodeURIComponent(pathname)}`);
    } else if (user.role !== "admin") {
      router.replace("/auth/profile");
    }
  }, [loading, user, pathname, router]);

  if (loading) {
    return (
      <div className="auth-loading">
        <Loading text="جاري التحقق من الصلاحيات..." />
      </div>
    );
  }
  if (!user || user.role !== "admin") return null;
  return <>{children}</>;
}
