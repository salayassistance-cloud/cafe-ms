"use client";

// Bono Hotel — Reception (Phase 1, UI only).
//
// This screen is deliberately Hotel-only: it talks to the existing Hotel Route
// Handlers through their documented contracts and never imports POS UI, auth,
// or API helpers. The Hotel session cookie is HttpOnly, and the CSRF token is
// held only in the layout-scoped provider (memory) for mutations.
//
// Scope: guests, reservations, room assignment, check-in, in-house stays,
// check-out, folios, and payment recording/voiding. No gateway, deposits,
// refunds, reports, or room management are fabricated here.

import { useCallback, useEffect, useState } from "react";
import {
  IconBedFilled,
  IconCalendarEvent,
  IconClipboardListFilled,
  IconDoorEnter,
  IconRefresh,
  IconUsers,
} from "@tabler/icons-react";
import { getAddisYMD } from "@/lib/ethiopianCalendar";
import { hotelUrl } from "./hotelApi";
import HotelTopBar from "./HotelTopBar";
import { useHotelI18n } from "./HotelI18n";
import { useHotelRequest } from "./useHotelRequest";
import ReservationsPanel from "./ReservationsPanel";
import InHousePanel from "./InHousePanel";
import GuestsPanel from "./GuestsPanel";
import {
  Banner,
  BTN_SECONDARY,
  Card,
  Spinner,
} from "./ui";

const TABS = [
  {
    key: "reservations",
    labelKey: "reception.tabReservations",
    Icon: IconClipboardListFilled,
  },
  { key: "in-house", labelKey: "reception.tabInHouse", Icon: IconBedFilled },
  { key: "guests", labelKey: "reception.tabGuests", Icon: IconUsers },
];

const EMPTY_SUMMARY = {
  arrivals: null,
  inHouse: null,
  availableRooms: null,
  occupiedRooms: null,
};

export default function ReceptionUI() {
  const { lang, t } = useHotelI18n();
  // The /hotel server layout owns authentication and renders the shared PIN
  // gate. This screen only renders with a verified session, so there is no
  // per-page auth state, bootstrap request, or second login UI here.
  const request = useHotelRequest();

  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryNonce, setSummaryNonce] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);

  const [tab, setTab] = useState("reservations");
  const [notice, setNotice] = useState(null);
  const [guestFilter, setGuestFilter] = useState(null);
  const [newReservationGuest, setNewReservationGuest] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      setSummaryBusy(true);
      const today = getAddisYMD(new Date());
      const results = await Promise.allSettled([
        request(
          hotelUrl("/api/hotel/reservations", {
            status: "CONFIRMED",
            arrivalFrom: today,
            arrivalTo: today,
            limit: 1,
            offset: 0,
          })
        ),
        request(hotelUrl("/api/hotel/stays", { status: "IN_HOUSE", limit: 1, offset: 0 })),
        request(
          hotelUrl("/api/hotel/rooms", {
            isActive: "true",
            operationalStatus: "AVAILABLE",
            limit: 1,
            offset: 0,
          })
        ),
        request(
          hotelUrl("/api/hotel/rooms", {
            isActive: "true",
            operationalStatus: "OCCUPIED",
            limit: 1,
            offset: 0,
          })
        ),
      ]);
      if (cancelled) return;
      const totalOf = (result) => {
        if (result.status !== "fulfilled") return null;
        const total = result.value?.total;
        return typeof total === "number" ? total : null;
      };
      setSummary({
        arrivals: totalOf(results[0]),
        inHouse: totalOf(results[1]),
        availableRooms: totalOf(results[2]),
        occupiedRooms: totalOf(results[3]),
      });
      setSummaryBusy(false);
    }

    loadSummary();
    return () => {
      cancelled = true;
    };
  }, [request, summaryNonce]);

  useEffect(() => {
    if (!notice || notice.tone === "error") return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const notify = useCallback((next) => {
    setNotice({ ...next, id: Date.now() });
  }, []);

  const handleChanged = useCallback(() => {
    setDataVersion((value) => value + 1);
    setSummaryNonce((value) => value + 1);
  }, []);

  function openReservationsForGuest(guest) {
    setGuestFilter({ id: guest.id, fullName: guest.fullName });
    setNewReservationGuest(null);
    setTab("reservations");
  }

  function startReservationForGuest(guest) {
    setNewReservationGuest(guest);
    setGuestFilter({ id: guest.id, fullName: guest.fullName });
    setTab("reservations");
  }

  return (
    <div lang={lang} className="min-h-screen bg-[#F4F5F9] text-[#1E293B] dark:bg-[#12131A] dark:text-white">
      <HotelTopBar
        titleKey="reception.title"
        skipHref="#reception-main"
        skipLabelKey="reception.skip"
        actions={
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={() => setSummaryNonce((value) => value + 1)}
            disabled={summaryBusy}
          >
            <IconRefresh className={`h-3.5 w-3.5 ${summaryBusy ? "animate-spin" : ""}`} aria-hidden="true" />
            {t("common.refresh")}
          </button>
        }
      >
        <nav aria-label={t("reception.sections")} className="flex flex-wrap gap-2">
          {TABS.map(({ key, labelKey, Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setTab(key)}
                className={`tactile inline-flex h-10 items-center gap-2 rounded-full border px-4 text-xs font-extrabold transition-colors ${
                  active
                    ? "border-[#FFD600] bg-[#FFD600] text-[#1E293B] shadow-[0_8px_18px_-8px_rgba(0,0,0,0.3)] dark:border-[#FF5E00] dark:bg-[#FF5E00] dark:text-white"
                    : "border-[#E2E8F0] bg-white text-[#1E293B] hover:bg-[#F8FAFC] dark:border-[#2A2B36] dark:bg-[#1C1D24] dark:text-white dark:hover:bg-[#252631]"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {t(labelKey)}
              </button>
            );
          })}
        </nav>
      </HotelTopBar>

      <div className="mx-auto w-full max-w-7xl px-4 pb-4 sm:px-6 sm:pb-6">
        <section aria-labelledby="reception-summary-heading" className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <h2
              id="reception-summary-heading"
              className="text-[11px] font-extrabold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]"
            >
              {t("reception.todayGlance")}
            </h2>
            {summaryBusy ? (
              <span className="flex items-center gap-1.5 text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">
                <Spinner className="h-3 w-3" />
                {t("common.refreshing")}
              </span>
            ) : null}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard
              label={t("reception.arrivalsToday")}
              value={summary.arrivals}
              busy={summaryBusy && summary.arrivals === null}
              hint={t("reception.arrivalsTodayHint")}
              Icon={IconCalendarEvent}
            />
            <SummaryCard
              label={t("reception.inHouseStays")}
              value={summary.inHouse}
              busy={summaryBusy && summary.inHouse === null}
              hint={t("reception.inHouseHint")}
              Icon={IconDoorEnter}
            />
            <SummaryCard
              label={t("reception.availableRooms")}
              value={summary.availableRooms}
              busy={summaryBusy && summary.availableRooms === null}
              hint={t("reception.availableHint")}
              Icon={IconBedFilled}
            />
            <SummaryCard
              label={t("reception.occupiedRooms")}
              value={summary.occupiedRooms}
              busy={summaryBusy && summary.occupiedRooms === null}
              hint={t("reception.occupiedHint")}
              Icon={IconUsers}
            />
          </div>
        </section>

        <main id="reception-main" tabIndex={-1} className="mt-4 outline-none">
          {notice ? (
            <Banner
              tone={notice.tone || "info"}
              className="mb-4"
              onDismiss={() => setNotice(null)}
            >
              {notice.message}
            </Banner>
          ) : null}

          {tab === "reservations" ? (
            <ReservationsPanel
              request={request}
              refreshToken={dataVersion}
              onChanged={handleChanged}
              notify={notify}
              guestFilter={guestFilter}
              onClearGuestFilter={() => setGuestFilter(null)}
              newReservationGuest={newReservationGuest}
              onConsumeNewReservationGuest={() => setNewReservationGuest(null)}
            />
          ) : tab === "in-house" ? (
            <InHousePanel
              request={request}
              refreshToken={dataVersion}
              onChanged={handleChanged}
              notify={notify}
            />
          ) : (
            <GuestsPanel
              request={request}
              refreshToken={dataVersion}
              onChanged={handleChanged}
              notify={notify}
              onViewReservations={openReservationsForGuest}
              onReserve={startReservationForGuest}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, hint, busy, Icon }) {
  return (
    <Card className="p-3.5 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
            {label}
          </p>
          {busy ? (
            <div className="mt-2 h-7 w-12 animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
          ) : (
            <p className="mt-0.5 text-2xl font-black tabular-nums text-[#1E293B] dark:text-white">
              {value === null || value === undefined ? "—" : value}
            </p>
          )}
          <p className="mt-0.5 text-[10px] font-medium leading-tight text-[#94A3B8] dark:text-[#64748B]">
            {hint}
          </p>
        </div>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#FEF9C3] text-[#A16207] dark:bg-[#2A2110] dark:text-[#FCD34D]">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
    </Card>
  );
}
