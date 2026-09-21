"use client";

import { HTMLAttributes, forwardRef } from "react";

export interface LoadingProps extends HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "md" | "lg";
  text?: string;
}

export const Loading = forwardRef<HTMLDivElement, LoadingProps>(
  ({ size = "md", text, className = "", ...props }, ref) => {
    const sizeStyles = {
      sm: "h-4 w-4",
      md: "h-8 w-8",
      lg: "h-12 w-12",
    };

    return (
      <div
        ref={ref}
        className={`flex flex-col items-center justify-center gap-3 ${className}`}
        {...props}
      >
        <svg
          className={`animate-spin text-[#2E7D32] ${sizeStyles[size]}`}
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        {text && <p className="text-gray-600 text-center">{text}</p>}
      </div>
    );
  }
);

Loading.displayName = "Loading";

export interface LoadingOverlayProps extends HTMLAttributes<HTMLDivElement> {
  isLoading: boolean;
  children: React.ReactNode;
  text?: string;
}

export const LoadingOverlay = ({
  isLoading,
  children,
  text,
  className = "",
  ...props
}: LoadingOverlayProps) => (
  <div className={`relative ${className}`} {...props}>
    {children}
    {isLoading && (
      <div
        className="absolute inset-0 bg-white/80 flex items-center justify-center z-10 rounded-xl"
        role="status"
        aria-live="polite"
      >
        <Loading size="lg" text={text} />
      </div>
    )}
  </div>
);