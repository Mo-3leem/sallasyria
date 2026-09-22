import type { ApiError } from "@/types/api";

/**
 * Centralized Arabic mapping for backend auth error codes.
 * The backend envelope is always:
 *   { ok: false, error: { code, message, details? } }
 * `details[]` appears only on 400 `validation_failed`.
 */

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ApiError).ok === false &&
    typeof (value as ApiError).error?.code === "string"
  );
}

export function getErrorCode(res: unknown): string | null {
  return isApiError(res) ? res.error.code : null;
}

/** Field-level errors from `error.details[]` (validation_failed 400s). */
export function getFieldErrors(res: unknown): Record<string, string> {
  if (!isApiError(res) || !Array.isArray(res.error.details)) return {};
  const out: Record<string, string> = {};
  for (const d of res.error.details) {
    if (typeof d?.field === "string" && !(d.field in out)) {
      out[d.field] = d.message || "قيمة غير صالحة.";
    }
  }
  return out;
}

const CODE_MESSAGES: Record<string, string> = {
  invalid_credentials: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  email_not_verified:
    "يجب توثيق البريد الإلكتروني أولاً. تحقق من بريدك الوارد واضغط رابط التفعيل، ثم سجّل الدخول.",
  credentials_rotation_required:
    "يجب تغيير كلمة المرور قبل المتابعة.",
  email_taken: "هذا البريد الإلكتروني مسجّل مسبقاً. سجّل الدخول أو استخدم بريداً آخر.",
  phone_taken: "رقم الهاتف هذا مسجّل مسبقاً. سجّل الدخول أو استخدم رقماً آخر.",
  rate_limited: "محاولات كثيرة في وقت قصير. يرجى الانتظار قليلاً ثم المحاولة مجدداً.",
  invalid_token: "الرابط غير صالح أو منتهي الصلاحية أو مستخدم مسبقاً.",
  invalid_email: "البريد الإلكتروني غير مرتبط بهذا الحساب.",
  current_password_required:
    "كلمة المرور الحالية مطلوبة لتغيير البريد الإلكتروني أو رقم الهاتف.",
  validation_failed: "البيانات المدخلة غير صالحة. راجع الحقول المحددة.",
  unauthorized: "يجب تسجيل الدخول أولاً.",
  forbidden: "غير مصرّح لك بتنفيذ هذا الإجراء.",
  user_not_found: "المستخدم غير موجود.",
  not_found: "غير موجود.",
  internal: "حدث خطأ غير متوقع. حاول مجدداً.",
};

const STATUS_MESSAGES: Record<number, string> = {
  400: "طلب غير صالح. راجع البيانات المدخلة.",
  401: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  403: "غير مصرّح لك بتنفيذ هذا الإجراء.",
  404: "غير موجود.",
  409: "تعارض: هذه القيمة مسجّلة مسبقاً.",
  422: "تعذّر تنفيذ الطلب.",
  429: "محاولات كثيرة في وقت قصير. يرجى الانتظار قليلاً ثم المحاولة مجدداً.",
};

export const NETWORK_ERROR_MESSAGE =
  "تعذّر الاتصال بالخادم. تحقق من اتصالك بالإنترنت وحاول مجدداً.";

/**
 * Resolve a user-facing Arabic message for a failed API result.
 * Prefers the curated Arabic map; falls back to the backend's own
 * message (preserves useful details), then status-based text.
 */
export function authErrorMessage(res: unknown, status?: number): string {
  const code = getErrorCode(res);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (isApiError(res) && res.error.message) return res.error.message;
  if (status !== undefined && STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  return "حدث خطأ غير متوقع. حاول مجدداً.";
}
