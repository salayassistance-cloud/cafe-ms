"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";
import { useLanguage } from "@/app/components/LanguageProvider";
import {
  PageFrame,
  TopControls,
  resolvedText,
} from "@/app/components/HomeNav";
import {
  IconDashboardFilled,
  IconBedFilled,
  IconFileAnalytics,
  IconCashRegister,
  IconReceiptFilled,
  IconChefHatFilled,
  IconMugFilled,
  IconCoffee,
  IconDoor,
  IconClipboardListFilled,
} from "@tabler/icons-react";

// Main homepage — two solid primary cards (POS / ROOM) over the BONO hero.

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

const MODULE_LINK_CLASS =
  "card-elevated tactile flex w-full flex-col items-center justify-center rounded-3xl border border-[var(--c-border)] bg-[var(--c-card)] p-5 text-center overflow-hidden sm:p-6";

const MODULES = [
  {
    href: "/pos",
    titleKey: "restaurantOperationsTitle",
    fallbackTitle: "Restaurant Operations",
    descriptionKey: "posModuleDesc",
    fallback: "Point of sale & kitchen operations",
    columns: true,
    subPages: [
      { label: "Manager Reports", Icon: IconFileAnalytics },
      { label: "Cashier Portal", Icon: IconCashRegister },
      { label: "Waiter Portal", Icon: IconReceiptFilled },
      { label: "Kitchen Display", Icon: IconChefHatFilled },
      { label: "Barista Display", Icon: IconMugFilled },
      { label: "Jebena Buna", Icon: IconCoffee },
    ],
    Icon: IconDashboardFilled,
  },
  {
    href: "/room",
    titleKey: "hotelOperationsTitle",
    fallbackTitle: "Hotel Operations",
    descriptionKey: "roomModuleDesc",
    fallback: "Hotel reception & room operations",
    columns: false,
    subPages: [
      { label: "Reception", Icon: IconDoor },
      { label: "Room Management", Icon: IconBedFilled },
      { label: "Room Reports", Icon: IconClipboardListFilled },
    ],
    Icon: IconBedFilled,
  },
];

function SubPageList({ items, columns }) {
  return (
    <div
      className={`mt-7 w-full ${
        columns ? "grid grid-cols-2 gap-x-3 gap-y-2" : "flex flex-col gap-2"
      }`}
    >
      {items.map(({ label, Icon }) => (
        <span
          key={label}
          className="flex items-center gap-1.5 text-left text-[11px] font-medium leading-tight text-[var(--c-muted)]"
        >
          <Icon
            size={12}
            stroke={2}
            aria-hidden="true"
            className="shrink-0 text-[var(--c-accent)]"
          />
          <span className="break-words">{label}</span>
        </span>
      ))}
    </div>
  );
}

export default function PortalHub() {
  const hasMounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { t } = useLanguage();

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
    <PageFrame>
      <TopControls />

      {/* Upper image region — subtle image with a clear lower boundary */}
      <section
        className="relative w-full shrink-0 overflow-hidden border-b-2 border-[var(--c-accent)]"
        style={{ height: "clamp(280px, 50dvh, 560px)" }}
      >
        <Image
          src="/home/homepage.png"
          alt="Hotel and café"
          fill
          priority
          sizes="100vw"
          className="object-cover object-center opacity-80 select-none pointer-events-none"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[var(--c-header)] opacity-30 dark:bg-[var(--c-accent)] dark:opacity-20"
        />

        {/* Top-centered page heading with a short two-line subtitle */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 mx-auto w-full max-w-3xl px-4 pt-16 text-center sm:pt-20">
          <h1 className="text-lg font-black tracking-tight text-[var(--c-text)] drop-shadow-sm sm:text-2xl">
            Avenue Hotel Management System
          </h1>
          <p className="mt-1 text-xs font-medium leading-snug text-[var(--c-text)] drop-shadow-sm sm:text-sm">
            {resolvedText(t, "homeSubtitleLine1", "One place for every daily operation.")}
            <br />
            {resolvedText(t, "homeSubtitleLine2", "Choose a module to get started.")}
          </p>
        </div>
      </section>

      {/* Lower clean region */}
      <div className="relative z-10 w-full flex-1 bg-[var(--c-bg)]">
        <div className="mx-auto w-full max-w-xl px-4 sm:px-6">
          <div
            className="grid grid-cols-1 gap-10 md:grid-cols-2 sm:gap-12"
            style={{ marginTop: "calc(-1 * clamp(50px, 12dvh, 120px))" }}
          >
            {MODULES.map(({
              href,
              titleKey,
              fallbackTitle,
              descriptionKey,
              fallback,
              subPages,
              columns,
              Icon,
            }) => (
              <Link
                key={href}
                href={href}
                className={MODULE_LINK_CLASS}
                style={{ minHeight: "clamp(310px, 44dvh, 420px)" }}
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-transparent text-[var(--c-accent)]">
                  <Icon size={36} stroke={1.5} aria-hidden="true" />
                </span>
                <span className="mt-4 text-xl font-black tracking-tight text-[var(--c-text)]">
                  {resolvedText(t, titleKey, fallbackTitle)}
                </span>
                <span className="mt-2 line-clamp-2 text-sm font-medium text-[var(--c-muted)]">
                  {resolvedText(t, descriptionKey, fallback)}
                </span>
                <SubPageList items={subPages} columns={columns} />
              </Link>
            ))}
          </div>
        </div>
      </div>

      <footer className="py-5 text-center text-xs text-[var(--c-muted)]">
        {t("footer")}
      </footer>
    </PageFrame>
  );
}
