"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { SlugField, isValidSlug } from "./SlugField";

export interface StoreFormValues {
  name: string;
  slug: string;
  currency: string;
}

/**
 * Shared create/edit form. Owns fields + client-side validation (backend
 * rules: name 1–200, slug kebab-case 1–200, currency 1–8). Server errors
 * arrive via props; submit emits clean values only.
 */
export function StoreForm({
  initial,
  submitLabel,
  submitting,
  fieldErrors = {},
  formError = null,
  onSubmit,
}: {
  initial: StoreFormValues;
  submitLabel: string;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  onSubmit: (values: StoreFormValues) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [currency, setCurrency] = useState(initial.currency);
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
    if (name.trim().length < 1) local.name = "اسم المتجر مطلوب.";
    if (name.trim().length > 200) local.name = "اسم المتجر طويل جداً (200 حرف كحد أقصى).";
    if (!isValidSlug(slug.trim()))
      local.slug = "الرابط غير صالح: حروف صغيرة وأرقام وشرطات فقط.";
    if (currency.trim().length < 1) local.currency = "العملة مطلوبة.";
    if (currency.trim().length > 8) local.currency = "العملة طويلة جداً (8 أحرف كحد أقصى).";
    setLocalErrors(local);
    if (Object.keys(local).length > 0) return;
    onSubmit({ name: name.trim(), slug: slug.trim(), currency: currency.trim() });
  }

  const err = (key: string) => localErrors[key] ?? fieldErrors[key];

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      <TextField
        label="اسم المتجر"
        id="field-name"
        placeholder="مثال: إلكترونيات الشام"
        maxLength={200}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          clearLocal("name");
        }}
        error={err("name")}
      />
      <SlugField
        value={slug}
        onChange={(v) => {
          setSlug(v);
          clearLocal("slug");
        }}
        error={err("slug")}
      />
      <TextField
        label="العملة"
        id="field-currency"
        dir="ltr"
        placeholder="SYP"
        maxLength={8}
        value={currency}
        onChange={(e) => {
          setCurrency(e.target.value);
          clearLocal("currency");
        }}
        error={err("currency")}
        hint="رمز العملة، مثال: SYP."
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
