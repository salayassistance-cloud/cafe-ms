'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { safeFetchJson } from '@/lib/clientFetch';
import { formatPrice } from '@/lib/currency';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useLanguage } from '@/app/components/LanguageProvider';
import {
  formatEthiopianDate,
  addisYMDToUTCStart,
  ethQuickRanges,
} from '@/lib/ethiopianCalendar';

// Station Menu Item Performance — one reusable presentation for Kitchen,
// Barista and Jebena Buna. Mirrors the Cashier report table/controls.
//
// The endpoint derives the station from the authenticated LIVE Staff role, so
// this component never sends a station/role parameter. Reports are fetched only
// when the section is opened, when the date preset changes, or on explicit
// refresh. No polling and no SSE coupling with the preparation board.

const PRESETS = [
  { key: 'today', labelKey: 'today' },
  { key: 'yesterday', labelKey: 'yesterday' },
  { key: 'thisWeek', labelKey: 'thisWeek' },
  { key: 'thisMonth', labelKey: 'thisMonth' },
  { key: 'last7', labelKey: 'last7' },
];

const COPY = {
  en: {
    title: 'Menu Item Performance',
    subtitle: 'Completed item lines and paid revenue in the selected business range.',
    menuItem: 'Menu Item',
    quantity: 'Quantity Sold',
    orders: 'Orders',
    revenue: 'Total Revenue',
    empty: 'No completed items in this range.',
    error: 'Unable to load the station report.',
    forbidden: 'This station cannot access another station report.',
    dbUnavailable: 'Database unavailable. Please retry shortly.',
    tooMany: 'Too many requests. Please wait a moment.',
    show: 'Show report',
    hide: 'Hide report',
    roundingNote: 'Card totals follow canonical Birr rounding; item amounts are line-level.',
  },
  am: {
    title: 'የምናሌ እቃ አፈጻጸም',
    subtitle: 'በተመረጠው የስራ ክልል ውስጥ የተከፈለ ገቢ እና የተጠናቀቁ እቃዎች።',
    menuItem: 'እቃ',
    quantity: 'ብዛት',
    orders: 'ትዕዛዞች',
    revenue: 'ጠቅላላ ገቢ',
    empty: 'በዚህ ክልል የተጠናቀቁ እቃዎች የሉም።',
    error: 'ሪፖርቱን መጫን አልተቻለም።',
    forbidden: 'ይህ ጣቢያ የሌላ ጣቢያ ሪፖርት ማየት አይችልም።',
    dbUnavailable: 'የመረጃ ቋቱ አይገኝም። እባክዎ ቆይተው ይሞክሩ።',
    tooMany: 'ብዙ ጥያቄዎች። እባክዎ ትንሽ ይጠብቁ።',
    show: 'ሪፖርት አሳይ',
    hide: 'ሪፖርት ደብቅ',
    roundingNote: 'የካርድ ድምሮች በቀኖናዊ የብር ማጠጋጋት ይታያሉ፤ የእቃ መጠኖች በመስመር ደረጃ ናቸው።',
  },
  om: {
    title: 'Raawwii Meeshaa Menuu',
    subtitle: 'Galii kaffalame fi sarara meeshaa xumurame daangaa hojii filatame keessatti.',
    menuItem: 'Meeshaa',
    quantity: "Baay'ina",
    orders: 'Ajajoota',
    revenue: 'Galii Waliigalaa',
    empty: 'Daangaa kana keessatti meeshaan xumurame hin jirin.',
    error: "Riipeertii fecuu hin danda'amne.",
    forbidden: "Iddoon kun riipeertii iddoo biraa ilaaluu hin danda'u.",
    dbUnavailable: 'Kuusaan odeeffannoo hin argamu. Maaloo booda yaali.',
    tooMany: "Gaaffii baay'ee. Maaloo xiqqoo eegi.",
    show: 'Riipeertii agarsiisi',
    hide: 'Riipeertii dhoksi',
    roundingNote: "Ida'oon kaardii safartuu Birrii kanonaalii hordofa; hangi meeshaa sadarkaa sararaati.",
  },
};

function copyFor(lang) {
  return COPY[lang] || COPY.en;
}

function presetRange(key) {
  const ranges = ethQuickRanges();
  const range = ranges[key] || ranges.last7;
  return { from: range.from, to: range.to };
}

function reportRangeLabel(from, to, lang) {
  const start = addisYMDToUTCStart(from);
  const end = addisYMDToUTCStart(to);
  if (!start || !end) return `${from} — ${to}`;
  const locale = lang === 'om' ? 'om' : lang === 'en' ? 'en' : 'am';
  return `${formatEthiopianDate(start, locale)} — ${formatEthiopianDate(end, locale)}`;
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try {
    return formatPrice(v, 'ETB');
  } catch {
    return `ETB ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
}

function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function MetricCard({ label, value, highlight = false }) {
  return (
    <div className={`rounded-xl border p-3 ${highlight ? 'border-[var(--c-accent)]/40 bg-[var(--c-accent)]/10' : 'border-[var(--c-border-soft)] bg-[var(--c-bg)]'}`}>
      <p className="text-[10px] font-black uppercase tracking-widest text-[var(--c-muted)]">{label}</p>
      <p className="mt-1 text-lg sm:text-xl font-black tabular-nums text-[var(--c-text)]">{value}</p>
    </div>
  );
}

export default function StationReportPanel({ itemType = 'FOOD', stationName = '' }) {
  const { t, lang } = useLanguage();
  const copy = copyFor(lang);
  const [preset, setPreset] = useState('last7');
  const [range, setRange] = useState(() => presetRange('last7'));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  const reqIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const controller = abortRef.current;
      abortRef.current = null;
      try {
        controller?.abort();
      } catch {}
    };
  }, []);

  const fetchReport = useCallback(async (nextRange, nextPreset) => {
    // A newer interval supersedes the old request: abort it, bump the request
    // id, and ignore anything the old request still delivers.
    if (inFlightRef.current) {
      const previous = abortRef.current;
      abortRef.current = null;
      try {
        previous?.abort();
      } catch {}
    }
    const reqId = reqIdRef.current + 1;
    reqIdRef.current = reqId;
    inFlightRef.current = true;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({
        from: nextRange.from,
        to: nextRange.to,
        interval: nextPreset,
      });
      const json = await safeFetchJson(`/api/station/report?${qs.toString()}`, {
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!mountedRef.current || reqId !== reqIdRef.current) return;
      if (!json?.success) throw new Error(json?.error || json?.message || 'Failed to load report');
      const payload = json.data || {};
      setData({
        menuItems: Array.isArray(payload.menuItems) ? payload.menuItems : [],
        totals: payload.totals || { items: 0, units: 0, revenue: 0 },
        station: payload.station || null,
        itemType: payload.itemType || null,
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || controller?.signal?.aborted)) return;
      if (!mountedRef.current || reqId !== reqIdRef.current) return;
      const status = err?.status;
      if (status === 429) setError(copy.tooMany);
      else if (status === 403) setError(copy.forbidden);
      else if (status === 503) setError(copy.dbUnavailable);
      else setError(copy.error);
    } finally {
      if (reqId === reqIdRef.current) {
        inFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, [copy]);

  const selectPreset = useCallback((key) => {
    const nextRange = presetRange(key);
    setPreset(key);
    setRange(nextRange);
    // Never show the previous interval's rows under the new label.
    setData(null);
    setError('');
    setLoading(true);
    fetchReport(nextRange, key);
  }, [fetchReport]);

  const refresh = useCallback(() => {
    fetchReport(range, preset);
  }, [fetchReport, range, preset]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    // Lazy: the report request starts only when the section is first opened.
    if (next && !data && !loading) fetchReport(range, preset);
  }, [expanded, data, loading, fetchReport, range, preset]);

  const items = Array.isArray(data?.menuItems) ? data.menuItems : [];
  const totals = data?.totals || { items: 0, units: 0, revenue: 0 };
  const dateLabel = reportRangeLabel(range.from, range.to, lang);
  const heading = stationName ? `${stationName} · ${copy.title}` : copy.title;
  const bodyId = `station-report-body-${itemType}`;
  const titleId = `station-report-title-${itemType}`;

  return (
    <section aria-labelledby={titleId} className="mx-4 mt-3">
      <div className="rounded-2xl border border-[var(--c-border-soft)] bg-[var(--c-card)] p-3 sm:p-4 shadow-[var(--shadow-card)]" aria-busy={loading}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{heading}</h2>
            <p className="mt-1 hidden text-[11px] font-medium text-[var(--c-muted)] sm:block">{copy.subtitle}</p>
            <p className="mt-1 text-[11px] font-bold text-[var(--c-text)]" aria-live="polite">{dateLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)] shadow-sm disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><path d="M21 12a9 9 0 11-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              {t('cashierRefresh')}
            </button>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={expanded}
              aria-controls={bodyId}
              aria-label={expanded ? copy.hide : copy.show}
              title={expanded ? copy.hide : copy.show}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white text-[var(--c-muted)] shadow-sm dark:bg-[#1C1D24]"
            >
              <svg viewBox="0 0 24 24" fill="none" className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
        </div>

        <div id={bodyId} className={expanded ? '' : 'hidden'}>
          <div className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {PRESETS.map((option) => {
              const active = preset === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => selectPreset(option.key)}
                  aria-pressed={active}
                  className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-wide transition-all duration-150 ease-out active:shadow-inner ${active ? 'border-transparent bg-[var(--c-accent)] text-[#1E293B] shadow-sm dark:text-white' : 'border-[var(--c-border-soft)] bg-white text-[var(--c-muted)] dark:bg-[#1C1D24]'}`}
                >
                  {t(option.labelKey)}
                </button>
              );
            })}
          </div>

          {error && (
            <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#DC2626]">
              <span>{error}</span>
              <button type="button" onClick={refresh} className="rounded-lg border border-[#FECACA] bg-white px-2.5 py-1 text-xs font-bold text-[#DC2626] hover:bg-[#FFF7ED]">{t('uiRetry')}</button>
            </div>
          )}

          {loading && !data ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {Array.from({ length: 2 }).map((_, index) => (
                <div key={index} className="h-[76px] animate-pulse rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)]" />
              ))}
            </div>
          ) : data ? (
            <div className={`mt-3 transition-opacity ${loading ? 'opacity-60' : ''}`}>
              <div className="grid gap-2 sm:grid-cols-2">
                <MetricCard label={copy.revenue} value={fmtMoney(totals.revenue)} highlight />
                <MetricCard label={copy.quantity} value={fmtCount(totals.units)} />
              </div>

              <div className="mt-3 overflow-hidden rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)]/60">
                <div className="flex items-center justify-between border-b border-[var(--c-border-soft)] px-3 py-2">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-[var(--c-muted)]">{copy.title}</h3>
                  <span className="rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-2 py-0.5 text-[10px] font-black text-[var(--c-muted)]">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs font-medium text-[var(--c-muted)]">{copy.empty}</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto custom-scrollbar">
                    <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_5.5rem_3.5rem_6rem] gap-2 border-b border-[var(--c-border-soft)] bg-[var(--c-card)] px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-[var(--c-muted)] sm:grid">
                      <span>{copy.menuItem}</span>
                      <span className="text-right">{copy.quantity}</span>
                      <span className="text-right">{copy.orders}</span>
                      <span className="text-right">{copy.revenue}</span>
                    </div>
                    <ul>
                      {items.map((item, index) => {
                        const name = getLocalizedSingleString(item?.name, lang) || '—';
                        const units = Number(item?.units) || 0;
                        const orders = Number(item?.orderCount) || 0;
                        const revenue = Number(item?.paidRevenue) || 0;
                        return (
                          <li
                            key={item?.key || `${item?.category || 'ITEM'}-${index}`}
                            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-[var(--c-border-soft)] px-3 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_5.5rem_3.5rem_6rem] sm:gap-2"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] text-[10px] font-black text-[var(--c-muted)]">{index + 1}</span>
                              <span className="truncate text-xs font-bold text-[var(--c-text)]" title={name}>{name}</span>
                            </span>
                            <span className="hidden text-right text-xs font-bold tabular-nums text-[var(--c-text)] sm:block">{fmtCount(units)}</span>
                            <span className="hidden text-right text-xs font-semibold tabular-nums text-[var(--c-muted)] sm:block">{fmtCount(orders)}</span>
                            <span className="text-right text-xs font-black tabular-nums text-[var(--c-text)]">
                              <span className="block text-[9px] font-black uppercase tracking-wide text-[var(--c-muted)] sm:hidden">{copy.revenue}</span>
                              {fmtMoney(revenue)}
                            </span>
                            <span className="col-span-2 flex items-center gap-3 text-[10px] font-semibold text-[var(--c-muted)] sm:hidden">
                              <span>{copy.quantity}: <strong className="font-black text-[var(--c-text)]">{fmtCount(units)}</strong></span>
                              <span>{copy.orders}: <strong className="font-black text-[var(--c-text)]">{fmtCount(orders)}</strong></span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
              <p className="mt-1 text-[10px] font-medium text-[var(--c-muted)]">{copy.roundingNote}</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
