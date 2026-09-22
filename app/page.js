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
  IconCashRegister,
  IconArchiveFilled,
  IconUsers,
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
    case "CASHIER":
      return <IconCashRegister {...iconProps} className="h-9 w-9" />;
    case "INVENTORY":
      return <IconArchiveFilled {...iconProps} className="h-9 w-9" />;
    case "STAFF":
      return <IconUsers {...iconProps} className="h-9 w-9" />;
    case "MENU":
      return <IconBookFilled {...iconProps} className="h-9 w-9" />;
    default:
      return null;
  }
}

const PORTALS = [
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
    role: "INVENTORY",
    titleKey: "inventoryPortal",
    subtitleKey: "inventoryDesc",
    route: "/manager/inventory",
    fallbackTitle: "Inventory",
    fallbackDesc: "Stock & suppliers",
  },
  {
    role: "STAFF",
    titleKey: "staffPortal",
    subtitleKey: "staffDesc",
    route: "/manager/staff",
    fallbackTitle: "Staff",
    fallbackDesc: "Team & accounts",
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

// Mobile: Row1 Cashier|Waiter, Row2 Kitchen|Barista, Row3 Inventory|Staff, Last row Manager full-width.
// Desktop lg: Manager top full-width (lg:col-span-3) then 2 rows × 3 cols. Responsive order moves Manager to top on desktop.
const MOBILE_GRID_ORDER = {
  CASHIER: "order-1 lg:order-2",
  WAITER: "order-2 lg:order-3",
  KITCHEN: "order-3 lg:order-4",
  BARISTA: "order-4 lg:order-5",
  INVENTORY: "order-5 lg:order-6",
  STAFF: "order-6 lg:order-7",
  MANAGER: "order-7 lg:order-1 col-span-2 lg:col-span-3 min-h-[110px] lg:min-h-[140px]",
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
    if (portal.role === "INVENTORY") {
      // Inventory reuses existing MANAGER authorization (no new INVENTORY role per Phase A boundaries)
      // Homepage keeps unique React key via role: "INVENTORY", but PinLoginModal authenticates as MANAGER.
      // Preserve inventory display via fallbackTitle/fallbackDesc and explicit icon override.
      setActive({
        ...portal,
        role: "MANAGER",
        _inventoryDisplayRole: "INVENTORY",
        icon: <IconArchiveFilled size={28} aria-hidden={true} className="h-7 w-7" />,
      });
      return;
    }
    if (portal.role === "STAFF") {
      // Staff reuses MANAGER authorization — no new STAFF role, manager-only administration
      setActive({
        ...portal,
        role: "MANAGER",
        _staffDisplayRole: "STAFF",
        icon: <IconUsers size={28} aria-hidden={true} className="h-7 w-7" />,
      });
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
      {/* Full-width top banner — mobile: brand + subtitle; desktop: hidden (left column shows headline) */}
      <header className="w-full bg-[var(--c-header)] dark:bg-transparent text-[var(--c-text)] py-6 px-4 shadow-sm dark:shadow-none border-b border-[var(--c-border-soft)] dark:border-transparent backdrop-blur lg:hidden">
        <div className="w-full max-w-7xl mx-auto">
          <div className="text-center">
            <h1 className="text-2xl md:text-3xl font-black tracking-tight text-[var(--c-text)]">
              BONO MANAGEMENT SYSTEM
            </h1>
            <p className="text-sm font-medium text-[var(--c-muted)] mt-2">{t('selectPortal')}</p>
            <div className="w-16 h-1 bg-black/15 dark:bg-white/15 rounded-full mx-auto mt-3" />
          </div>
        </div>
      </header>

      {/* Two-column desktop: left introduction, right portals */}
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex-1 flex flex-col lg:flex-row gap-8 lg:gap-10 items-stretch overflow-x-hidden">
        {/* LEFT — introduction */}
        <section className="w-full lg:w-[42%] flex flex-col items-center lg:items-start text-center lg:text-left shrink-0 lg:justify-between gap-4 lg:gap-4">
          <div className="flex flex-col items-center lg:items-start text-center lg:text-left w-full">
            <h1 className="hidden lg:block text-2xl md:text-3xl font-black tracking-tight text-[var(--c-text)]">
              BONO MANAGEMENT SYSTEM
            </h1>
            <p className="hidden lg:block text-sm font-medium text-[var(--c-muted)] mt-2">{t('selectPortal')}</p>
            <div className="hidden lg:block w-16 h-1 bg-black/15 dark:bg-white/15 rounded-full mt-3 mb-4" />
          </div>
          <Image
            src="/home/homepage.png"
            alt="Hotel and café"
            width={1774}
            height={887}
            priority
            className="w-full max-w-sm lg:max-w-md max-h-[32vh] lg:max-h-[36vh] h-auto object-contain mx-auto lg:mx-0 select-none pointer-events-none my-4 lg:my-4"
          />
          <article className="hidden lg:block w-full text-sm leading-relaxed text-[var(--c-muted)] bg-[var(--c-card)] border border-[var(--c-border-soft)] rounded-2xl p-5 shadow-sm text-left lg:mt-auto">
            {t('bonoArticle') !== 'bonoArticle' ? t('bonoArticle') : "Bono Management System helps organize daily hotel and café operations in one place. Staff can access their dedicated portals to manage orders, kitchen and barista preparation, cashier payments, and inventory, while managers oversee operations and reports. The system is designed to make everyday work clearer, more organized, and easier to follow."}
          </article>
        </section>

        {/* RIGHT — portals: Manager full-width top, then 2 rows × 3 cols */}
        <section className="w-full lg:w-[58%] flex flex-col">
          <div className="flex justify-between lg:justify-end items-center gap-3 mb-4 px-1 lg:px-0">
            <div className="shrink-0">
              <LanguageToggle />
            </div>
            <div className="shrink-0">
              <ThemeToggleHome />
            </div>
          </div>
          <main className="grid grid-cols-2 lg:grid-cols-3 gap-5 w-full auto-rows-fr">
            {PORTALS.map((portal) => {
              const title = (() => { const v = t(portal.titleKey); return v !== portal.titleKey ? v : (portal.fallbackTitle || v); })();
              const sub = (() => { const v = t(portal.subtitleKey); return v !== portal.subtitleKey ? v : (portal.fallbackDesc || v); })();
              return (
              <button
                key={portal.role}
                type="button"
                onClick={() => handlePortalClick(portal)}
                className={`card-elevated tactile bg-[var(--c-card)] rounded-2xl p-6 flex flex-col items-center justify-center text-center w-full overflow-hidden min-h-[140px] ${MOBILE_GRID_ORDER[portal.role] || ""}`}
              >
                <span className="flex h-14 w-14 items-center justify-center mb-3 text-[var(--c-accent)]">
                  <PortalIcon role={portal.role} />
                </span>
                <span className="text-base font-bold text-[var(--c-text)] leading-tight">{title}</span>
                <span className="text-xs font-medium text-[var(--c-muted)] mt-1 leading-tight">{sub}</span>
              </button>
            );})}
          </main>
        </section>
      </div>

      <footer className="mt-8 text-center text-xs text-[var(--c-muted)]">
        {t('footer')}
      </footer>

      <PinLoginModal
        key={active?.route || active?.role}
        open={!!active}
        portal={active}
        onClose={() => setActive(null)}
      />
    </div>
  );
}
