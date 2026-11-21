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

import {
  IconBedFilled,
  IconChartBar,
  IconDoorEnter,
  IconUsers,
} from "@tabler/icons-react";
import Link from "next/link";
import { getAddisYMD } from "@/lib/ethiopianCalendar";
import HotelTopBar from "./HotelTopBar";
import { useHotelI18n } from "./HotelI18n";
import { useHotelSession } from "./HotelSessionProvider";
import { useHotelRequest } from "./useHotelRequest";
import RoomReportsPanel from "./RoomReportsPanel";
import {
  BTN_SECONDARY,
  Card,
} from "./ui";

export default function RoomReportsUI() {
  const { lang, t } = useHotelI18n();
  // One server-verified Hotel session is shared by Room Management and Room
  // Reports. No duplicate login UI, bootstrap request, or client auth state.
  const serverSession = useHotelSession();
  const request = useHotelRequest();

  const today = getAddisYMD(new Date());
  const role = serverSession?.role || serverSession?.user?.role;
  const canReadReports = role === "MANAGER";

  return (
    <div lang={lang} className="min-h-screen bg-[#F4F5F9] text-[#1E293B] dark:bg-[#12131A] dark:text-white">
      <HotelTopBar
        titleKey="reports.title"
        skipHref="#room-reports-main"
        skipLabelKey="reports.skip"
        actions={
          <>
            <Link href="/hotel/reception" className={BTN_SECONDARY}>
              <IconDoorEnter className="h-3.5 w-3.5" aria-hidden="true" />
              {t("top.reception")}
            </Link>
            <Link href="/hotel/rooms" className={BTN_SECONDARY}>
              <IconBedFilled className="h-3.5 w-3.5" aria-hidden="true" />
              {t("top.roomManagement")}
            </Link>
            {canReadReports ? (
              <Link href="/hotel/management" className={BTN_SECONDARY}>
                <IconUsers className="h-3.5 w-3.5" aria-hidden="true" />
                {t("top.staffManagement")}
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mx-auto w-full max-w-7xl px-4 pb-4 sm:px-6 sm:pb-6">
        <main id="room-reports-main" tabIndex={-1} className="mt-4 outline-none">
          {canReadReports ? (
            <RoomReportsPanel request={request} today={today} />
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
