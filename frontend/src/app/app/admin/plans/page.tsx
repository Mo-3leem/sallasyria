"use client";

import { useEffect, useState } from "react";
import { adminApi } from "@/lib/api";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
} from "@/lib/auth-errors";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { TextField } from "@/components/auth/TextField";
import { FormError } from "@/components/auth/FormError";
import { SlugField, isValidSlug } from "@/components/store/SlugField";
import type { Plan } from "@/types/api";

function parseMoney(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Admin plans: list, create (code immutable kebab-case), edit
 * (name/prices/max only), hard delete (409 while referenced).
 */
export default function AdminPlansPage() {
  const { refresh: refreshAuth } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create form
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [monthly, setMonthly] = useState("0");
  const [yearly, setYearly] = useState("0");
  const [maxProducts, setMaxProducts] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Edit state (per-plan inline)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editMonthly, setEditMonthly] = useState("");
  const [editYearly, setEditYearly] = useState("");
  const [editMax, setEditMax] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<Plan | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.plans.list();
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setError(res.error.message || "تعذّر تحميل الخطط.");
        return;
      }
      setPlans(res.data.plans);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate() {
    if (submitting) return;
    setFieldErrors({});
    setFormError(null);
    setNotice(null);
    const local: Record<string, string> = {};
    if (!isValidSlug(code.trim())) local.code = "الرمز غير صالح: حروف صغيرة وأرقام وشرطات فقط.";
    if (name.trim().length < 1) local.name = "اسم الخطة مطلوب.";
    const mo = parseMoney(monthly);
    const yr = parseMoney(yearly);
    if (mo === null) local.price_monthly = "السعر الشهري رقم صحيح ≥ 0.";
    if (yr === null) local.price_yearly = "السعر السنوي رقم صحيح ≥ 0.";
    let max: number | null = null;
    if (maxProducts.trim() !== "") {
      if (!/^\d+$/.test(maxProducts.trim()) || Number(maxProducts.trim()) < 1) {
        local.max_products = "الحد رقم صحيح ≥ 1، أو اتركه فارغاً لغير المحدود.";
      } else {
        max = Number(maxProducts.trim());
      }
    }
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }
    setSubmitting(true);
    try {
      const res = await adminApi.plans.create({
        code: code.trim(),
        name: name.trim(),
        price_monthly: mo as number,
        price_yearly: yr as number,
        max_products: max,
      });
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        const fields = getFieldErrors(res);
        if (getErrorCode(res) === "plan_code_taken") {
          fields.code = fields.code || "هذا الرمز مستخدم بالفعل.";
        }
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else setFormError(authErrorMessage(res, 400));
        return;
      }
      setNotice(`تم إنشاء الخطة «${res.data.plan.name}».`);
      setCode("");
      setName("");
      setMonthly("0");
      setYearly("0");
      setMaxProducts("");
      await load();
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(plan: Plan) {
    setEditingId(plan.id);
    setEditName(plan.name);
    setEditMonthly(String(plan.price_monthly));
    setEditYearly(String(plan.price_yearly));
    setEditMax(plan.max_products === null ? "" : String(plan.max_products));
    setFormError(null);
  }

  async function saveEdit(plan: Plan) {
    if (savingEdit) return;
    const mo = parseMoney(editMonthly);
    const yr = parseMoney(editYearly);
    if (mo === null || yr === null) {
      setFormError("الأسعار أرقام صحيحة ≥ 0.");
      return;
    }
    let max: number | null | undefined;
    if (editMax.trim() === "") max = null;
    else if (/^\d+$/.test(editMax.trim()) && Number(editMax.trim()) >= 1)
      max = Number(editMax.trim());
    else {
      setFormError("الحد رقم صحيح ≥ 1، أو فارغ لغير المحدود.");
      return;
    }
    const diff: { name?: string; price_monthly?: number; price_yearly?: number; max_products?: number | null } = {};
    if (editName.trim() !== plan.name) diff.name = editName.trim();
    if (mo !== plan.price_monthly) diff.price_monthly = mo;
    if (yr !== plan.price_yearly) diff.price_yearly = yr;
    if (max !== plan.max_products) diff.max_products = max;
    if (Object.keys(diff).length === 0) {
      setEditingId(null);
      return;
    }
    setSavingEdit(true);
    try {
      const res = await adminApi.plans.update(plan.id, diff);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        setFormError(authErrorMessage(res, 400));
        return;
      }
      setEditingId(null);
      setNotice(`تم تحديث الخطة «${res.data.plan.name}».`);
      await load();
    } catch {
      setFormError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSavingEdit(false);
    }
  }

  async function doDelete(plan: Plan) {
    setDeleting(true);
    try {
      const res = await adminApi.plans.remove(plan.id);
      if (!res.ok) {
        if (getErrorCode(res) === "unauthorized") {
          await refreshAuth();
          return;
        }
        if (getErrorCode(res) === "plan_in_use") {
          setError("الخطة مرتبطة باشتراكات ولا يمكن حذفها.");
          return;
        }
        setError(authErrorMessage(res, 400));
        return;
      }
      setPendingDelete(null);
      setNotice(`تم حذف الخطة «${plan.name}».`);
      await load();
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="shell-card">
        <h2 className="shell-card-title">إنشاء خطة</h2>
        <FormError message={formError} />
        {notice && (
          <div className="shell-success" role="status" style={{ marginBottom: 16 }}>
            <i className="fas fa-check-circle" aria-hidden="true"></i>
            <span>{notice}</span>
          </div>
        )}
        <div className="auth-form">
          <SlugField
            value={code}
            label="رمز الخطة (ثابت بعد الإنشاء)"
            placeholder="basic"
            onChange={setCode}
            error={fieldErrors.code}
          />
          <TextField
            label="اسم الخطة"
            id="field-plan-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fieldErrors.name}
          />
          <TextField
            label="السعر الشهري (بالقرش)"
            id="field-plan-monthly"
            dir="ltr"
            inputMode="numeric"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            error={fieldErrors.price_monthly}
          />
          <TextField
            label="السعر السنوي (بالقرش)"
            id="field-plan-yearly"
            dir="ltr"
            inputMode="numeric"
            value={yearly}
            onChange={(e) => setYearly(e.target.value)}
            error={fieldErrors.price_yearly}
          />
          <TextField
            label="حد المنتجات (فارغ = غير محدود)"
            id="field-plan-max"
            dir="ltr"
            inputMode="numeric"
            value={maxProducts}
            onChange={(e) => setMaxProducts(e.target.value)}
            error={fieldErrors.max_products}
          />
          <button
            type="button"
            className="btn btn-primary btn-lg auth-submit"
            disabled={submitting}
            onClick={onCreate}
          >
            {submitting ? "جاري الإنشاء..." : "إنشاء الخطة"}
          </button>
        </div>
      </div>

      <div className="shell-card">
        <h2 className="shell-card-title">الخطط الحالية</h2>
        {loading ? (
          <div className="shell-loading">
            <span className="shell-spinner" aria-hidden="true"></span>
            جاري التحميل...
          </div>
        ) : error ? (
          <div className="shell-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{error}</span>
          </div>
        ) : plans.length === 0 ? (
          <EmptyState icon="fas fa-box-open" title="لا توجد خطط" />
        ) : (
          <div className="shell-stack">
            {plans.map((plan) => {
              const isEditing = editingId === plan.id;
              return (
                <div key={plan.id} className="store-row">
                  <span className="store-row-icon" aria-hidden="true">
                    <i className="fas fa-box-open"></i>
                  </span>
                  <span className="store-row-body">
                    <span className="store-row-name">
                      {plan.name} <span dir="ltr">({plan.code})</span>
                    </span>
                    <span className="store-row-meta">
                      <span>{plan.price_monthly.toLocaleString("ar-SY")} شهرياً</span>
                      <span>·</span>
                      <span>{plan.price_yearly.toLocaleString("ar-SY")} سنوياً</span>
                      <span>·</span>
                      <span>
                        {plan.max_products === null
                          ? "غير محدود"
                          : `حتى ${plan.max_products.toLocaleString("ar-SY")}`}
                      </span>
                    </span>
                    {isEditing && (
                      <span style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input
                          className="auth-input"
                          style={{ maxWidth: 160 }}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="الاسم"
                          aria-label="اسم الخطة"
                        />
                        <input
                          className="auth-input"
                          style={{ maxWidth: 130 }}
                          dir="ltr"
                          inputMode="numeric"
                          value={editMonthly}
                          onChange={(e) => setEditMonthly(e.target.value)}
                          placeholder="شهري"
                          aria-label="السعر الشهري"
                        />
                        <input
                          className="auth-input"
                          style={{ maxWidth: 130 }}
                          dir="ltr"
                          inputMode="numeric"
                          value={editYearly}
                          onChange={(e) => setEditYearly(e.target.value)}
                          placeholder="سنوي"
                          aria-label="السعر السنوي"
                        />
                        <input
                          className="auth-input"
                          style={{ maxWidth: 110 }}
                          dir="ltr"
                          inputMode="numeric"
                          value={editMax}
                          onChange={(e) => setEditMax(e.target.value)}
                          placeholder="الحد"
                          aria-label="حد المنتجات"
                        />
                      </span>
                    )}
                  </span>
                  <span className="store-card-links">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          disabled={savingEdit}
                          onClick={() => saveEdit(plan)}
                        >
                          حفظ
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          onClick={() => setEditingId(null)}
                        >
                          إلغاء
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          onClick={() => startEdit(plan)}
                        >
                          تعديل
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-shell-dark btn-sm"
                          onClick={() => setPendingDelete(plan)}
                        >
                          حذف
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف الخطة؟"
        description="حذف نهائي. الخطط المرتبطة باشتراكات لا يمكن حذفها."
        confirmLabel="حذف"
        confirming={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && doDelete(pendingDelete)}
      />
    </>
  );
}
