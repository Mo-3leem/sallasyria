"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ShopPage } from "@/components/shop/ShopPage";
import { buyerApi } from "@/lib/api";
import { NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";

/** Buyer password reset request. Always succeeds visibly (no oracle). */
export default function BuyerForgotPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  const [identity, setIdentity] = useState("");
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || !identity.trim()) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await buyerApi.forgotPassword(slug, identity.trim());
      if (!res.ok) {
        setFormError("تعذّر إرسال الطلب. حاول مجدداً.");
        return;
      }
      setSent(true);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ShopPage slug={slug} title="نسيت كلمة المرور">
      {() => (
        <div className="shell-card">
          {sent ? (
            <p className="shell-note">
              إن كان بريدك مسجلاً ستصلك رسالة إعادة التعيين.{" "}
              <Link href={`/s/${encodeURIComponent(slug)}/account/login`}>تسجيل الدخول</Link>
            </p>
          ) : (
            <form className="auth-form" onSubmit={onSubmit} noValidate>
              <FormError message={formError} />
              <TextField label="البريد المسجل" id="bf-email" dir="ltr" value={identity} onChange={(e) => setIdentity(e.target.value)} />
              <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={submitting}>
                {submitting ? "جاري الإرسال..." : "إرسال رابط التعيين"}
              </button>
            </form>
          )}
        </div>
      )}
    </ShopPage>
  );
}
