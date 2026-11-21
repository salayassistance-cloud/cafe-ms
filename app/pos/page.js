"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import PinLoginModal from "@/app/components/PinLoginModal";
import { useLanguage } from "@/app/components/LanguageProvider";
import {
  LandingShell,
  PORTALS,
  PortalIcon,
  resolvedText,
} from "@/app/components/HomeNav";
import { IconArchiveFilled, IconUsers } from "@tabler/icons-react";

// Compact rectangular POS cards. Scoped to /pos so the ROOM landing page keeps
// its existing shared square tiles unchanged.
const POS_TILE_CLASS =
  "card-elevated tactile flex h-[104px] w-full flex-col items-center justify-center rounded-2xl p-2 text-center bg-[var(--c-card)] overflow-hidden sm:h-[116px] sm:p-2.5";

// Dedicated POS landing page. Six POS cards only, with a compact header.
// The PIN verification / navigation flow is the exact flow previously used.

export default function PosLandingPage() {
  const [active, setActive] = useState(null);
  const router = useRouter();
  const { t } = useLanguage();

  const handlePortalClick = (portal) => {
    if (portal.route === "/menu") {
      // Customer menu is reached via QR / portal — replace history so this
      // landing page is not behind /menu and the device Back button does not
      // return here. Other portals use the login modal, not push.
      router.replace(portal.route);
      return;
    }
    if (portal.role === "INVENTORY") {
      // Inventory reuses existing MANAGER authorization (no new INVENTORY role per Phase A boundaries)
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

  return (
    <LandingShell
      heading="POS"
      subtitle={resolvedText(t, "posLandingSubtitle", "Restaurant service and daily operations")}
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:gap-x-5 sm:gap-y-6 lg:grid-cols-3">
        {PORTALS.map((portal) => {
          const title = resolvedText(t, portal.titleKey, portal.fallbackTitle);
          const sub = resolvedText(t, portal.subtitleKey, portal.fallbackDesc);
          return (
            <button
              key={portal.role}
              type="button"
              onClick={() => handlePortalClick(portal)}
              className={POS_TILE_CLASS}
            >
              <span className="flex h-10 w-10 items-center justify-center mb-2 text-[var(--c-accent)]">
                <PortalIcon role={portal.role} />
              </span>
              <span className="text-sm font-bold text-[var(--c-text)] leading-tight break-words">
                {title}
              </span>
              <span className="mt-1 line-clamp-2 text-[11px] font-medium text-[var(--c-muted)] leading-tight">
                {sub}
              </span>
            </button>
          );
        })}
      </div>

      <PinLoginModal
        key={active?.route || active?.role}
        open={!!active}
        portal={active}
        onClose={() => setActive(null)}
      />
    </LandingShell>
  );
}
