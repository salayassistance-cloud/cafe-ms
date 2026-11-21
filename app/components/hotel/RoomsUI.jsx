"use client";

// Bono Hotel — Room Management (Phase 2, UI only).
//
// Same Hotel-only shell as Reception: the /hotel server layout verifies the
// session once, the CSRF token is held only in the layout provider (memory) for
// mutations, and no POS auth component, cookie, or helper is used. Room/type
// mutations require a MANAGER session and the server enforces that independently.

import { useCallback, useEffect, useState } from "react";
import { IconBedFilled, IconDoorEnter, IconUsers } from "@tabler/icons-react";
import Link from "next/link";
import HotelTopBar from "./HotelTopBar";
import { useHotelI18n } from "./HotelI18n";
import { useHotelSession } from "./HotelSessionProvider";
import { useHotelRequest } from "./useHotelRequest";
import RoomsPanel from "./RoomsPanel";
import {
  Banner,
  BTN_SECONDARY,
} from "./ui";

export default function RoomsUI() {
  const { lang, t } = useHotelI18n();
  // Authentication is owned by the /hotel server layout. The verified session
  // is reused for role display and the shared request wrapper handles CSRF and
  // expired-session refresh, so this screen has no second login or bootstrap.
  const serverSession = useHotelSession();
  const request = useHotelRequest();
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!notice || notice.tone === "error") return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const notify = useCallback((next) => {
    setNotice({ ...next, id: Date.now() });
  }, []);

  const role = serverSession?.role || serverSession?.user?.role;

  return (
    <div lang={lang} className="min-h-screen bg-[#F4F5F9] text-[#1E293B] dark:bg-[#12131A] dark:text-white">
      <HotelTopBar
        titleKey="top.roomManagement"
        skipHref="#rooms-main"
        skipLabelKey="rooms.skip"
        actions={
          <>
            <Link href="/hotel/reception" className={BTN_SECONDARY}>
              <IconDoorEnter className="h-3.5 w-3.5" aria-hidden="true" />
              {t("top.reception")}
            </Link>
            {role === "MANAGER" ? (
              <Link href="/hotel/management" className={BTN_SECONDARY}>
                <IconUsers className="h-3.5 w-3.5" aria-hidden="true" />
                {t("top.staffManagement")}
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mx-auto w-full max-w-7xl px-4 pb-4 sm:px-6 sm:pb-6">
        <main id="rooms-main" tabIndex={-1} className="mt-4 outline-none">
          {notice ? (
            <Banner
              tone={notice.tone || "info"}
              className="mb-4"
              onDismiss={() => setNotice(null)}
            >
              {notice.message}
            </Banner>
          ) : null}

          <RoomsPanel request={request} notify={notify} role={role} />
        </main>
      </div>
    </div>
  );
}
