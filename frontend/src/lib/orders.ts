/**
 * Order/payment lifecycle mirrors the backend maps exactly
 * (services/orders.ts ORDER_TRANSITIONS / PAYMENT_TRANSITIONS).
 * The UI only offers allowed next states; the backend re-validates.
 */

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "بانتظار التأكيد",
  confirmed: "مؤكد",
  processing: "قيد التجهيز",
  shipped: "تم الشحن",
  delivered: "تم التوصيل",
  cancelled: "ملغي",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "بانتظار الدفع",
  paid: "مدفوع",
  failed: "فشل الدفع",
  refunded: "مسترد",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cod: "الدفع عند الاستلام",
  bank_transfer: "تحويل بنكي",
  wallet: "محفظة إلكترونية",
};

export const NEXT_ORDER_STATUSES: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

export const NEXT_PAYMENT_STATUSES: Record<string, string[]> = {
  pending: ["paid", "failed"],
  paid: ["refunded"],
  failed: ["paid"],
  refunded: [],
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method] ?? method;
}
