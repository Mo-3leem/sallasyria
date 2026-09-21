"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";

export function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="fixed top-0 right-0 left-0 z-50 bg-white/95 backdrop-blur-sm border-b border-gray-100">
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8" aria-label="التنقل الرئيسي">
        <div className="flex h-16 items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-[#2E7D32] hover:opacity-80 transition-opacity"
            aria-label="سلة سوريا - الصفحة الرئيسية"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#E8F5E9] text-[#2E7D32]">
              <svg
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
            </span>
            <span className="font-bold text-xl">
              سلة <span className="text-gray-600 font-normal">سوريا</span>
            </span>
          </Link>

          <div className="hidden md:flex md:items-center md:gap-8">
            <Link
              href="#sectors"
              className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium"
            >
              القطاعات
            </Link>
            <Link
              href="#features"
              className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium"
            >
              المميزات
            </Link>
            <Link
              href="#payments"
              className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium"
            >
              المدفوعات
            </Link>
            <Link
              href="#about"
              className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium"
            >
              عن سلة
            </Link>
            <Link
              href="#partners"
              className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium"
            >
              الشركاء
            </Link>
          </div>

          <div className="hidden md:flex md:items-center md:gap-3">
            <Link href="/auth/login">
              <Button variant="outline" size="md">
                تسجيل الدخول
              </Button>
            </Link>
            <Link href="/auth/register">
              <Button variant="primary" size="md">
                ابدأ مجاناً
              </Button>
            </Link>
          </div>

          <button
            type="button"
            className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
            aria-label="القائمة"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {mobileMenuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>
        </div>

        {mobileMenuOpen && (
          <div
            id="mobile-menu"
            className="md:hidden py-4 border-t border-gray-100 animate-in slide-in-from-top-2 duration-200"
          >
            <div className="flex flex-col gap-4">
              <Link
                href="#sectors"
                className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium px-2 py-2"
              >
                القطاعات
              </Link>
              <Link
                href="#features"
                className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium px-2 py-2"
              >
                المميزات
              </Link>
              <Link
                href="#payments"
                className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium px-2 py-2"
              >
                المدفوعات
              </Link>
              <Link
                href="#about"
                className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium px-2 py-2"
              >
                عن سلة
              </Link>
              <Link
                href="#partners"
                className="text-gray-600 hover:text-[#2E7D32] transition-colors font-medium px-2 py-2"
              >
                الشركاء
              </Link>
              <div className="flex flex-col gap-3 pt-4 border-t border-gray-100">
                <Link href="/auth/login">
                  <Button variant="outline" className="w-full justify-center">
                    تسجيل الدخول
                  </Button>
                </Link>
                <Link href="/auth/register">
                  <Button variant="primary" className="w-full justify-center">
                    ابدأ مجاناً
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}