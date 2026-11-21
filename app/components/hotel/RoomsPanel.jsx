"use client";

// Reception — Room Management.
//
// Sources of truth used by this panel (no invented API or fields):
// - GET/POST /api/hotel/rooms, PATCH /api/hotel/rooms/[id],
//   POST /api/hotel/rooms/[id]/status, POST /api/hotel/rooms/[id]/deactivate,
//   GET /api/hotel/room-types (list for filters and room creation).
// Supported filters are only what the rooms API accepts: operationalStatus,
// roomTypeId, floor, isActive, limit, offset. There is no server-side room
// number search, so no search box is offered.
// OCCUPIED and RESERVED are owned by the reservation/check-in flow; the status
// control only offers the four manual housekeeping statuses, matching the
// server's validation.
// List loads are guarded against stale responses (requestId) and duplicate
// refreshes; summary counts come from the API `total` values, never invented.
// Room/type mutations require a MANAGER session (the server enforces this too;
// RECEPTIONIST sessions see a read-only screen).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBan,
  IconBedFilled,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTag,
} from "@tabler/icons-react";
import { hotelUrl, humanHotelError } from "./hotelApi";
import { useHotelI18n } from "./HotelI18n";
import RoomTypesPanel from "./RoomTypesPanel";
import {
  Banner,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Card,
  EmptyState,
  Field,
  INPUT,
  LABEL,
  Modal,
  Pagination,
  SectionHeader,
  Spinner,
  StatusBadge,
  TEXTAREA,
  formatDateTime,
  formatMoney,
  humanizeStatus,
} from "./ui";

const PAGE_SIZE = 20;

// Mirrors HOTEL_ROOM_OPERATIONAL_STATUSES / HOTEL_MANUAL_ROOM_STATUSES from
// lib/hotel/constants.js. OCCUPIED and RESERVED are reservation-flow states
// and are never offered as manual options.
const ALL_ROOM_STATUSES = [
  "AVAILABLE",
  "OCCUPIED",
  "RESERVED",
  "CLEANING",
  "MAINTENANCE",
  "OUT_OF_SERVICE",
];
const MANUAL_ROOM_STATUSES = ["AVAILABLE", "CLEANING", "MAINTENANCE", "OUT_OF_SERVICE"];

const ROOM_NUMBER_PATTERN = "^[A-Z0-9][A-Z0-9-]*$";

function roomStatusLabel(status, t) {
  if (!status) return t("common.unknown");
  return t(`status.${status}`, undefined, humanizeStatus(status));
}

const TABS = [
  { key: "rooms", labelKey: "rooms.tabRooms", Icon: IconBedFilled },
  { key: "room-types", labelKey: "rooms.tabTypes", Icon: IconTag },
];

export default function RoomsPanel({ request, notify, role }) {
  const { t } = useHotelI18n();
  const [tab, setTab] = useState("rooms");
  const canManage = role === "MANAGER";
  const roomsTabActive = tab === "rooms";

  const [activeTotal, setActiveTotal] = useState(null);
  const [statusTotals, setStatusTotals] = useState(null);
  const [summaryBusy, setSummaryBusy] = useState(true);
  const summaryRequestIdRef = useRef(0);

  const loadSummary = useCallback(async () => {
    const requestId = ++summaryRequestIdRef.current;
    setSummaryBusy(true);
    const results = await Promise.allSettled([
      request(hotelUrl("/api/hotel/rooms", { isActive: "true", limit: 1, offset: 0 })),
      ...ALL_ROOM_STATUSES.map((value) =>
        request(
          hotelUrl("/api/hotel/rooms", { isActive: "true", operationalStatus: value, limit: 1, offset: 0 })
        )
      ),
    ]);
    if (summaryRequestIdRef.current !== requestId) return;
    const totalOf = (result) =>
      result.status === "fulfilled" && typeof result.value?.total === "number"
        ? result.value.total
        : null;
    setActiveTotal(totalOf(results[0]));
    setStatusTotals(ALL_ROOM_STATUSES.map((value, index) => ({ value, total: totalOf(results[index + 1]) })));
    setSummaryBusy(false);
  }, [request]);

  useEffect(() => {
    if (!roomsTabActive) return undefined;
    const timeoutId = setTimeout(() => {
      loadSummary();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [loadSummary, roomsTabActive]);

  return (
    <div className="space-y-4">
      <RoomsNavTabs tab={tab} onTab={setTab} />

      {roomsTabActive ? (
        <>
          <RoomsSummary activeTotal={activeTotal} statusTotals={statusTotals} busy={summaryBusy} />
          <RoomsListSection
            request={request}
            canManage={canManage}
            notify={notify}
            onRefreshSummary={loadSummary}
          />
        </>
      ) : (
        <RoomTypesPanel
          request={request}
          notify={notify}
          canManage={canManage}
        />
      )}
    </div>
  );
}

function RoomsNavTabs({ tab, onTab }) {
  const { t } = useHotelI18n();
  return (
    <nav aria-label={t("rooms.sections")} className="flex flex-wrap gap-2">
      {TABS.map(({ key, labelKey, Icon }) => {
        const active = tab === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onTab(key)}
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
  );
}

function RoomsSummary({ activeTotal, statusTotals, busy }) {
  const { t } = useHotelI18n();
  return (
    <section aria-labelledby="rooms-summary-heading">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="rooms-summary-heading"
          className="text-[11px] font-extrabold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]"
        >
          {t("rooms.summaryHeading")}
        </h2>
        {busy ? (
          <span className="flex items-center gap-1.5 text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">
            <Spinner className="h-3 w-3" />
            {t("rooms.counting")}
          </span>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label={t("rooms.activeRooms")} value={activeTotal} busy={busy} />
        {ALL_ROOM_STATUSES.map((value) => (
          <SummaryCard
            key={value}
            label={roomStatusLabel(value, t)}
            value={
              statusTotals
                ? statusTotals.find((entry) => entry.value === value)?.total ?? null
                : null
            }
            busy={busy}
          />
        ))}
      </div>
    </section>
  );
}

function SummaryCard({ label, value, busy }) {
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
        </div>
      </div>
    </Card>
  );
}

const EMPTY_FILTERS = {
  operationalStatus: "",
  roomTypeId: "",
  floor: "",
  activeView: "active",
};

function RoomsListSection({ request, canManage, notify, onRefreshSummary }) {
  const { t } = useHotelI18n();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [types, setTypes] = useState(null);
  const [formTarget, setFormTarget] = useState(null); // null | "new" | room object
  const [statusTarget, setStatusTarget] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);

  const loadIdRef = useRef(0);
  const [actingId, setActingId] = useState(null);

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
    try {
      const data = await request(
        hotelUrl("/api/hotel/room-types", { isActive: "true", limit: 100, offset: 0 })
      );
      setTypes(Array.isArray(data?.items) ? data.items : []);
    } catch (loadError) {
      if (loadError?.status !== 401) {
        // Type filtering and room creation degrade gracefully without types.
        setTypes(null);
      }
    }
  }, [request]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      loadTypes();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [loadTypes]);

  const load = useCallback(async () => {
    const requestId = ++loadIdRef.current;
    setLoading(true);
    try {
      const data = await request(hotelUrl("/api/hotel/rooms", query));
      if (loadIdRef.current !== requestId) return;
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
      setError("");
    } catch (loadError) {
      if (loadIdRef.current !== requestId) return;
      if (loadError?.status !== 401) {
        setError(humanHotelError(loadError, t("rooms.loadError")));
      }
      setItems([]);
      setTotal(0);
    } finally {
      if (loadIdRef.current === requestId) setLoading(false);
    }
  }, [request, query, t]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      load();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [load]);

  function updateFilter(key, value) {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setOffset(0);
  }

  function afterMutation(message) {
    notify?.({ tone: "success", message });
    load();
    onRefreshSummary();
  }

  // Serializes deactivate/reactivate per room so a double click cannot send
  // the same mutation twice.
  const actOnRoom = useCallback(
    async (id, action) => {
      if (actingId !== null) return;
      setActingId(id);
      try {
        await action();
      } finally {
        setActingId(null);
      }
    },
    [actingId]
  );

  function handleDeactivate(room) {
    actOnRoom(room.id, () =>
      deactivateRoomThroughApi({ request, room })
        .then((data) => {
          afterMutation(
            data?.changed === false
              ? t("rooms.alreadyInactive", { number: room.roomNumber })
              : t("rooms.deactivated", { number: room.roomNumber })
          );
        })
        .catch((submitError) => {
          if (submitError?.status !== 401) {
            notify?.({
              tone: "error",
              message: humanHotelError(submitError, t("rooms.deactivateError")),
            });
          }
        })
    );
  }

  function handleReactivate(room) {
    actOnRoom(room.id, () =>
      request(`/api/hotel/rooms/${encodeURIComponent(room.id)}`, {
        method: "PATCH",
        body: { isActive: true },
      })
        .then(() => {
          afterMutation(t("rooms.reactivated", { number: room.roomNumber }));
        })
        .catch((submitError) => {
          if (submitError?.status !== 401) {
            notify?.({
              tone: "error",
              message: humanHotelError(submitError, t("rooms.reactivateError")),
            });
          }
        })
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeader
          title={t("rooms.listTitle")}
          subtitle={t("rooms.listSubtitle")}
          action={
            <>
              <button type="button" className={BTN_SECONDARY} onClick={load} disabled={loading}>
                <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
                {t("common.refresh")}
              </button>
              {canManage ? (
                <button type="button" className={BTN_PRIMARY} onClick={() => setFormTarget("new")}>
                  <IconPlus className="h-4 w-4" aria-hidden="true" />
                  {t("rooms.new")}
                </button>
              ) : null}
            </>
          }
        />

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div>
            <label htmlFor="room-status-filter" className={LABEL}>
              {t("rooms.filterStatus")}
            </label>
            <select
              id="room-status-filter"
              className={INPUT}
              value={filters.operationalStatus}
              onChange={(event) => updateFilter("operationalStatus", event.target.value)}
            >
              <option value="">{t("common.allStatuses")}</option>
              {ALL_ROOM_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {roomStatusLabel(value, t)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="room-type-filter" className={LABEL}>
              {t("rooms.filterType")}
            </label>
            <select
              id="room-type-filter"
              className={INPUT}
              value={filters.roomTypeId}
              onChange={(event) => updateFilter("roomTypeId", event.target.value)}
            >
              <option value="">
                {types === null
                  ? t("common.roomTypesUnavailable")
                  : types.length === 0
                    ? t("common.noActiveRoomTypes")
                    : t("common.allRoomTypes")}
              </option>
              {(types || []).map((roomType) => (
                <option key={roomType.id} value={roomType.id}>
                  {roomType.name} ({roomType.code})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="room-floor-filter" className={LABEL}>
              {t("rooms.filterFloor")}
            </label>
            <input
              id="room-floor-filter"
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
              <p role="alert" className="mt-1 text-[11px] font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
                {t("common.wholeFloor")}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="room-active-filter" className={LABEL}>
              {t("rooms.filterState")}
            </label>
            <select
              id="room-active-filter"
              className={INPUT}
              value={filters.activeView}
              onChange={(event) => updateFilter("activeView", event.target.value)}
            >
              <option value="active">{t("common.activeRooms")}</option>
              <option value="inactive">{t("common.inactiveRooms")}</option>
              <option value="all">{t("common.allRooms")}</option>
            </select>
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
      </Card>

      <Card className="p-4 sm:p-5">
        {loading && items.length === 0 ? (
          <div
            className="flex items-center justify-center gap-2 py-10 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]"
            role="status"
            aria-live="polite"
          >
            <Spinner />
            {t("common.loadingRooms")}
          </div>
        ) : items.length === 0 && !loading ? (
          <EmptyState
            title={t("rooms.noMatch")}
            description={t("rooms.noMatchHint")}
            action={
              canManage ? (
                <button type="button" className={BTN_PRIMARY} onClick={() => setFormTarget("new")}>
                  <IconPlus className="h-4 w-4" aria-hidden="true" />
                  {t("rooms.new")}
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <ul
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
              aria-busy={loading}
            >
              {items.map((room) => (
                <li key={room.id}>
                  <RoomCard
                    room={room}
                    canManage={canManage}
                    acting={actingId !== null}
                    onEdit={() => setFormTarget(room)}
                    onStatus={() => setStatusTarget(room)}
                    onDeactivate={() => handleDeactivate(room)}
                    onReactivate={() => handleReactivate(room)}
                    onDetails={() => setDetailTarget(room)}
                  />
                </li>
              ))}
            </ul>
            <Pagination
              total={total}
              limit={PAGE_SIZE}
              offset={offset}
              busy={loading}
              onPrev={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              onNext={() => setOffset((value) => value + PAGE_SIZE)}
            />
          </>
        )}
      </Card>

      {formTarget ? (
        <RoomFormModal
          request={request}
          room={formTarget === "new" ? null : formTarget}
          types={types}
          canManage={canManage}
          onClose={() => setFormTarget(null)}
          onSaved={(message) => {
            setFormTarget(null);
            afterMutation(message);
          }}
        />
      ) : null}

      {statusTarget ? (
        <RoomStatusModal
          request={request}
          room={statusTarget}
          onClose={() => setStatusTarget(null)}
          onChanged={(message) => {
            setStatusTarget(null);
            afterMutation(message);
          }}
        />
      ) : null}

      {detailTarget ? (
        <RoomDetailsModal room={detailTarget} onClose={() => setDetailTarget(null)} />
      ) : null}
    </div>
  );
}

async function deactivateRoomThroughApi({ request, room }) {
  return request(`/api/hotel/rooms/${encodeURIComponent(room.id)}/deactivate`, {
    method: "POST",
    body: {},
  });
}

function RoomCard({ room, canManage, acting, onEdit, onStatus, onDeactivate, onReactivate, onDetails }) {
  const { t } = useHotelI18n();
  const blocked = room.operationalStatus === "OCCUPIED" || room.operationalStatus === "RESERVED";
  const blockedTitle = t("rooms.blockedTitle", {
    status: roomStatusLabel(room.operationalStatus, t),
  });
  return (
    <div
      className={`flex h-full flex-col justify-between gap-3 rounded-2xl border p-4 ${
        room.isActive
          ? "border-[#E2E8F0] bg-white dark:border-[#2A2B36] dark:bg-[#1C1D24]"
          : "border-dashed border-[#E2E8F0] bg-[#F8FAFC] dark:border-[#2A2B36] dark:bg-[#252631]/40"
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-black tracking-tight text-[#1E293B] dark:text-white">
              {t("rooms.roomNumber", { number: room.roomNumber })}
            </p>
            <p className="truncate text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
              {room.roomType?.name
                ? `${room.roomType.name} (${room.roomType.code})`
                : t("common.roomTypeUnavailable")}
            </p>
          </div>
          <StatusBadge status={room.isActive ? room.operationalStatus : "INACTIVE"} />
        </div>
        <p className="mt-2 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
          {t("rooms.floorCapacity", {
            floor: room.floor ?? "—",
            capacity: room.capacity,
            rate: formatMoney(room.effectiveNightlyRate),
          })}
          {room.nightlyRateOverride !== null && room.nightlyRateOverride !== undefined
            ? t("rooms.override")
            : ""}
        </p>
        {room.isActive === false ? (
          <p className="mt-1 text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
            {t("rooms.inactiveNote")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-end gap-1.5">
        <button type="button" className={BTN_SECONDARY} onClick={onDetails}>
          {t("common.details")}
        </button>
        {canManage && room.isActive ? (
          <>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={onStatus}
              disabled={acting || blocked}
              title={blocked ? blockedTitle : t("rooms.changeStatusTitle")}
            >
              {t("rooms.changeStatus")}
            </button>
            <button type="button" className={BTN_SECONDARY} onClick={onEdit} disabled={acting}>
              <IconEdit className="h-3.5 w-3.5" aria-hidden="true" />
              {t("common.edit")}
            </button>
            <button
              type="button"
              className={BTN_DANGER}
              onClick={onDeactivate}
              disabled={acting || blocked}
              title={
                blocked
                  ? t("rooms.blockedDeactivate", { title: blockedTitle })
                  : t("rooms.deactivateTitle", { number: room.roomNumber })
              }
            >
              <IconBan className="h-3.5 w-3.5" aria-hidden="true" />
              {t("rooms.deactivate")}
            </button>
          </>
        ) : null}
        {canManage && room.isActive === false ? (
          <button type="button" className={BTN_SECONDARY} onClick={onReactivate} disabled={acting}>
            {t("rooms.reactivate")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function amenityText(amenities) {
  if (!Array.isArray(amenities) || amenities.length === 0) return "";
  return amenities.join(", ");
}

function parseAmenities(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function RoomFormModal({ request, room, types, canManage, onClose, onSaved }) {
  const { t } = useHotelI18n();
  const isCreate = room === null;
  const [roomNumber, setRoomNumber] = useState(room?.roomNumber ?? "");
  const [floor, setFloor] = useState(
    room?.floor !== undefined && room?.floor !== null ? String(room.floor) : ""
  );
  const [roomTypeId, setRoomTypeId] = useState(room?.roomTypeId ?? "");
  const [capacity, setCapacity] = useState(
    room?.capacity !== undefined && room?.capacity !== null ? String(room.capacity) : ""
  );
  const [capacityTouched, setCapacityTouched] = useState(room ? true : false);
  const [amenities, setAmenities] = useState(amenityText(room?.amenities));
  const [rateOverride, setRateOverride] = useState(
    room?.nightlyRateOverride !== undefined && room?.nightlyRateOverride !== null
      ? String(room.nightlyRateOverride)
      : ""
  );
  const [initialStatus, setInitialStatus] = useState("AVAILABLE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const activeTypes = (types || []).filter((entry) => entry.isActive !== false);
  const currentTypeInactive = room?.roomType && room.roomType.isActive === false;
  const typeOptions = currentTypeInactive
    ? [{ ...room.roomType, __currentInactive: true }, ...activeTypes]
    : activeTypes;

  function updateFieldErrors(next) {
    setFieldErrors(next);
  }

  function selectRoomType(value) {
    setRoomTypeId(value);
    updateFieldErrors({ ...fieldErrors, roomTypeId: undefined });
    if (isCreate && !capacityTouched) {
      const selected = (types || []).find((entry) => entry.id === value);
      if (selected && selected.capacity) {
        setCapacity(String(selected.capacity));
      }
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || !canManage) return;
    setError("");
    setFieldErrors({});

    const localErrors = {};
    const trimmedRoomNumber = roomNumber.trim().toUpperCase();
    if (!trimmedRoomNumber) {
      localErrors.roomNumber = t("roomForm.errRoomNumber");
    } else if (trimmedRoomNumber.length > 20 || !new RegExp(ROOM_NUMBER_PATTERN).test(trimmedRoomNumber)) {
      localErrors.roomNumber = t("roomForm.errRoomNumberFormat");
    }
    const floorNumber = Number(floor);
    if (floor === "" || !Number.isInteger(floorNumber) || floorNumber < -10 || floorNumber > 200) {
      localErrors.floor = t("roomForm.errFloor");
    }
    if (!roomTypeId) {
      localErrors.roomTypeId = t("roomForm.errRoomType");
    }
    const capacityNumber = Number(capacity);
    if (capacity === "" || !Number.isInteger(capacityNumber) || capacityNumber < 1 || capacityNumber > 100) {
      localErrors.capacity = t("roomForm.errCapacity");
    }
    const overrideNumber = Number(rateOverride);
    if (rateOverride !== "" && (!Number.isFinite(overrideNumber) || overrideNumber < 0)) {
      localErrors.nightlyRateOverride = t("roomForm.errRate");
    }
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    const payload = {
      roomNumber: trimmedRoomNumber,
      floor: floorNumber,
      roomTypeId,
      capacity: capacityNumber,
      amenities: parseAmenities(amenities),
      nightlyRateOverride: rateOverride === "" ? null : overrideNumber,
    };
    if (isCreate) payload.operationalStatus = initialStatus;

    setBusy(true);
    try {
      if (isCreate) {
        await request("/api/hotel/rooms", { method: "POST", body: payload });
        onSaved(t("roomForm.created", { number: payload.roomNumber }));
      } else {
        const data = await request(`/api/hotel/rooms/${encodeURIComponent(room.id)}`, {
          method: "PATCH",
          body: payload,
        });
        onSaved(
          t("roomForm.updated", {
            number: data?.room?.roomNumber || payload.roomNumber,
          })
        );
      }
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("roomForm.error")));
        if (submitError?.fieldErrors) setFieldErrors(submitError.fieldErrors);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        isCreate
          ? t("roomForm.newTitle")
          : t("roomForm.editTitle", { number: room.roomNumber })
      }
      description={!isCreate ? t("roomForm.editDescription") : undefined}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="hotel-room-form" className={BTN_PRIMARY} disabled={busy || !canManage}>
            {busy ? <Spinner /> : <IconPlus className="h-4 w-4" aria-hidden="true" />}
            {busy
              ? t("common.saving")
              : isCreate
                ? t("roomForm.create")
                : t("common.saveChanges")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      <form id="hotel-room-form" onSubmit={handleSubmit} noValidate>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t("roomForm.roomNumber")}
            htmlFor="room-number"
            required
            error={fieldErrors.roomNumber}
            hint={t("roomForm.roomNumberHint")}
          >
            <input
              id="room-number"
              type="text"
              className={INPUT}
              value={roomNumber}
              onChange={(event) => {
                setRoomNumber(event.target.value.toUpperCase());
                updateFieldErrors({ ...fieldErrors, roomNumber: undefined });
              }}
              onBlur={() => setRoomNumber((value) => value.trim().toUpperCase())}
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.roomNumber || error ? "true" : undefined}
            />
          </Field>

          <Field
            label={t("common.floor")}
            htmlFor="room-floor"
            required
            error={fieldErrors.floor}
            hint={t("roomForm.floorHint")}
          >
            <input
              id="room-floor"
              type="number"
              inputMode="numeric"
              step={1}
              min={-10}
              max={200}
              className={INPUT}
              value={floor}
              onChange={(event) => {
                setFloor(event.target.value);
                updateFieldErrors({ ...fieldErrors, floor: undefined });
              }}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.floor || error ? "true" : undefined}
            />
          </Field>

          <Field
            label={t("common.roomType")}
            htmlFor="room-type"
            required
            error={fieldErrors.roomTypeId}
            hint={t("roomForm.roomTypeHint")}
          >
            <select
              id="room-type"
              className={INPUT}
              value={roomTypeId}
              onChange={(event) => selectRoomType(event.target.value)}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.roomTypeId || error ? "true" : undefined}
            >
              <option value="">
                {types === null
                  ? t("common.loadingRoomTypes")
                  : t("common.selectRoomType")}
              </option>
              {typeOptions.map((roomType) => (
                <option key={roomType.id} value={roomType.id}>
                  {roomType.name} ({roomType.code})
                  {roomType.__currentInactive ? t("common.inactiveSuffix") : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label={t("common.capacity")}
            htmlFor="room-capacity"
            required
            error={fieldErrors.capacity}
            hint={t("roomForm.capacityHint")}
          >
            <input
              id="room-capacity"
              type="number"
              inputMode="numeric"
              step={1}
              min={1}
              max={100}
              className={INPUT}
              value={capacity}
              onChange={(event) => {
                setCapacity(event.target.value);
                setCapacityTouched(true);
                updateFieldErrors({ ...fieldErrors, capacity: undefined });
              }}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.capacity || error ? "true" : undefined}
            />
          </Field>

          <Field
            label={t("roomForm.rateOverride")}
            htmlFor="room-rate"
            error={fieldErrors.nightlyRateOverride}
            hint={t("roomForm.rateOverrideHint")}
          >
            <input
              id="room-rate"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              className={INPUT}
              value={rateOverride}
              onChange={(event) => {
                setRateOverride(event.target.value);
                updateFieldErrors({ ...fieldErrors, nightlyRateOverride: undefined });
              }}
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.nightlyRateOverride || error ? "true" : undefined}
            />
          </Field>

          <Field
            label={t("roomForm.amenities")}
            htmlFor="room-amenities"
            error={fieldErrors.amenities}
            hint={t("roomForm.amenitiesHint")}
          >
            <input
              id="room-amenities"
              type="text"
              className={INPUT}
              value={amenities}
              onChange={(event) => {
                setAmenities(event.target.value);
                updateFieldErrors({ ...fieldErrors, amenities: undefined });
              }}
              disabled={busy || !canManage}
              placeholder={t("roomForm.amenitiesPlaceholder")}
              aria-invalid={fieldErrors.amenities || error ? "true" : undefined}
            />
          </Field>
        </div>

        {isCreate ? (
          <Field
            label={t("roomForm.initialStatus")}
            htmlFor="room-initial-status"
            className="mt-3"
          >
            <select
              id="room-initial-status"
              className={INPUT}
              value={initialStatus}
              onChange={(event) => setInitialStatus(event.target.value)}
              disabled={busy || !canManage}
            >
              {MANUAL_ROOM_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {roomStatusLabel(value, t)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </form>
    </Modal>
  );
}

function RoomStatusModal({ request, room, onClose, onChanged }) {
  const { t } = useHotelI18n();
  const blocked = room.operationalStatus === "OCCUPIED" || room.operationalStatus === "RESERVED";
  const options = MANUAL_ROOM_STATUSES.filter((value) => value !== room.operationalStatus);
  const [status, setStatus] = useState(options[0] ?? "AVAILABLE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || blocked) return;
    setBusy(true);
    setError("");
    try {
      await request(`/api/hotel/rooms/${encodeURIComponent(room.id)}/status`, {
        method: "POST",
        body: { operationalStatus: status, note: note.trim() },
      });
      onChanged(
        t("roomStatus.changed", {
          number: room.roomNumber,
          status: roomStatusLabel(status, t),
        })
      );
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("roomStatus.error")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("roomStatus.title", { number: room.roomNumber })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="hotel-room-status" className={BTN_PRIMARY} disabled={busy || blocked}>
            {busy ? <Spinner /> : <IconEdit className="h-4 w-4" aria-hidden="true" />}
            {busy ? t("common.saving") : t("rooms.changeStatus")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      {blocked ? (
        <Banner tone="warning" className="mb-3">
          {t("roomStatus.blocked", {
            status: roomStatusLabel(room.operationalStatus, t),
          })}
        </Banner>
      ) : null}
      <form id="hotel-room-status" onSubmit={handleSubmit} noValidate>
        <Field label={t("roomStatus.newStatus")} htmlFor="room-status-select" required>
          <select
            id="room-status-select"
            className={INPUT}
            value={blocked ? "" : status}
            onChange={(event) => setStatus(event.target.value)}
            disabled={busy || blocked}
          >
            {blocked ? <option value="">{t("roomStatus.notChangeable")}</option> : null}
            {options.map((value) => (
              <option key={value} value={value}>
                {roomStatusLabel(value, t)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t("roomStatus.note")}
          htmlFor="room-status-note"
          className="mt-3"
          hint={t("roomStatus.noteHint")}
        >
          <textarea
            id="room-status-note"
            rows={3}
            className={TEXTAREA}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            disabled={busy || blocked}
          />
        </Field>
      </form>
    </Modal>
  );
}

function RoomDetailsModal({ room, onClose }) {
  const { t } = useHotelI18n();
  const rows = [
    ["common.status", <StatusBadge key="status" status={room.isActive ? room.operationalStatus : "INACTIVE"} />],
    ["roomDetail.roomNumber", room.roomNumber],
    ["common.floor", room.floor ?? "—"],
    [
      "common.roomType",
      room.roomType
        ? `${room.roomType.name} (${room.roomType.code})${
            room.roomType.isActive === false ? t("common.inactiveSuffix") : ""
          }`
        : "—",
    ],
    ["roomDetail.typeCapacity", room.roomType?.capacity ?? "—"],
    ["roomDetail.roomCapacity", room.capacity],
    ["roomDetail.rateType", formatMoney(room.roomType?.baseNightlyRate ?? null)],
    [
      "roomDetail.rateOverride",
      room.nightlyRateOverride !== null && room.nightlyRateOverride !== undefined
        ? formatMoney(room.nightlyRateOverride)
        : t("common.none"),
    ],
    ["roomDetail.effectiveRate", formatMoney(room.effectiveNightlyRate)],
    ["roomDetail.amenities", amenityText(room.amenities) || t("common.noneRecorded")],
    ["roomDetail.created", formatDateTime(room.createdAt)],
    ["roomDetail.updated", formatDateTime(room.updatedAt)],
  ];

  return (
    <Modal
      title={t("roomDetail.title", { number: room.roomNumber })}
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
              {value === null || value === undefined || value === "" ? "—" : value}
            </dd>
          </div>
        ))}
      </dl>

      <h3 className="mt-4 text-[11px] font-extrabold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
        {t("roomDetail.history")}
      </h3>
      {Array.isArray(room.statusHistory) && room.statusHistory.length > 0 ? (
        <ol className="mt-2 space-y-2">
          {[...room.statusHistory].reverse().map((entry, index) => (
            <li
              key={`${entry.changedAt ?? "entry"}-${entry.status}-${index}`}
              className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs dark:border-[#2A2B36] dark:bg-[#252631]/60"
            >
              <p className="font-bold text-[#1E293B] dark:text-white">
                {roomStatusLabel(entry.status, t)}
                {entry.previousStatus
                  ? ` ${t("common.fromStatus", {
                      status: roomStatusLabel(entry.previousStatus, t),
                    })}`
                  : ` (${t("common.initial")})`}
              </p>
              <p className="mt-0.5 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                {formatDateTime(entry.changedAt)}
                {entry.note ? ` · ${entry.note}` : ""}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">
          {t("roomDetail.noHistory")}
        </p>
      )}
    </Modal>
  );
}
