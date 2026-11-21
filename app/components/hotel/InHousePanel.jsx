"use client";

// Reception — in-house stays, check-out, folios, and payment records.
//
// Payment support is record-only: no gateway, no card data, no partial refunds.
// Recording requires a CHECKED_OUT stay with finalized charges. Voiding is the
// only correction path exposed by the Hotel API.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconCash,
  IconDoorExit,
  IconReceipt,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import EthiopianDateRangePicker from "@/app/components/EthiopianDateRangePicker";
import { HOTEL_PAYMENT_METHODS } from "@/lib/hotel/constants";
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
  { value: "IN_HOUSE", labelKey: "inhouse.viewInHouse" },
  { value: "CHECKED_OUT", labelKey: "inhouse.viewCheckedOut" },
  { value: "all", labelKey: "inhouse.viewAll" },
];

function makeIdempotencyKey(stayId) {
  const suffix = String(stayId || "stay").slice(-8);
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `rec-${suffix}-${Date.now().toString(36)}-${random.slice(0, 24)}`;
}

export default function InHousePanel({ request, refreshToken, onChanged, notify }) {
  const { t, lang } = useHotelI18n();
  const [view, setView] = useState("IN_HOUSE");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checkoutTarget, setCheckoutTarget] = useState(null);
  const [folioTarget, setFolioTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = { limit: PAGE_SIZE, offset };
      if (view === "all") {
        // no status filter
      } else {
        params.status = view;
      }
      if (from) params.checkedInFrom = from;
      if (to) params.checkedInTo = to;
      const data = await request(hotelUrl("/api/hotel/stays", params));
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
    } catch (loadError) {
      if (loadError?.status !== 401) {
        setError(humanHotelError(loadError, t("inhouse.loadError")));
      }
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [request, view, from, to, offset, t]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      load();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [load, refreshToken]);

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeader
          title={t("inhouse.title")}
          subtitle={t("inhouse.subtitle")}
          action={
            <button type="button" className={BTN_SECONDARY} onClick={load} disabled={loading}>
              <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              {t("common.refresh")}
            </button>
          }
        />

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-52">
            <label htmlFor="stay-view" className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t("inhouse.view")}
            </label>
            <select
              id="stay-view"
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
              {t("inhouse.checkedInWindow")}
            </span>
            <EthiopianDateRangePicker
              from={from}
              to={to}
              onChange={(nextFrom, nextTo) => {
                setFrom(nextFrom || "");
                setTo(nextTo || "");
                setOffset(0);
              }}
            />
          </div>

          {from || to ? (
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => {
                setFrom("");
                setTo("");
                setOffset(0);
              }}
            >
              <IconX className="h-3.5 w-3.5" aria-hidden="true" />
              {t("res.clearDates")}
            </button>
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
          <table className="w-full min-w-[900px] text-left text-sm">
            <caption className="sr-only">{t("inhouse.caption")}</caption>
            <thead className="bg-[#F4F5F9] text-[11px] uppercase tracking-wide text-[#64748B] dark:bg-[#252631] dark:text-[#94A3B8]">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("inhouse.colStay")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.guest")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.room")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("inhouse.colCheckedIn")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("inhouse.colExpectedOut")}</th>
                <th scope="col" className="px-4 py-2.5 font-extrabold">{t("common.status")}</th>
                <th scope="col" className="px-4 py-2.5 text-right font-extrabold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] dark:divide-[#2A2B36]">
              {loading ? (
                <LoadingRow label={t("common.loadingStays")} colSpan={7} />
              ) : items.length === 0 ? (
                <EmptyState
                  colSpan={7}
                  title={t("inhouse.noMatch")}
                  description={t("inhouse.noMatchHint")}
                />
              ) : (
                items.map((stay) => (
                  <tr key={stay.id} className="align-top hover:bg-[#F8FAFC] dark:hover:bg-[#252631]/60">
                    <td className="px-4 py-3">
                      <p className="font-extrabold text-[#1E293B] dark:text-white">
                        {stay.reservationNumber}
                      </p>
                      <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                        {t("res.nightsAdults", {
                          nights: stay.reservationNights,
                          nightLabel:
                            stay.reservationNights === 1
                              ? t("common.nightUnit")
                              : t("common.nightsUnit"),
                          adults: stay.adults,
                          adultLabel:
                            stay.adults === 1
                              ? t("common.adultUnit")
                              : t("common.adultsUnit"),
                          children: stay.children
                            ? t("res.childrenPart", { count: stay.children })
                            : "",
                        })}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[#1E293B] dark:text-white">
                        {stay.guest?.fullName || stay.guestSnapshot?.fullName || t("common.guestDetailsUnavailable")}
                      </p>
                      <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                        {stay.guest?.phone || stay.guestSnapshot?.phone || t("common.noPhone")}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[#1E293B] dark:text-white">
                        {stay.room?.roomNumber ? t("res.roomNumber", { number: stay.room.roomNumber }) : "—"}
                      </p>
                      <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                        {stay.roomType?.name || stay.roomTypeSnapshot?.name || "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[#1E293B] dark:text-white">
                        {formatEthiopianLocalDate(stay.checkedInLocalDate, lang) || "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[#1E293B] dark:text-white">
                        {formatEthiopianLocalDate(stay.departureLocalDate, lang) || "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={stay.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {stay.status === "IN_HOUSE" ? (
                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            onClick={() => setCheckoutTarget(stay)}
                          >
                            <IconDoorExit className="h-3.5 w-3.5" aria-hidden="true" />
                            {t("inhouse.checkOut")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={BTN_SECONDARY}
                          onClick={() => setFolioTarget(stay)}
                        >
                          <IconReceipt className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("inhouse.folio")}
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

      {checkoutTarget ? (
        <CheckOutModal
          request={request}
          stay={checkoutTarget}
          onClose={() => setCheckoutTarget(null)}
          onCheckedOut={(result) => {
            setCheckoutTarget(null);
            notify?.({
              tone: "success",
              message: t("inhouse.checkedOutMessage", {
                number: checkoutTarget.reservationNumber,
                status: t(
                  `status.${result?.roomStatus}`,
                  undefined,
                  humanizeStatus(result?.roomStatus)
                ),
              }),
            });
            load();
            onChanged?.();
            if (result?.stay) setFolioTarget(result.stay);
          }}
        />
      ) : null}

      {folioTarget ? (
        <FolioModal
          request={request}
          stay={folioTarget}
          onClose={() => setFolioTarget(null)}
          notify={notify}
          onChanged={() => {
            onChanged?.();
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function CheckOutModal({ request, stay, onClose, onCheckedOut }) {
  const { t } = useHotelI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await request(`/api/hotel/stays/${encodeURIComponent(stay.id)}/check-out`, {
        method: "POST",
        body: { note: note.trim() },
      });
      onCheckedOut(data);
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("checkout.error")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("checkout.title", { number: stay.reservationNumber })}
      description={t("checkout.description", {
        room: stay.room?.roomNumber || "—",
        guest: stay.guest?.fullName || stay.guestSnapshot?.fullName || t("common.guest"),
      })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="hotel-check-out" className={BTN_PRIMARY} disabled={busy}>
            {busy ? <Spinner /> : <IconDoorExit className="h-4 w-4" aria-hidden="true" />}
            {busy ? t("checkout.busy") : t("checkout.submit")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      <Banner tone="warning" className="mb-3">
        {t("checkout.info")}
      </Banner>
      <form id="hotel-check-out" onSubmit={handleSubmit}>
        <Field label={t("checkout.note")} htmlFor="check-out-note" hint={t("common.optional500")}>
          <textarea
            id="check-out-note"
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

function FolioModal({ request, stay, onClose, notify, onChanged }) {
  const { t, lang } = useHotelI18n();
  const [folio, setFolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState(HOTEL_PAYMENT_METHODS[0]);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState("");
  const keyRef = useRef("");

  const [voidTarget, setVoidTarget] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await request(`/api/hotel/stays/${encodeURIComponent(stay.id)}/folio`);
        if (!cancelled) setFolio(data?.folio || null);
      } catch (loadError) {
        if (!cancelled && loadError?.status !== 401) {
          setError(humanHotelError(loadError, t("folio.loadError")));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // Reload only when the stay or reload token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, stay.id, reloadToken]);

  const currency = folio?.currency || "ETB";
  const canRecord =
    stay.status === "CHECKED_OUT" &&
    folio?.canRecordPayment === true &&
    Number(folio?.outstandingBalance) > 0;
  const payments = useMemo(
    () => (Array.isArray(folio?.payments) ? folio.payments : []),
    [folio]
  );

  function resetIdempotencyKey() {
    keyRef.current = "";
  }

  async function handleRecordPayment(event) {
    event.preventDefault();
    if (payBusy) return;
    setPayError("");

    const raw = amount.trim();
    if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(raw)) {
      setPayError(t("folio.errPositive"));
      return;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setPayError(t("folio.errGreaterThanZero"));
      return;
    }
    if (folio?.outstandingBalance != null && numeric > Number(folio.outstandingBalance)) {
      setPayError(
        t("folio.errExceeds", {
          amount: formatMoney(folio.outstandingBalance, currency),
        })
      );
      return;
    }

    if (!keyRef.current) keyRef.current = makeIdempotencyKey(stay.id);
    setPayBusy(true);
    try {
      const data = await request(`/api/hotel/stays/${encodeURIComponent(stay.id)}/payments`, {
        method: "POST",
        body: {
          amount: raw,
          method,
          idempotencyKey: keyRef.current,
        },
      });
      setFolio(data?.folio || folio);
      setAmount("");
      resetIdempotencyKey();
      notify?.({
        tone: "success",
        message: data?.replayed
          ? t("folio.replayed")
          : t("folio.recorded", { number: data?.payment?.paymentNumber || "" }).trim(),
      });
      onChanged?.();
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setPayError(humanHotelError(submitError, t("folio.errRecord")));
        // Retain the key only for ambiguous transport/server failures so a
        // retry cannot create a second payment.
        if (submitError?.status === 0 || (submitError?.status || 0) >= 500) {
          // keep keyRef.current
        } else {
          resetIdempotencyKey();
        }
      }
    } finally {
      setPayBusy(false);
    }
  }

  return (
    <Modal
      title={t("folio.title", { number: stay.reservationNumber })}
      description={t("folio.description", {
        room: stay.room?.roomNumber || "—",
        guest: stay.guest?.fullName || stay.guestSnapshot?.fullName || t("common.guest"),
        arrival: formatEthiopianLocalDate(stay.arrivalLocalDate, lang),
        departure: formatEthiopianLocalDate(stay.departureLocalDate, lang),
      })}
      onClose={voidTarget ? () => {} : onClose}
      wide
      footer={
        <button type="button" className={BTN_SECONDARY} onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">
          <Spinner />
          {t("common.loadingFolio")}
        </div>
      ) : !folio ? (
        <Banner tone="warning">{t("folio.noFolio")}</Banner>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={folio.settlementStatus} />
            <StatusBadge status={stay.status} />
            <span className="text-[11px] font-bold text-[#64748B] dark:text-[#94A3B8]">
              {t("folio.chargeRule", { rule: folio.chargeRule || "—" })}
            </span>
          </div>

          {!folio.available ? (
            <Banner tone="warning">
              {t("folio.unavailable", {
                reason: folio.reason
                  ? t("folio.unavailableReason", {
                      reason: humanizeStatus(folio.reason),
                    })
                  : "",
              })}{" "}
              {t("folio.unavailableNote")}
            </Banner>
          ) : null}
          {folio.available && !folio.finalized ? (
            <Banner tone="info">
              {t("folio.notFinalized")}
            </Banner>
          ) : null}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryTile label={t("folio.billableNights")} value={folio.billableNights ?? "—"} />
            <SummaryTile label={t("folio.nightlyRate")} value={formatMoney(folio.nightlyRate, currency)} />
            <SummaryTile label={t("folio.roomCharges")} value={formatMoney(folio.roomCharges, currency)} />
            <SummaryTile label={t("folio.totalCharges")} value={formatMoney(folio.totalCharges, currency)} />
            <SummaryTile label={t("folio.totalPaid")} value={formatMoney(folio.totalPaid, currency)} />
            <SummaryTile label={t("folio.outstanding")} value={formatMoney(folio.outstandingBalance, currency)} />
            <SummaryTile
              label={t("folio.overpayment")}
              value={folio.overpayment == null ? "—" : formatMoney(folio.overpayment, currency)}
            />
            <SummaryTile label={t("folio.paymentsCount")} value={folio.paymentCount == null ? "—" : String(folio.paymentCount)} />
          </div>

          <section aria-labelledby="folio-payments-heading">
            <h3 id="folio-payments-heading" className="text-sm font-extrabold text-[#1E293B] dark:text-white">
              {t("folio.recordedPayments")}
            </h3>
            <div className="mt-2 overflow-x-auto rounded-2xl border border-[#E2E8F0] dark:border-[#2A2B36]">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead className="bg-[#F4F5F9] text-[10px] uppercase tracking-wide text-[#64748B] dark:bg-[#252631] dark:text-[#94A3B8]">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-extrabold">{t("folio.colPayment")}</th>
                    <th scope="col" className="px-3 py-2 font-extrabold">{t("folio.colAmount")}</th>
                    <th scope="col" className="px-3 py-2 font-extrabold">{t("folio.colMethod")}</th>
                    <th scope="col" className="px-3 py-2 font-extrabold">{t("common.status")}</th>
                    <th scope="col" className="px-3 py-2 font-extrabold">{t("folio.colRecorded")}</th>
                    <th scope="col" className="px-3 py-2 text-right font-extrabold">{t("folio.colAction")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0] dark:divide-[#2A2B36]">
                  {payments.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">
                        {t("folio.noPayments")}
                      </td>
                    </tr>
                  ) : (
                    payments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="px-3 py-2 font-bold text-[#1E293B] dark:text-white">
                          {payment.paymentNumber || "—"}
                        </td>
                        <td className="px-3 py-2 font-semibold">
                          {formatMoney(payment.amount, payment.currency || currency)}
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {payment.method
                            ? t(`pay.${payment.method}`, undefined, payment.method)
                            : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={payment.status} />
                        </td>
                        <td className="px-3 py-2 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                          {formatDateTime(payment.recordedAt)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {payment.status === "RECORDED" && folio.canVoidPayment ? (
                            <button
                              type="button"
                              className={BTN_DANGER}
                              onClick={() => setVoidTarget(payment)}
                            >
                              {t("folio.void")}
                            </button>
                          ) : (
                            <span className="text-[11px] font-medium text-[#94A3B8]">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="folio-record-heading" className="rounded-2xl border border-[#E2E8F0] p-3 dark:border-[#2A2B36]">
            <h3 id="folio-record-heading" className="text-sm font-extrabold text-[#1E293B] dark:text-white">
              {t("folio.recordPayment")}
            </h3>
            {!canRecord ? (
              <p className="mt-1 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                {stay.status !== "CHECKED_OUT"
                  ? t("folio.recordDisabledNotCheckedOut")
                  : folio.available === false
                    ? t("folio.recordDisabledUnavailable")
                    : t("folio.recordDisabledSettled")}
              </p>
            ) : (
              <form onSubmit={handleRecordPayment} className="mt-3 space-y-3" noValidate>
                {payError ? (
                  <Banner tone="error" onDismiss={() => setPayError("")}>
                    {payError}
                  </Banner>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field
                    label={t("folio.amount", { currency })}
                    htmlFor="payment-amount"
                    required
                    hint={t("folio.outstandingHint", {
                      amount: formatMoney(folio.outstandingBalance, currency),
                    })}
                  >
                    <input
                      id="payment-amount"
                      type="text"
                      inputMode="decimal"
                      className={INPUT}
                      value={amount}
                      onChange={(event) => {
                        setAmount(event.target.value);
                        resetIdempotencyKey();
                      }}
                      placeholder="0.00"
                      disabled={payBusy}
                    />
                  </Field>
                  <Field label={t("folio.method")} htmlFor="payment-method" required>
                    <select
                      id="payment-method"
                      className={INPUT}
                      value={method}
                      onChange={(event) => {
                        setMethod(event.target.value);
                        resetIdempotencyKey();
                      }}
                      disabled={payBusy}
                    >
                      {HOTEL_PAYMENT_METHODS.map((value) => (
                        <option key={value} value={value}>
                          {t(`pay.${value}`, undefined, value)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="flex items-end">
                    <button type="submit" className={`${BTN_PRIMARY} w-full`} disabled={payBusy || !amount.trim()}>
                      {payBusy ? <Spinner /> : <IconCash className="h-4 w-4" aria-hidden="true" />}
                      {payBusy ? t("folio.recording") : t("folio.record")}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                  {t("folio.recordNote")}
                </p>
              </form>
            )}
          </section>
        </div>
      )}

      {voidTarget ? (
        <VoidPaymentModal
          request={request}
          payment={voidTarget}
          onClose={() => setVoidTarget(null)}
          onVoided={(data) => {
            setVoidTarget(null);
            if (data?.folio) setFolio(data.folio);
            notify?.({
              tone: "success",
              message: data?.replayed ? t("void.already") : t("void.done"),
            });
            onChanged?.();
          }}
        />
      ) : null}
    </Modal>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div className="rounded-xl bg-[#F4F5F9] px-3 py-2 dark:bg-[#252631]">
      <p className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-black text-[#1E293B] dark:text-white">{value}</p>
    </div>
  );
}

function VoidPaymentModal({ request, payment, onClose, onVoided }) {
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
      const data = await request(`/api/hotel/payments/${encodeURIComponent(payment.id)}/void`, {
        method: "POST",
        body: { reason: reason.trim() },
      });
      onVoided(data);
    } catch (submitError) {
      if (submitError?.status !== 401) {
        setError(humanHotelError(submitError, t("void.error")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("void.title", { number: payment.paymentNumber || "" })}
      description={t("void.description", {
        amount: formatMoney(payment.amount, payment.currency || "ETB"),
        method: payment.method
          ? t(`pay.${payment.method}`, undefined, payment.method)
          : "—",
      })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>
            {t("void.keep")}
          </button>
          <button type="submit" form="hotel-void-payment" className={BTN_DANGER} disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? t("void.busy") : t("void.submit")}
          </button>
        </>
      }
    >
      {error ? (
        <Banner tone="error" className="mb-3" onDismiss={() => setError("")}>
          {error}
        </Banner>
      ) : null}
      <form id="hotel-void-payment" onSubmit={handleSubmit}>
        <Field
          label={t("void.reason")}
          htmlFor="void-reason"
          hint={t("void.reasonHint")}
        >
          <textarea
            id="void-reason"
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
