"use client";

import { useMemo, type ReactNode } from "react";

export interface SummaryLine {
  product_name: string;
  quantity: number;
  unit_price: number;
}

export interface SummaryRate {
  method: string;
  cost: number;
}

export type RateState = "loading" | "ready" | "unavailable" | "error";

/** Minor-unit money in the storefront convention (integer qirsh). */
export function formatQirsh(amount: number): string {
  return `${amount.toLocaleString("ar-SY")} قرش`;
}

/**
 * Checkout order summary: server-cart lines subtotal + the configured
 * shipping rate for the selected governorate. The subtotal is a display
 * estimate from the server cart lines; the server owns the final totals
 * when the order is confirmed.
 */
export function CheckoutSummary({
  lines,
  governorate,
  rateState,
  rate,
  onRetryRates,
  footer,
  serverNote,
}: {
  lines: SummaryLine[];
  governorate: string;
  rateState: RateState;
  rate: SummaryRate | null;
  onRetryRates: () => void;
  footer?: ReactNode;
  serverNote?: string;
}) {
  const itemCount = useMemo(
    () => lines.reduce((s, l) => s + l.quantity, 0),
    [lines]
  );
  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + l.unit_price * l.quantity, 0),
    [lines]
  );
  const total = rateState === "ready" && rate ? subtotal + rate.cost : null;

  return (
    <div className="checkout-summary">
      <h2 className="checkout-summary-title">
        <i className="fas fa-receipt" aria-hidden="true"></i>
        ملخص الطلب
      </h2>

      {lines.length > 0 && (
        <ul className="checkout-summary-lines" aria-label="المنتجات">
          {lines.map((l, i) => (
            <li key={`${l.product_name}-${i}`} className="checkout-summary-line">
              <span className="checkout-summary-line-name">
                {l.product_name}
                <span className="checkout-summary-line-qty" aria-label="الكمية">
                  × {l.quantity.toLocaleString("ar-SY")}
                </span>
              </span>
              <span className="checkout-summary-line-total">
                {formatQirsh(l.unit_price * l.quantity)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="checkout-summary-rows">
        <div className="checkout-summary-row">
          <span>
            المنتجات
            <span className="checkout-summary-count">
              ({itemCount.toLocaleString("ar-SY")})
            </span>
          </span>
          <strong>{formatQirsh(subtotal)}</strong>
        </div>
        <div className="checkout-summary-row">
          <span>
            الشحن
            <span className="checkout-summary-count">· {governorate}</span>
          </span>
          {rateState === "loading" ? (
            <span className="checkout-summary-pending" role="status">
              <span className="account-skeleton account-skeleton-inline" aria-hidden="true"></span>
              جاري الحساب...
            </span>
          ) : rateState === "ready" && rate ? (
            <strong>{formatQirsh(rate.cost)}</strong>
          ) : (
            <strong className="checkout-summary-missing">—</strong>
          )}
        </div>
        {rateState === "ready" && rate && (
          <p className="checkout-summary-method">{rate.method}</p>
        )}
        {rateState === "unavailable" && (
          <div className="account-error" role="alert">
            <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
            <span>الشحن غير متوفر لهذه المحافظة. اختر محافظة أخرى.</span>
          </div>
        )}
        {rateState === "error" && (
          <div className="account-error" role="alert">
            <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
            <span>تعذّر حساب الشحن.</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={onRetryRates}>
              <i className="fas fa-rotate-right" aria-hidden="true"></i>
              إعادة المحاولة
            </button>
          </div>
        )}
        <div className="checkout-summary-row is-total">
          <span>الإجمالي</span>
          <strong>{total === null ? "—" : formatQirsh(total)}</strong>
        </div>
      </div>

      {serverNote && <p className="checkout-summary-note">{serverNote}</p>}

      {footer && <div className="checkout-summary-action">{footer}</div>}
    </div>
  );
}
