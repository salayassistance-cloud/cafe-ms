"use client";

// Room inventory detail for the Manager Room Reports page.
//
// Only the existing room and room-type read endpoints are used. The filters are
// exactly the filters accepted by GET /api/hotel/rooms: operationalStatus,
// roomTypeId, floor, isActive, limit, and offset. There is no server-side room
// search or date filter, so none is offered.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { hotelUrl, humanHotelError } from "./hotelApi";
import { useHotelI18n } from "./HotelI18n";
import {
  Banner,
  BTN_SECONDARY,
  Card,
  EmptyState,
  INPUT,
  LABEL,
  Pagination,
  SectionHeader,
  SkeletonRows,
  Spinner,
  StatusBadge,
  formatMoney,
  humanizeStatus,
} from "./ui";

const PAGE_SIZE = 20;

const ROOM_STATUSES = [
  "AVAILABLE",
  "OCCUPIED",
  "RESERVED",
  "CLEANING",
  "MAINTENANCE",
  "OUT_OF_SERVICE",
];

const EMPTY_FILTERS = {
  operationalStatus: "",
  roomTypeId: "",
  floor: "",
  activeView: "active",
};

function roomStatusLabel(status, t) {
  if (!status) return t("common.unknown");
  return t(`status.${status}`, undefined, humanizeStatus(status));
}

export default function RoomInventoryReport({ request }) {
  const { t } = useHotelI18n();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [types, setTypes] = useState(null);

  const loadIdRef = useRef(0);
  const abortRef = useRef(null);
  const typesAbortRef = useRef(null);

  const query = useMemo(() => {
    const params = {};
    if (filters.activeView === "active") params.isActive = "true";
    else if (filters.activeView === "inactive") params.isActive = "false";
    if (filters.operationalStatus) params.operationalStatus = filters.operationalStatus;
    if (filters.roomTypeId) params.roomTypeId = filters.roomTypeId;
    if (filters.floor !== "") {
      const parsed = Number(filters.floor);
      if (Number.isInteger(parsed) && parsed >= -10 && parsed <= 200) {
        params.floor = String(parsed);
      }
    }
    params.limit = PAGE_SIZE;
    params.offset = offset;
    return params;
  }, [filters, offset]);

  const floorInvalid =
    filters.floor !== "" &&
    (() => {
      const parsed = Number(filters.floor);
      return !Number.isInteger(parsed) || parsed < -10 || parsed > 200;
    })();

  const loadTypes = useCallback(async () => {
    typesAbortRef.current?.abort();
    const controller = new AbortController();
    typesAbortRef.current = controller;
    try {
      const data = await request(
        hotelUrl("/api/hotel/room-types", { limit: 100, offset: 0 }),
        { signal: controller.signal }
      );
      setTypes(Array.isArray(data?.items) ? data.items : []);
    } catch (loadError) {
      if (loadError?.name === "AbortError") return;
      if (loadError?.status !== 401) {
        // Room inventory remains usable without the optional type filter.
        setTypes(null);
      }
    }
  }, [request]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      loadTypes();
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      typesAbortRef.current?.abort();
    };
  }, [loadTypes]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++loadIdRef.current;

    setLoading(true);
    try {
      const data = await request(hotelUrl("/api/hotel/rooms", query), {
        signal: controller.signal,
      });
      if (loadIdRef.current !== requestId) return;
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
      setError("");
    } catch (loadError) {
      if (loadIdRef.current !== requestId || loadError?.name === "AbortError") return;
      if (loadError?.status !== 401) {
        setError(humanHotelError(loadError, t("inventory.loadError")));
      }
      setItems([]);
      setTotal(0);
    } finally {
      if (loadIdRef.current === requestId) setLoading(false);
    }
  }, [query, request, t]);

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

  function updateFilter(key, value) {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setOffset(0);
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS);
    setOffset(0);
  }

  return (
    <Card className="p-4 sm:p-5">
      <SectionHeader
        title={t("inventory.title")}
        action={
          <button type="button" className={BTN_SECONDARY} onClick={load} disabled={loading}>
            <IconRefresh
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {t("common.refresh")}
          </button>
        }
      />

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div>
          <label htmlFor="report-room-status" className={LABEL}>
            {t("inventory.filterStatus")}
          </label>
          <select
            id="report-room-status"
            className={INPUT}
            value={filters.operationalStatus}
            onChange={(event) => updateFilter("operationalStatus", event.target.value)}
          >
            <option value="">{t("common.allStatuses")}</option>
            {ROOM_STATUSES.map((value) => (
              <option key={value} value={value}>
                {roomStatusLabel(value, t)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="report-room-type" className={LABEL}>
            {t("inventory.filterType")}
          </label>
          <select
            id="report-room-type"
            className={INPUT}
            value={filters.roomTypeId}
            onChange={(event) => updateFilter("roomTypeId", event.target.value)}
          >
            <option value="">
              {types === null
                ? t("common.roomTypesUnavailable")
                : types.length === 0
                  ? t("common.noRoomTypes")
                  : t("common.allRoomTypes")}
            </option>
            {(types || []).map((roomType) => (
              <option key={roomType.id} value={roomType.id}>
                {roomType.name} ({roomType.code})
                {roomType.isActive === false ? t("common.inactiveSuffix") : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="report-room-floor" className={LABEL}>
            {t("inventory.filterFloor")}
          </label>
          <input
            id="report-room-floor"
            type="number"
            inputMode="numeric"
            step={1}
            min={-10}
            max={200}
            className={`${INPUT} ${floorInvalid ? "border-[#FCA5A5] focus:ring-[#EF4444]/40" : ""}`}
            value={filters.floor}
            onChange={(event) => updateFilter("floor", event.target.value)}
            placeholder={t("common.anyFloor")}
            aria-invalid={floorInvalid ? "true" : undefined}
          />
          {floorInvalid ? (
            <p
              role="alert"
              className="mt-1 text-[11px] font-bold text-[#B91C1C] dark:text-[#FCA5A5]"
            >
              {t("common.wholeFloor")}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="report-room-active" className={LABEL}>
            {t("inventory.filterState")}
          </label>
          <select
            id="report-room-active"
            className={INPUT}
            value={filters.activeView}
            onChange={(event) => updateFilter("activeView", event.target.value)}
          >
            <option value="active">{t("common.activeRooms")}</option>
            <option value="inactive">{t("common.inactiveRooms")}</option>
            <option value="all">{t("common.allRooms")}</option>
          </select>
        </div>

        <div className="flex items-end">
          <button type="button" className={BTN_SECONDARY} onClick={resetFilters}>
            {t("inventory.reset")}
          </button>
        </div>
      </div>

      {error ? (
        <Banner tone="error" className="mt-4" onDismiss={() => setError("")}>
          {error}{" "}
          <button
            type="button"
            className="ml-1 underline underline-offset-2 hover:no-underline"
            onClick={() => {
              setError("");
              load();
            }}
          >
            {t("common.tryAgain")}
          </button>
        </Banner>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table
          className="w-full min-w-[54rem] text-left text-xs"
          aria-label={t("inventory.aria")}
          aria-busy={loading}
        >
          <caption className="sr-only">{t("inventory.caption")}</caption>
          <thead>
            <tr className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              <th scope="col" className="px-3 pb-2">{t("inventory.colRoom")}</th>
              <th scope="col" className="px-3 pb-2">{t("inventory.colFloor")}</th>
              <th scope="col" className="px-3 pb-2">{t("inventory.colRoomType")}</th>
              <th scope="col" className="px-3 pb-2">{t("inventory.colCapacity")}</th>
              <th scope="col" className="px-3 pb-2">{t("inventory.colRate")}</th>
              <th scope="col" className="px-3 pb-2">{t("inventory.colStatus")}</th>
              <th scope="col" className="px-3 pb-2">{t("inventory.colState")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <SkeletonRows rows={6} cols={7} />
            ) : items.length > 0 ? (
              items.map((room) => (
                <tr
                  key={room.id}
                  className="border-t border-[#E2E8F0] dark:border-[#2A2B36]"
                >
                  <td className="px-3 py-2.5 font-extrabold text-[#1E293B] dark:text-white">
                    {room.roomNumber}
                  </td>
                  <td className="px-3 py-2.5 font-medium">{room.floor ?? "—"}</td>
                  <td className="px-3 py-2.5 font-medium">
                    {room.roomType
                      ? `${room.roomType.name} (${room.roomType.code})`
                      : t("common.roomTypeUnavailable")}
                  </td>
                  <td className="px-3 py-2.5 font-medium">{room.capacity}</td>
                  <td className="px-3 py-2.5 font-medium">
                    {formatMoney(room.effectiveNightlyRate)}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge
                      status={room.isActive ? room.operationalStatus : "INACTIVE"}
                    />
                  </td>
                  <td className="px-3 py-2.5 font-medium">
                    {room.isActive ? t("inventory.active") : t("inventory.inactive")}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title={t("inventory.noMatch")}
                    description={t("inventory.noMatchHint")}
                    action={
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={resetFilters}
                      >
                        {t("inventory.reset")}
                      </button>
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {loading && items.length > 0 ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]"
        >
          <Spinner className="h-3 w-3" />
          {t("inventory.refreshing")}
        </p>
      ) : null}

      {!loading || items.length > 0 ? (
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
  );
}
