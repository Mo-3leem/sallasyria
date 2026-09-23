"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShopPage } from "@/components/shop/ShopPage";
import { useBuyer } from "@/hooks/useBuyer";
import { NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { TurnstileWidget, TURNSTILE_READY, logCaptchaFailure } from "@/components/auth/TurnstileWidget";
import { getLastRequestId } from "@/lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Buyer registration. Same phone as a prior guest order claims its history. */
export default function BuyerRegisterPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  const router = useRouter();
  const { register } = useBuyer();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  function retryCaptcha() {
    setCaptchaToken(null);
    setCaptchaKey((k) => k + 1);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    const local: Record<string, string> = {};
    if (name.trim().length < 1) local.name = "الاسم مطلوب.";
    if (phone.trim().length < 1) local.phone = "رقم الهاتف مطلوب.";
    if (email.trim() !== "" && !EMAIL_RE.test(email.trim())) local.email = "بريد غير صالح.";
    if (password.length < 8) local.password = "كلمة المرور 8 أحرف على الأقل.";
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
      const res = await register(slug, {
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim() === "" ? null : email.trim(),
        password,
      }, captchaToken ?? undefined);
      if (!res.ok) {
        if (res.code === "user_exists") setFormError("يوجد حساب بهذا الهاتف. سجّل الدخول بدلاً من ذلك.");
        else if (res.code === "email_taken") setFormError("هذا البريد مسجل مسبقاً في المتجر.");
        else if (res.code === "turnstile_required") {
          logCaptchaFailure(res.code, getLastRequestId());
          setFormError("أكمل التحقق الأمني أولاً.");
        }
        else if (res.code === "turnstile_failed") {
          logCaptchaFailure(res.code, getLastRequestId());
          setFormError("فشل التحقق الأمني. حاول مجدداً.");
          retryCaptcha();
        }
        else if (res.code === "turnstile_misconfigured") {
          logCaptchaFailure(res.code, getLastRequestId());
          setFormError("التحقق الأمني غير مفعّل حالياً — تواصل مع الإدارة.");
        }
        else if (res.code === "network_error") setFormError(NETWORK_ERROR_MESSAGE);
        else setFormError("تعذّر إنشاء الحساب. حاول مجدداً.");
        return;
      }
      router.replace(`/s/${encodeURIComponent(slug)}/account`);
    } finally {
      // Turnstile tokens are single-use: every attempt consumes the token,
      // so a retry (taken phone, expired solve) always mints a fresh one.
      retryCaptcha();
      setSubmitting(false);
    }
  }

  return (
    <ShopPage slug={slug} title="إنشاء حساب">
      {() => (
        <div className="shell-card">
          <p className="shell-note" style={{ marginBottom: 12 }}>
            سجّلت بنفس رقم هاتف طلب سابق؟ سيُربط سجل طلباتك بحسابك تلقائياً.
          </p>
          <form className="auth-form" onSubmit={onSubmit} noValidate>
            <FormError message={formError} />
            <TextField label="الاسم" id="br-name" value={name} onChange={(e) => setName(e.target.value)} error={fieldErrors.name} />
            <TextField label="رقم الهاتف" id="br-phone" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={fieldErrors.phone} />
            <TextField label="البريد (اختياري)" id="br-email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} error={fieldErrors.email} />
            <PasswordInput label="كلمة المرور" id="br-password" value={password} onChange={(e) => setPassword(e.target.value)} error={fieldErrors.password} />
            <TurnstileWidget key={captchaKey} onToken={setCaptchaToken} />
            <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={submitting}>
              {submitting ? "جاري إنشاء الحساب..." : "إنشاء الحساب"}
            </button>
          </form>
          <p className="shell-note" style={{ marginTop: 12 }}>
            لديك حساب؟{" "}
            <Link href={`/s/${encodeURIComponent(slug)}/account/login`}>سجّل الدخول</Link>
          </p>
        </div>
      )}
    </ShopPage>
  );
}
