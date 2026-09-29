"use client";

import { useState, type FormEvent } from "react";
import { authApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  INVALID_PHONE_MESSAGE,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useCooldown } from "@/hooks/useCooldown";
import { RequireGuest } from "@/components/guards/RequireGuest";
import { AuthCard } from "@/components/auth/AuthCard";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { RateLimitNotice } from "@/components/auth/RateLimitNotice";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";
import { TurnstileWidget, TURNSTILE_READY, logCaptchaFailure } from "@/components/auth/TurnstileWidget";
import { getLastRequestId } from "@/lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RegisterForm() {
  const { locked, remaining, lock } = useCooldown();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  function retryCaptcha() {
    setCaptchaToken(null);
    setCaptchaKey((k) => k + 1);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked || submitting) return;
    setFieldErrors({});
    setFormError(null);

    // Client-side mirrors of the backend contract (min 8 / max 256).
    const local: Record<string, string> = {};
    if (!name.trim()) local.name = "الاسم مطلوب.";
    if (!EMAIL_RE.test(email.trim())) local.email = "أدخل بريداً إلكترونياً صالحاً.";
    if (!phone.trim()) local.phone = "رقم الهاتف مطلوب.";
    if (password.length < 8) local.password = "كلمة المرور 8 أحرف على الأقل.";
    if (password.length > 256) local.password = "كلمة المرور طويلة جداً.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }
    if (TURNSTILE_READY && !captchaToken) {
      setFormError("أكمل التحقق الأمني أولاً.");
      return;
    }
    if (!TURNSTILE_READY) {
      // No widget baked in: no token can ever be produced. Backend answers
      // 400/503; say so instead of pointing at a missing checkbox.
      setFormError("التحقق الأمني غير مفعّل حالياً — تواصل مع الإدارة.");
      return;
    }

    setSubmitting(true);
    try {
      // Backend-controlled fields (id, role, store_id, ...) are never sent:
      // role is forced to merchant server-side.
      const res = await authApi.register({
        email: email.trim(),
        phone: phone.trim(),
        password,
        name: name.trim(),
      }, captchaToken ?? undefined);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "rate_limited") lock(30);
        const fields = getFieldErrors(res);
        if (code === "email_taken") fields.email = fields.email || "هذا البريد مسجّل مسبقاً.";
        if (code === "phone_taken") fields.phone = fields.phone || "هذا الرقم مسجّل مسبقاً.";
        if (code === "invalid_phone") fields.phone = fields.phone || INVALID_PHONE_MESSAGE;
        if (code === "turnstile_required") {
          logCaptchaFailure(code, getLastRequestId());
          setFormError("أكمل التحقق الأمني أولاً.");
        } else if (code === "turnstile_failed") {
          logCaptchaFailure(code, getLastRequestId());
          setFormError("فشل التحقق الأمني. حاول مجدداً.");
          retryCaptcha();
        } else if (code === "turnstile_misconfigured") {
          logCaptchaFailure(code, getLastRequestId());
          setFormError("التحقق الأمني غير مفعّل حالياً — تواصل مع الإدارة.");
        }
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError((prev) => prev ?? authErrorMessage(res, 400));
        return;
      }
      // Registration mints NO session — the merchant must verify, then log in.
      setRegisteredEmail(res.data.user.email ?? email.trim());
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      // Turnstile tokens are single-use: every attempt consumes the token,
      // so a retry always mints a fresh one.
      retryCaptcha();
      setSubmitting(false);
    }
  }

  if (registeredEmail) {
    return (
      <AuthCard
        title="تم إنشاء حسابك"
        footer={
          <span>
            جاهز؟ <a href="/auth/login">سجّل الدخول بعد التفعيل</a>
          </span>
        }
      >
        <div className="auth-success" role="status">
          <i className="fas fa-check-circle" aria-hidden="true"></i>
          <span>
            أرسلنا رابط تفعيل إلى <strong dir="ltr">{registeredEmail}</strong>.
            اضغط الرابط في بريدك لتفعيل حسابك، ثم سجّل الدخول.
          </span>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="أنشئ حساب تاجر"
      subtitle="سجّل متجرك وابدأ البيع مع سلة سوريا."
      footer={
        <span>
          لديك حساب؟ <a href="/auth/login">سجّل الدخول</a>
        </span>
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        <RateLimitNotice remaining={remaining} />
        <TextField
          label="الاسم"
          placeholder="مثال: محمد حداد"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
        />
        <TextField
          label="البريد الإلكتروني"
          type="email"
          dir="ltr"
          placeholder="merchant@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          hint="هوية تسجيل الدخول — يجب تفعيله قبل أول دخول."
        />
        <TextField
          label="رقم الهاتف"
          type="tel"
          dir="ltr"
          placeholder="+963991234567"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={fieldErrors.phone}
        />
        <PasswordInput
          label="كلمة المرور"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          hint="8 أحرف على الأقل."
        />
        <TurnstileWidget key={captchaKey} onToken={setCaptchaToken} />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="btn btn-primary btn-lg auth-submit"
          disabled={submitting || locked}
        >
          {submitting ? <Loading size="sm" text="جاري إنشاء الحساب..." /> : "إنشاء الحساب"}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function RegisterPage() {
  return (
    <RequireGuest>
      <RegisterForm />
    </RequireGuest>
  );
}
