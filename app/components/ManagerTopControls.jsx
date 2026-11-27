"use client";

import Link from "next/link";
import LanguageToggle from "@/app/components/LanguageToggle";
import ThemeToggleHome from "@/app/components/ThemeToggleHome";
import { useLanguage } from "@/app/components/LanguageProvider";

export default function ManagerTopControls({ homeHref = "/", className = "" }) {
  const { t } = useLanguage();

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LanguageToggle />
      <Link
        href={homeHref}
        title={t("home")}
        aria-label={t("home")}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm hover:bg-[#F8FAFC] dark:hover:bg-[#252631] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z"
          />
        </svg>
      </Link>
      <ThemeToggleHome />
    </div>
  );
}
