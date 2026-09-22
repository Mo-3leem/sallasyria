"use client";

/** 429 notice with remaining cooldown seconds (keeps the UI recoverable). */
export function RateLimitNotice({ remaining }: { remaining: number }) {
  if (remaining <= 0) return null;
  return (
    <div className="auth-rate-limit" role="status">
      <i className="fas fa-hourglass-half" aria-hidden="true"></i>
      <span>
        محاولات كثيرة في وقت قصير. يمكنك المحاولة مجدداً بعد {remaining} ثانية.
      </span>
    </div>
  );
}
