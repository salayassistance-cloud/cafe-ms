"use client";

import { getAddisYMD } from "@/lib/ethiopianCalendar";
import HotelLanguageToggle from "./HotelLanguageToggle";
import ThemeToggleHome from "@/app/components/ThemeToggleHome";
import { useHotelI18n } from "./HotelI18n";
import { formatEthiopianLocalDate } from "./ui";

const SKIP_CLASS =
  "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[#FFD600] focus:px-4 focus:py-2 focus:text-xs focus:font-extrabold focus:text-[#1E293B] dark:focus:bg-[#FF5E00] dark:focus:text-white";

export default function HotelTopBar({
  titleKey,
  skipHref,
  skipLabelKey,
  actions,
  children,
}) {
  const { lang, t } = useHotelI18n();
  const today = getAddisYMD(new Date());

  return (
    <>
      <a href={skipHref} className={SKIP_CLASS}>
        {t(skipLabelKey)}
      </a>

      <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6 sm:pt-6">
        <header className="rounded-2xl border border-[#E2E8F0]/70 bg-white px-4 py-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] dark:border-[#2A2B36] dark:bg-[#1C1D24] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-black tracking-tight sm:text-2xl">
                {t(titleKey)}
              </h1>
              <p className="mt-0.5 text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
                {formatEthiopianLocalDate(today, lang)}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {actions}
              <HotelLanguageToggle />
              <ThemeToggleHome />
            </div>
          </div>

          {children ? <div className="mt-3">{children}</div> : null}
        </header>
      </div>
    </>
  );
}
