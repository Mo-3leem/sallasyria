"use client";

import Link from "next/link";
import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { ShopPage } from "@/components/shop/ShopPage";
import { EmptyState } from "@/components/common/EmptyState";
import { buyerApi } from "@/lib/api";
import { NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";

/** Buyer password reset (link from the reset email). */
export default function BuyerResetPage({ params }: { params: { slug: string } }) {
  return (
    <ShopPage slug={params.slug} title="تعيين كلمة المرور">
      {() => (
        <Suspense fallback={<div className="shell-card"><p className="shell-note">جاري التحميل...</p></div>}>
          <ResetBody slug={params.slug} />
        </Suspense>
      )}
    </ShopPage>
  );
}

function ResetBody({ slug }: { slug: string }) {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    if (password.length < 8) {
      setFormError("كلمة المرور 8 أحرف على الأقل.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await buyerApi.resetPassword(slug, { token, password });
      if (!res.ok) {
        setFormError("الرابط غير صالح أو انتهت صلاحيته.");
        return;
      }
      setDone(true);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="shell-card">
      {done ? (
        <p className="shell-success">
          تم تعيين كلمة المرور.{" "}
          <Link href={`/s/${encodeURIComponent(slug)}/account/login`}>سجّل الدخول</Link>
        </p>
      ) : token === "" ? (
        <div className="shell-card">
          <EmptyState
            icon="fas fa-link-slash"
            title="رابط غير صالح"
            description="انتهت صلاحية رابط التعيين أو أنه غير مكتمل."
            action={
              <Link href={`/s/${encodeURIComponent(slug)}/account/forgot-password`} className="btn btn-outline">
                طلب رابط جديد
              </Link>
            }
          />
        </div>
      ) : (
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <FormError message={formError} />
          <PasswordInput label="كلمة المرور الجديدة" id="brst-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={submitting}>
            {submitting ? "جاري التعيين..." : "تعيين كلمة المرور"}
          </button>
        </form>
      )}
    </div>
  );
}
