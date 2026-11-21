"use client";

// Reception — Room types.
//
// Uses only the existing room-type endpoints: GET/POST /api/hotel/room-types,
// PATCH /api/hotel/room-types/[id], POST /api/hotel/room-types/[id]/deactivate.
// A room type cannot be deactivated while any active room references it (the
// API answers 409 and the message is shown as-is). Reactivation uses
// PATCH isActive: true. Lists are guarded against stale responses.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBan,
  IconEdit,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { hotelUrl, humanHotelError } from "./hotelApi";
import { useHotelI18n } from "./HotelI18n";
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
  LoadingRow,
  Modal,
  Pagination,
  SectionHeader,
  Spinner,
  StatusBadge,
  TEXTAREA,
  formatMoney,
} from "./ui";

const PAGE_SIZE = 20;

const VIEW_OPTIONS = [
  { value: "active", labelKey: "types.viewActive" },
  { value: "inactive", labelKey: "types.viewInactive" },
  { value: "all", labelKey: "types.viewAll" },
];

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

export default function RoomTypesPanel({ request, notify, canManage }) {
  const { t } = useHotelI18n();
  const [view, setView] = useState("active");
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [formTarget, setFormTarget] = useState(null); // null | "new" | roomType
  const [deactivatingId, setDeactivatingId] = useState(null);

  const loadIdRef = useRef(0);

  const query = useMemo(() => {
    const params = { limit: PAGE_SIZE, offset };
    if (view === "active") params.isActive = "true";
    else if (view === "inactive") params.isActive = "false";
    return params;
  }, [view, offset]);

  const load = useCallback(async () => {
    const requestId = ++loadIdRef.current;
    setLoading(true);
    try {
      const data = await request(hotelUrl("/api/hotel/room-types", query));
      if (loadIdRef.current !== requestId) return;
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
      setError("");
    } catch (loadError) {
      if (loadIdRef.current !== requestId) return;
      if (loadError?.status !== 401) {
        setError(humanHotelError(loadError, t("types.loadError")));
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

  function afterMutation(message) {
    notify?.({ tone: "success", message });
    load();
  }

  async function handleDeactivate(roomType) {
    if (deactivatingId !== null) return;
    setDeactivatingId(roomType.id);
    try {
      const data = await request(
        `/api/hotel/room-types/${encodeURIComponent(roomType.id)}/deactivate`,
        { method: "POST", body: {} }
      );
      afterMutation(
        data?.changed === false
          ? t("types.alreadyInactive", { code: roomType.code })
          : t("types.deactivated", { code: roomType.code })
      );
    } catch (submitError) {
      if (submitError?.status !== 401) {
        notify?.({
          tone: "error",
          message: humanHotelError(submitError, t("types.deactivateError")),
        });
      }
    } finally {
      setDeactivatingId(null);
    }
  }

  async function handleReactivate(roomType) {
    if (deactivatingId !== null) return;
    setDeactivatingId(roomType.id);
    try {
      await request(`/api/hotel/room-types/${encodeURIComponent(roomType.id)}`, {
        method: "PATCH",
        body: { isActive: true },
      });
      afterMutation(t("types.reactivated", { code: roomType.code }));
    } catch (submitError) {
      if (submitError?.status !== 401) {
        notify?.({
          tone: "error",
          message: humanHotelError(submitError, t("types.reactivateError")),
        });
      }
    } finally {
      setDeactivatingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeader
          title={t("types.title")}
          action={
            <>
              <button type="button" className={BTN_SECONDARY} onClick={load} disabled={loading}>
                <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
                {t("common.refresh")}
              </button>
              {canManage ? (
                <button type="button" className={BTN_PRIMARY} onClick={() => setFormTarget("new")}>
                  <IconPlus className="h-4 w-4" aria-hidden="true" />
                  {t("types.new")}
                </button>
              ) : null}
            </>
          }
        />

        <div className="mt-4 max-w-xs">
          <label htmlFor="room-type-view" className={LABEL}>
            {t("types.show")}
          </label>
          <select
            id="room-type-view"
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
        <div className="overflow-x-auto rounded-2xl border border-[#E2E8F0] dark:border-[#2A2B36]">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">{t("types.caption")}</caption>
            <thead className="bg-[#F4F5F9] text-[11px] uppercase tracking-wide text-[#64748B] dark:bg-[#252631] dark:text-[#94A3B8]">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("types.colRoomType")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("types.colCapacity")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("types.colRate")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.status")}</th>
                <th scope="col" className="px-4 py-2.5 text-right font-extrabold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] dark:divide-[#2A2B36]">
              {loading ? (
                <LoadingRow label={t("common.loadingRoomTypes")} colSpan={5} />
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      title={t("types.noMatch")}
                      description={t("types.noMatchHint")}
                      action={
                        canManage ? (
                          <button type="button" className={BTN_PRIMARY} onClick={() => setFormTarget("new")}>
                            <IconPlus className="h-4 w-4" aria-hidden="true" />
                            {t("types.new")}
                          </button>
                        ) : null
                      }
                    />
                  </td>
                </tr>
              ) : (
                items.map((roomType) => (
                  <tr key={roomType.id} className="align-top hover:bg-[#F8FAFC] dark:hover:bg-[#252631]/60">
                    <td className="px-4 py-3">
                      <p className="font-extrabold text-[#1E293B] dark:text-white">{roomType.name}</p>
                      <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                        {roomType.code}
                        {amenityText(roomType.amenities)
                          ? ` · ${
                              roomType.amenities.length === 1
                                ? t("common.amenityCountOne", { count: 1 })
                                : t("common.amenityCount", { count: roomType.amenities.length })
                            }`
                          : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-[#1E293B] dark:text-white">
                      {roomType.capacity} {t("common.guestsUnit")}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-[#1E293B] dark:text-white">
                      {formatMoney(roomType.baseNightlyRate)} {t("common.perNight")}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={roomType.isActive ? "ACTIVE" : "INACTIVE"} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {canManage ? (
                          <>
                            <button
                              type="button"
                              className={BTN_SECONDARY}
                              onClick={() => setFormTarget(roomType)}
                              disabled={deactivatingId === roomType.id}
                            >
                              <IconEdit className="h-3.5 w-3.5" aria-hidden="true" />
                              {t("common.edit")}
                            </button>
                            {roomType.isActive ? (
                              <button
                                type="button"
                                className={BTN_DANGER}
                                onClick={() => handleDeactivate(roomType)}
                                disabled={deactivatingId !== null}
                                title={t("types.deactivateTitle", { code: roomType.code })}
                              >
                                {deactivatingId === roomType.id ? (
                                  <Spinner className="h-3.5 w-3.5" />
                                ) : (
                                  <IconBan className="h-3.5 w-3.5" aria-hidden="true" />
                                )}
                                {t("types.deactivate")}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={BTN_SECONDARY}
                                onClick={() => handleReactivate(roomType)}
                                disabled={deactivatingId !== null}
                              >
                                {t("types.reactivate")}
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                            {t("common.readOnlyManager")}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
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

      {formTarget ? (
        <RoomTypeFormModal
          roomType={formTarget === "new" ? null : formTarget}
          canManage={canManage}
          onClose={() => setFormTarget(null)}
          onSaved={(message) => {
            setFormTarget(null);
            afterMutation(message);
          }}
          request={request}
        />
      ) : null}
    </div>
  );
}

function RoomTypeFormModal({ request, roomType, canManage, onClose, onSaved }) {
  const { t } = useHotelI18n();
  const isCreate = roomType === null;
  const [name, setName] = useState(roomType?.name ?? "");
  const [code, setCode] = useState(roomType?.code ?? "");
  const [capacity, setCapacity] = useState(
    roomType?.capacity !== undefined && roomType?.capacity !== null ? String(roomType.capacity) : ""
  );
  const [baseNightlyRate, setBaseNightlyRate] = useState(
    roomType?.baseNightlyRate !== undefined && roomType?.baseNightlyRate !== null
      ? String(roomType.baseNightlyRate)
      : ""
  );
  const [amenities, setAmenities] = useState(amenityText(roomType?.amenities));
  const [description, setDescription] = useState(roomType?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const ROOM_TYPE_CODE_PATTERN = "^[A-Z0-9][A-Z0-9_-]*$";

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || !canManage) return;
    setError("");
    setFieldErrors({});

    const localErrors = {};
    if (!name.trim()) {
      localErrors.name = t("typeForm.errName");
    } else if (name.trim().length > 100) {
      localErrors.name = t("typeForm.errNameLong");
    }
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedCode) {
      localErrors.code = t("typeForm.errCode");
    } else if (
      trimmedCode.length > 30 ||
      !new RegExp(ROOM_TYPE_CODE_PATTERN).test(trimmedCode)
    ) {
      localErrors.code = t("typeForm.errCodeFormat");
    }
    const capacityNumber = Number(capacity);
    if (capacity === "" || !Number.isInteger(capacityNumber) || capacityNumber < 1 || capacityNumber > 100) {
      localErrors.capacity = t("typeForm.errCapacity");
    }
    const rateNumber = Number(baseNightlyRate);
    if (baseNightlyRate === "" || !Number.isFinite(rateNumber) || rateNumber < 0) {
      localErrors.baseNightlyRate = t("typeForm.errRate");
    }
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    const payload = {
      name: name.trim(),
      code: trimmedCode,
      capacity: capacityNumber,
      baseNightlyRate: rateNumber,
      amenities: parseAmenities(amenities),
      description: description.trim(),
    };

    setBusy(true);
    try {
      if (isCreate) {
        const data = await request("/api/hotel/room-types", { method: "POST", body: payload });
        onSaved(t("typeForm.created", { code: data?.roomType?.code || payload.code }));
      } else {
        const data = await request(
          `/api/hotel/room-types/${encodeURIComponent(roomType.id)}`,
          { method: "PATCH", body: payload }
        );
        onSaved(t("typeForm.updated", { code: data?.roomType?.code || payload.code }));
      }
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("typeForm.error")));
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
          ? t("typeForm.newTitle")
          : t("typeForm.editTitle", { code: roomType.code })
      }
      description={
        !isCreate ? t("typeForm.editDescription") : undefined
      }
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="hotel-room-type-form" className={BTN_PRIMARY} disabled={busy || !canManage}>
            {busy ? <Spinner /> : <IconPlus className="h-4 w-4" aria-hidden="true" />}
            {busy
              ? t("common.saving")
              : isCreate
                ? t("typeForm.create")
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
      <form id="hotel-room-type-form" onSubmit={handleSubmit} noValidate>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t("typeForm.name")}
            htmlFor="room-type-name"
            required
            error={fieldErrors.name}
            hint={t("typeForm.nameHint")}
          >
            <input
              id="room-type-name"
              type="text"
              className={INPUT}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setFieldErrors((current) => ({ ...current, name: undefined }));
              }}
              onBlur={() => setName((value) => value.trim())}
              maxLength={100}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.name || error ? "true" : undefined}
            />
          </Field>

          <Field
            label={t("typeForm.code")}
            htmlFor="room-type-code"
            required
            error={fieldErrors.code}
            hint={t("typeForm.codeHint")}
          >
            <input
              id="room-type-code"
              type="text"
              className={INPUT}
              value={code}
              onChange={(event) => {
                setCode(event.target.value.toUpperCase());
                setFieldErrors((current) => ({ ...current, code: undefined }));
              }}
              onBlur={() => setCode((value) => value.trim().toUpperCase())}
              maxLength={30}
              autoComplete="off"
              spellCheck={false}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.code || error ? "true" : undefined}
            />
          </Field>

          <Field
            label={t("types.colCapacity")}
            htmlFor="room-type-capacity"
            required
            error={fieldErrors.capacity}
            hint={t("typeForm.capacityHint")}
          >
            <input
              id="room-type-capacity"
              type="number"
              inputMode="numeric"
              step={1}
              min={1}
              max={100}
              className={INPUT}
              value={capacity}
              onChange={(event) => {
                setCapacity(event.target.value);
                setFieldErrors((current) => ({ ...current, capacity: undefined }));
              }}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.capacity || error ? "true" : undefined}
            />
          </Field>

          <Field
            label={t("typeForm.baseRate")}
            htmlFor="room-type-rate"
            required
            error={fieldErrors.baseNightlyRate}
            hint={t("typeForm.baseRateHint")}
          >
            <input
              id="room-type-rate"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              className={INPUT}
              value={baseNightlyRate}
              onChange={(event) => {
                setBaseNightlyRate(event.target.value);
                setFieldErrors((current) => ({ ...current, baseNightlyRate: undefined }));
              }}
              required
              disabled={busy || !canManage}
              aria-invalid={fieldErrors.baseNightlyRate || error ? "true" : undefined}
            />
          </Field>
        </div>

        <Field
          label={t("typeForm.amenities")}
          htmlFor="room-type-amenities"
          className="mt-3"
          error={fieldErrors.amenities}
          hint={t("typeForm.amenitiesHint")}
        >
          <input
            id="room-type-amenities"
            type="text"
            className={INPUT}
            value={amenities}
            onChange={(event) => {
              setAmenities(event.target.value);
              setFieldErrors((current) => ({ ...current, amenities: undefined }));
            }}
            disabled={busy || !canManage}
            placeholder={t("typeForm.amenitiesPlaceholder")}
            aria-invalid={fieldErrors.amenities || error ? "true" : undefined}
          />
        </Field>

        <Field
          label={t("typeForm.description")}
          htmlFor="room-type-description"
          className="mt-3"
          error={fieldErrors.description}
          hint={t("typeForm.descriptionHint")}
        >
          <textarea
            id="room-type-description"
            rows={3}
            className={TEXTAREA}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setFieldErrors((current) => ({ ...current, description: undefined }));
            }}
            maxLength={1000}
            disabled={busy || !canManage}
            aria-invalid={fieldErrors.description || error ? "true" : undefined}
          />
        </Field>
      </form>
    </Modal>
  );
}
