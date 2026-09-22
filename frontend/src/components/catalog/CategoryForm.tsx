"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { SlugField, isValidSlug } from "@/components/store/SlugField";
import type { Category } from "@/types/api";

export interface CategoryFormValues {
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
  is_active: 0 | 1;
}

/**
 * Shared category create/edit form. Parent options come from props (same
 * store, provided by the page). The edited category itself is excluded by
 * the caller to prevent self-parenting in the UI (backend re-checks).
 */
export function CategoryForm({
  initial,
  parents,
  excludeId = null,
  submitLabel,
  submitting,
  fieldErrors = {},
  formError = null,
  onSubmit,
}: {
  initial: CategoryFormValues;
  parents: Category[];
  excludeId?: string | null;
  submitLabel: string;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  onSubmit: (values: CategoryFormValues) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [parentId, setParentId] = useState<string>(initial.parent_id ?? "");
  const [sortOrder, setSortOrder] = useState(String(initial.sort_order));
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
    if (name.trim().length < 1) local.name = "اسم التصنيف مطلوب.";
    if (name.trim().length > 200) local.name = "الاسم طويل جداً (200 حرف كحد أقصى).";
    if (!isValidSlug(slug.trim()))
      local.slug = "الرابط غير صالح: حروف صغيرة وأرقام وشرطات فقط.";
    const sort = Number(sortOrder);
    if (!Number.isInteger(sort)) local.sort_order = "الترتيب يجب أن يكون رقماً صحيحاً.";
    setLocalErrors(local);
    if (Object.keys(local).length > 0) return;
    onSubmit({
      name: name.trim(),
      slug: slug.trim(),
      parent_id: parentId === "" ? null : parentId,
      sort_order: sort,
      is_active: isActive ? 1 : 0,
    });
  }

  const err = (key: string) => localErrors[key] ?? fieldErrors[key];
  const options = parents.filter((c) => c.id !== excludeId);

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <FormError message={formError} />
      <TextField
        label="اسم التصنيف"
        id="field-name"
        placeholder="مثال: هواتف"
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
        label="رابط التصنيف"
        placeholder="مثال: phones"
        onChange={(v) => {
          setSlug(v);
          clearLocal("slug");
        }}
        error={err("slug")}
      />
      <div className="auth-field">
        <label className="auth-label" htmlFor="field-parent">
          التصنيف الأب (اختياري)
        </label>
        <select
          id="field-parent"
          className="auth-input"
          value={parentId}
          onChange={(e) => {
            setParentId(e.target.value);
            clearLocal("parent_id");
          }}
        >
          <option value="">بدون أب — تصنيف رئيسي</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="الترتيب"
        id="field-sort"
        dir="ltr"
        inputMode="numeric"
        value={sortOrder}
        onChange={(e) => {
          setSortOrder(e.target.value);
          clearLocal("sort_order");
        }}
        error={err("sort_order")}
        hint="رقم صحيح لترتيب العرض."
      />
      <label className="auth-check">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        <span>نشط (يظهر للعملاء)</span>
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
