"use client";

// Reception — reservations.
//
// Supported filters: status, activeOnly, guestId, arrivalFrom/arrivalTo, and
// pagination. Supported actions: create, assign room, check in, cancel, and
// view. There is no reservation search by reservation number or guest name in
// the Hotel API, so guestName/reservationNumber lookups are not offered.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconBan,
  IconBedFilled,
  IconChevronDown,
  IconDoorEnter,
  IconPlus,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import EthiopianDateRangePicker from "@/app/components/EthiopianDateRangePicker";
import { hotelUrl, humanHotelError } from "./hotelApi";
import { useHotelI18n } from "./HotelI18n";
import NewReservationModal from "./NewReservationModal";
import {
  Banner,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Card,
  EmptyState,
  Field,
  INPUT,
  LoadingRow,
  Modal,
  Pagination,
  SectionHeader,
  Spinner,
  StatusBadge,
  formatDateTime,
  formatEthiopianLocalDate,
  formatMoney,
  humanizeStatus,
} from "./ui";

const PAGE_SIZE = 20;

const VIEW_OPTIONS = [
  { value: "active", labelKey: "res.viewActive" },
  { value: "CONFIRMED", labelKey: "res.viewConfirmed" },
  { value: "CHECKED_IN", labelKey: "res.viewInHouse" },
  { value: "CHECKED_OUT", labelKey: "res.viewCheckedOut" },
  { value: "CANCELLED", labelKey: "res.viewCancelled" },
  { value: "NO_SHOW", labelKey: "res.viewNoShow" },
  { value: "all", labelKey: "res.viewAll" },
];

function guestNameOf(reservation, t) {
  return (
    reservation.guest?.fullName ||
    reservation.guestSnapshot?.fullName ||
    t("common.guestDetailsUnavailable")
  );
}

function roomNumberOf(reservation) {
  return (
    reservation.room?.roomNumber ||
    reservation.roomSnapshot?.roomNumber ||
    null
  );
}

export default function ReservationsPanel({
  request,
  refreshToken,
  onChanged,
  notify,
  guestFilter,
  onClearGuestFilter,
  newReservationGuest,
  onConsumeNewReservationGuest,
}) {
  const { t, lang } = useHotelI18n();
  const [view, setView] = useState("active");
  const [arrivalFrom, setArrivalFrom] = useState("");
  const [arrivalTo, setArrivalTo] = useState("");
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [checkInTarget, setCheckInTarget] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);

  const query = useMemo(() => {
    const params = {};
    if (view === "active") params.activeOnly = "true";
    else if (view !== "all") params.status = view;
    if (guestFilter?.id) params.guestId = guestFilter.id;
    if (arrivalFrom) params.arrivalFrom = arrivalFrom;
    if (arrivalTo) params.arrivalTo = arrivalTo;
    params.limit = PAGE_SIZE;
    params.offset = offset;
    return params;
  }, [view, guestFilter, arrivalFrom, arrivalTo, offset]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request(hotelUrl("/api/hotel/reservations", query));
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
    } catch (loadError) {
      if (loadError?.status !== 401) {
        setError(humanHotelError(loadError, t("res.loadError")));
      }
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [request, query, t]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      load();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [load, refreshToken]);

  const showCreate = createOpen || Boolean(newReservationGuest);

  function afterMutation(message) {
    notify?.({ tone: "success", message });
    load();
    onChanged?.();
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeader
          title={t("res.title")}
          action={
            <>
              <button type="button" className={BTN_SECONDARY} onClick={load} disabled={loading}>
                <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
                {t("common.refresh")}
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={() => setCreateOpen(true)}>
                <IconPlus className="h-4 w-4" aria-hidden="true" />
                {t("res.new")}
              </button>
            </>
          }
        />

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-56">
            <label htmlFor="reservation-view" className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t("common.status")}
            </label>
            <select
              id="reservation-view"
              className={INPUT}
              value={view}
              onChange={(event) => {
                setView(event.target.value);
                setOffset(0);
              }}
            >
              {VIEW_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t("res.arrivalWindow")}
            </span>
            <EthiopianDateRangePicker
              from={arrivalFrom}
              to={arrivalTo}
              onChange={(from, to) => {
                setArrivalFrom(from || "");
                setArrivalTo(to || "");
                setOffset(0);
              }}
            />
          </div>

          {arrivalFrom || arrivalTo ? (
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => {
                setArrivalFrom("");
                setArrivalTo("");
                setOffset(0);
              }}
            >
              <IconX className="h-3.5 w-3.5" aria-hidden="true" />
              {t("res.clearDates")}
            </button>
          ) : null}

          {guestFilter ? (
            <span className="inline-flex h-9 items-center gap-2 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[11px] font-bold text-[#1E293B] dark:border-[#2A2B36] dark:bg-[#252631] dark:text-white">
              {t("res.guestFilter", { name: guestFilter.fullName })}
              <button
                type="button"
                onClick={onClearGuestFilter}
                aria-label={t("res.clearGuestFilter")}
                className="rounded-full p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
              >
                <IconX className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>

        {error ? (
          <Banner tone="error" className="mt-4" onDismiss={() => setError("")}>
            {error}
          </Banner>
        ) : null}
      </Card>

      <Card className="p-4 sm:p-5">
        <div className="overflow-x-auto rounded-2xl border border-[#E2E8F0] dark:border-[#2A2B36]">
          <table className="w-full min-w-[980px] text-left text-sm">
            <caption className="sr-only">
              {t("res.caption")}
            </caption>
            <thead className="bg-[#F4F5F9] text-[11px] uppercase tracking-wide text-[#64748B] dark:bg-[#252631] dark:text-[#94A3B8]">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("res.colReservation")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.guest")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.room")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("res.colStay")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.status")}</th>
                <th scope="col" className="px-4 py-2.5 text-right font-extrabold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] dark:divide-[#2A2B36]">
              {loading ? (
                <LoadingRow label={t("common.loadingReservations")} colSpan={6} />
              ) : items.length === 0 ? (
                <EmptyState
                  colSpan={6}
                  title={t("res.noMatch")}
                  description={
                    guestFilter
                      ? t("res.noMatchGuest")
                      : t("res.noMatchHint")
                  }
                  action={
                    <button type="button" className={BTN_PRIMARY} onClick={() => setCreateOpen(true)}>
                      <IconPlus className="h-4 w-4" aria-hidden="true" />
                      {t("res.new")}
                    </button>
                  }
                />
              ) : (
                items.map((reservation) => {
                  const roomNumber = roomNumberOf(reservation);
                  const roomType =
                    reservation.roomType?.name ||
                    reservation.roomTypeSnapshot?.name ||
                    t("common.roomTypeUnavailable");
                  return (
                    <tr
                      key={reservation.id}
                      className="align-top hover:bg-[#F8FAFC] dark:hover:bg-[#252631]/60"
                    >
                      <td className="px-4 py-3">
                        <p className="font-extrabold text-[#1E293B] dark:text-white">
                          {reservation.reservationNumber}
                        </p>
                        <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                          {t("res.nightsAdults", {
                            nights: reservation.nights,
                            nightLabel:
                              reservation.nights === 1
                                ? t("common.nightUnit")
                                : t("common.nightsUnit"),
                            adults: reservation.adults,
                            adultLabel:
                              reservation.adults === 1
                                ? t("common.adultUnit")
                                : t("common.adultsUnit"),
                            children: reservation.children
                              ? t("res.childrenPart", { count: reservation.children })
                              : "",
                          })}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[#1E293B] dark:text-white">
                          {guestNameOf(reservation, t)}
                        </p>
                        <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                          {reservation.guest?.phone || reservation.guestSnapshot?.phone || t("common.noPhone")}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[#1E293B] dark:text-white">
                          {roomNumber ? t("res.roomNumber", { number: roomNumber }) : t("common.unassigned")}
                        </p>
                        <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                          {roomType}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[#1E293B] dark:text-white">
                          {formatEthiopianLocalDate(reservation.arrivalLocalDate, lang)} →{" "}
                          {formatEthiopianLocalDate(reservation.departureLocalDate, lang)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={reservation.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {reservation.status === "CONFIRMED" ? (
                            <button
                              type="button"
                              className={BTN_SECONDARY}
                              onClick={() => setAssignTarget(reservation)}
                            >
                              <IconBedFilled className="h-3.5 w-3.5" aria-hidden="true" />
                              {reservation.roomId ? t("res.changeRoom") : t("res.assign")}
                            </button>
                          ) : null}
                          {reservation.status === "CONFIRMED" ? (
                            <button
                              type="button"
                              className={BTN_SECONDARY}
                              onClick={() => setCheckInTarget(reservation)}
                              disabled={!reservation.roomId}
                              title={
                                reservation.roomId
                                  ? t("res.checkInTitle")
                                  : t("res.assignFirst")
                              }
                            >
                              <IconDoorEnter className="h-3.5 w-3.5" aria-hidden="true" />
                              {t("res.checkIn")}
                            </button>
                          ) : null}
                          {reservation.status === "CONFIRMED" ? (
                            <button
                              type="button"
                              className={BTN_DANGER}
                              onClick={() => setCancelTarget(reservation)}
                            >
                              <IconBan className="h-3.5 w-3.5" aria-hidden="true" />
                              {t("common.cancel")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            onClick={() => setDetailTarget(reservation)}
                            aria-label={t("res.detailsFor", { number: reservation.reservationNumber })}
                          >
                            <IconChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                            {t("common.details")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {!loading && items.length > 0 ? (
          <Pagination
            total={total}
            limit={PAGE_SIZE}
            offset={offset}
            busy={loading}
            onPrev={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            onNext={() => setOffset((value) => value + PAGE_SIZE)}
          />
        ) : null}
      </Card>

      {showCreate ? (
        <NewReservationModal
          request={request}
          initialGuest={newReservationGuest || null}
          onClose={() => {
            setCreateOpen(false);
            onConsumeNewReservationGuest?.();
          }}
          onCreated={(reservation) => {
            setCreateOpen(false);
            onConsumeNewReservationGuest?.();
            afterMutation(
              t("res.created", { number: reservation?.reservationNumber || "" }).trim()
            );
          }}
        />
      ) : null}

      {assignTarget ? (
        <AssignRoomModal
          request={request}
          reservation={assignTarget}
          onClose={() => setAssignTarget(null)}
          onAssigned={(roomNumber) => {
            setAssignTarget(null);
            afterMutation(
              roomNumber
                ? t("res.roomAssigned", { number: roomNumber })
                : t("res.roomAssignedGeneric")
            );
          }}
        />
      ) : null}

      {checkInTarget ? (
        <CheckInModal
          request={request}
          reservation={checkInTarget}
          onClose={() => setCheckInTarget(null)}
          onCheckedIn={(message) => {
            setCheckInTarget(null);
            afterMutation(message);
          }}
        />
      ) : null}

      {cancelTarget ? (
        <CancelReservationModal
          request={request}
          reservation={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => {
            setCancelTarget(null);
            afterMutation(
              t("res.cancelled", { number: cancelTarget.reservationNumber })
            );
          }}
        />
      ) : null}

      {detailTarget ? (
        <ReservationDetailsModal
          reservation={detailTarget}
          onClose={() => setDetailTarget(null)}
        />
      ) : null}
    </div>
  );
}

function AssignRoomModal({ request, reservation, onClose, onAssigned }) {
  const { t, lang } = useHotelI18n();
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await request(
          hotelUrl("/api/hotel/rooms", {
            isActive: "true",
            roomTypeId: reservation.roomTypeId,
            limit: 100,
            offset: 0,
          })
        );
        if (!cancelled) {
          setRooms(
            (Array.isArray(data?.items) ? data.items : []).filter(
              (room) => room.operationalStatus !== "OUT_OF_SERVICE"
            )
          );
        }
      } catch (loadError) {
        if (!cancelled && loadError?.status !== 401) {
          setError(humanHotelError(loadError, t("rooms.loadError")));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // Load once per room type; language changes do not re-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, reservation.roomTypeId]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || !roomId) return;
    setBusy(true);
    setError("");
    try {
      const data = await request(
        `/api/hotel/reservations/${encodeURIComponent(reservation.id)}/room`,
        { method: "POST", body: { roomId } }
      );
      onAssigned(
        data?.reservation?.room?.roomNumber ||
          data?.reservation?.roomSnapshot?.roomNumber ||
          ""
      );
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("assign.error")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t(reservation.roomId ? "assign.titleChange" : "assign.titleAssign", {
        number: reservation.reservationNumber,
      })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="hotel-assign-room"
            className={BTN_PRIMARY}
            disabled={busy || loading || !roomId}
          >
            {busy ? <Spinner /> : <IconBedFilled className="h-4 w-4" aria-hidden="true" />}
            {busy
              ? t("common.saving")
              : reservation.roomId
                ? t("res.changeRoom")
                : t("res.assign")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      <form id="hotel-assign-room" onSubmit={handleSubmit}>
        <Field
          label={t("assign.room")}
          htmlFor="assign-room-select"
          required
          hint={t("assign.hint", {
            nights: reservation.nights,
            date: formatEthiopianLocalDate(reservation.arrivalLocalDate, lang),
          })}
        >
          <select
            id="assign-room-select"
            className={INPUT}
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={busy || loading}
          >
            <option value="">
              {loading
                ? t("common.loadingRooms")
                : rooms.length === 0
                  ? t("assign.noRooms")
                  : t("assign.selectRoom")}
            </option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {t("assign.option", {
                  number: room.roomNumber,
                  status: t(
                    `status.${room.operationalStatus}`,
                    undefined,
                    humanizeStatus(room.operationalStatus)
                  ),
                  capacity: room.capacity,
                })}
              </option>
            ))}
          </select>
        </Field>
        {roomId ? (
          <div className="mt-3 flex items-center gap-2">
            <StatusBadge status={rooms.find((room) => room.id === roomId)?.operationalStatus || "RESERVED"} />
            <span className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
              {t("assign.info")}
            </span>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function CheckInModal({ request, reservation, onClose, onCheckedIn }) {
  const { t, lang } = useHotelI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await request(
        `/api/hotel/reservations/${encodeURIComponent(reservation.id)}/check-in`,
        { method: "POST", body: { note: note.trim() } }
      );
      const already = data?.stayCreated === false && data?.changed === false;
      onCheckedIn(
        t(already ? "checkin.already" : "checkin.done", {
          number: reservation.reservationNumber,
        })
      );
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("checkin.error")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("checkin.title", { number: reservation.reservationNumber })}
      description={t("checkin.description", {
        room: roomNumberOf(reservation) || "—",
        guest: guestNameOf(reservation, t),
        arrival: formatEthiopianLocalDate(reservation.arrivalLocalDate, lang),
        departure: formatEthiopianLocalDate(reservation.departureLocalDate, lang),
      })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="hotel-check-in" className={BTN_PRIMARY} disabled={busy}>
            {busy ? <Spinner /> : <IconDoorEnter className="h-4 w-4" aria-hidden="true" />}
            {busy ? t("checkin.busy") : t("checkin.submit")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      <Banner tone="info" className="mb-3">
        {t("checkin.info")}
      </Banner>
      <form id="hotel-check-in" onSubmit={handleSubmit}>
        <Field label={t("checkin.note")} htmlFor="check-in-note" hint={t("common.optional500")}>
          <textarea
            id="check-in-note"
            rows={3}
            className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-medium text-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/60 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:focus:ring-[#FF5E00]/60"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
            maxLength={500}
          />
        </Field>
      </form>
    </Modal>
  );
}

function CancelReservationModal({ request, reservation, onClose, onCancelled }) {
  const { t } = useHotelI18n();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request(
        `/api/hotel/reservations/${encodeURIComponent(reservation.id)}/cancel`,
        { method: "POST", body: { reason: reason.trim() } }
      );
      onCancelled();
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("cancel.error")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("cancel.title", { number: reservation.reservationNumber })}
      description={t("cancel.description")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("cancel.keep")}
          </button>
          <button type="submit" form="hotel-cancel-reservation" className={BTN_DANGER} disabled={busy}>
            {busy ? <Spinner /> : <IconBan className="h-3.5 w-3.5" aria-hidden="true" />}
            {busy ? t("cancel.busy") : t("cancel.submit")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      <form id="hotel-cancel-reservation" onSubmit={handleSubmit}>
        <Field label={t("cancel.reason")} htmlFor="cancel-reason" hint={t("common.optional500")}>
          <textarea
            id="cancel-reason"
            rows={3}
            className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-medium text-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/60 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:focus:ring-[#FF5E00]/60"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={busy}
            maxLength={500}
          />
        </Field>
      </form>
    </Modal>
  );
}

function ReservationDetailsModal({ reservation, onClose }) {
  const { t, lang } = useHotelI18n();
  const guest = reservation.guest || reservation.guestSnapshot || {};
  const roomType = reservation.roomType || reservation.roomTypeSnapshot || {};
  const roomNumber = roomNumberOf(reservation);
  const rows = [
    ["common.status", <StatusBadge key="status" status={reservation.status} />],
    ["common.guest", guest.fullName || "—"],
    ["resDetail.phone", guest.phone || "—"],
    ["resDetail.email", guest.email || "—"],
    ["common.room", roomNumber ? t("res.roomNumber", { number: roomNumber }) : t("common.unassigned")],
    ["common.roomType", roomType.name ? `${roomType.name} (${roomType.code || "—"})` : "—"],
    ["resDetail.arrival", formatEthiopianLocalDate(reservation.arrivalLocalDate, lang)],
    ["resDetail.departure", formatEthiopianLocalDate(reservation.departureLocalDate, lang)],
    ["resDetail.nights", String(reservation.nights ?? "—")],
    ["resDetail.guests", t("resDetail.guestsValue", { adults: reservation.adults ?? "—", children: reservation.children ?? 0 })],
    ["resDetail.rate", formatMoney(reservation.nightlyRate)],
    ["resDetail.total", formatMoney(reservation.totalAmount)],
    ["resDetail.rateSource", reservation.rateSource || "—"],
    ["resDetail.checkedIn", reservation.checkedInAt ? formatDateTime(reservation.checkedInAt) : t("common.notCheckedIn")],
    ["resDetail.checkedOut", reservation.checkedOutAt ? formatDateTime(reservation.checkedOutAt) : t("common.notCheckedOut")],
    ["resDetail.created", formatDateTime(reservation.createdAt)],
    ["common.notes", reservation.notes || "—"],
  ];

  return (
    <Modal
      title={t("resDetail.title", { number: reservation.reservationNumber })}
      description={t("resDetail.description")}
      onClose={onClose}
      wide
      footer={
        <button type="button" className={BTN_SECONDARY} onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <dl className="divide-y divide-[#E2E8F0] dark:divide-[#2A2B36]">
        {rows.map(([labelKey, value]) => (
          <div key={labelKey} className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-3 sm:gap-3">
            <dt className="text-[11px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t(labelKey)}
            </dt>
            <dd className="text-sm font-semibold text-[#1E293B] dark:text-white sm:col-span-2">
              {value || "—"}
            </dd>
          </div>
        ))}
        {reservation.cancellation ? (
          <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-3 sm:gap-3">
            <dt className="text-[11px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t("common.cancellation")}
            </dt>
            <dd className="text-sm font-semibold text-[#1E293B] dark:text-white sm:col-span-2">
              {formatDateTime(reservation.cancellation.cancelledAt)}
              {reservation.cancellation.reason ? ` · ${reservation.cancellation.reason}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>
    </Modal>
  );
}
