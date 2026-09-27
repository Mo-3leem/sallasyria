"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";
import { getNextPath } from "@/lib/auth";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { RequireAuth } from "@/components/guards/RequireAuth";
import { AuthCard } from "@/components/auth/AuthCard";
import { BackButton } from "@/components/common/BackButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";

export default function ChangePasswordPage() {
  return (
    <RequireAuth>
      <Suspense
        fallback={
          <div className="auth-loading">
            <Loading text="جاري التحميل..." />
          </div>
        }
      >
        <ChangePasswordContent />
      </Suspense>
    </RequireAuth>
  );
}

function ChangePasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useAuth();
  // `required=1` marks the forced admin rotation after a must_rotate login.
  const required = searchParams.get("required") === "1";
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [logoutOthers, setLogoutOthers] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);

    const local: Record<string, string> = {};
    if (!current) local.current_password = "كلمة المرور الحالية مطلوبة.";
    if (next.length < 8) local.new_password = "كلمة المرور الجديدة 8 أحرف على الأقل.";
    if (next.length > 256) local.new_password = "كلمة المرور طويلة جداً.";
    if (confirm !== next) local.confirm = "تأكيد كلمة المرور غير مطابق.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    setSubmitting(true);
    try {
      const res = await authApi.changePassword({
        current_password: current,
        new_password: next,
        // Default false; the calling session survives either way.
        logout_other_sessions: logoutOthers,
      });
      if (!res.ok) {
        if (getErrorCode(res) === "credentials_rotation_required") {
          // Backend still enforces rotation: stay on this screen.
          setFormError(authErrorMessage(res));
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      await refresh();
      router.replace(getNextPath(searchParams));
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {!required && <BackButton href="/app/settings" />}
      <AuthCard
      title="تغيير كلمة المرور"
      subtitle={
        required
          ? "مطلوب تغيير كلمة المرور قبل المتابعة."
          : "اختر كلمة مرور جديدة لحسابك."
      }
      footer={
        !required ? (
          <span>
            <a href="/auth/profile">العودة إلى حسابي</a>
          </span>
        ) : undefined
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        {required && (
          <div className="auth-notice" role="status">
            <i className="fas fa-shield-alt" aria-hidden="true"></i>
            <span>حسابك يتطلب تدوير بيانات الدخول. لن تتمكن من المتابعة قبل التغيير.</span>
          </div>
        )}
        <PasswordInput
          label="كلمة المرور الحالية"
          id="field-current-password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={fieldErrors.current_password}
        />
        <PasswordInput
          label="كلمة المرور الجديدة"
          id="field-new-password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={fieldErrors.new_password}
          hint="8 أحرف على الأقل."
        />
        <PasswordInput
          label="تأكيد كلمة المرور الجديدة"
          id="field-confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldErrors.confirm}
        />
        <label className="auth-check">
          <input
            type="checkbox"
            checked={logoutOthers}
            onChange={(e) => setLogoutOthers(e.target.checked)}
          />
          <span>تسجيل الخروج من جميع الجلسات الأخرى (جلستك الحالية تبقى دائماً)</span>
        </label>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          disabled={submitting}
        >
          {submitting ? <Loading size="sm" text="جاري الحفظ..." /> : "تغيير كلمة المرور"}
        </Button>
      </form>
    </AuthCard>
    </>
  );
}
