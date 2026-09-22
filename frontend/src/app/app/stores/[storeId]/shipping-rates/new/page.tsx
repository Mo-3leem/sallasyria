"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { shippingRatesApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import {
  ShippingRateForm,
  type ShippingRateFormValues,
} from "@/components/buyers/ShippingRateForm";
import { EmptyState } from "@/components/common/EmptyState";
import { GOVERNORATES } from "@/lib/governorates";

/** Create a per-governorate rate (409 while the governorate has one). */
export default function NewShippingRatePage({
  params,
}: {
  params: { storeId: string };
}) {
  const { storeId } = params;
  const router = useRouter();
  const { refresh: refreshAuth } = useAuth();
  const [storeMissing, setStoreMissing] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const base = `/app/stores/${encodeURIComponent(storeId)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await shippingRatesApi.list(storeId);
        if (cancelled) return;
        if (!res.ok) {
          if (getErrorCode(res) === "unauthorized") await refreshAuth();
          else if (getErrorCode(res) === "store_not_found") setStoreMissing(true);
        }
      } catch {
        // Creation stays possible; the list is only a store-existence probe.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, refreshAuth]);

  async function onSubmit(values: ShippingRateFormValues) {
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await shippingRatesApi.create(storeId, values);
      if (!res.ok) {
        const code = getErrorCode(res);
        if (code === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (code === "store_not_found") {
          setStoreMissing(true);
          return;
        }
        if (code === "subscription_inactive") {
          setFormError(
            "تعديل الشحن يتطلب اشتراكاً نشطاً. التفعيل يدوياً عبر إدارة المنصة."
          );
          return;
        }
        if (code === "rate_exists") {
          setFormError("المحافظة لها سعر بالفعل — عدّل السعر الحالي بدل إنشاء واحد جديد.");
          return;
        }
        const fields = getFieldErrors(res);
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        setFormError(authErrorMessage(res, 400));
        return;
      }
      router.push(`${base}/shipping-rates`);
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  if (storeMissing) {
    return (
      <div className="shell-card">
        <EmptyState
          icon="fas fa-store-slash"
          title="المتجر غير موجود أو لا تملك صلاحية الوصول إليه."
          action={
            <Link href="/app/stores" className="btn btn-primary">
              العودة إلى المتاجر
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <div className="shell-page-head">
        <h1>إضافة سعر شحن</h1>
        <p>
          <Link href={`${base}/shipping-rates`}>الشحن</Link>
          {" / "}
          سعر جديد
        </p>
      </div>
      <div className="shell-card">
        <ShippingRateForm
          initial={{
            governorate: GOVERNORATES[0],
            shipping_method: "",
            cost: 0,
            is_active: 1,
          }}
          allowGovernorate
          submitLabel="إضافة السعر"
          submitting={submitting}
          fieldErrors={fieldErrors}
          formError={formError}
          onSubmit={onSubmit}
        />
      </div>
    </>
  );
}
