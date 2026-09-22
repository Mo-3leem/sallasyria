"use client";

import { HTMLAttributes, forwardRef } from "react";
import { Button } from "./Button";

export interface ErrorStateProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryText?: string;
}

export const ErrorState = forwardRef<HTMLDivElement, ErrorStateProps>(
  (
    {
      title = "حدث خطأ",
      message = "لم نتمكن من إكمال طلبك. يرجى المحاولة مرة أخرى.",
      onRetry,
      retryText = "إعادة المحاولة",
      className = "",
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      className={`flex flex-col items-center justify-center text-center py-12 px-4 ${className}`}
      {...props}
    >
      <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-red-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-gray-600 mb-6 max-w-md">{message}</p>
      {onRetry && (
        <Button variant="primary" onClick={onRetry}>
          {retryText}
        </Button>
      )}
    </div>
  )
);

ErrorState.displayName = "ErrorState";

export interface InlineErrorProps extends HTMLAttributes<HTMLDivElement> {
  message: string;
}

export const InlineError = forwardRef<HTMLDivElement, InlineErrorProps>(
  ({ message, className = "", ...props }, ref) => (
    <div
      ref={ref}
      className={`flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm ${className}`}
      role="alert"
      {...props}
    >
      <svg
        className="w-5 h-5 flex-shrink-0"
        fill="currentColor"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      </svg>
      <p>{message}</p>
    </div>
  )
);

InlineError.displayName = "InlineError";