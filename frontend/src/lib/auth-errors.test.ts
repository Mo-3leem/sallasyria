import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
  getErrorCode,
  getFieldErrors,
  INVALID_PHONE_MESSAGE,
  isApiError,
  NETWORK_ERROR_MESSAGE,
} from "./auth-errors.js";

const err = (code: string, message = "backend says no", details?: unknown) => ({
  ok: false as const,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

describe("isApiError", () => {
  it("accepts only the failure envelope shape", () => {
    expect(isApiError(err("x"))).toBe(true);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError("nope")).toBe(false);
    expect(isApiError({ ok: true })).toBe(false);
    expect(isApiError({ ok: false })).toBe(false);
    expect(isApiError({ ok: false, error: { code: 42 } })).toBe(false);
    expect(isApiError({ ok: false, error: null })).toBe(false);
  });
});

describe("getErrorCode", () => {
  it("returns the code or null", () => {
    expect(getErrorCode(err("rate_limited"))).toBe("rate_limited");
    expect(getErrorCode({})).toBeNull();
    expect(getErrorCode(null)).toBeNull();
  });
});

describe("getFieldErrors", () => {
  it("keeps the first message per field and defaults missing messages", () => {
    expect(
      getFieldErrors(
        err("validation_failed", "m", [
          { field: "email", message: "taken" },
          { field: "email", message: "ignored-duplicate" },
          { field: "phone" },
        ])
      )
    ).toEqual({ email: "taken", phone: "قيمة غير صالحة." });
  });

  it("returns empty for non-envelopes and non-array details", () => {
    expect(getFieldErrors({})).toEqual({});
    expect(getFieldErrors(err("validation_failed", "m", "nope"))).toEqual({});
    expect(getFieldErrors(err("validation_failed", "m", [{ field: 7 }]))).toEqual({});
  });
});

describe("authErrorMessage priority", () => {
  it("prefers the curated code map over the backend message", () => {
    expect(authErrorMessage(err("invalid_credentials", "custom"))).toBe(
      "البريد الإلكتروني أو رقم الهاتف أو كلمة المرور غير صحيحة."
    );
    expect(authErrorMessage(err("invalid_phone", "custom"))).toBe(INVALID_PHONE_MESSAGE);
  });

  it("falls back to the backend message, then status text, then generic", () => {
    expect(authErrorMessage(err("some_future_code", "backend detail"))).toBe("backend detail");
    expect(authErrorMessage({ ok: true }, 404)).toBe("غير موجود.");
    expect(authErrorMessage(null)).toBe("حدث خطأ غير متوقع. حاول مجدداً.");
    expect(authErrorMessage(null, 418)).toBe("حدث خطأ غير متوقع. حاول مجدداً.");
  });

  it("exposes the shared network message", () => {
    expect(typeof NETWORK_ERROR_MESSAGE).toBe("string");
    expect(NETWORK_ERROR_MESSAGE.length).toBeGreaterThan(0);
  });
});
