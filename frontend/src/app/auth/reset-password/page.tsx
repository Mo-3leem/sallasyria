"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useCooldown } from "@/hooks/useCooldown";
import { AuthCard } from "@/components/auth/AuthCard";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { RateLimitNotice } from "@/components/auth/RateLimitNotice";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { locked, remaining, lock } = useCooldown();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [logoutOthers, setLogoutOthers] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked || submitting || !token) return;
    setFieldErrors({});
    setFormError(null);

    const local: Record<string, string> = {};
    if (password.length < 8) local.new_password = "كلمة المرور 8 أحرف على الأقل.";
    if (password.length > 256) local.new_password = "كلمة المرور طويلة جداً.";
    if (confirm !== password) local.confirm = "تأكيد كلمة المرور غير مطابق.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    setSubmitting(true);
    try {
      const res = await authApi.resetPassword({
        token,
        new_password: password,
        // Default false: keep every session unless the user explicitly opts in.
        logout_other_sessions: logoutOthers,
      });
      if (!res.ok) {
        if (getErrorCode(res) === "rate_limited") lock(30);
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setDone(true);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthCard
        title="رابط غير مكتمل"
        footer={
          <span>
            <a href="/auth/forgot-password">اطلب رابطاً جديداً</a>
          </span>
        }
      >
        <div className="auth-form-error" role="alert">
          <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
          <span>رابط الاستعادة غير مكتمل (لا يوجد رمز). افتح الرابط الكامل من بريدك.</span>
        </div>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard
        title="تم تغيير كلمة المرور"
        footer={
          <span>
            <a href="/auth/login">سجّل الدخول بكلمتك الجديدة</a>
          </span>
        }
      >
        <div className="auth-success" role="status">
          <i className="fas fa-check-circle" aria-hidden="true"></i>
          <span>تم تعيين كلمتك الجديدة بنجاح. سجّل الدخول لمتابعة عملك.</span>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="كلمة مرور جديدة"
      subtitle="اختر كلمة مرور قوية لحسابك."
      footer={
        <span>
          <a href="/auth/login">العودة لتسجيل الدخول</a>
        </span>
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        <RateLimitNotice remaining={remaining} />
        <PasswordInput
          label="كلمة المرور الجديدة"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.new_password}
          hint="8 أحرف على الأقل."
        />
        <PasswordInput
          label="تأكيد كلمة المرور"
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
          <span>تسجيل الخروج من جميع الجلسات الأخرى بعد التغيير</span>
        </label>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          disabled={submitting || locked}
        >
          {submitting ? <Loading size="sm" text="جاري الحفظ..." /> : "تعيين كلمة المرور"}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="كلمة مرور جديدة">
          <div className="auth-loading" style={{ minHeight: 0 }}>
            <Loading text="جاري التحميل..." />
          </div>
        </AuthCard>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
