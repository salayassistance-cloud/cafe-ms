'use client';

// Ethiopian (Ge'ez) calendar single-date picker, used where the Hotel UI used
// to render a native Gregorian date input (e.g. the reservation arrival and
// departure fields).
//
// The picker UI is fully Ethiopian: one month grid labelled with Amharic month
// and weekday names, navigating by Ethiopian year/month. On every selection the
// Ethiopian date is converted back to a Gregorian YYYY-MM-DD (via
// lib/ethiopianCalendar) so the Hotel API — which receives exact Gregorian
// civil dates — keeps its existing YYYY-MM-DD contract unchanged.
//
// Styling and conversion conventions mirror EthiopianDateRangePicker.jsx: the
// Addis wall-time transport bridge (addisYMDToUTCStart) never lets the browser
// timezone shift a business date, and labels read "Meskerem 12, 2019 E.C." /
// "መስከረም 12, 2019 ዓ.ም.".

import { useState, useRef, useEffect } from 'react';
import {
  toEthiopian,
  fromEthiopian,
  gregYMD,
  getEthiopianMonthName,
  addisYMDToUTCStart,
  ethDayNumber,
  daysInEthMonth,
  ET_MONTHS_AM,
  ET_MONTHS_EN,
  ET_MONTHS_OM,
  ET_WEEKDAYS_AM,
  ET_WEEKDAYS_EN,
} from '@/lib/ethiopianCalendar';
import { useLanguage } from '@/app/components/LanguageProvider';

// Field-like trigger that matches the Hotel INPUT control (h-9 rounded-xl).
const FIELD_STYLE =
  'flex h-9 w-full items-center rounded-xl border border-[#E2E8F0] bg-white px-3 text-left text-sm font-medium text-[#1E293B] transition-colors hover:bg-[#F8FAFC] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/60 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:hover:bg-[#252631] dark:focus:ring-[#FF5E00]/60';

// Canonical transport bridge: Gregorian YYYY-MM-DD (Addis wall, API contract)
// → Addis civil-midnight UTC instant → Ethiopian business date.
// Never construct a Date from local calendar parts — browser timezone must not
// influence the business date.
function transportToEthiopian(ymd) {
  const start = addisYMDToUTCStart(ymd);
  if (!start) return null;
  return toEthiopian(start);
}

// Same presentation convention as EthiopianDateRangePicker: EC label per lang.
function formatECLabel(ec, lang) {
  if (!ec) return '';
  const l = lang === 'en' ? 'en' : lang === 'om' ? 'om' : 'am';
  const monthName = getEthiopianMonthName(ec.month, l) || '';
  const suffix = l === 'am' ? 'ዓ.ም.' : 'E.C.';
  return `${monthName} ${ec.day}, ${ec.year} ${suffix}`;
}

export default function EthiopianDatePicker({
  id,
  value,
  min,
  onChange,
  disabled = false,
}) {
  const { t, lang } = useLanguage();
  const [open, setOpen] = useState(false);
  const [selectedEC, setSelectedEC] = useState(() => transportToEthiopian(value));
  const [view, setView] = useState(() => {
    const anchor = transportToEthiopian(value) || transportToEthiopian(min);
    return anchor
      ? { year: anchor.year, month: anchor.month }
      : { ...toEthiopian(new Date()) };
  });
  const ref = useRef(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedEC(transportToEthiopian(value));
  }, [value]);

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function shiftView(delta) {
    let m = view.month + delta;
    let y = view.year;
    while (m < 1) {
      m += 13;
      y -= 1;
    }
    while (m > 13) {
      m -= 13;
      y += 1;
    }
    setView({ year: y, month: m });
  }

  function pick(ec) {
    // Gregorian YYYY-MM-DD is the only transport value: the Hotel API contract
    // stays unchanged (arrival/departure stay civil YMD strings).
    const ymd = gregYMD(fromEthiopian(ec.year, ec.month, ec.day));
    if (min && ymd < min) return; // outside the allowed range
    setSelectedEC(ec);
    onChange(ymd);
    setOpen(false);
  }

  const label = formatECLabel(selectedEC, lang);
  const selectedDay = selectedEC ? ethDayNumber(selectedEC) : null;

  function renderGrid() {
    const dim = daysInEthMonth(view.year, view.month);
    const cells = [];
    for (let d = 1; d <= dim; d += 1) cells.push({ year: view.year, month: view.month, day: d });
    // Pad the first row so day 1 lands on its Ethiopian weekday (Mon=0).
    const firstDow = (ethDayNumber({ year: view.year, month: view.month, day: 1 }) + 2) % 7;

    return (
      <div className="w-full max-w-[15rem]">
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => shiftView(-1)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white transition-colors hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
            aria-label={t('prevMonth')}
          >
            ‹
          </button>
          <span className="text-xs font-extrabold text-[#1E293B] dark:text-white">
            {(lang === 'en' ? ET_MONTHS_EN : lang === 'om' ? ET_MONTHS_OM : ET_MONTHS_AM)[view.month - 1]} {view.year}
          </span>
          <button
            type="button"
            onClick={() => shiftView(1)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white transition-colors hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
            aria-label={t('nextMonth')}
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {(lang === 'en' ? ET_WEEKDAYS_EN : ET_WEEKDAYS_AM).map((w) => (
            <span key={w} className="text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">
              {w}
            </span>
          ))}
          {Array.from({ length: firstDow }).map((_, i) => (
            <span key={`pad-${i}`} />
          ))}
          {cells.map((ec) => {
            const ymd = gregYMD(fromEthiopian(ec.year, ec.month, ec.day));
            const beforeMin = min ? ymd < min : false;
            const isSelected =
              selectedDay != null && ethDayNumber(ec) === selectedDay;
            const base =
              'flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition-colors';
            const styles = beforeMin
              ? 'cursor-not-allowed text-[#CBD5E1] dark:text-[#4B4D5C]'
              : isSelected
                ? 'bg-[#F59E0B] text-[#1E293B]'
                : 'text-[#1E293B] dark:text-white hover:bg-[#F8FAFC] dark:hover:bg-[#252631]';
            return (
              <button
                key={`${ec.year}-${ec.month}-${ec.day}`}
                type="button"
                onClick={() => pick(ec)}
                disabled={beforeMin}
                aria-pressed={isSelected}
                className={`${base} ${styles}`}
              >
                {ec.day}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        id={id}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={FIELD_STYLE}
      >
        <span className="truncate">{label || '—'}</span>
      </button>

      {open && (
        <div className="fixed inset-x-2 bottom-2 z-50 max-h-[85dvh] w-auto overflow-y-auto rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-4 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)] md:absolute md:inset-x-auto md:bottom-auto md:left-0 md:mt-2 md:max-h-none md:w-[min(92vw,_17rem)]">
          {renderGrid()}

          {/* Selected Ethiopian date + close for the mobile bottom sheet */}
          <div className="mt-3 flex items-center justify-between border-t border-[#E2E8F0] dark:border-[#2A2B36] pt-3">
            <span className="truncate text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">
              {label || '—'} {label ? <span className="opacity-60">({t('ecLabel')})</span> : null}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-1.5 text-xs font-bold text-[#1E293B] dark:text-white transition-colors hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
            >
              {t('close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
