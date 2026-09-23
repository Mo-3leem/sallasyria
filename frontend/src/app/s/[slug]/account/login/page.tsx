"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShopPage } from "@/components/shop/ShopPage";
import { useBuyer } from "@/hooks/useBuyer";
import { useCart } from "@/hooks/useCart";
import { NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { TextField } from "@/components/auth/TextField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { TurnstileWidget, TURNSTILE_READY } from "@/components/auth/TurnstileWidget";

/** Buyer login: email or phone + password. Guest checkout never needs this. */
export default function BuyerLoginPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  const router = useRouter();
  const { login } = useBuyer();
  const { mergeGuest } = useCart();
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    if (!identity.trim() || !password) {
      setFormError("أدخل الهاتف أو البريد وكلمة المرور.");
      return;
    }
    if (TURNSTILE_READY && !captchaToken) {
      setFormError("أكمل التحقق الأمني أولاً.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await login(slug, identity.trim(), password, captchaToken ?? undefined);
      if (!res.ok) {
        if (res.code === "turnstile_required") {
          setFormError("أكمل التحقق الأمني أولاً.");
          return;
        }
        if (res.code === "turnstile_failed") {
          setFormError("فشل التحقق الأمني. حاول مجدداً.");
          setCaptchaToken(null);
          setCaptchaKey((k) => k + 1);
          return;
        }
        setFormError(
          res.code === "user_not_found"
            ? "بيانات الدخول غير صحيحة."
            : res.code === "network_error"
              ? NETWORK_ERROR_MESSAGE
              : "تعذّر تسجيل الدخول. حاول مجدداً."
        );
        return;
      }
      await mergeGuest(slug);
      router.replace(`/s/${encodeURIComponent(slug)}/account`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ShopPage slug={slug} title="تسجيل الدخول">
      {() => (
        <div className="shell-card">
          <form className="auth-form" onSubmit={onSubmit} noValidate>
            <FormError message={formError} />
            <TextField label="الهاتف أو البريد" id="buyer-identity" dir="ltr" value={identity} onChange={(e) => setIdentity(e.target.value)} />
            <PasswordInput label="كلمة المرور" id="buyer-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <TurnstileWidget key={captchaKey} onToken={setCaptchaToken} />
            <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={submitting}>
              {submitting ? "جاري الدخول..." : "دخول"}
            </button>
          </form>
          <p className="shell-note" style={{ marginTop: 12 }}>
            ليس لديك حساب؟{" "}
            <Link href={`/s/${encodeURIComponent(slug)}/account/register`}>أنشئ حساباً</Link>
            {" · "}
            <Link href={`/s/${encodeURIComponent(slug)}/account/forgot-password`}>نسيت كلمة المرور؟</Link>
          </p>
        </div>
      )}
    </ShopPage>
  );
}
