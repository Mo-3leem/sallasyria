"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { GOVERNORATES } from "@/lib/governorates";

export interface ShippingRateFormValues {
  governorate: string;
  shipping_method: string;
  cost: number;
  is_active: 0 | 1;
}

function parseCostMinor(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Shipping-rate create/edit form. Governorate is selectable only on create
 * (immutable on PATCH — delete + recreate to change it); the edit caller
 * hides the field and keeps the stored value.
 */
export function ShippingRateForm({
  initial,
  allowGovernorate,
  submitLabel,
  submitting,
  fieldErrors = {},
  formError = null,
  onSubmit,
}: {
  initial: ShippingRateFormValues;
  allowGovernorate: boolean;
  submitLabel: string;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  onSubmit: (values: ShippingRateFormValues) => void;
}) {
  const [governorate, setGovernorate] = useState(initial.governorate);
  const [method, setMethod] = useState(initial.shipping_method);
  const [cost, setCost] = useState(String(initial.cost));
  const [isActive, setIsActive] = useState<boolean>(initial.is_active === 1);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  function clearLocal(key: string) {
    setLocalErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (
      allowGovernorate &&
      !GOVERNORATES.includes(governorate as (typeof GOVERNORATES)[number])
    )
      local.governorate = "اختر محافظة من القائمة.";
    if (method.trim().length < 1) local.shipping_method = "طريقة الشحن مطلوبة.";
    if (method.trim().length > 200) local.shipping_method = "الاسم طويل جداً.";
    const costNum = parseCostMinor(cost);
    if (costNum === null) local.cost = "التكلفة رقم صحيح ≥ 0 بالقرش.";
    setLocalErrors(local);
    if (Object.keys(local).length > 0 || costNum === null) return;
    onSubmit({
      governorate,
      shipping_method: method.trim(),
      cost: costNum,
      is_active: isActive ? 1 : 0,
    });
  }

  const err = (key: string) => localErrors[key] ?? fieldErrors[key];

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      {allowGovernorate ? (
        <div className="auth-field">
          <label className="auth-label" htmlFor="field-governorate">
            المحافظة
          </label>
          <select
            id="field-governorate"
            className="auth-input"
            value={governorate}
            onChange={(e) => {
              setGovernorate(e.target.value);
              clearLocal("governorate");
            }}
          >
            {GOVERNORATES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="shell-note">
          المحافظة: <strong>{governorate}</strong> (ثابتة — للحصول على محافظة
          أخرى احذف السعر وأنشئ سعراً جديداً).
        </p>
      )}
      <TextField
        label="طريقة الشحن"
        id="field-method"
        placeholder="مثال: Standard"
        maxLength={200}
        value={method}
        onChange={(e) => {
          setMethod(e.target.value);
          clearLocal("shipping_method");
        }}
        error={err("shipping_method")}
      />
      <TextField
        label="التكلفة (بالقرش)"
        id="field-cost"
        dir="ltr"
        inputMode="numeric"
        placeholder="5000"
        value={cost}
        onChange={(e) => {
          setCost(e.target.value);
          clearLocal("cost");
        }}
        error={err("cost")}
      />
      <label className="auth-check">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        <span>نشط</span>
      </label>
      <button
        type="submit"
        className="btn btn-primary btn-lg auth-submit"
        disabled={submitting}
      >
        {submitting ? "جاري الحفظ..." : submitLabel}
      </button>
    </form>
  );
}
