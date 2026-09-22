"use client";

import { useState } from "react";
import { authApi } from "@/lib/api";
import { authErrorMessage, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { RequireAuth } from "@/components/guards/RequireAuth";
import { AuthCard } from "@/components/auth/AuthCard";
import { FormError } from "@/components/auth/FormError";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";

export default function SessionsPage() {
  return (
    <RequireAuth>
      <SessionsContent />
    </RequireAuth>
  );
}

function SessionsContent() {
  const [formError, setFormError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onLogoutOthers() {
    if (submitting) return;
    setFormError(null);
    setRevoked(null);
    setSubmitting(true);
    try {
      // The backend exposes no session list — only this revoke-others count.
      const res = await authApi.logoutOthers();
      if (!res.ok) {
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setRevoked(res.data.revoked);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="الجلسات النشطة"
      subtitle="جلستك الحالية تبقى دائماً. يمكنك إنهاء بقية الجلسات من هنا."
      footer={
        <span>
          <a href="/auth/profile">العودة إلى حسابي</a>
        </span>
      }
    >
      <div className="auth-form">
        <FormError message={formError} />
        {revoked !== null && (
          <div className="auth-success" role="status">
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>تم تسجيل الخروج من {revoked} جلسة أخرى.</span>
          </div>
        )}
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          onClick={onLogoutOthers}
          disabled={submitting}
        >
          {submitting ? (
            <Loading size="sm" text="جاري إنهاء الجلسات..." />
          ) : (
            "تسجيل الخروج من الجلسات الأخرى"
          )}
        </Button>
      </div>
    </AuthCard>
  );
}
