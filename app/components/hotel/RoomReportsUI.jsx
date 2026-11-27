"use client";

// Bono Hotel — Room Reports (Phase 3, UI only).
//
// Same Hotel-only shell as Reception and Room Management: the /hotel server
// layout verifies the shared session once, the CSRF token is held only in the
// layout provider (memory), and no POS auth component, session helper, or POS
// database code is used.
//
// Reporting is read-only. Every figure below is derived from an existing Hotel
// read endpoint (rooms, room types, reservations, stays). There is no report
// API, no occupancy-history API, and no payment/revenue aggregate API.

import { useState } from "react";
import {
  IconBedFilled,
  IconChartBar,
  IconDoorEnter,
} from "@tabler/icons-react";
import Link from "next/link";
import { getAddisYMD } from "@/lib/ethiopianCalendar";
import ManagerSidebar from "@/app/components/ManagerSidebar";
import ManagerTopControls from "@/app/components/ManagerTopControls";
import { useHotelI18n } from "./HotelI18n";
import { useHotelRequest } from "./useHotelRequest";
import RoomReportsPanel from "./RoomReportsPanel";
import {
  BTN_SECONDARY,
  Card,
} from "./ui";

export default function RoomReportsUI() {
  const { lang, t } = useHotelI18n();
  const request = useHotelRequest();
  const [exportHandlers, setExportHandlers] = useState(null);

  const today = getAddisYMD(new Date());
  const canReadReports = true;

  return (
    <div lang={lang} className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col lg:flex-row">
      <ManagerSidebar
        onExportCsv={exportHandlers?.ready ? exportHandlers.exportCsv : null}
        onExportPdf={exportHandlers?.ready ? exportHandlers.exportPdf : null}
      />
      <div className="flex-1 min-w-0 p-4 text-[#1E293B] dark:text-white sm:p-6 overflow-x-hidden">
        <header className="relative rounded-2xl bg-white dark:bg-[#1C1D24] px-4 py-3 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out active:shadow-inner mb-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold text-[#1E293B] dark:text-white sm:text-2xl">
                {t("reports.title")}
              </h1>
            </div>
            <ManagerTopControls />
          </div>
        </header>

        <main id="room-reports-main" tabIndex={-1} className="outline-none">
          {canReadReports ? (
            <RoomReportsPanel
              request={request}
              today={today}
              onExportReady={setExportHandlers}
            />
          ) : (
            <ManagerOnlyNotice />
          )}
        </main>
      </div>
    </div>
  );
}

function ManagerOnlyNotice() {
  const { t } = useHotelI18n();
  return (
    <Card className="p-6 sm:p-8">
      <div className="mx-auto max-w-xl text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FEF9C3] text-[#A16207] dark:bg-[#2A2110] dark:text-[#FCD34D]">
          <IconChartBar className="h-6 w-6" aria-hidden="true" />
        </span>
        <h2 className="mt-3 text-lg font-black text-[#1E293B] dark:text-white">
          {t("reports.managerOnlyTitle")}
        </h2>
        <p className="mt-1 text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">
          {t("reports.managerOnlyBody")}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href="/hotel/rooms" className={BTN_SECONDARY}>
            <IconBedFilled className="h-3.5 w-3.5" aria-hidden="true" />
            {t("top.roomManagement")}
          </Link>
          <Link href="/hotel/reception" className={BTN_SECONDARY}>
            <IconDoorEnter className="h-3.5 w-3.5" aria-hidden="true" />
            {t("top.reception")}
          </Link>
        </div>
      </div>
    </Card>
  );
}
