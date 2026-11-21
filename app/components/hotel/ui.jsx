"use client";

// Shared presentation primitives for the Hotel Reception screen.
//
// These intentionally mirror the existing Bono visual language (rounded 2xl
// cards, slate/orange dark palette, yellow/white light palette) instead of
// introducing a second design system. No POS component is imported here.

import { useEffect, useId, useRef } from "react";
import {
  IconAlertTriangleFilled,
  IconCheck,
  IconInfoCircle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import {
  addisYMDToUTCStart,
  formatEthiopianDate,
} from "@/lib/ethiopianCalendar";
import { useHotelI18n } from "./HotelI18n";

export const CARD =
  "rounded-2xl border border-[#E2E8F0]/70 bg-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:border-[#2A2B36] dark:bg-[#1C1D24] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]";

export const INPUT =
  "h-9 w-full rounded-xl border border-[#E2E8F0] bg-white px-3 text-sm font-medium text-[#1E293B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/60 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:placeholder:text-[#64748B] dark:focus:ring-[#FF5E00]/60";

export const TEXTAREA =
  "w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-medium text-[#1E293B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/60 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:placeholder:text-[#64748B] dark:focus:ring-[#FF5E00]/60";

export const LABEL =
  "mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]";

export const BTN_PRIMARY =
  "tactile inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-[#FFD600] px-4 text-xs font-extrabold text-[#1E293B] shadow-[0_6px_14px_-6px_rgba(0,0,0,0.25)] hover:bg-[#FFC800] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#FF5E00] dark:text-white dark:hover:bg-[#F97316]";

export const BTN_SECONDARY =
  "tactile inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-4 text-xs font-bold text-[#1E293B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#2A2B36] dark:bg-[#1C1D24] dark:text-white dark:hover:bg-[#252631]";

export const BTN_GHOST =
  "inline-flex h-8 items-center justify-center gap-1 rounded-full px-3 text-[11px] font-bold text-[#64748B] hover:bg-[#F4F5F9] hover:text-[#1E293B] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#94A3B8] dark:hover:bg-[#252631] dark:hover:text-white";

export const BTN_DANGER =
  "inline-flex h-8 items-center justify-center gap-1 rounded-full border border-[#FCA5A5] bg-[#FEF2F2] px-3 text-[11px] font-bold text-[#B91C1C] hover:bg-[#FEE2E2] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#7F1D1D] dark:bg-[#3F1D1D] dark:text-[#FCA5A5] dark:hover:bg-[#4C1D1D]";

const TONES = {
  success: {
    wrap: "border-[#86EFAC] bg-[#F0FDF4] text-[#166534] dark:border-[#166534] dark:bg-[#12281C] dark:text-[#86EFAC]",
    Icon: IconCheck,
  },
  error: {
    wrap: "border-[#FCA5A5] bg-[#FEF2F2] text-[#991B1B] dark:border-[#7F1D1D] dark:bg-[#2C1616] dark:text-[#FCA5A5]",
    Icon: IconAlertTriangleFilled,
  },
  warning: {
    wrap: "border-[#FCD34D] bg-[#FFFBEB] text-[#92400E] dark:border-[#78350F] dark:bg-[#2A2110] dark:text-[#FCD34D]",
    Icon: IconAlertTriangleFilled,
  },
  info: {
    wrap: "border-[#BAE6FD] bg-[#F0F9FF] text-[#075985] dark:border-[#164E63] dark:bg-[#12232B] dark:text-[#7DD3FC]",
    Icon: IconInfoCircle,
  },
};

const BADGE_TONES = {
  green:
    "bg-[#DCFCE7] text-[#166534] dark:bg-[#12281C] dark:text-[#86EFAC] border-[#86EFAC]/60 dark:border-[#166534]",
  blue:
    "bg-[#DBEAFE] text-[#1D4ED8] dark:bg-[#131F33] dark:text-[#93C5FD] border-[#BFDBFE]/60 dark:border-[#1E3A8A]",
  amber:
    "bg-[#FEF3C7] text-[#92400E] dark:bg-[#2A2110] dark:text-[#FCD34D] border-[#FCD34D]/60 dark:border-[#78350F]",
  red: "bg-[#FEE2E2] text-[#991B1B] dark:bg-[#2C1616] dark:text-[#FCA5A5] border-[#FCA5A5]/60 dark:border-[#7F1D1D]",
  slate:
    "bg-[#F1F5F9] text-[#475569] dark:bg-[#252631] dark:text-[#CBD5E1] border-[#E2E8F0] dark:border-[#3A3B46]",
  purple:
    "bg-[#EDE9FE] text-[#5B21B6] dark:bg-[#241B38] dark:text-[#C4B5FD] border-[#DDD6FE]/60 dark:border-[#4C1D95]",
};

const STATUS_TONES = {
  CONFIRMED: "blue",
  CHECKED_IN: "green",
  CHECKED_OUT: "slate",
  CANCELLED: "red",
  NO_SHOW: "amber",
  IN_HOUSE: "green",
  ACTIVE: "green",
  INACTIVE: "slate",
  AVAILABLE: "green",
  OCCUPIED: "amber",
  RESERVED: "blue",
  CLEANING: "purple",
  MAINTENANCE: "amber",
  OUT_OF_SERVICE: "red",
  RECORDED: "green",
  VOIDED: "red",
  UNAVAILABLE: "slate",
  CHARGES_NOT_FINALIZED: "amber",
  NO_CHARGE: "slate",
  UNPAID: "amber",
  PARTIALLY_PAID: "blue",
  SETTLED: "green",
  OVERPAID: "purple",
};

export function statusTone(status) {
  return STATUS_TONES[String(status || "").toUpperCase()] || "slate";
}

export function humanizeStatus(status) {
  if (!status) return "Unknown";
  return String(status)
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function StatusBadge({ status }) {
  const { t } = useHotelI18n();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${BADGE_TONES[statusTone(status)]}`}
    >
      {status ? t(`status.${status}`, undefined, humanizeStatus(status)) : "—"}
    </span>
  );
}

export function Card({ children, className = "", as: Tag = "div", ...rest }) {
  return (
    <Tag className={`${CARD} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function SectionHeader({ title, subtitle, action, id }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-base font-extrabold text-[#1E293B] dark:text-white">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function Banner({ tone = "info", title, children, onDismiss, className = "" }) {
  const { t } = useHotelI18n();
  const config = TONES[tone] || TONES.info;
  const Icon = config.Icon;
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`flex items-start gap-2.5 rounded-2xl border px-3.5 py-2.5 text-xs font-semibold ${config.wrap} ${className}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-extrabold">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5 font-medium" : "font-medium"}>{children}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.dismiss")}
          className="shrink-0 rounded-full p-1 hover:bg-black/5 dark:hover:bg-white/10"
        >
          <IconX className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function Field({ label, htmlFor, error, hint, required, children, className = "" }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={LABEL}>
        {label}
        {required ? <span className="ml-0.5 text-[#DC2626] dark:text-[#F87171]">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-[11px] font-bold text-[#B91C1C] dark:text-[#FCA5A5]">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">{hint}</p>
      ) : null}
    </div>
  );
}

export function Spinner({ className = "h-4 w-4" }) {
  return <IconLoader2 className={`animate-spin ${className}`} aria-hidden="true" />;
}

export function LoadingRow({ label, colSpan = 1 }) {
  const { t } = useHotelI18n();
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10">
        <div className="flex items-center justify-center gap-2 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">
          <Spinner />
          <span>{label || t("common.loading")}</span>
        </div>
      </td>
    </tr>
  );
}

export function EmptyState({ title, description, action, colSpan }) {
  const body = (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-extrabold text-[#1E293B] dark:text-white">{title}</p>
      {description ? (
        <p className="max-w-md text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
  if (!colSpan) return body;
  return (
    <tr>
      <td colSpan={colSpan}>{body}</td>
    </tr>
  );
}

export function SkeletonRows({ rows = 4, cols = 5 }) {
  return Array.from({ length: rows }).map((_, rowIndex) => (
    <tr key={`skeleton-${rowIndex}`}>
      {Array.from({ length: cols }).map((__, colIndex) => (
        <td key={`skeleton-${rowIndex}-${colIndex}`} className="px-4 py-3.5">
          <div className="h-3 w-full max-w-[8rem] animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
        </td>
      ))}
    </tr>
  ));
}

export function Modal({ title, description, onClose, children, footer, wide = false }) {
  const { t } = useHotelI18n();
  const titleId = useId();
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    previouslyFocused.current =
      typeof document !== "undefined" ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      const focusable = panel.querySelector(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      (focusable || panel).focus();
    }
    return () => {
      const previous = previouslyFocused.current;
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(
        panel.querySelectorAll(
          'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((node) => node.offsetParent !== null);
      if (nodes.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-[#1E293B]/40 px-3 py-4 backdrop-blur-md sm:items-center dark:bg-[#12131A]/80"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`max-h-[92dvh] w-full overflow-y-auto rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-[0_24px_60px_-15px_rgba(0,0,0,0.35)] outline-none dark:border-[#2A2B36] dark:bg-[#1C1D24] ${
          wide ? "max-w-2xl" : "max-w-lg"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-extrabold text-[#1E293B] dark:text-white">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.closeDialog")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#64748B] hover:bg-[#F4F5F9] hover:text-[#1E293B] dark:text-[#94A3B8] dark:hover:bg-[#252631] dark:hover:text-white"
          >
            <IconX className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-4">{children}</div>
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Pagination({ total, limit, offset, onPrev, onNext, busy }) {
  const { t } = useHotelI18n();
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
      <p className="text-[11px] font-bold text-[#64748B] dark:text-[#94A3B8]">
        {t("common.showing", { start, end, total })}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={onPrev}
          disabled={busy || offset <= 0}
          aria-label={t("common.previousPage")}
        >
          {t("common.previous")}
        </button>
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={onNext}
          disabled={busy || offset + limit >= total}
          aria-label={t("common.nextPage")}
        >
          {t("common.next")}
        </button>
      </div>
    </div>
  );
}

const MONEY_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value, currency = "ETB") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return `${currency} ${MONEY_FORMAT.format(Number(value))}`;
}

export function formatEthiopianLocalDate(ymd, lang = "en") {
  if (!ymd) return null;
  const date = addisYMDToUTCStart(ymd);
  if (!date) return null;
  try {
    return formatEthiopianDate(date, lang);
  } catch {
    return null;
  }
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Addis_Ababa",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function FieldError({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[11px] font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
      {children}
    </p>
  );
}
