"use client";

import { useEffect, useState } from "react";

/**
 * Submission cooldown (used after 429 rate-limit responses).
 * Prevents immediate repeated submission while keeping the UI recoverable.
 */
export function useCooldown() {
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  const remaining = Math.max(0, Math.ceil((lockedUntil - now) / 1000));

  const lock = (seconds: number) => {
    setLockedUntil(Date.now() + seconds * 1000);
    setNow(Date.now());
  };

  return { locked: remaining > 0, remaining, lock };
}
