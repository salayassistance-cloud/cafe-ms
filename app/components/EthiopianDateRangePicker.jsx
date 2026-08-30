'use client';

// Ethiopian (Ge'ez) calendar range picker for the Manager Reports dashboard.
//
// The picker UI is fully Ethiopian: two month grids labelled with Amharic month
// and weekday names, navigating by Ethiopian year/month. Internally every
// selected date is converted to a Gregorian YYYY-MM-DD (via the native converter
// in lib/ethiopianCalendar) so the backend analytics API — which filters on
// Gregorian UTC timestamps — receives exact, unshifted business-day boundaries.

import { useState, useRef, useEffect } from 'react';
import {
  toEthiopian,
  fromEthiopian,
  gregYMD,
  formatEthiopian,
  ethQuickRanges,
  ET_MONTHS_AM,
  ET_MONTHS_EN,
  ET_MONTHS_OM,
  ET_PRESET_LABELS_AM,
} from '@/lib/ethiopianCalendar';
import { useLanguage } from '@/app/components/LanguageProvider';

const ET_WEEKDAYS_AM = ['ሰኞ', 'ማክሰ', 'ረቡዕ', 'ሐሙስ', 'አርብ', 'ቅዳሜ', 'እሑድ'];

function ymdToDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function ethDayNumber(ec) {
  const daysBeforeYear = 365 * (ec.year - 1) + Math.floor((ec.year - 1) / 4);
  return daysBeforeYear + (ec.month - 1) * 30 + (ec.day - 1);
}

function daysInEthMonth(year, month) {
  if (month >= 1 && month <= 12) return 30;
  return year % 4 === 0 ? 6 : 5; // Pagume
}

function nextMonth(view) {
  let m = view.month + 1;
  let y = view.year;
  if (m > 13) {
    m = 1;
    y += 1;
  }
  return { year: y, month: m };
}

function CalendarIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" strokeLinecap="round" />
    </svg>
  );
}

export default function EthiopianDateRangePicker({ from, to, onChange }) {
  const { t, lang } = useLanguage();
  const [open, setOpen] = useState(false);
  const [fromEC, setFromEC] = useState(() => toEthiopian(ymdToDate(from)));
  const [toEC, setToEC] = useState(() => toEthiopian(ymdToDate(to)));
  const [view, setView] = useState({ year: fromEC.year, month: fromEC.month });
  const ref = useRef(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFromEC(toEthiopian(ymdToDate(from)));
    setToEC(toEthiopian(ymdToDate(to)));
  }, [from, to]);

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
    // No start yet, or a full range already chosen -> begin a new range.
    if (!fromEC || (fromEC && toEC)) {
      setFromEC(ec);
      setToEC(null);
      setView({ year: ec.year, month: ec.month });
      return;
    }
    // Start exists, selecting the end.
    const da = ethDayNumber(fromEC);
    const db = ethDayNumber(ec);
    if (db < da) {
      setToEC(fromEC);
      setFromEC(ec);
    } else {
      setToEC(ec);
    }
  }

  function applyPreset(key) {
    const r = ethQuickRanges()[key];
    setFromEC(r.ecFrom);
    setToEC(r.ecTo);
    setView({ year: r.ecFrom.year, month: r.ecFrom.month });
  }

  function apply() {
    const end = toEC || fromEC;
    const f = gregYMD(fromEthiopian(fromEC.year, fromEC.month, fromEC.day));
    const t = gregYMD(fromEthiopian(end.year, end.month, end.day));
    onChange(f, t);
    setOpen(false);
  }

  const rightView = nextMonth(view);
  const rangeStart = fromEC ? ethDayNumber(fromEC) : null;
  const rangeEnd = toEC ? ethDayNumber(toEC) : rangeStart;

  function cellState(ec) {
    const n = ethDayNumber(ec);
    if (rangeStart != null && rangeEnd != null) {
      if (n === rangeStart && n === rangeEnd) return 'single';
      if (n === rangeStart) return 'start';
      if (n === rangeEnd) return 'end';
      if (n > rangeStart && n < rangeEnd) return 'between';
    }
    return 'none';
  }

  function renderGrid(v) {
    const dim = daysInEthMonth(v.year, v.month);
    const cells = [];
    for (let d = 1; d <= dim; d += 1) cells.push({ year: v.year, month: v.month, day: d });
    // Pad the first row so day 1 lands on its Ethiopian weekday (Mon=0).
    const firstDow = (ethDayNumber({ year: v.year, month: v.month, day: 1 }) + 2) % 7;

    return (
      <div className="w-full max-w-[15rem] md:w-[min(46%,_15rem)]">
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
            {(lang === 'en' ? ET_MONTHS_EN : lang === 'om' ? ET_MONTHS_OM : ET_MONTHS_AM)[v.month - 1]} {v.year}
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
          {ET_WEEKDAYS_AM.map((w) => (
            <span key={w} className="text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">
              {w}
            </span>
          ))}
          {Array.from({ length: firstDow }).map((_, i) => (
            <span key={`pad-${i}`} />
          ))}
          {cells.map((ec) => {
            const st = cellState(ec);
            const base =
              'flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition-colors';
            const styles = {
              none: 'text-[#1E293B] dark:text-white hover:bg-[#F8FAFC] dark:hover:bg-[#252631]',
              between: 'bg-[#F59E0B]/15 text-[#1E293B] dark:text-white',
              single: 'bg-[#F59E0B] text-[#1E293B]',
              start: 'bg-[#F59E0B] text-[#1E293B] rounded-r-none',
              end: 'bg-[#F59E0B] text-[#1E293B] rounded-l-none',
            }[st];
            return (
              <button
                key={`${ec.year}-${ec.month}-${ec.day}`}
                type="button"
                onClick={() => pick(ec)}
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

  const labelFrom = formatEthiopian(fromEC, { withYear: true });
  const labelTo = formatEthiopian(toEC || fromEC, { withYear: true });

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 items-center gap-1.5 rounded-full bg-white dark:bg-[#1C1D24] px-4 text-xs font-bold uppercase tracking-wide text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
      >
        <CalendarIcon />
        <span className="normal-case tracking-normal">
          {labelFrom} – {labelTo} <span className="opacity-60">• EC</span>
        </span>
      </button>

      {open && (
        <div className="fixed inset-x-2 bottom-2 z-50 max-h-[85dvh] w-auto overflow-y-auto rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-4 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)] md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:mt-2 md:max-h-none md:w-[min(92vw,_34rem)]">
          {/* Presets */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {Object.keys(ET_PRESET_LABELS_AM).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className="rounded-full bg-[#F4F5F9] dark:bg-[#252631] px-3 py-1.5 text-[11px] font-bold text-[#1E293B] dark:text-white transition-colors hover:bg-[#FFD600] dark:hover:bg-[#FF5E00]"
              >
                {t(key)}
              </button>
            ))}
          </div>

          {/* Two month grids */}
          <div className="flex flex-wrap justify-center gap-4">
            {renderGrid(view)}
            {renderGrid(rightView)}
          </div>

          {/* Selected range + actions */}
          <div className="mt-3 flex items-center justify-between border-t border-[#E2E8F0] dark:border-[#2A2B36] pt-3">
            <span className="text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">
               {labelFrom} – {labelTo} <span className="opacity-60">({t('ecLabel')})</span>
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-1.5 text-xs font-bold text-[#1E293B] dark:text-white transition-colors hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
              >
                {t('close')}
              </button>
              <button
                type="button"
                onClick={apply}
                className="rounded-full bg-[#FFD600] dark:bg-[#FF5E00] px-4 py-1.5 text-xs font-bold text-[#1E293B] dark:text-white transition-colors hover:bg-[#FFD600] dark:hover:bg-[#FF5E00]"
              >
                {t('apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
