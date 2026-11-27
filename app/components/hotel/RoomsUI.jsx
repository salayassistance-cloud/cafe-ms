"use client";

// Bono Hotel — Room Management (Phase 2, UI only).
//
// Same Hotel-only shell as Reception: the /hotel server layout verifies the
// session once, the CSRF token is held only in the layout provider (memory) for
// mutations, and no POS auth component, cookie, or helper is used. Room/type
// mutations require a MANAGER session and the server enforces that independently.

import { useCallback, useEffect, useState } from "react";
import ManagerSidebar from "@/app/components/ManagerSidebar";
import ManagerTopControls from "@/app/components/ManagerTopControls";
import { useHotelI18n } from "./HotelI18n";
import { useHotelRequest } from "./useHotelRequest";
import RoomsPanel from "./RoomsPanel";
import { Banner } from "./ui";

export default function RoomsUI() {
  const { lang, t } = useHotelI18n();
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

  const role = "MANAGER";

  return (
    <div lang={lang} className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col lg:flex-row">
      <ManagerSidebar />
      <div className="flex-1 min-w-0 p-4 text-[#1E293B] dark:text-white sm:p-6 overflow-x-hidden">
        <header className="relative rounded-2xl bg-white dark:bg-[#1C1D24] px-4 py-3 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out active:shadow-inner mb-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold text-[#1E293B] dark:text-white sm:text-2xl">
                {t("top.roomManagement")}
              </h1>
            </div>
            <ManagerTopControls />
          </div>
        </header>

        <main id="rooms-main" tabIndex={-1} className="outline-none">
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
