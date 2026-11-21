"use client";

import Link from "next/link";
import { useLanguage } from "@/app/components/LanguageProvider";
import {
  LandingShell,
  ROOM_PORTALS,
  RoomIcon,
  resolvedText,
  LANDING_TILE_CLASS,
} from "@/app/components/HomeNav";

// Dedicated ROOM landing page. Three Hotel cards only, with a compact header.
// Each link enters the unchanged /hotel routes and their server-side session gate.

export default function RoomLandingPage() {
  const { t } = useLanguage();

  return (
    <LandingShell
      heading="ROOM"
      subtitle={resolvedText(t, "roomLandingSubtitle", "Hotel reception, rooms and reporting")}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        {ROOM_PORTALS.map((portal) => {
          const title = resolvedText(t, portal.titleKey, portal.fallbackTitle);
          const sub = resolvedText(t, portal.subtitleKey, portal.fallbackDesc);
          return (
            <Link key={portal.role} href={portal.route} className={LANDING_TILE_CLASS}>
              <span className="flex h-10 w-10 items-center justify-center mb-2 text-[var(--c-accent)]">
                <RoomIcon role={portal.role} />
              </span>
              <span className="text-sm font-bold text-[var(--c-text)] leading-tight break-words">
                {title}
              </span>
              <span className="mt-1 line-clamp-2 text-[11px] font-medium text-[var(--c-muted)] leading-tight">
                {sub}
              </span>
            </Link>
          );
        })}
      </div>
    </LandingShell>
  );
}
