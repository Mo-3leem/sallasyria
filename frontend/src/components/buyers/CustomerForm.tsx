"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";

export interface CustomerFormValues {
  name: string;
  phone: string;
  email: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Merchant-private customer edit form (creation is a public buyer upsert —
 * no create usage). Phone is sent raw; the backend normalizes server-side.
 */
export function CustomerForm({
  initial,
  submitLabel,
  submitting,
  fieldErrors = {},
  formError = null,
  onSubmit,
}: {
  initial: CustomerFormValues;
  submitLabel: string;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  onSubmit: (values: CustomerFormValues) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [email, setEmail] = useState(initial.email ?? "");
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
    if (name.trim().length < 1) local.name = "اسم العميل مطلوب.";
    if (name.trim().length > 200) local.name = "الاسم طويل جداً (200 حرف كحد أقصى).";
    if (phone.trim().length < 1) local.phone = "رقم الهاتف مطلوب.";
    if (phone.trim().length > 64) local.phone = "الرقم طويل جداً.";
    if (email.trim() !== "" && !EMAIL_RE.test(email.trim()))
      local.email = "أدخل بريداً إلكترونياً صالحاً أو اتركه فارغاً.";
    setLocalErrors(local);
    if (Object.keys(local).length > 0) return;
    onSubmit({
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim() === "" ? null : email.trim(),
    });
  }

  const err = (key: string) => localErrors[key] ?? fieldErrors[key];

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      <TextField
        label="اسم العميل"
        id="field-name"
        placeholder="مثال: ليلى حداد"
        maxLength={200}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          clearLocal("name");
        }}
        error={err("name")}
      />
      <TextField
        label="رقم الهاتف"
        id="field-phone"
        dir="ltr"
        inputMode="tel"
        placeholder="+963991234567"
        maxLength={64}
        value={phone}
        onChange={(e) => {
          setPhone(e.target.value);
          clearLocal("phone");
        }}
        error={err("phone")}
        hint="يُطبَّع الرقم تلقائياً على الخادم."
      />
      <TextField
        label="البريد الإلكتروني (اختياري)"
        id="field-email"
        dir="ltr"
        placeholder="customer@example.com"
        maxLength={254}
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          clearLocal("email");
        }}
        error={err("email")}
      />
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
