"use client";

import { useState, useSyncExternalStore } from "react";
import Image from "next/image";
import LanguageToggle from "@/app/components/LanguageToggle";
import ThemeToggleHome from "@/app/components/ThemeToggleHome";
import { useLanguage } from "@/app/components/LanguageProvider";
import PinLoginModal from "@/app/components/PinLoginModal";
import {
  PageFrame,
  TopControls,
  UNIFIED_PORTALS,
  PortalIcon,
  resolvedText,
} from "@/app/components/HomeNav";

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

// Desktop layout: 4 columns x 2 rows
// MANAGER occupies column 1 and spans both rows
// Row 1: CASHIER (col 2), RECEPTION (col 3), WAITER (col 4)
// Row 2: KITCHEN (col 2), BARISTA (col 3), JEBENA BUNA (col 4)
//
// Mobile layout: 2 columns x 4 rows
// Col 1: WAITER (row 1), RECEPTION (row 2), CASHIER (row 3)
// Col 2: KITCHEN (row 1), BARISTA (row 2), JEBENA BUNA (row 3)
// Row 4: MANAGER spans both columns (col-span-2)
const GRID_CLASSES = {
  WAITER: "col-start-1 row-start-1 lg:col-start-4 lg:row-start-1 min-h-[140px] sm:min-h-[155px]",
  RECEPTION: "col-start-1 row-start-2 lg:col-start-3 lg:row-start-1 min-h-[140px] sm:min-h-[155px]",
  CASHIER: "col-start-1 row-start-3 lg:col-start-2 lg:row-start-1 min-h-[140px] sm:min-h-[155px]",
  KITCHEN: "col-start-2 row-start-1 lg:col-start-2 lg:row-start-2 min-h-[140px] sm:min-h-[155px]",
  BARISTA: "col-start-2 row-start-2 lg:col-start-3 lg:row-start-2 min-h-[140px] sm:min-h-[155px]",
  HOT_DRINK: "col-start-2 row-start-3 lg:col-start-4 lg:row-start-2 min-h-[140px] sm:min-h-[155px]",
  MANAGER:
    "col-span-2 col-start-1 row-start-4 lg:col-span-1 lg:row-span-2 lg:col-start-1 lg:row-start-1 min-h-[160px] lg:min-h-[340px]",
};

export default function PortalHub() {
  const hasMounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { t } = useLanguage();
  const [activePortal, setActivePortal] = useState(null);

  if (!hasMounted) {
    return (
      <div className="flex items-center justify-center space-x-2 min-h-screen bg-[var(--c-bg)]">
        <div className="w-3 h-3 bg-[var(--c-accent)] rounded-full animate-bounce [animation-delay:-0.3s]"></div>
        <div className="w-3 h-3 bg-[var(--c-accent)] rounded-full animate-bounce [animation-delay:-0.15s]"></div>
        <div className="w-3 h-3 bg-[var(--c-accent)] rounded-full animate-bounce"></div>
      </div>
    );
  }

  const handlePortalClick = (portal) => {
    setActivePortal(portal);
  };

  return (
    <PageFrame>
      {/* Upper image section: yellow-tinted in light mode, orange-tinted in dark mode */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[280px] sm:h-[310px] lg:h-[330px] overflow-hidden border-b-2 border-[#FFD600] dark:border-[#FF5E00]"
      >
        <Image
          src="/home/homepage.png"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center opacity-85 select-none"
        />
        <div className="absolute inset-0 bg-[#FFD600] opacity-40 mix-blend-multiply dark:bg-[#FF5E00]" />
        <div className="absolute inset-0 bg-[#FFD600]/15 dark:bg-orange-600/15" />
      </div>

      <div className="hidden lg:block">
        <TopControls />
      </div>

      <main className="relative z-10 flex w-full max-w-5xl flex-col mx-auto px-4 sm:px-6 mt-auto pt-16 pb-3 sm:pt-20 sm:pb-4">
        <div className="text-center mb-6 sm:mb-8">
          <h1 className="text-xl font-black tracking-tight text-[var(--c-text)] sm:text-3xl">
            Avenue Hotel Management System
          </h1>
          <p className="mt-1.5 text-xs font-medium text-[var(--c-muted)] sm:text-sm">
            {resolvedText(t, "homeSubtitleLine1", "One place for every daily operation.")}
          </p>
        </div>

        {/* Mobile-only controls row: Language toggle aligned with WAITER (col 1), Theme toggle aligned with KITCHEN (col 2) */}
        <div className="flex lg:hidden items-center justify-between w-full mb-3 px-0.5">
          <LanguageToggle />
          <ThemeToggleHome />
        </div>

        {/* Unified Seven Staff Portals Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5 w-full">
          {UNIFIED_PORTALS.map((portal) => {
            const title = resolvedText(t, portal.titleKey, portal.fallbackTitle);
            const sub = resolvedText(t, portal.subtitleKey, portal.fallbackDesc);
            const isManager = portal.role === "MANAGER";
            const gridClass = GRID_CLASSES[portal.role] || "";

            return (
              <button
                key={portal.role}
                type="button"
                onClick={() => handlePortalClick(portal)}
                aria-label={title}
                className={`card-elevated tactile group flex flex-col items-center justify-center rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4 sm:p-5 text-center overflow-hidden transition-all duration-150 ease-out hover:border-[var(--c-accent)] hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] active:scale-[0.98] ${gridClass}`}
              >
                <span
                  className={`flex items-center justify-center rounded-2xl bg-transparent text-[var(--c-accent)] transition-transform duration-150 group-hover:scale-110 ${
                    isManager
                      ? "h-14 w-14 sm:h-16 sm:w-16 mb-3 sm:mb-4"
                      : "h-10 w-10 sm:h-12 sm:w-12 mb-2 sm:mb-2.5"
                  }`}
                >
                  <PortalIcon role={portal.role} />
                </span>
                <span
                  className={`font-black tracking-tight text-[var(--c-text)] leading-tight ${
                    isManager ? "text-base sm:text-lg lg:text-xl" : "text-sm sm:text-base"
                  }`}
                >
                  {title}
                </span>
                <span
                  className={`mt-1 line-clamp-2 font-medium text-[var(--c-muted)] leading-tight ${
                    isManager ? "text-xs sm:text-sm max-w-[200px]" : "text-[11px] sm:text-xs"
                  }`}
                >
                  {sub}
                </span>
              </button>
            );
          })}
        </div>
      </main>

      <footer className="py-3 text-center text-xs text-[var(--c-muted)]">
        {t("footer")}
      </footer>

      <PinLoginModal
        key={activePortal?.route || activePortal?.role}
        open={!!activePortal}
        portal={activePortal}
        onClose={() => setActivePortal(null)}
      />
    </PageFrame>
  );
}
