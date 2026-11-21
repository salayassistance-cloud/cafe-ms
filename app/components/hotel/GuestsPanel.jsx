"use client";

// Reception — guest directory.
//
// Uses only GET /api/hotel/guests (search over first/last name, phone, email,
// isActive filter, pagination) and POST /api/hotel/guests. There is no guest
// delete endpoint; deactivation is intentionally not part of Reception.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconPlus,
  IconRefresh,
  IconSearch,
  IconUserPlus,
} from "@tabler/icons-react";
import { hotelUrl, humanHotelError } from "./hotelApi";
import { useHotelI18n } from "./HotelI18n";
import {
  Banner,
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
  formatDateTime,
} from "./ui";

const PAGE_SIZE = 20;
const ID_TYPES = [
  { value: "", labelKey: "common.notRecorded" },
  { value: "PASSPORT", labelKey: "guests.idType.passport" },
  { value: "NATIONAL_ID", labelKey: "guests.idType.national" },
  { value: "DRIVER_LICENSE", labelKey: "guests.idType.licence" },
  { value: "OTHER", labelKey: "guests.idType.other" },
];

const ID_TYPE_KEYS = {
  PASSPORT: "guests.idType.passport",
  NATIONAL_ID: "guests.idType.national",
  DRIVER_LICENSE: "guests.idType.licence",
  OTHER: "guests.idType.other",
};

const EMPTY_GUEST = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  nationality: "",
  idType: "",
  idNumber: "",
  address: "",
  notes: "",
};

export default function GuestsPanel({
  request,
  refreshToken,
  onChanged,
  onReserve,
  onViewReservations,
  notify,
}) {
  const { t } = useHotelI18n();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("true");
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request(
        hotelUrl("/api/hotel/guests", {
          search,
          isActive: activeFilter,
          limit: PAGE_SIZE,
          offset,
        })
      );
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
    } catch (loadError) {
      if (loadError?.status !== 401) {
        setError(humanHotelError(loadError, t("guests.loadError")));
      }
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [request, search, activeFilter, offset, t]);

  useEffect(() => {
    // Defer the initial fetch so state updates happen outside the effect body
    // (same pattern as InventoryUI / StaffManagement).
    const timeoutId = setTimeout(() => {
      load();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [load, refreshToken]);

  function submitSearch(event) {
    event.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  }

  const hasFilter = Boolean(search) || activeFilter !== "";

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeader
          title={t("guests.title")}
          subtitle={t("guests.subtitle")}
          action={
            <>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => load()}
                disabled={loading}
              >
                <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
                {t("common.refresh")}
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={() => setCreateOpen(true)}>
                <IconUserPlus className="h-4 w-4" aria-hidden="true" />
                {t("guests.new")}
              </button>
            </>
          }
        />

        <form onSubmit={submitSearch} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="guest-search" className={LABEL}>
              {t("guests.searchLabel")}
            </label>
            <div className="relative">
              <IconSearch
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]"
                aria-hidden="true"
              />
              <input
                id="guest-search"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className={`${INPUT} pl-9`}
                placeholder={t("guests.searchPlaceholder")}
              />
            </div>
          </div>
          <div className="w-full sm:w-44">
            <label htmlFor="guest-active-filter" className={LABEL}>
              {t("common.status")}
            </label>
            <select
              id="guest-active-filter"
              value={activeFilter}
              onChange={(event) => {
                setActiveFilter(event.target.value);
                setOffset(0);
              }}
              className={INPUT}
            >
              <option value="">{t("guests.allGuests")}</option>
              <option value="true">{t("guests.activeOnly")}</option>
              <option value="false">{t("guests.inactiveOnly")}</option>
            </select>
          </div>
          <button type="submit" className={BTN_SECONDARY} disabled={loading}>
            <IconSearch className="h-3.5 w-3.5" aria-hidden="true" />
            {t("common.search")}
          </button>
          {hasFilter ? (
            <button
              type="button"
              className="h-9 rounded-full px-3 text-[11px] font-bold text-[#64748B] hover:bg-[#F4F5F9] dark:text-[#94A3B8] dark:hover:bg-[#252631]"
              onClick={() => {
                setSearchInput("");
                setSearch("");
                setActiveFilter("");
                setOffset(0);
              }}
            >
              {t("common.clear")}
            </button>
          ) : null}
        </form>

        {error ? (
          <Banner tone="error" className="mt-4" onDismiss={() => setError("")}>
            {error}
          </Banner>
        ) : null}
      </Card>

      <Card className="p-4 sm:p-5">
        <div className="overflow-x-auto rounded-2xl border border-[#E2E8F0] dark:border-[#2A2B36]">
          <table className="w-full min-w-[860px] text-left text-sm">
            <caption className="sr-only">
              {t("guests.caption")}
            </caption>
            <thead className="bg-[#F4F5F9] text-[11px] uppercase tracking-wide text-[#64748B] dark:bg-[#252631] dark:text-[#94A3B8]">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.guest")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("guests.colContact")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("guests.colIdentification")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.status")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("guests.colCreated")}</th>
                <th scope="col" className="px-4 py-2.5 text-right font-extrabold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] dark:divide-[#2A2B36]">
              {loading ? (
                <LoadingRow label={t("common.loadingGuests")} colSpan={6} />
              ) : items.length === 0 ? (
                <EmptyState
                  colSpan={6}
                  title={t("guests.noMatch")}
                  description={t("guests.noMatchHint")}
                  action={
                    <button type="button" className={BTN_PRIMARY} onClick={() => setCreateOpen(true)}>
                      <IconPlus className="h-4 w-4" aria-hidden="true" />
                      {t("guests.new")}
                    </button>
                  }
                />
              ) : (
                items.map((guest) => (
                  <tr key={guest.id} className="align-top hover:bg-[#F8FAFC] dark:hover:bg-[#252631]/60">
                    <td className="px-4 py-3">
                      <p className="font-extrabold text-[#1E293B] dark:text-white">
                        {guest.fullName || t("common.unnamedGuest")}
                      </p>
                      <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                        {guest.nationality || t("common.nationalityNotRecorded")}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{guest.phone || "—"}</p>
                      <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                        {guest.email || t("common.noEmail")}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{guest.idNumber || "—"}</p>
                      <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                        {guest.idType
                          ? t(
                              ID_TYPE_KEYS[guest.idType],
                              undefined,
                              guest.idType.replaceAll("_", " ")
                            )
                          : t("common.noIdType")}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={guest.isActive ? "ACTIVE" : "INACTIVE"} />
                    </td>
                    <td className="px-4 py-3 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                      {formatDateTime(guest.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className={BTN_SECONDARY}
                          onClick={() => onReserve(guest)}
                        >
                          <IconPlus className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("common.reserve")}
                        </button>
                        <button
                          type="button"
                          className={BTN_SECONDARY}
                          onClick={() => onViewReservations(guest)}
                        >
                          {t("res.title")}
                        </button>
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

      {createOpen ? (
        <CreateGuestModal
          request={request}
          onClose={() => setCreateOpen(false)}
          onCreated={(guest) => {
            setCreateOpen(false);
            notify?.({
              tone: "success",
              message: t("guests.created", { name: guest.fullName }),
            });
            if (offset === 0) {
              load();
            } else {
              setOffset(0);
            }
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateGuestModal({ request, onClose, onCreated }) {
  const { t } = useHotelI18n();
  const [form, setForm] = useState(EMPTY_GUEST);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const canSubmit = useMemo(
    () => form.firstName.trim() && form.lastName.trim() && form.phone.trim(),
    [form.firstName, form.lastName, form.phone]
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

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setFieldErrors({});

    const localErrors = {};
    if (!form.firstName.trim()) localErrors.firstName = t("guestForm.errFirstName");
    if (!form.lastName.trim()) localErrors.lastName = t("guestForm.errLastName");
    if (!form.phone.trim()) localErrors.phone = t("guestForm.errPhone");
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      localErrors.email = t("guestForm.errEmail");
    }
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setBusy(true);
    try {
      const body = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
      };
      if (form.email.trim()) body.email = form.email.trim();
      if (form.nationality.trim()) body.nationality = form.nationality.trim();
      if (form.idType) body.idType = form.idType;
      if (form.idNumber.trim()) body.idNumber = form.idNumber.trim();
      if (form.address.trim()) body.address = form.address.trim();
      if (form.notes.trim()) body.notes = form.notes.trim();

      const data = await request("/api/hotel/guests", { method: "POST", body });
      onCreated(data.guest);
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("guestForm.error")));
        if (submitError?.fieldErrors) setFieldErrors(submitError.fieldErrors);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("guestForm.title")}
      description={t("guestForm.description")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="hotel-create-guest"
            className={BTN_PRIMARY}
            disabled={busy || !canSubmit}
          >
            {busy ? <Spinner /> : <IconUserPlus className="h-4 w-4" aria-hidden="true" />}
            {busy ? t("common.creating") : t("guestForm.create")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-4" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}

      <form id="hotel-create-guest" onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
        <Field label={t("guestForm.firstName")} htmlFor="guest-first-name" required error={fieldErrors.firstName}>
          <input
            id="guest-first-name"
            className={INPUT}
            value={form.firstName}
            onChange={(event) => update("firstName", event.target.value)}
            disabled={busy}
            maxLength={80}
            autoComplete="given-name"
          />
        </Field>
        <Field label={t("guestForm.lastName")} htmlFor="guest-last-name" required error={fieldErrors.lastName}>
          <input
            id="guest-last-name"
            className={INPUT}
            value={form.lastName}
            onChange={(event) => update("lastName", event.target.value)}
            disabled={busy}
            maxLength={80}
            autoComplete="family-name"
          />
        </Field>
        <Field label={t("guestForm.phone")} htmlFor="guest-phone" required error={fieldErrors.phone}>
          <input
            id="guest-phone"
            className={INPUT}
            value={form.phone}
            onChange={(event) => update("phone", event.target.value)}
            disabled={busy}
            maxLength={30}
            inputMode="tel"
            autoComplete="tel"
            placeholder="+251..."
          />
        </Field>
        <Field label={t("guestForm.email")} htmlFor="guest-email" error={fieldErrors.email}>
          <input
            id="guest-email"
            type="email"
            className={INPUT}
            value={form.email}
            onChange={(event) => update("email", event.target.value)}
            disabled={busy}
            maxLength={254}
            autoComplete="email"
          />
        </Field>
        <Field label={t("guestForm.nationality")} htmlFor="guest-nationality" error={fieldErrors.nationality}>
          <input
            id="guest-nationality"
            className={INPUT}
            value={form.nationality}
            onChange={(event) => update("nationality", event.target.value)}
            disabled={busy}
            maxLength={80}
            autoComplete="country-name"
          />
        </Field>
        <Field label={t("guestForm.idType")} htmlFor="guest-id-type" error={fieldErrors.idType}>
          <select
            id="guest-id-type"
            className={INPUT}
            value={form.idType}
            onChange={(event) => update("idType", event.target.value)}
            disabled={busy}
          >
            {ID_TYPES.map((option) => (
              <option key={option.value || "none"} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("guestForm.idNumber")} htmlFor="guest-id-number" error={fieldErrors.idNumber}>
          <input
            id="guest-id-number"
            className={INPUT}
            value={form.idNumber}
            onChange={(event) => update("idNumber", event.target.value)}
            disabled={busy}
            maxLength={60}
          />
        </Field>
        <Field label={t("guestForm.address")} htmlFor="guest-address" error={fieldErrors.address} className="sm:col-span-2">
          <input
            id="guest-address"
            className={INPUT}
            value={form.address}
            onChange={(event) => update("address", event.target.value)}
            disabled={busy}
            maxLength={300}
            autoComplete="street-address"
          />
        </Field>
        <Field
          label={t("common.notes")}
          htmlFor="guest-notes"
          error={fieldErrors.notes}
          hint={t("common.optional1000")}
          className="sm:col-span-2"
        >
          <textarea
            id="guest-notes"
            className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-medium text-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/60 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:focus:ring-[#FF5E00]/60"
            rows={3}
            value={form.notes}
            onChange={(event) => update("notes", event.target.value)}
            disabled={busy}
            maxLength={1000}
          />
        </Field>
      </form>
    </Modal>
  );
}
