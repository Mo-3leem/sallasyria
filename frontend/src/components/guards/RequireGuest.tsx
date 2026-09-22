"use client";

import { Suspense, useEffect, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { getNextPath } from "@/lib/auth";
import { Loading } from "@/components/ui/Loading";

/**
 * UX-only guard for login/register: signed-in users are sent to their
 * destination (`?next=` when safe) instead of seeing auth forms again.
 */
function RequireGuestInner({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!loading && user) {
      router.replace(getNextPath(searchParams));
    }
  }, [loading, user, searchParams, router]);

  if (loading) {
    return (
      <div className="auth-loading">
        <Loading text="جاري التحقق من الجلسة..." />
      </div>
    );
  }
  if (user) return null;
  return <>{children}</>;
}

export function RequireGuest({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="auth-loading">
          <Loading text="جاري التحميل..." />
        </div>
      }
    >
      <RequireGuestInner>{children}</RequireGuestInner>
    </Suspense>
  );
}
