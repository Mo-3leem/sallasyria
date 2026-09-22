"use client";

import { useState, type FormEvent } from "react";
import { authApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useCooldown } from "@/hooks/useCooldown";
import { AuthCard } from "@/components/auth/AuthCard";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { RateLimitNotice } from "@/components/auth/RateLimitNotice";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
  const { locked, remaining, lock } = useCooldown();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked || submitting) return;
    setFieldError(undefined);
    setFormError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setFieldError("أدخل بريداً إلكترونياً صالحاً.");
      return;
    }
    setSubmitting(true);
    try {
      // The backend always answers 200 with the same body (no oracle).
      const res = await authApi.forgotPassword(email.trim());
      if (!res.ok) {
        if (getErrorCode(res) === "rate_limited") lock(30);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setSent(true);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthCard
        title="تحقق من بريدك"
        footer={
          <span>
            <a href="/auth/login">العودة لتسجيل الدخول</a>
          </span>
        }
      >
        <div className="auth-success" role="status">
          <i className="fas fa-envelope-open-text" aria-hidden="true"></i>
          <span>
            إذا كان البريد مسجلاً لدينا، أرسلنا إليه رابط استعادة كلمة المرور
            (صالح لساعة واحدة). تحقق من البريد الوارد ومجلد الرسائل غير
            المرغوبة.
          </span>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="استعادة كلمة المرور"
      subtitle="أدخل بريدك وسنرسل لك رابط الاستعادة."
      footer={
        <span>
          تذكرت كلمة المرور؟ <a href="/auth/login">سجّل الدخول</a>
        </span>
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        <RateLimitNotice remaining={remaining} />
        <TextField
          label="البريد الإلكتروني"
          type="email"
          dir="ltr"
          placeholder="merchant@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          disabled={submitting || locked}
        >
          {submitting ? <Loading size="sm" text="جاري الإرسال..." /> : "إرسال رابط الاستعادة"}
        </Button>
      </form>
    </AuthCard>
  );
}
