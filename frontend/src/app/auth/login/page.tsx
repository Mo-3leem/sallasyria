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
import { useCooldown } from "@/hooks/useCooldown";
import { RequireGuest } from "@/components/guards/RequireGuest";
import { AuthCard } from "@/components/auth/AuthCard";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { RateLimitNotice } from "@/components/auth/RateLimitNotice";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useAuth();
  const { locked, remaining, lock } = useCooldown();
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked || submitting) return;
    setFieldErrors({});
    setFormError(null);
    setUnverified(false);

    const local: Record<string, string> = {};
    if (!identity.trim()) local.identity = "البريد الإلكتروني أو رقم الهاتف مطلوب.";
    if (!password) local.password = "كلمة المرور مطلوبة.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    setSubmitting(true);
    try {
      const res = await authApi.login({ identity: identity.trim(), password });
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "rate_limited") lock(30);
        if (code === "email_not_verified") setUnverified(true);
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 401));
        return;
      }
      await refresh();
      if (res.data.must_rotate) {
        // Forced admin credential rotation — cannot be bypassed in the UI;
        // the backend additionally 403s every non-exempt route until rotation.
        const next = getNextPath(searchParams);
        router.replace(
          `/auth/change-password?required=1&next=${encodeURIComponent(next)}`
        );
        return;
      }
      router.replace(getNextPath(searchParams));
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="تسجيل الدخول"
      subtitle="مرحباً بعودتك إلى سلة سوريا."
      footer={
        <>
          <span>
            ليس لديك حساب؟ <a href="/auth/register">أنشئ حساب تاجر</a>
          </span>
          <span>
            نسيت كلمة المرور؟ <a href="/auth/forgot-password">استعادتها</a>
          </span>
        </>
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        <RateLimitNotice remaining={remaining} />
        {unverified && (
          <div className="auth-notice" role="status">
            <i className="fas fa-envelope-open-text" aria-hidden="true"></i>
            <span>
              أرسلنا رابط التفعيل إلى بريدك عند التسجيل. تحقق من البريد الوارد
              (ومجلد الرسائل غير المرغوبة) واضغط الرابط، ثم سجّل الدخول.
            </span>
          </div>
        )}
        <TextField
          label="البريد الإلكتروني أو رقم الهاتف"
          type="text"
          dir="ltr"
          placeholder="merchant@example.com أو 0991234567"
          autoComplete="username"
          value={identity}
          onChange={(e) => setIdentity(e.target.value)}
          error={fieldErrors.identity}
        />
        <PasswordInput
          label="كلمة المرور"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          disabled={submitting || locked}
        >
          {submitting ? (
            <Loading size="sm" text="جاري تسجيل الدخول..." />
          ) : (
            "تسجيل الدخول"
          )}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <RequireGuest>
      <Suspense
        fallback={
          <div className="auth-loading">
            <Loading text="جاري التحميل..." />
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </RequireGuest>
  );
}
