"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShopPage } from "@/components/shop/ShopPage";
import { useBuyer } from "@/hooks/useBuyer";
import { authErrorMessage, getErrorCode, getFieldErrors, NETWORK_ERROR_MESSAGE } from "@/lib/auth-errors";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { FormError } from "@/components/auth/FormError";
import { buyerApi } from "@/lib/api";

/** Buyer change password: current + new + confirm. Session survives. */
export default function BuyerChangePasswordPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  return (
    <ShopPage slug={slug} title="تغيير كلمة المرور">
      {() => <ChangePasswordBody slug={slug} />}
    </ShopPage>
  );
}

function ChangePasswordBody({ slug }: { slug: string }) {
  const router = useRouter();
  const { buyerFor, refresh } = useBuyer();
  const buyer = buyerFor(slug);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    refresh(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    if (buyer === undefined) return;
    if (buyer === null) {
      router.replace(`/s/${encodeURIComponent(slug)}/account/login`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyer, slug]);

  if (buyer === undefined) {
    return (
      <div className="shell-card">
        <div className="shell-loading" role="status">
          <span className="shell-spinner" aria-hidden="true"></span>
          جاري تحميل الحساب...
        </div>
      </div>
    );
  }
  if (buyer === null) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSaved(false);
    const local: Record<string, string> = {};
    if (!current) local.current_password = "كلمة المرور الحالية مطلوبة.";
    if (next.length < 8) local.new_password = "كلمة المرور الجديدة 8 أحرف على الأقل.";
    if (next.length > 256) local.new_password = "كلمة المرور الجديدة طويلة جداً.";
    if (confirm !== next) local.confirm = "تأكيد كلمة المرور غير مطابق.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }
    setSubmitting(true);
    try {
      const res = await buyerApi.changePassword(slug, {
        current_password: current,
        new_password: next,
      });
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "invalid_credentials") {
          setFieldErrors({ current_password: "كلمة المرور الحالية غير صحيحة." });
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setSaved(true);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="shell-card">
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        {saved && (
          <p className="shell-success" role="status">
            تم تغيير كلمة المرور بنجاح. جلستك الحالية ما زالت سارية.
          </p>
        )}
        <PasswordInput
          label="كلمة المرور الحالية"
          id="bc-current"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={fieldErrors.current_password}
        />
        <PasswordInput
          label="كلمة المرور الجديدة"
          id="bc-new"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={fieldErrors.new_password}
        />
        <PasswordInput
          label="تأكيد كلمة المرور الجديدة"
          id="bc-confirm"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldErrors.confirm}
        />
        <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={submitting}>
          {submitting ? "جاري الحفظ..." : "تغيير كلمة المرور"}
        </button>
      </form>
      <p className="shell-note mt-12">
        <Link href={`/s/${encodeURIComponent(slug)}/account`}>العودة إلى حسابي</Link>
      </p>
    </div>
  );
}
