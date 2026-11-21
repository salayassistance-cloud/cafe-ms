"use client";

// Manager Room Reports — read-only data sections.
//
// API sources:
// - GET /api/hotel/reports/summary   -> the backend aggregate for the selected
//   Addis-Ababa civil-date window: occupancy room-nights and rate, payments
//   (recorded date), voids (void date), posted charges (checkout date),
//   outstanding, ADR, RevPAR, arrivals/check-ins/departures/check-outs, and a
//   live Room/RoomType inventory snapshot. Report copy is business-facing; the
//   backend metric definitions are not rendered in the UI.
// - GET /api/hotel/stays             -> live in-house count and check-in details
// - GET /api/hotel/reservations      -> confirmed arrival details
// - GET /api/hotel/reports/summary/export -> the same aggregation rendered as
//   RFC-4180 CSV (server-side; the browser only opens the download URL)
// - GET /api/hotel/reports/summary/export/pdf -> the same aggregation rendered
//   as an A4 PDF through the Hotel session transport
//
// "Payments collected" is net recorded money, labelled with the recorded-date
// basis. It is never presented as accounting revenue. Occupancy rates stay
// null (shown as —) wherever the room status history cannot establish the
// denominator — never a guessed zero.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBedFilled,
  IconCalendarEvent,
  IconDoorEnter,
  IconFileDownload,
  IconFileTypePdf,
  IconRefresh,
  IconUsers,
} from "@tabler/icons-react";
import EthiopianDateRangePicker from "@/app/components/EthiopianDateRangePicker";
import { hotelDownload, hotelUrl, humanHotelError } from "./hotelApi";
import { useHotelI18n } from "./HotelI18n";
import RoomInventoryReport from "./RoomInventoryReport";
import {
  Banner,
  BTN_SECONDARY,
  Card,
  EmptyState,
  SectionHeader,
  SkeletonRows,
  Spinner,
  StatusBadge,
  formatDateTime,
  formatEthiopianLocalDate,
  humanizeStatus,
  statusTone,
} from "./ui";

// Mirrors HOTEL_ROOM_OPERATIONAL_STATUSES. OCCUPIED and RESERVED are owned by
// the reservation/check-in flow; they are still valid current status filters.
const ROOM_STATUSES = [
  "AVAILABLE",
  "OCCUPIED",
  "RESERVED",
  "CLEANING",
  "MAINTENANCE",
  "OUT_OF_SERVICE",
];

const DAILY_COLUMN_KEYS = [
  "daily.colDate",
  "daily.colOccupied",
  "daily.colAvailable",
  "daily.colOccupancy",
  "daily.colPayments",
  "daily.colVoids",
  "daily.colCharges",
  "daily.colArrivals",
  "daily.colNoShows",
  "daily.colCheckIns",
  "daily.colDepartures",
  "daily.colCheckOuts",
];

const BAR_TONES = {
  green: "bg-[#16A34A] dark:bg-[#4ADE80]",
  blue: "bg-[#2563EB] dark:bg-[#60A5FA]",
  amber: "bg-[#D97706] dark:bg-[#FBBF24]",
  red: "bg-[#DC2626] dark:bg-[#F87171]",
  purple: "bg-[#7C3AED] dark:bg-[#A78BFA]",
  slate: "bg-[#64748B] dark:bg-[#94A3B8]",
};

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

const EMPTY_ACTIVITY = {
  arrivals: null,
  checkIns: null,
};

function formatCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return COUNT_FORMAT.format(Number(value));
}

// Payments live in integer minor units (santim); display uses exact ETB 2dp.
function formatMoney(minor) {
  if (minor === null || minor === undefined || Number.isNaN(Number(minor))) {
    return "—";
  }
  return (Number(minor) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Null rates render as —, never as a fabricated 0%.
function formatPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(Number(pct))) {
    return "—";
  }
  return `${COUNT_FORMAT.format(Number(pct))}%`;
}

function guestNameOf(record, t) {
  return (
    record?.guest?.fullName ||
    record?.guestSnapshot?.fullName ||
    t("common.guestDetailsUnavailable")
  );
}

function reservationRoomOf(reservation, t) {
  return (
    reservation?.room?.roomNumber ||
    reservation?.roomSnapshot?.roomNumber ||
    t("common.unassigned")
  );
}

function stayRoomOf(stay) {
  return stay?.room?.roomNumber || stay?.roomSnapshot?.roomNumber || "—";
}

function statusLabel(status, t) {
  if (!status) return "—";
  return t(`status.${status}`, undefined, humanizeStatus(status));
}

function LocalDateCell({ ymd }) {
  const { lang } = useHotelI18n();
  return (
    <span className="block">{formatEthiopianLocalDate(ymd, lang) || "—"}</span>
  );
}

export default function RoomReportsPanel({ request, today }) {
  const { t, lang } = useHotelI18n();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState(null);
  const [summary, setSummary] = useState({
    totalRooms: null,
    activeRooms: null,
    inactiveRooms: null,
    statuses: null,
  });
  const [inHouse, setInHouse] = useState(null);
  const [activity, setActivity] = useState(EMPTY_ACTIVITY);
  const [loading, setLoading] = useState(true);
  const [dataNotice, setDataNotice] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(null);

  const summaryFailed = report === null && loadedAt !== null;
  const loadIdRef = useRef(0);
  const abortRef = useRef(null);
  const rangeInvalid = Boolean(from && to && from > to);

  const load = useCallback(async () => {
    if (!from || !to || from > to) {
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++loadIdRef.current;

    setLoading(true);
    setDataNotice(null);

    const signal = controller.signal;
    const [summaryResult, inHouseResult, arrivalsResult, checkInsResult] =
      await Promise.allSettled([
        request(hotelUrl("/api/hotel/reports/summary", { from, to }), { signal }),
        request(
          hotelUrl("/api/hotel/stays", { status: "IN_HOUSE", limit: 1, offset: 0 }),
          { signal }
        ),
        request(
          hotelUrl("/api/hotel/reservations", {
            status: "CONFIRMED",
            arrivalFrom: from,
            arrivalTo: to,
            limit: 8,
            offset: 0,
          }),
          { signal }
        ),
        request(
          hotelUrl("/api/hotel/stays", {
            checkedInFrom: from,
            checkedInTo: to,
            limit: 8,
            offset: 0,
          }),
          { signal }
        ),
      ]);

    if (loadIdRef.current !== requestId) return;

    const totalOf = (result) =>
      result.status === "fulfilled" && typeof result.value?.total === "number"
        ? result.value.total
        : null;
    const itemsOf = (result) =>
      result.status === "fulfilled" && Array.isArray(result.value?.items)
        ? result.value.items
        : [];

    if (summaryResult.status === "fulfilled") {
      const data = summaryResult.value ?? {};
      setReport(data);
      const inventory = data.inventory ?? {};
      setSummary({
        totalRooms: inventory.roomsTotal ?? null,
        activeRooms: inventory.roomsActive ?? null,
        inactiveRooms: inventory.roomsInactive ?? null,
        statuses: ROOM_STATUSES.map((status) => ({
          status,
          total: inventory.roomsByOperationalStatus?.[status] ?? null,
        })),
      });
    } else {
      setReport(null);
      setSummary({ totalRooms: null, activeRooms: null, inactiveRooms: null, statuses: null });
    }

    setInHouse(totalOf(inHouseResult));
    setActivity({
      arrivals: {
        total: totalOf(arrivalsResult),
        items: itemsOf(arrivalsResult),
      },
      checkIns: {
        total: totalOf(checkInsResult),
        items: itemsOf(checkInsResult),
      },
    });

    if (summaryResult.status === "rejected" && summaryResult.reason?.status !== 401) {
      setDataNotice({
        tone: "error",
        message: t("reports.loadError", {
          detail: humanHotelError(summaryResult.reason, t("common.connectionRetry")),
        }),
      });
    } else {
      const failures = [inHouseResult, arrivalsResult, checkInsResult].filter(
        (result) =>
          result.status === "rejected" &&
          result.reason?.name !== "AbortError" &&
          result.reason?.status !== 401
      );
      if (failures.length > 0) {
        setDataNotice({
          tone: "warning",
          message: t("reports.partialError", { count: failures.length }),
        });
      }
    }

    setLoadedAt(new Date().toISOString());
    setLoading(false);
  }, [from, request, to, t]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      load();
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      loadIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, [load]);

  function applyWindow(nextFrom, nextTo) {
    const start = nextFrom || today;
    const end = nextTo || start;
    setFrom(start);
    setTo(end);
    setPdfError(null);
  }

  async function downloadPdf() {
    if (pdfBusy || !from || !to || from > to) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const { blob } = await hotelDownload(
        hotelUrl("/api/hotel/reports/summary/export/pdf", { from, to })
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `hotel-report-${from}-to-${to}.pdf`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setPdfError(humanHotelError(error, t("reports.pdfError")));
    } finally {
      setPdfBusy(false);
    }
  }

  const resetDisabled = from === today && to === today;
  const exportHref = `/api/hotel/reports/summary/export?from=${encodeURIComponent(
    from
  )}&to=${encodeURIComponent(to)}`;
  const showsReport = report !== null;
  const totals = showsReport ? report.totals ?? {} : {};
  const days = showsReport && Array.isArray(report.days) ? report.days : [];
  const coverage = showsReport ? report.denominatorCoverage ?? null : null;
  const inventory = showsReport ? report.inventory ?? {} : {};

  const uncoveredCount = coverage?.uncoveredDates?.length ?? 0;
  const coverageMessage =
    coverage && !coverage.fullyCovered
      ? t("reports.coverageGap", {
          count: formatCount(uncoveredCount),
          starting: uncoveredCount
            ? t("reports.coverageStarting", {
                date: formatEthiopianLocalDate(coverage.uncoveredDates[0], lang),
              })
            : t("reports.coverageEnd"),
        })
      : null;

  return (
    <div className="space-y-4">
      {dataNotice ? (
        <Banner
          tone={dataNotice.tone}
          onDismiss={() => setDataNotice(null)}
          className="mb-0"
        >
          {dataNotice.message}{" "}
          <button
            type="button"
            className="ml-1 underline underline-offset-2 hover:no-underline"
            onClick={load}
          >
            {t("common.tryAgain")}
          </button>
        </Banner>
      ) : null}

      <section aria-labelledby="reports-range-heading">
        <Card className="p-4 sm:p-5">
          <SectionHeader
            title={t("reports.reportDates")}
            action={
              showsReport && !rangeInvalid ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={exportHref}
                    className={BTN_SECONDARY}
                    aria-label={t("reports.exportCsvLabel")}
                  >
                    <IconFileDownload className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("reports.exportCsv")}
                  </a>
                  <button
                    type="button"
                    className={BTN_SECONDARY}
                    onClick={downloadPdf}
                    disabled={pdfBusy || loading}
                    aria-label={t("reports.downloadPdfLabel")}
                    aria-busy={pdfBusy}
                  >
                    {pdfBusy ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <IconFileTypePdf className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {pdfBusy ? t("reports.preparingPdf") : t("reports.downloadPdf")}
                  </button>
                </div>
              ) : null
            }
          />
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <EthiopianDateRangePicker from={from} to={to} onChange={applyWindow} />
            </div>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => {
                setFrom(today);
                setTo(today);
                setPdfError(null);
              }}
              disabled={resetDisabled || loading}
            >
              {t("reports.today")}
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={load}
              disabled={loading || rangeInvalid}
            >
              <IconRefresh
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {t("common.refresh")}
            </button>
          </div>
          {rangeInvalid ? (
            <Banner tone="error" className="mt-3">
              {t("reports.rangeInvalid")}
            </Banner>
          ) : null}
          {pdfError ? (
            <Banner
              tone="error"
              className="mt-3"
              onDismiss={() => setPdfError(null)}
            >
              {pdfError}{" "}
              <button
                type="button"
                className="ml-1 underline underline-offset-2 hover:no-underline"
                onClick={downloadPdf}
              >
                {t("common.tryAgain")}
              </button>
            </Banner>
          ) : null}
        </Card>
      </section>

      <section aria-labelledby="reports-metrics-heading" className="space-y-4">
        <div>
          <h2
            id="reports-metrics-heading"
            className="text-[11px] font-extrabold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]"
          >
            {t("reports.reportTotals")}
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <ReportCard
            label={t("reports.occupiedRoomNights")}
            value={formatCount(totals.occupiedRoomNights)}
            busy={loading && !showsReport}
            Icon={IconBedFilled}
          />
          <ReportCard
            label={t("reports.occupancyRate")}
            value={formatPct(totals.occupancyRatePct)}
            busy={loading && !showsReport}
            Icon={IconUsers}
          />
          <ReportCard
            label={t("reports.paymentsCollected")}
            value={formatMoney(totals.paymentsRecordedMinor)}
            busy={loading && !showsReport}
            Icon={IconCalendarEvent}
          />
          <ReportCard
            label={t("reports.paymentsVoided")}
            value={formatMoney(totals.paymentsVoidedMinor)}
            busy={loading && !showsReport}
            Icon={IconCalendarEvent}
          />
          <ReportCard
            label={t("reports.postedCharges")}
            value={formatMoney(totals.postedRoomChargesMinor)}
            busy={loading && !showsReport}
            Icon={IconDoorEnter}
          />
          <ReportCard
            label={t("reports.outstanding")}
            value={formatMoney(totals.outstandingMinor)}
            busy={loading && !showsReport}
            Icon={IconDoorEnter}
          />
          <ReportCard
            label={t("reports.adr")}
            value={formatMoney(totals.adrMinor)}
            busy={loading && !showsReport}
            Icon={IconUsers}
          />
          <ReportCard
            label={t("reports.revpar")}
            value={formatMoney(totals.revparMinor)}
            busy={loading && !showsReport}
            Icon={IconUsers}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ReportCard
            label={t("reports.scheduledArrivals")}
            value={formatCount(totals.scheduledArrivals)}
            busy={loading && !showsReport}
            Icon={IconCalendarEvent}
          />
          <ReportCard
            label={t("reports.noShowArrivals")}
            value={formatCount(totals.noShowArrivals)}
            busy={loading && !showsReport}
            Icon={IconCalendarEvent}
          />
          <ReportCard
            label={t("reports.actualCheckIns")}
            value={formatCount(totals.checkIns)}
            busy={loading && !showsReport}
            Icon={IconDoorEnter}
          />
          <ReportCard
            label={t("reports.departuresDue")}
            value={formatCount(totals.departuresDue)}
            busy={loading && !showsReport}
            Icon={IconDoorEnter}
          />
          <ReportCard
            label={t("reports.actualCheckOuts")}
            value={formatCount(totals.checkOuts)}
            busy={loading && !showsReport}
            Icon={IconDoorEnter}
          />
        </div>

        {coverageMessage ? (
          <Banner tone="info" className="mb-0">
            {coverageMessage}
          </Banner>
        ) : null}

        {summaryFailed && !loading ? (
          <Card className="p-4 sm:p-5">
            <EmptyState
              title={t("reports.summaryUnavailable")}
              description={t("reports.summaryUnavailableBody")}
              action={
                <button type="button" className={BTN_SECONDARY} onClick={load}>
                  {t("common.tryAgain")}
                </button>
              }
            />
          </Card>
        ) : null}
      </section>

      <Card className="p-4 sm:p-5">
        <SectionHeader title={t("reports.dailyTitle")} />
        <DailyTable days={days} loading={loading} summaryLoaded={showsReport} />
      </Card>

      <section aria-labelledby="reports-live-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2
              id="reports-live-heading"
              className="text-[11px] font-extrabold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]"
            >
              {t("reports.liveSnapshot")}
            </h2>
            <p className="mt-0.5 text-[11px] font-medium text-[#94A3B8] dark:text-[#64748B]">
              {loadedAt
                ? t("reports.updated", { time: formatDateTime(loadedAt) })
                : t("reports.notLoaded")}
            </p>
          </div>
          {loading ? (
            <span
              role="status"
              aria-live="polite"
              className="flex items-center gap-1.5 text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]"
            >
              <Spinner className="h-3 w-3" />
              {t("common.refreshing")}
            </span>
          ) : null}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <ReportCard
            label={t("reports.totalRooms")}
            value={formatCount(summary.totalRooms)}
            busy={loading && summary.totalRooms === null}
            Icon={IconBedFilled}
          />
          <ReportCard
            label={t("reports.activeRooms")}
            value={formatCount(summary.activeRooms)}
            busy={loading && summary.activeRooms === null}
            Icon={IconBedFilled}
          />
          <ReportCard
            label={t("reports.inactiveRooms")}
            value={formatCount(summary.inactiveRooms)}
            busy={loading && summary.inactiveRooms === null}
            Icon={IconBedFilled}
          />
          <ReportCard
            label={t("reports.inHouseNow")}
            value={formatCount(inHouse)}
            busy={loading && inHouse === null}
            Icon={IconUsers}
          />
        </div>
      </section>

      <Card className="p-4 sm:p-5">
        <SectionHeader title={t("reports.currentStatus")} />
        <div className="mt-4">
          <StatusBars statuses={summary.statuses} loading={loading} />
        </div>
        <p className="mt-3 text-[11px] font-medium text-[#94A3B8] dark:text-[#64748B]">
          {t("reports.roomTypesSummary", {
            total: formatCount(inventory.roomTypesTotal),
            active: formatCount(inventory.roomTypesActive),
          })}
        </p>
      </Card>

      <section aria-labelledby="reports-activity-heading" className="space-y-4">
        <div>
          <h2
            id="reports-activity-heading"
            className="text-[11px] font-extrabold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]"
          >
            {t("reports.activityTitle")}
          </h2>
        </div>

        <ActivityTable
          title={t("reports.arrivalsTitle")}
          subtitle={t("reports.arrivalsSubtitle")}
          data={activity.arrivals}
          loading={loading}
          columnKeys={[
            "res.colReservation",
            "common.guest",
            "resDetail.arrival",
            "resDetail.departure",
            "common.room",
            "common.status",
          ]}
          minWidthClass="min-w-[48rem]"
          onRetry={load}
          ariaLabel={t("reports.arrivalsAria")}
          emptyTitle={t("reports.arrivalsEmpty")}
          emptyDescription={t("reports.arrivalsEmptyBody")}
          renderRow={(reservation) => (
            <tr
              key={reservation.id}
              className="border-t border-[#E2E8F0] dark:border-[#2A2B36]"
            >
              <td className="px-3 py-2.5 font-extrabold text-[#1E293B] dark:text-white">
                {reservation.reservationNumber || "—"}
              </td>
              <td className="px-3 py-2.5 font-semibold">{guestNameOf(reservation, t)}</td>
              <td className="px-3 py-2.5 font-medium">
                <LocalDateCell ymd={reservation.arrivalLocalDate} />
              </td>
              <td className="px-3 py-2.5 font-medium">
                <LocalDateCell ymd={reservation.departureLocalDate} />
              </td>
              <td className="px-3 py-2.5 font-medium">
                {reservationRoomOf(reservation, t)}
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={reservation.status} />
              </td>
            </tr>
          )}
        />

        <ActivityTable
          title={t("reports.checkInsTitle")}
          subtitle={t("reports.checkInsSubtitle")}
          data={activity.checkIns}
          loading={loading}
          columnKeys={[
            "res.colReservation",
            "common.guest",
            "common.room",
            "inhouse.colCheckedIn",
            "common.status",
          ]}
          minWidthClass="min-w-[40rem]"
          onRetry={load}
          ariaLabel={t("reports.checkInsAria")}
          emptyTitle={t("reports.checkInsEmpty")}
          emptyDescription={t("reports.checkInsEmptyBody")}
          renderRow={(stay) => (
            <tr key={stay.id} className="border-t border-[#E2E8F0] dark:border-[#2A2B36]">
              <td className="px-3 py-2.5 font-extrabold text-[#1E293B] dark:text-white">
                {stay.reservationNumber || "—"}
              </td>
              <td className="px-3 py-2.5 font-semibold">{guestNameOf(stay, t)}</td>
              <td className="px-3 py-2.5 font-medium">{stayRoomOf(stay)}</td>
              <td className="px-3 py-2.5 font-medium">
                <LocalDateCell ymd={stay.checkedInLocalDate} />
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={stay.status} />
              </td>
            </tr>
          )}
        />
      </section>

      <RoomInventoryReport request={request} />
    </div>
  );
}

function ReportCard({ label, value, busy, Icon }) {
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
              {value}
            </p>
          )}
        </div>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#FEF9C3] text-[#A16207] dark:bg-[#2A2110] dark:text-[#FCD34D]">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
    </Card>
  );
}

function DailyTable({ days, loading, summaryLoaded }) {
  const { lang, t } = useHotelI18n();
  const columns = DAILY_COLUMN_KEYS.map((key) => t(key));
  const tableLabel = t("daily.label");

  if (!loading && !summaryLoaded) {
    return (
      <EmptyState
        title={t("daily.unavailable")}
        description={t("daily.unavailableBody")}
      />
    );
  }

  return (
    <div className="mt-3 overflow-x-auto">
      <table
        className="w-full min-w-[72rem] text-left text-xs"
        aria-label={tableLabel}
        aria-busy={loading}
      >
        <caption className="sr-only">{tableLabel}</caption>
        <thead>
          <tr className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
            {columns.map((column, index) => (
              <th key={DAILY_COLUMN_KEYS[index]} scope="col" className="px-3 pb-2">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && days.length === 0 ? (
            <SkeletonRows rows={3} cols={columns.length} />
          ) : days.length > 0 ? (
            days.map((day) => (
              <tr
                key={day.date}
                className="border-t border-[#E2E8F0] dark:border-[#2A2B36]"
              >
                <td className="px-3 py-2.5 font-extrabold text-[#1E293B] dark:text-white">
                  <LocalDateCell ymd={day.date} />
                </td>
                <td className="px-3 py-2.5 font-semibold tabular-nums">
                  {formatCount(day.occupiedRoomNights)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatCount(day.availableRoomNights)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatPct(day.occupancyRatePct)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatMoney(day.paymentsRecordedMinor)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatMoney(day.paymentsVoidedMinor)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatMoney(day.postedRoomChargesMinor)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatCount(day.scheduledArrivals)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatCount(day.noShowArrivals)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatCount(day.checkIns)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatCount(day.departuresDue)}
                </td>
                <td className="px-3 py-2.5 font-medium tabular-nums">
                  {formatCount(day.checkOuts)}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>
                <EmptyState
                  title={t("daily.noDays")}
                  description={t("daily.noDaysBody")}
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatusBars({ statuses, loading }) {
  const { t } = useHotelI18n();
  if (loading && !statuses) {
    return (
      <div className="space-y-3" role="status" aria-live="polite">
        <span className="sr-only">{t("status.loadingCounts")}</span>
        {ROOM_STATUSES.map((status) => (
          <div key={status} className="space-y-1.5">
            <div className="h-3 w-32 animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
            <div className="h-2.5 w-full animate-pulse rounded-full bg-[#F1F5F9] dark:bg-[#252631]" />
          </div>
        ))}
      </div>
    );
  }

  if (!statuses) {
    return (
      <EmptyState
        title={t("status.unavailableTitle")}
        description={t("status.unavailableBody")}
      />
    );
  }

  const allUnavailable = statuses.every((entry) => entry.total === null);
  if (allUnavailable) {
    return (
      <EmptyState
        title={t("status.unavailableTitle")}
        description={t("status.unavailableBody")}
      />
    );
  }

  const allZero = statuses.every((entry) => entry.total === 0);
  if (allZero) {
    return (
      <EmptyState
        title={t("status.noRoomsTitle")}
        description={t("status.noRoomsBody")}
      />
    );
  }

  const maxCount = Math.max(
    ...statuses.map((entry) => (typeof entry.total === "number" ? entry.total : 0)),
    0
  );

  return (
    <ul className="space-y-3" aria-label={t("status.countsAria")}>
      {statuses.map(({ status, total }) => {
        const width =
          typeof total === "number" && total > 0 && maxCount > 0
            ? Math.max(2, (total / maxCount) * 100)
            : 0;
        return (
          <li key={status}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-bold text-[#1E293B] dark:text-white">
                {statusLabel(status, t)}
              </span>
              <span className="text-xs font-black tabular-nums text-[#1E293B] dark:text-white">
                {formatCount(total)}
              </span>
            </div>
            <div
              className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-[#F1F5F9] dark:bg-[#252631]"
              aria-hidden="true"
            >
              <div
                className={`h-full rounded-full ${BAR_TONES[statusTone(status)] || BAR_TONES.slate}`}
                style={{ width: `${width}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ActivityTable({
  title,
  subtitle,
  data,
  loading,
  columnKeys,
  minWidthClass,
  onRetry,
  ariaLabel,
  emptyTitle,
  emptyDescription,
  renderRow,
}) {
  const { t } = useHotelI18n();
  const columns = columnKeys.map((key) => t(key));
  const items = Array.isArray(data?.items) ? data.items : [];
  const unavailable = !loading && (!data || data.total === null);

  return (
    <Card className="p-4 sm:p-5">
      <SectionHeader
        title={title}
        subtitle={subtitle}
        action={
          data && data.total !== null ? (
            <span className="text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">
              {t("reports.showingOf", {
                count: items.length,
                total: formatCount(data.total),
              })}
            </span>
          ) : null
        }
      />

      {unavailable ? (
        <EmptyState
          title={t("reports.unavailableSuffix", { title })}
          description={t("reports.queryFailed")}
          action={
            <button type="button" className={BTN_SECONDARY} onClick={onRetry}>
              {t("common.tryAgain")}
            </button>
          }
        />
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table
            className={`w-full ${minWidthClass} text-left text-xs`}
            aria-label={ariaLabel}
            aria-busy={loading}
          >
            <caption className="sr-only">{ariaLabel}</caption>
            <thead>
              <tr className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
                {columns.map((column, index) => (
                  <th key={columnKeys[index]} scope="col" className="px-3 pb-2">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <SkeletonRows rows={3} cols={columns.length} />
              ) : items.length > 0 ? (
                items.map(renderRow)
              ) : (
                <tr>
                  <td colSpan={columns.length}>
                    <EmptyState title={emptyTitle} description={emptyDescription} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
