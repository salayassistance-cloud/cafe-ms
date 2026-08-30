"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import PinLoginModal from "@/app/components/PinLoginModal";
import ThemeToggleHome from "@/app/components/ThemeToggleHome";
import LanguageToggle from "@/app/components/LanguageToggle";
import { useLanguage } from "@/app/components/LanguageProvider";
import {
  IconReceiptFilled,
  IconChefHatFilled,
  IconMugFilled,
  IconDashboardFilled,
  IconBookFilled,
} from "@tabler/icons-react";

// Home Portal Hub — 5 portals with /kds-identical tokens, no hardcoded colors
// Icons: Tabler filled 2D, transparent background, ~32px, brand orange, no box/border

function PortalIcon({ role }) {
  const iconProps = {
    size: 36,
    stroke: 1.5,
    "aria-hidden": true,
  };
  switch (role) {
    case "WAITER":
      return <IconReceiptFilled {...iconProps} className="h-9 w-9" />;
    case "KITCHEN":
      return <IconChefHatFilled {...iconProps} className="h-9 w-9" />;
    case "BARISTA":
      return <IconMugFilled {...iconProps} className="h-9 w-9" />;
    case "MANAGER":
      return <IconDashboardFilled {...iconProps} className="h-9 w-9" />;
    case "MENU":
      return <IconBookFilled {...iconProps} className="h-9 w-9" />;
    default:
      return null;
  }
}

const PORTALS = [
  {
    role: "MENU",
    titleKey: "menuPortal",
    subtitleKey: "menuDesc",
    route: "/menu",
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
    role: "MANAGER",
    titleKey: "managerPortal",
    subtitleKey: "managerDesc",
    route: "/manager/reports",
  },
];

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

// Mobile-only card ordering: 2×2 grid (Menu, Waiter / Kitchen, Barista) then Manager full-width.
// Resets on desktop (md:order-none / md:col-span-1) so the existing 5-column arrangement is preserved.
const MOBILE_GRID_ORDER = {
  MENU: "order-1",
  WAITER: "order-2",
  KITCHEN: "order-3",
  BARISTA: "order-4",
  MANAGER: "order-5 col-span-2 md:col-span-1 min-h-[110px] md:min-h-[140px]",
};

export default function PortalHub() {
  const [active, setActive] = useState(null);
  const hasMounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const router = useRouter();
  const { t } = useLanguage();

  const handlePortalClick = (portal) => {
    if (portal.route === "/menu") {
      // Customer menu is reached via QR / portal — replace history so the
      // homepage is not behind /menu and the device Back button does not
      // return to the homepage. Other portals use the login modal, not push.
      router.replace(portal.route);
      return;
    }
    setActive(portal);
  };

  if (!hasMounted) {
    return (
      <div className="flex items-center justify-center space-x-2 min-h-screen bg-[var(--c-bg)]">
        <div className="w-3 h-3 bg-[var(--c-accent)] rounded-full animate-bounce [animation-delay:-0.3s]"></div>
        <div className="w-3 h-3 bg-[var(--c-accent)] rounded-full animate-bounce [animation-delay:-0.15s]"></div>
        <div className="w-3 h-3 bg-[var(--c-accent)] rounded-full animate-bounce"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--c-bg)] text-[var(--c-text)] flex flex-col items-center overflow-x-hidden">
      {/* Full-width top banner — yellow in light, transparent in dark (matches /kds header) */}
      <header className="w-full bg-[var(--c-header)] dark:bg-transparent text-[var(--c-text)] py-6 px-4 shadow-sm dark:shadow-none border-b border-[var(--c-border-soft)] dark:border-transparent backdrop-blur">
        <div className="w-full max-w-7xl mx-auto">
          <div className="text-center">
            <h1 className="text-2xl md:text-3xl font-black tracking-tight text-[var(--c-text)]">
              {t('brand')}
            </h1>
            <p className="text-sm font-medium text-[var(--c-muted)] mt-2">{t('selectPortal')}</p>
            <div className="w-16 h-1 bg-black/15 dark:bg-white/15 rounded-full mx-auto mt-3" />
          </div>
        </div>
      </header>

      {/* Content wrapper below header — identical structure to /kds main */}
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex-1 flex flex-col justify-center items-center overflow-x-hidden">
        <Image
          src="/home/homepage.png"
          alt="Hotel and café"
          width={1774}
          height={887}
          priority
          className="w-full max-w-sm max-h-[32vh] h-auto object-contain mx-auto select-none pointer-events-none"
        />
        {/* Desktop-only toggle group — below illustration, above cards: [ DARK/LIGHT ] [ AM | EN ] (no container) */}
        <div className="hidden md:flex md:items-center md:justify-center md:gap-2 md:mt-4 md:mb-5">
          <ThemeToggleHome />
          <LanguageToggle />
        </div>
        {/* Mobile-only controls — kept BELOW illustration with a normal card-like gap (desktop uses controls above cards) */}
        <div className="flex w-full max-w-3xl items-center justify-between px-1 sm:px-2 mt-5 mb-5 md:hidden">
          <div className="shrink-0">
            <LanguageToggle />
          </div>
          <div className="shrink-0">
            <ThemeToggleHome />
          </div>
        </div>
        <main className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-5 w-full max-w-6xl mx-auto auto-rows-fr">
          {PORTALS.map((portal) => (
            <button
              key={portal.role}
              type="button"
              onClick={() => handlePortalClick(portal)}
              className={`card-elevated tactile bg-[var(--c-card)] rounded-2xl p-6 flex flex-col items-center justify-center text-center w-full overflow-hidden min-h-[140px] ${MOBILE_GRID_ORDER[portal.role] || ""} md:order-none`}
            >
              <span className="flex h-14 w-14 items-center justify-center mb-3 text-[var(--c-accent)]">
                <PortalIcon role={portal.role} />
              </span>
              <span className="text-base font-bold text-[var(--c-text)] leading-tight">{t(portal.titleKey)}</span>
              <span className="text-xs font-medium text-[var(--c-muted)] mt-1 leading-tight">{t(portal.subtitleKey)}</span>
            </button>
          ))}
        </main>

        <footer className="mt-8 text-center text-xs text-[var(--c-muted)]">
          {t('footer')}
        </footer>
      </div>

      <PinLoginModal
        key={active?.role}
        open={!!active}
        portal={active}
        onClose={() => setActive(null)}
      />
    </div>
  );
}
