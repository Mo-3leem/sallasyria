"use client";

export type SubscriptionStatus = "active" | "inactive" | "unknown" | "trialing";

const STATUS_TEXT: Record<SubscriptionStatus, string> = {
  active: "اشتراك نشط",
  inactive: "الاشتراك غير نشط",
  unknown: "حالة الاشتراك غير معروفة",
  trialing: "فترة تجريبية",
};

/**
 * Subscription/plan status badge. The backend exposes no merchant-facing
 * subscription-status endpoint, so callers MUST pass "unknown" unless the
 * status genuinely comes from an authorized source — never guess.
 */
export function SubscriptionBadge({
  status,
  planName,
}: {
  status: SubscriptionStatus;
  planName?: string;
}) {
  return (
    <span className={`sub-badge sub-badge-${status}`}>
      <i className="fas fa-circle sub-badge-dot" aria-hidden="true"></i>
      {planName ? `${planName} · ` : ""}
      {STATUS_TEXT[status]}
    </span>
  );
}
