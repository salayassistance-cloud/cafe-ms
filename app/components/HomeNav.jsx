"use client";

// Shared homepage / landing navigation pieces.
// Holds the existing BONO portal catalog (routes, icons, labels) so the main
// homepage, the POS landing page and the ROOM landing page use exactly the
// same data, card styling and viewport frame. No business or auth logic here.

import Link from "next/link";
import LanguageToggle from "./LanguageToggle";
import ThemeToggleHome from "./ThemeToggleHome";
import { useLanguage } from "./LanguageProvider";
import {
  IconReceiptFilled,
  IconChefHatFilled,
  IconMugFilled,
  IconCoffee,
  IconDashboardFilled,
  IconBookFilled,
  IconCashRegister,
  IconArchiveFilled,
  IconUsers,
  IconDoor,
  IconBedFilled,
  IconClipboardListFilled,
  IconArrowLeft,
} from "@tabler/icons-react";

export const ICON_PROPS = {
  size: 36,
  stroke: 1.5,
  "aria-hidden": true,
  className: "h-7 w-7",
};

export function PortalIcon({ role }) {
  switch (role) {
    case "WAITER":
      return <IconReceiptFilled {...ICON_PROPS} />;
    case "KITCHEN":
      return <IconChefHatFilled {...ICON_PROPS} />;
    case "BARISTA":
      return <IconMugFilled {...ICON_PROPS} />;
    case "HOT_DRINK":
      return <IconCoffee {...ICON_PROPS} />;
    case "MANAGER":
      return <IconDashboardFilled {...ICON_PROPS} />;
    case "CASHIER":
      return <IconCashRegister {...ICON_PROPS} />;
    case "RECEPTION":
      return <IconDoor {...ICON_PROPS} />;
    case "INVENTORY":
      return <IconArchiveFilled {...ICON_PROPS} />;
    case "STAFF":
      return <IconUsers {...ICON_PROPS} />;
    case "MENU":
      return <IconBookFilled {...ICON_PROPS} />;
    default:
      return null;
  }
}

export function RoomIcon({ role }) {
  switch (role) {
    case "RECEPTION":
      return <IconDoor {...ICON_PROPS} />;
    case "ROOMS":
      return <IconBedFilled {...ICON_PROPS} />;
    case "ROOM_REPORTS":
      return <IconClipboardListFilled {...ICON_PROPS} />;
    default:
      return null;
  }
}

// POS destinations — unchanged routes, PIN authorization and modal flow.
export const PORTALS = [
  {
    role: "MANAGER",
    titleKey: "managerPortal",
    subtitleKey: "managerDesc",
    route: "/manager/reports",
  },
  {
    role: "CASHIER",
    titleKey: "cashierPortal",
    subtitleKey: "cashierDesc",
    route: "/cashier",
    fallbackTitle: "Cashier Portal",
    fallbackDesc: "Billing & payments",
  },
  {
    role: "WAITER",
    titleKey: "waiterPortal",
    subtitleKey: "waiterDesc",
    route: "/waiter",
  },
  {
    role: "KITCHEN",
    titleKey: "kitchenPortal",
    subtitleKey: "kitchenDesc",
    route: "/kds",
  },
  {
    role: "BARISTA",
    titleKey: "baristaPortal",
    subtitleKey: "baristaDesc",
    route: "/barista",
  },
  {
    role: "HOT_DRINK",
    titleKey: "hotDrinkPortal",
    subtitleKey: "hotDrinkDesc",
    route: "/jebena",
    fallbackTitle: "JEBENA BUNA",
    fallbackDesc: "Coffee & hot drinks board",
  },
];

// ROOM destinations — plain links to the existing Hotel routes only.
export const ROOM_PORTALS = [
  {
    role: "RECEPTION",
    titleKey: "receptionPortal",
    subtitleKey: "receptionDesc",
    route: "/hotel/reception",
  },
  {
    role: "ROOMS",
    titleKey: "roomsPortal",
    subtitleKey: "roomsDesc",
    route: "/hotel/rooms",
  },
  {
    role: "ROOM_REPORTS",
    titleKey: "roomReportsPortal",
    subtitleKey: "roomReportsDesc",
    route: "/hotel/reports",
  },
];

// Unified seven staff portals for the main homepage.
export const UNIFIED_PORTALS = [
  {
    role: "MANAGER",
    titleKey: "managerPortal",
    subtitleKey: "managerDesc",
    route: "/manager/reports",
    fallbackTitle: "Manager Reports",
    fallbackDesc: "Sales & analytics",
  },
  {
    role: "CASHIER",
    titleKey: "cashierPortal",
    subtitleKey: "cashierDesc",
    route: "/cashier",
    fallbackTitle: "Cashier Portal",
    fallbackDesc: "Billing & payments",
  },
  {
    role: "RECEPTION",
    titleKey: "receptionPortal",
    subtitleKey: "receptionDesc",
    route: "/hotel/reception",
    fallbackTitle: "Reception",
    fallbackDesc: "Reservations & check-in",
  },
  {
    role: "WAITER",
    titleKey: "waiterPortal",
    subtitleKey: "waiterDesc",
    route: "/waiter",
    fallbackTitle: "Waiter Portal",
    fallbackDesc: "Order entry & payments",
  },
  {
    role: "KITCHEN",
    titleKey: "kitchenPortal",
    subtitleKey: "kitchenDesc",
    route: "/kds",
    fallbackTitle: "Kitchen Display",
    fallbackDesc: "Live prep board",
  },
  {
    role: "BARISTA",
    titleKey: "baristaPortal",
    subtitleKey: "baristaDesc",
    route: "/barista",
    fallbackTitle: "Barista Display",
    fallbackDesc: "Drinks prep board",
  },
  {
    role: "HOT_DRINK",
    titleKey: "hotDrinkPortal",
    subtitleKey: "hotDrinkDesc",
    route: "/jebena",
    fallbackTitle: "JEBENA BUNA",
    fallbackDesc: "Coffee & hot drinks board",
  },
];

export function resolvedText(t, key, fallback) {
  const value = t(key);
  return value !== key ? value : fallback || value;
}

export const TILE_CLASS =
  "card-elevated tactile flex min-h-[104px] h-full w-full flex-col items-center justify-center rounded-2xl p-3 text-center bg-[var(--c-card)] overflow-hidden";

// Square-like destination tiles for the POS / ROOM landing pages.
export const LANDING_TILE_CLASS =
  "card-elevated tactile flex aspect-square w-full flex-col items-center justify-center rounded-2xl p-2 text-center bg-[var(--c-card)] overflow-hidden sm:p-3";

// Consistent application frame: the real viewport, not a decorative mockup.
// dvh is used where supported, with min-h-screen as the CSS fallback.
export function PageFrame({ children, fixed = false }) {
  return (
    <div
      className={`relative flex min-h-screen flex-col overflow-x-hidden bg-[var(--c-bg)] text-[var(--c-text)] ${
        fixed ? "lg:h-dvh lg:overflow-y-auto" : ""
      }`}
      style={{ minHeight: "100dvh" }}
    >
      {children}
    </div>
  );
}

// Single header row shared by all three pages. On landing pages an arrow-only
// back link sits opposite the language/theme controls on the same level.
export function TopControls({ back = false }) {
  const { t } = useLanguage();

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex w-full items-center justify-between px-4 pt-4 sm:px-6 sm:pt-6">
      {back ? (
        <Link
          href="/"
          aria-label={t("backToHome")}
          title={t("backToHome")}
          className="pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#FFD600] dark:text-[#FF5E00] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out active:scale-[0.97]"
        >
          <IconArrowLeft size={18} stroke={2} aria-hidden="true" />
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <div className="pointer-events-auto flex items-center gap-2 sm:gap-3">
        <LanguageToggle />
        <ThemeToggleHome />
      </div>
    </div>
  );
}

// Compact landing shell: centered heading + short subtitle, sized to fit a
// normal desktop viewport without page scrolling.
export function LandingShell({ heading, subtitle, children }) {
  const { t } = useLanguage();

  return (
    <PageFrame fixed>
      <TopControls back />
      <main className="relative z-10 flex w-full max-w-4xl flex-1 items-center mx-auto px-4 sm:px-6 pt-16 pb-3 lg:pt-14">
        <div className="w-full">
          <h1 className="mb-1 text-center text-lg font-black tracking-tight text-[var(--c-text)] sm:text-xl">
            {heading}
          </h1>
          <p className="mb-4 text-center text-xs font-medium text-[var(--c-muted)]">
            {subtitle}
          </p>
          {children}
        </div>
      </main>
      <footer className="py-2 text-center text-xs text-[var(--c-muted)]">
        {t("footer")}
      </footer>
    </PageFrame>
  );
}
