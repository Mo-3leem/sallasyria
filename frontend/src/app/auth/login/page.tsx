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
import { TurnstileWidget, logCaptchaFailure } from "@/components/auth/TurnstileWidget";
import { getLastRequestId } from "@/lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  // Brute-force escalation: the backend demands a Turnstile challenge only
  // after repeated failed passwords for one identity. The widget stays
  // hidden until then; nothing here reveals whether an account exists.
  const [challengeRequired, setChallengeRequired] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendDone, setResendDone] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked || submitting) return;
    setFieldErrors({});
    setFormError(null);
    setUnverified(false);
    setResendDone(false);
    setResendError(null);

    const local: Record<string, string> = {};
    if (!identity.trim()) local.identity = "البريد الإلكتروني أو رقم الهاتف مطلوب.";
    if (!password) local.password = "كلمة المرور مطلوبة.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    setSubmitting(true);
    try {
      const res = await authApi.login(
        { identity: identity.trim(), password },
        captchaToken ?? undefined
      );
      // Single-use tokens: refresh after every attempt so a retry never
      // replays a consumed token into a confusing 403.
      setCaptchaToken(null);
      setCaptchaKey((k) => k + 1);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "rate_limited") lock(30);
        if (code === "email_not_verified") setUnverified(true);
        if (code === "turnstile_required") {
          // Escalated attempt: show the challenge and stop. The message
          // stays generic — it reveals nothing about the account.
          logCaptchaFailure(code, getLastRequestId());
          setChallengeRequired(true);
          setFormError("يرجى إكمال التحقق الأمني ثم إعادة المحاولة.");
          return;
        }
        if (code === "turnstile_failed") {
          logCaptchaFailure(code, getLastRequestId());
          setChallengeRequired(true);
          setFormError("فشل التحقق الأمني. يرجى إعادة المحاولة.");
          return;
        }
        if (code === "turnstile_misconfigured") {
          logCaptchaFailure(code, getLastRequestId());
          setFormError(authErrorMessage(res, 401));
          return;
        }
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

  async function onResend() {
    // Public recovery: only fire for email-shaped identities, never phones.
    // The backend answers identically whether or not the address exists.
    const address = identity.trim();
    if (resending || !EMAIL_RE.test(address)) return;
    setResending(true);
    setResendDone(false);
    setResendError(null);
    try {
      const res = await authApi.resendVerification(address);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "rate_limited") lock(30);
        setResendError(authErrorMessage(res, 400));
        return;
      }
      setResendDone(true);
    } catch {
      setResendError(NETWORK_ERROR_MESSAGE);
    } finally {
      setResending(false);
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
            {EMAIL_RE.test(identity.trim()) && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={resending}
                  onClick={onResend}
                >
                  {resending ? "جاري الإرسال..." : "إعادة إرسال رسالة التفعيل"}
                </button>
                {resendDone && (
                  <span role="status" style={{ marginInlineStart: 8 }}>
                    إذا كان البريد مرتبطًا بحساب، فسيتم إرسال رسالة تحقق إليه.
                  </span>
                )}
                {resendError && (
                  <span className="auth-field-error" role="alert" style={{ marginInlineStart: 8 }}>
                    {resendError}
                  </span>
                )}
              </div>
            )}
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
        {challengeRequired && (
          <TurnstileWidget key={captchaKey} onToken={setCaptchaToken} />
        )}
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
