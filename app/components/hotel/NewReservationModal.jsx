"use client";

// Reception — create a reservation.
//
// Uses only documented Hotel capabilities:
//   GET  /api/hotel/guests?search=…        (guest picker)
//   GET  /api/hotel/room-types?isActive=…
//   GET  /api/hotel/rooms?isActive=…&roomTypeId=…
//   POST /api/hotel/reservations
//
// Reservation creation has no server idempotency key, so the submit button is
// hard-disabled while the request is in flight.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconBedFilled,
  IconCalendarEvent,
  IconSearch,
  IconUserPlus,
} from "@tabler/icons-react";
import { getAddisYMD } from "@/lib/ethiopianCalendar";
import EthiopianDatePicker from "@/app/components/EthiopianDatePicker";
import { hotelUrl, humanHotelError } from "./hotelApi";
import { useHotelI18n } from "./HotelI18n";
import {
  Banner,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Field,
  INPUT,
  Modal,
  Spinner,
  StatusBadge,
  formatMoney,
  humanizeStatus,
} from "./ui";

function tomorrowYMD() {
  return getAddisYMD(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

export default function NewReservationModal({ request, initialGuest, onClose, onCreated }) {
  const { t } = useHotelI18n();
  const [guest, setGuest] = useState(initialGuest || null);
  const [guestQuery, setGuestQuery] = useState("");
  const [guestResults, setGuestResults] = useState([]);
  const [guestSearching, setGuestSearching] = useState(false);
  const [guestSearched, setGuestSearched] = useState(false);
  const [guestError, setGuestError] = useState("");

  const [roomTypes, setRoomTypes] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [loadingReferences, setLoadingReferences] = useState(true);
  const [referenceError, setReferenceError] = useState("");

  const [form, setForm] = useState({
    roomTypeId: "",
    roomId: "",
    arrivalDate: getAddisYMD(new Date()),
    departureDate: tomorrowYMD(),
    adults: "1",
    children: "0",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function loadReferences() {
      setLoadingReferences(true);
      setReferenceError("");
      try {
        const data = await request(
          hotelUrl("/api/hotel/room-types", { isActive: "true", limit: 100, offset: 0 })
        );
        if (!cancelled) setRoomTypes(Array.isArray(data?.items) ? data.items : []);
      } catch (loadError) {
        if (!cancelled && loadError?.status !== 401) {
          setReferenceError(humanHotelError(loadError, t("newres.loadError")));
        }
      } finally {
        if (!cancelled) setLoadingReferences(false);
      }
    }
    loadReferences();
    return () => {
      cancelled = true;
    };
    // Load once per mount; language changes do not re-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const loadRooms = useCallback(
    async (roomTypeId) => {
      if (!roomTypeId) {
        setRooms([]);
        return;
      }
      try {
        const data = await request(
          hotelUrl("/api/hotel/rooms", {
            isActive: "true",
            roomTypeId,
            limit: 100,
            offset: 0,
          })
        );
        setRooms(
          (Array.isArray(data?.items) ? data.items : []).filter(
            (room) => room.operationalStatus !== "OUT_OF_SERVICE"
          )
        );
      } catch {
        setRooms([]);
      }
    },
    [request]
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      loadRooms(form.roomTypeId);
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [form.roomTypeId, loadRooms]);

  const selectedRoomType = useMemo(
    () => roomTypes.find((item) => item.id === form.roomTypeId) || null,
    [roomTypes, form.roomTypeId]
  );

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function searchGuests(event) {
    event?.preventDefault();
    const query = guestQuery.trim();
    if (!query) {
      setGuestResults([]);
      return;
    }
    setGuestSearching(true);
    setGuestError("");
    setGuestSearched(true);
    try {
      const data = await request(
        hotelUrl("/api/hotel/guests", { search: query, isActive: "true", limit: 8, offset: 0 })
      );
      setGuestResults(Array.isArray(data?.items) ? data.items : []);
    } catch (searchError) {
      if (searchError?.status !== 401) {
        setGuestError(humanHotelError(searchError, t("newres.guestSearchError")));
      }
      setGuestResults([]);
    } finally {
      setGuestSearching(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setFieldErrors({});

    const localErrors = {};
    if (!guest?.id) localErrors.guestId = t("newres.errGuest");
    if (!form.roomTypeId) localErrors.roomTypeId = t("newres.errRoomType");
    if (!form.arrivalDate) localErrors.arrivalDate = t("newres.errArrival");
    if (!form.departureDate) localErrors.departureDate = t("newres.errDeparture");
    if (form.arrivalDate && form.departureDate && form.departureDate <= form.arrivalDate) {
      localErrors.departureDate = t("newres.errDepartureAfter");
    }
    const adults = Number(form.adults);
    const children = Number(form.children);
    if (!Number.isInteger(adults) || adults < 1 || adults > 100) {
      localErrors.adults = t("newres.errAdults");
    }
    if (!Number.isInteger(children) || children < 0 || children > 100) {
      localErrors.children = t("newres.errChildren");
    }
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setBusy(true);
    try {
      const body = {
        guestId: guest.id,
        roomTypeId: form.roomTypeId,
        arrivalDate: form.arrivalDate,
        departureDate: form.departureDate,
        adults,
        children,
        notes: form.notes.trim(),
      };
      if (form.roomId) body.roomId = form.roomId;

      const data = await request("/api/hotel/reservations", { method: "POST", body });
      onCreated(data.reservation);
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("newres.error")));
        if (submitError?.fieldErrors) setFieldErrors(submitError.fieldErrors);
      }
    } finally {
      setBusy(false);
    }
  }

  const roomDisabled = loadingReferences || roomTypes.length === 0;

  return (
    <Modal
      title={t("newres.title")}
      onClose={busy ? () => {} : onClose}
      wide
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="hotel-create-reservation"
            className={BTN_PRIMARY}
            disabled={busy || roomDisabled || !guest}
          >
            {busy ? <Spinner /> : <IconCalendarEvent className="h-4 w-4" aria-hidden="true" />}
            {busy ? t("common.creating") : t("newres.create")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-4" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      {referenceError ? (
        <Banner tone="warning" className="mb-4">
          {referenceError}
        </Banner>
      ) : null}
      {!loadingReferences && roomTypes.length === 0 && !referenceError ? (
        <Banner tone="warning" className="mb-4">
          {t("newres.noRoomTypes")}
        </Banner>
      ) : null}

      <form id="hotel-create-reservation" onSubmit={handleSubmit} className="space-y-4" noValidate>
        <fieldset>
          <legend className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
            {t("newres.guestLegend")}
          </legend>
          {guest ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 dark:border-[#2A2B36] dark:bg-[#252631]">
              <div className="min-w-0">
                <p className="truncate text-sm font-extrabold text-[#1E293B] dark:text-white">
                  {guest.fullName}
                </p>
                <p className="truncate text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                  {guest.phone || t("common.noPhone")} {guest.email ? `· ${guest.email}` : ""}
                </p>
              </div>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => {
                  setGuest(null);
                  setGuestResults([]);
                  setGuestSearched(false);
                }}
                disabled={busy}
              >
                {t("newres.change")}
              </button>
            </div>
          ) : (
            <div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <IconSearch
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]"
                    aria-hidden="true"
                  />
                  <input
                    id="reservation-guest-search"
                    type="search"
                    value={guestQuery}
                    onChange={(event) => {
                      setGuestQuery(event.target.value);
                      setGuestSearched(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        searchGuests();
                      }
                    }}
                    className={`${INPUT} pl-9`}
                    placeholder={t("newres.searchPlaceholder")}
                    disabled={busy}
                  />
                </div>
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  onClick={searchGuests}
                  disabled={busy || guestSearching || !guestQuery.trim()}
                >
                  {guestSearching ? <Spinner /> : <IconSearch className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t("newres.find")}
                </button>
              </div>
              {guestError ? (
                <p className="mt-1 text-[11px] font-bold text-[#B91C1C] dark:text-[#FCA5A5]">{guestError}</p>
              ) : null}
              {fieldErrors.guestId ? (
                <p className="mt-1 text-[11px] font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
                  {fieldErrors.guestId}
                </p>
              ) : null}
              {guestResults.length > 0 ? (
                <ul className="mt-2 max-h-48 divide-y divide-[#E2E8F0] overflow-y-auto rounded-xl border border-[#E2E8F0] dark:divide-[#2A2B36] dark:border-[#2A2B36]">
                  {guestResults.map((result) => (
                    <li key={result.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setGuest(result);
                          setGuestResults([]);
                          setGuestQuery("");
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-bold text-[#1E293B] dark:text-white">
                            {result.fullName}
                          </span>
                          <span className="block truncate text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                            {result.phone || t("common.noPhone")} {result.email ? `· ${result.email}` : ""}
                          </span>
                        </span>
                        <IconUserPlus className="h-4 w-4 shrink-0 text-[#64748B]" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : guestSearched && !guestSearching && !guestError ? (
                <p className="mt-2 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                  {t("newres.noGuestMatch")}
                </p>
              ) : null}
            </div>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("newres.roomType")} htmlFor="reservation-room-type" required error={fieldErrors.roomTypeId}>
            <select
              id="reservation-room-type"
              className={INPUT}
              value={form.roomTypeId}
              onChange={(event) => {
                update("roomTypeId", event.target.value);
                update("roomId", "");
              }}
              disabled={busy || loadingReferences}
            >
              <option value="">
                {loadingReferences ? t("common.loadingRoomTypes") : t("common.selectRoomType")}
              </option>
              {roomTypes.map((roomType) => (
                <option key={roomType.id} value={roomType.id}>
                  {t("newres.roomOption", {
                    name: roomType.name,
                    code: roomType.code,
                    capacity: roomType.capacity,
                  })}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label={t("newres.assignNow")}
            htmlFor="reservation-room"
            error={fieldErrors.roomId}
          >
            <select
              id="reservation-room"
              className={INPUT}
              value={form.roomId}
              onChange={(event) => update("roomId", event.target.value)}
              disabled={busy || !form.roomTypeId || rooms.length === 0}
            >
              <option value="">{t("newres.assignLater")}</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {t("newres.roomOptionShort", {
                    number: room.roomNumber,
                    status: t(
                      `status.${room.operationalStatus}`,
                      undefined,
                      humanizeStatus(room.operationalStatus)
                    ),
                  })}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("newres.arrival")} htmlFor="reservation-arrival" required error={fieldErrors.arrivalDate}>
            <EthiopianDatePicker
              id="reservation-arrival"
              value={form.arrivalDate}
              min={getAddisYMD(new Date())}
              onChange={(ymd) => update("arrivalDate", ymd)}
              disabled={busy}
            />
          </Field>

          <Field label={t("newres.departure")} htmlFor="reservation-departure" required error={fieldErrors.departureDate}>
            <EthiopianDatePicker
              id="reservation-departure"
              value={form.departureDate}
              min={form.arrivalDate || undefined}
              onChange={(ymd) => update("departureDate", ymd)}
              disabled={busy}
            />
          </Field>

          <Field label={t("newres.adults")} htmlFor="reservation-adults" required error={fieldErrors.adults}>
            <input
              id="reservation-adults"
              type="number"
              min="1"
              max="100"
              step="1"
              className={INPUT}
              value={form.adults}
              onChange={(event) => update("adults", event.target.value)}
              disabled={busy}
            />
          </Field>

          <Field label={t("newres.children")} htmlFor="reservation-children" error={fieldErrors.children}>
            <input
              id="reservation-children"
              type="number"
              min="0"
              max="100"
              step="1"
              className={INPUT}
              value={form.children}
              onChange={(event) => update("children", event.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        {selectedRoomType ? (
          <p className="flex items-center gap-2 rounded-xl bg-[#F4F5F9] px-3 py-2 text-[11px] font-medium text-[#64748B] dark:bg-[#252631] dark:text-[#94A3B8]">
            <IconBedFilled className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("newres.rateNote", {
              rate: formatMoney(selectedRoomType.baseNightlyRate),
              capacity: selectedRoomType.capacity,
            })}
          </p>
        ) : null}

        <Field label={t("common.notes")} htmlFor="reservation-notes" error={fieldErrors.notes} hint={t("common.optional1000")}>
          <textarea
            id="reservation-notes"
            rows={3}
            className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-medium text-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/60 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:focus:ring-[#FF5E00]/60"
            value={form.notes}
            onChange={(event) => update("notes", event.target.value)}
            disabled={busy}
            maxLength={1000}
          />
        </Field>

        {form.roomId ? (
          <div className="flex items-center gap-2 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
            <StatusBadge
              status={rooms.find((room) => room.id === form.roomId)?.operationalStatus || "RESERVED"}
            />
            {t("newres.selectedStatus")}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
