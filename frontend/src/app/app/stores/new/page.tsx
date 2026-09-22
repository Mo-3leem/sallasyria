"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { storesApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { useStores } from "@/hooks/useStores";
import { StoreForm, type StoreFormValues } from "@/components/store/StoreForm";

/** Create store: POST /stores → new store dashboard (URL-first). */
export default function NewStorePage() {
  const router = useRouter();
  const { refresh: refreshAuth } = useAuth();
  const { refresh: refreshStores } = useStores();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(values: StoreFormValues) {
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      // Owner flows from the session; id/role/store_id/owner_id never sent.
      const res = await storesApi.create(values);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        const fields = getFieldErrors(res);
        if (getErrorCode(res) === "slug_taken") {
          fields.slug =
            fields.slug || "هذا الرابط مستخدم بالفعل، اختر رابطًا آخر.";
          // The inline field error says it all — suppress the generic
          // English backend message so it doesn't duplicate/confuse.
          if (Object.keys(fields).length > 0) setFieldErrors(fields);
          return;
        }
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      // Real API response drives navigation — nothing fabricated.
      await refreshStores();
      router.push(`/app/stores/${encodeURIComponent(res.data.store.id)}`);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>إنشاء متجر</h1>
        <p>أنشئ متجراً جديداً — ستتمكن من إضافة المنتجات والبيع بعد التفعيل.</p>
      </div>
      <div className="shell-card">
        <StoreForm
          initial={{ name: "", slug: "", currency: "SYP" }}
          submitLabel="إنشاء المتجر"
          submitting={submitting}
          fieldErrors={fieldErrors}
          formError={formError}
          onSubmit={onSubmit}
        />
      </div>
    </>
  );
}
