"use client";

import { Fragment } from "react";
import { usePathname } from "next/navigation";
import { useLanguage } from "./LanguageProvider";

const HIDDEN_ROUTES = ["/waiter", "/kitchen", "/barista", "/kds"];

// Selector offers only Amharic and English. Translation data for other
// supported languages is left untouched; it is simply not selectable here.

const TOGGLE_LANGS = ["am", "en"];
const LABELS = { am: "AM", en: "EN" };

export default function LanguageToggle() {
  const pathname = usePathname();
  const { lang, setLang } = useLanguage();
  if (pathname && HIDDEN_ROUTES.some((route) => pathname.startsWith(route))) {
    return null;
  }

  const base =
    "flex h-9 select-none items-center gap-0.5 rounded-full border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-2 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner";
  const seg = (active) =>
    `rounded-full px-1.5 py-1 text-[11px] font-bold leading-none transition-colors duration-150 ${
      active
        ? "bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm"
        : "text-[#64748B] dark:text-[#94A3B8] hover:text-[#1E293B] dark:hover:text-white"
    }`;

  return (
    <div className={base} role="group" aria-label="Language selector">
      {TOGGLE_LANGS.map((code, index) => (
        <Fragment key={code}>
          {index > 0 && (
            <span className="px-0.5 text-[#64748B] dark:text-[#94A3B8]">|</span>
          )}
          <button
            type="button"
            onClick={() => setLang(code)}
            aria-pressed={lang === code}
            className={seg(lang === code)}
          >
            {LABELS[code] || code.toUpperCase()}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
