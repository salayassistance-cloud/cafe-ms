'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useState, useEffect, useRef, useCallback, memo } from 'react';
import Link from 'next/link';
import { safeFetchJson } from '@/lib/clientFetch';
import LanguageToggle from '@/app/components/LanguageToggle';
import { useLanguage } from '@/app/components/LanguageProvider';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';
import EthiopianDateRangePicker from '@/app/components/EthiopianDateRangePicker';
import ManagerSidebar from '@/app/components/ManagerSidebar';
import {
  ethQuickRanges,
  toEthiopian,
  formatEthiopianDate,
  formatEthiopianDateTime,
  addisYMDToUTCStart,
  ET_MONTHS_AM,
  ET_MONTHS_EN,
  ET_MONTHS_OM,
} from '@/lib/ethiopianCalendar';

// Phase 3 — Manager Time-Interval Reporting Dashboard.
// Consumes GET /api/manager/analytics and renders executive KPIs, interval
// breakdowns, top-seller velocity bars, waiter performance and kitchen speed.
// Exact palette: Slate #12131A / Vivid Orange #FF5500 unified — light #F4F5F9



const INTERVALS = [
  { key: 'hourly', labelKey: 'hourly' },
  { key: 'shift', labelKey: 'shift' },
  { key: 'trends', labelKey: 'trends' },
  { key: 'custom', labelKey: 'custom' },
];

function fmtETB(n) {
  const v = Number(n) || 0;
  return `ETB ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtDur(sec) {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Display-only localization of Ethiopian-clock period words.
// English mode maps ቀን/ማታ → AM/PM (established Reports convention);
// Amharic mode keeps the backend ቀን/ማታ labels untouched.
// The underlying report timestamps, timezone and aggregation are never touched.
function toAMPM(label, lang) {
  if (!label) return label;
  if (lang !== 'en') return String(label);
  return String(label).replace(/ቀን/g, 'AM').replace(/ማታ/g, 'PM');
}

// Display-only transform of a backend shift name (e.g.
// "Shift A · 12 ማታ → 6:30 ቀን (Morning)").
// Purely a display transform — the underlying shift assignment/calculation and
// report aggregation are never changed. Only the displayed label/range and the
// human-readable period word (Morning/Afternoon/Evening) are localized.
function localizeShiftName(name, lang) {
  if (!name) return name;
  const periodMap = {
    Morning: { am: 'ጥዋት' },
    Afternoon: { am: 'ከሰዓት' },
    Evening: { am: 'ማታ' },
  };
  const keyMatch = String(name).match(/(Shift\s*[A-C])/i);
  const key = keyMatch ? keyMatch[1] : '';
  const perMatch = String(name).match(/\(([^)]+)\)/);
  const period = perMatch ? perMatch[1].trim() : '';
  const periodLocal = (periodMap[period] && periodMap[period][lang]) || period;
  // Amharic mode keeps Ethiopian-clock words (ቀን/ማታ); other modes use the
  // established English AM/PM convention. Hour numbers are never converted.
  const amMode = lang === 'am';
  let range;
  if (/Shift\s*A/i.test(name)) range = amMode ? '12 ቀን - 6:30 ቀን' : '12 AM - 6:30 AM';
  else if (/Shift\s*C/i.test(name)) range = amMode ? '12 ማታ - 6 ማታ' : '12 PM - 6 PM';
  else {
    range = String(name);
    if (!amMode) range = range.replace(/ቀን/g, 'AM').replace(/ማታ/g, 'PM');
    range = range
      .replace(/·/g, ' ')
      .replace(/→/g, ' - ')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!key) {
    let fallback = String(name);
    if (!amMode) fallback = fallback.replace(/ቀን/g, 'AM').replace(/ማታ/g, 'PM');
    return fallback
      .replace(/·/g, ' ')
      .replace(/→/g, ' - ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return periodLocal ? `${key} ${range} (${periodLocal})` : `${key} ${range}`;
}

// Canonical Phase E bridge (Phase C foundation):
// Transport YYYY-MM-DD (Addis wall, API contract) → Addis civil-midnight UTC
// instant. Never `new Date(y, m - 1, d)` — browser timezone must not shift the
// business day. Display stays Ethiopian; transport stays YYYY-MM-DD.
function transportKeyToEthiopian(ymd) {
  const start = addisYMDToUTCStart(ymd);
  if (!start) return null;
  return toEthiopian(start);
}

// User-facing instant formatting — canonical Ethiopian calendar +
// Africa/Addis_Ababa wall time. Never browser-local toLocaleString for
// business dates. `new Date(value)` here only wraps an existing UTC instant.
function formatOrderDateTime(value, lang) {
  try {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return formatEthiopianDateTime(d, lang === 'en' ? 'en' : 'am');
  } catch {
    return '—';
  }
}

// All presets resolve to Gregorian YYYY-MM-DD bounds (the API contract) but are
// computed on the Ethiopian calendar so "this week / this month" align to EC
// periods. The backend filters on Gregorian UTC timestamps unchanged.
function defaultRange() {
  const r = ethQuickRanges().last7;
  return { from: r.from, to: r.to };
}

function rangeToday() {
  const r = ethQuickRanges().today;
  return { from: r.from, to: r.to };
}

function rangeYesterday() {
  const r = ethQuickRanges().yesterday;
  return { from: r.from, to: r.to };
}

function rangeThisWeek() {
  const r = ethQuickRanges().thisWeek;
  return { from: r.from, to: r.to };
}

function rangeThisMonth() {
  const r = ethQuickRanges().thisMonth;
  return { from: r.from, to: r.to };
}

function rangeLast7() {
  return defaultRange();
}

const QUICK_RANGES = [
  { labelKey: 'today', make: rangeToday },
  { labelKey: 'yesterday', make: rangeYesterday },
  { labelKey: 'thisWeek', make: rangeThisWeek },
  { labelKey: 'thisMonth', make: rangeThisMonth },
  { labelKey: 'last7', make: rangeLast7 },
];

function rangeActive(factory, from, to) {
  const { from: f, to: t } = factory();
  return from === f && to === t;
}

const PILL_ACTIVE =
  'bg-[#FFD600] dark:bg-[#FF5500] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner';
const PILL_INACTIVE =
  'bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner';
const CARD =
  'rounded-2xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:shadow-[0_14px_30px_-5px_rgba(0,0,0,0.08),0_10px_12px_-6px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_16px_36px_rgba(0,0,0,0.55)]   active:shadow-inner';

export default function ManagerReports() {
  const { t, lang } = useLanguage();
  const init = defaultRange();
  const [interval, setIntervalMode] = useState('trends');
  const [trendMode, setTrendMode] = useState('daily');
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [itemFilter, setItemFilter] = useState('ALL');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const dataRef = useRef(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const fetchReports = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ from, to, interval });
      const json = await safeFetchJson(`/api/manager/analytics?${qs.toString()}`, { cache: 'no-store' });
      if (!json.success) throw new Error(json.error || json.message || 'Failed');
      const d = json.data || {};
      setData({
        ...d,
        kpis: d.kpis || {},
        hourly: d.hourly || [],
        shifts: d.shifts || [],
        daily: d.daily || [],
        weekly: d.weekly || [],
        topItems: d.topItems || [],
        slowItems: d.slowItems || [],
        waiterPerf: d.waiterPerf || [],
        paymentBreakdown: d.paymentBreakdown || [],
        kitchen: d.kitchen || {},
      });
    } catch (err) {
      const status = err?.status;
      if (status === 401 || status === 403) {
        if (!silent || !dataRef.current) {
          setError(t('sessionExpired'));
          // Trigger hard reload so PinGuard layout re-evaluates HttpOnly cookie
          if (typeof window !== 'undefined' && !silent) {
            setTimeout(() => window.location.reload(), 1500);
          }
        }
        return;
      }
      if (status === 429) {
        if (!silent || !dataRef.current) {
          const ra = err?.retryAfter ? ` ${t('retryAfter')} ${err.retryAfter}s.` : '';
          setError(`${t('tooManyRequests')}${ra}`);
        }
        return;
      }
      if (!silent || !dataRef.current) {
        const msg = err?.message?.includes('503') || err?.message?.includes('Database')
          ? t('dbUnavailable')
          : t('unableLoadReports');
        setError(msg);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [from, to, interval, t]);

  // Phase 5: SSE-first, on-demand — fetch on mount / filters, silent revalidate on visibility or 60s idle.
  // No aggressive 3s poll (was 20 req/min per tab).
  useEffect(() => {
    const initId = setTimeout(() => fetchReports(), 0);
    let intervalId = null;
    const startInterval = () => {
      if (intervalId) clearInterval(intervalId);
      // 60s background refresh only when tab visible — avoids stale while idle, no hammer
      intervalId = setInterval(() => {
        if (document.visibilityState === "visible") fetchReports(true);
      }, 60000);
    };
    startInterval();
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchReports(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(initId);
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchReports]);

  // Business brand for the printed/PDF header — existing /api/brand
  // config (read-only here), operational fallback otherwise.
  const [brandName, setBrandName] = useState('');
  useEffect(() => {
    let cancelled = false;
    safeFetchJson('/api/brand', { cache: 'no-store' }).then((raw) => {
      if (cancelled) return;
      const n = raw?.data?.brand?.name;
      if (typeof n === 'string' && n.trim()) setBrandName(n.trim());
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const reportBrand = (brandName || 'AVENUE HOTEL').toUpperCase();

  // Gate @media print on the dedicated document: while report data is loaded
  // the browser prints ONLY #bono-report-doc; otherwise normal printing.
  const printableDoc = !!(data && !loading);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (printableDoc) document.body.classList.add('bono-print-report');
    else document.body.classList.remove('bono-print-report');
    return () => document.body.classList.remove('bono-print-report');
  }, [printableDoc]);

  function exportCSV() {
    if (!data) return;
    // Machine-readable cells: null/undefined become empty (never the strings
    // "null"/"undefined"); quotes are RFC-4180 doubled; every field is quoted
    // so commas/newlines inside values cannot break spreadsheet import.
    // Leading BOM keeps UTF-8 (Ethiopian-calendar text) intact in Excel.
    const csvCell = (c) => {
      if (c == null) return '""';
      return `"${String(c).replace(/"/g, '""')}"`;
    };
    const rows = [
      [t('csvReport'), `${t('managerReports')} (${formatOrderDateTime(data.range.from, lang)} to ${formatOrderDateTime(data.range.to, lang)})`],
      [''],
      [t('csvKpi'), t('csvValue')],
      [t('totalRevenue'), data.kpis.revenue],
      [`${t('revenueDelta')} %`, data.kpis.revenueDeltaPct],
      [t('completedOrders'), data.kpis.completedOrders],
      [t('cancelledOrders'), data.kpis.cancelledOrders],
      [`${t('avgFulfillment')} (s)`, data.kpis.avgFulfillmentSec],
      [t('peakHour'), toAMPM(data.kpis.peakHourLabel, lang)],
      [''],
      [t('csvTopItem'), t('csvCategory'), t('csvQty'), t('csvRevenue')],
      ...data.topItems.map((i) => [i.title, i.category, i.qty, i.revenue]),
      [''],
      [t('csvWaiter'), t('csvOrders'), t('csvRevenue'), t('csvAvgFulfillment')],
      ...data.waiterPerf.map((w) => [
        w.waiter,
        w.orders,
        w.revenue,
        w.avgFulfillmentSec,
      ]),
    ];
    const csv = '\uFEFF' + rows
      .map((r) => r.map(csvCell).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `manager-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPDF() {
    if (typeof window !== 'undefined') window.print();
  }

  const kpis = data?.kpis;
  const filteredTop =
    data?.topItems.filter(
      (i) => itemFilter === 'ALL' || i.category === itemFilter
    ) || [];

  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col lg:flex-row">
      <ManagerSidebar onExportCsv={exportCSV} onExportPdf={exportPDF} />
      <div className="flex-1 min-w-0 p-4 text-[#1E293B] dark:text-white sm:p-6 overflow-x-hidden">
        {/* ============ TIER 1: TOP HEADER BAR — transparent in dark ============ */}
      <header className="relative rounded-2xl bg-white dark:bg-[#1C1D24] px-4 py-3 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-[#1E293B] dark:text-white sm:text-2xl">
              {t('managerReports')}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle includeOromia={false} />
            <Link
              href="/"
              title={t('home')}
              aria-label={t('home')}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
              </svg>
            </Link>
            <ThemeToggleHome />
          </div>
        </div>
      </header>

      {/* ============ TIER 2: FILTER & VIEW CONTROL BAR ============ */}
      <div className="mt-4 rounded-2xl bg-white dark:bg-[#1C1D24] px-4 py-3 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner sm:px-6">
        {/* Row 1: Date Presets & Range */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Quick range presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            {QUICK_RANGES.map((r) => {
              const active = rangeActive(r.make, from, to);
              return (
                <button
                  key={`range-${r.labelKey}`}
                  type="button"
                  onClick={() => {
                    const { from: f, to: t2 } = r.make();
                    setFrom(f);
                    setTo(t2);
                  }}
                  className={`flex h-10 items-center rounded-full px-3.5 text-[11px] font-bold uppercase tracking-wide transition-all ${
                    active ? PILL_ACTIVE : PILL_INACTIVE
                  }`}
                >
                  {t(r.labelKey)}
                </button>
              );
            })}
          </div>

          {/* Divider */}
          <div className="hidden h-6 w-px bg-[#E2E8F0] dark:bg-[#2A2B36] sm:block" />

          {/* Ethiopian Calendar range picker — single clean pill (no duplicate) */}
          <div className="flex flex-wrap items-center gap-2">
            <EthiopianDateRangePicker
              from={from}
              to={to}
              onChange={(f, t2) => {
                setFrom(f);
                setTo(t2);
              }}
            />
          </div>
        </div>

        {/* Row 2: Analysis View Tabs */}
        <nav className="mt-3 flex flex-wrap items-center gap-2">
          {INTERVALS.map((it) => (
            <button
              key={`iv-${it.key}`}
              type="button"
              onClick={() => setIntervalMode(it.key)}
              className={`flex h-10 items-center rounded-full px-4 text-xs font-bold uppercase tracking-wide transition-all ${
                interval === it.key ? PILL_ACTIVE : PILL_INACTIVE
              }`}
            >
              {t(it.labelKey)}
            </button>
          ))}
        </nav>
      </div>

      {/* ============ MAIN CONTENT ============ */}
      <main className="mt-4 space-y-6">
        {loading && <ReportsSkeleton />}
        {error && (
          <div className="rounded-2xl bg-white dark:bg-[#1C1D24] p-6 text-center text-sm font-bold text-[#FFD600] dark:text-[#FF5500] border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner">
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            {/* KPI CARDS — revenue distinguishable: base vs components, notes have 0 revenue */}
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <KpiCard
                index={0}
                label={t('totalRevenue')}
                value={fmtETB(kpis.revenue)}
                delta={kpis.revenueDeltaPct}
                suffix={t('revenueDelta')}
                sub={kpis.componentRevenue != null ? `${t('reportItemsLabel')} ${fmtETB(kpis.baseRevenue ?? 0)} ${t('reportExtraLabel')} ${fmtETB(kpis.componentRevenue ?? 0)}` : undefined}
              />
              <KpiCard
                index={1}
                label={t('completedOrders')}
                value={kpis.completedOrders.toLocaleString()}
                sub={`${kpis.cancelledOrders} ${t('cancelled')} ${kpis.activeOrders} ${t('active')}`}
              />
              <KpiCard
                index={2}
                label={t('completedItems')}
                value={(kpis.completedItems ?? 0).toLocaleString()}
                sub={`${kpis.cancelledItems ?? 0} ${t('cancelledItems')}`}
              />
              <KpiCard
                index={3}
                label={t('avgFulfillment')}
                value={fmtDur(kpis.avgFulfillmentSec)}
                sub={t('prepReady')}
              />
              <KpiCard
                index={4}
                label={t('peakHour')}
                value={toAMPM(kpis.peakHourLabel, lang)}
                sub={fmtETB(kpis.peakHourRevenue)}
              />
            </section>


            {/* HOURLY */}
            {interval === 'hourly' && (
              <Section title={t('hourlyTitle')}>
                {data.hourly.every((h) => h.orders === 0) ? (
                  <p className="py-6 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">
                    {t('noSales')}
                  </p>
                ) : (
                  <HourlyBars hourly={data.hourly} lang={lang} />
                )}
              </Section>
            )}

            {/* SHIFT */}
            {interval === 'shift' && (
              <Section title={t('shiftReport')}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {data.shifts.map((s) => (
                    <div
                      key={`shift-${s.name}`}
                      className="rounded-2xl bg-[#F4F5F9] dark:bg-[#252631] p-4"
                    >
                      <h3 className="font-extrabold text-[#1E293B] dark:text-white">{localizeShiftName(s.name, lang)}</h3>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                        <Stat label={t('orders')} value={s.orders} />
                        <Stat label={t('revenue')} value={fmtETB(s.revenue)} />
                        <Stat label={t('completed')} value={s.completed} />
                        <Stat label={t('cancelled')} value={s.cancelled} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* TRENDS / CUSTOM — 2-COLUMN CHART GRID */}
            {(interval === 'trends' || interval === 'custom') && (
              <>
                {/* Section title with trend mode toggle */}
                <Section
                  title={
                    interval === 'custom'
                      ? t('customRange')
                      : t('dailyWeekly')
                  }
                  action={
                    interval === 'trends' ? (
                      <div className="flex gap-2">
                        {['daily', 'weekly'].map((m) => (
                          <button
                            key={`tm-${m}`}
                            type="button"
                            onClick={() => setTrendMode(m)}
                            className={`flex h-8 items-center rounded-full px-3 text-xs font-bold transition-all ${
                              trendMode === m ? PILL_ACTIVE : PILL_INACTIVE
                            }`}
                          >
                            {t(m)}
                          </button>
                        ))}
                      </div>
                    ) : null
                  }
                >
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    {/* COLUMN 1: Revenue & Order Velocity Trend */}
                    <TrendChart
                      rows={trendMode === 'weekly' ? data.weekly : data.daily}
                      t={t}
                      lang={lang}
                    />

                    {/* COLUMN 2: Monthly Performance / Category Breakdown */}
                    <CategoryBreakdownChart topItems={data.topItems} daily={data.daily} t={t} />
                  </div>
                </Section>
              </>
            )}

            {/* TOP SELLING ITEMS */}
            <Section
              title={t('topSelling')}
              action={
                <div className="flex gap-2">
                  {['all', 'food', 'drink'].map((fk) => (
                    <button
                      key={`f-${fk}`}
                      type="button"
                      onClick={() => setItemFilter(fk.toUpperCase())}
                      className={`flex h-8 items-center rounded-full px-3 text-xs font-bold transition-all ${
                        itemFilter === fk.toUpperCase() ? PILL_ACTIVE : PILL_INACTIVE
                      }`}
                    >
                      {t(fk)}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="space-y-3">
                {filteredTop.length === 0 && (
                  <p className="py-6 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">
                    {t('noSales')}
                  </p>
                )}
                {filteredTop.map((i) => (
                  <div
                    key={`top-${i.category}-${i.title}`}
                    className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-bold text-[#1E293B] dark:text-white">
                          {i.title}
                        </p>
                        <span
                          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            i.category === 'FOOD'
                              ? 'bg-[var(--hms-glow-a)] text-[#FFD600] dark:text-[#FF5500]'
                              : 'bg-[var(--hms-badge-bg)] text-[#1E293B] dark:text-white'
                          }`}
                        >
                          {i.category}
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="font-extrabold text-[#1E293B] dark:text-white">
                          {i.qty} pcs
                        </p>
                        <p className="text-xs text-[#64748B] dark:text-[#94A3B8]">
                          {fmtETB(i.revenue)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-[#E2E8F0] dark:bg-[#2A2B36]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#FFD600] to-[#FFD600] dark:from-[#FF5500] dark:to-[#FF5500]"
                        style={{ width: `${i.velocityPct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {data.slowItems.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-sm font-bold text-[#64748B] dark:text-[#94A3B8]">
                    {t('slowMoving')}
                  </h4>
                  <div className="overflow-hidden rounded-2xl">
                    <table className="w-full text-sm">
                      <thead className="bg-[#F4F5F9] dark:bg-[#252631] text-left text-xs uppercase text-[#64748B] dark:text-[#94A3B8]">
                        <tr>
                          <th className="px-3 py-2">{t('item')}</th>
                          <th className="px-3 py-2">{t('type')}</th>
                          <th className="px-3 py-2 text-right">{t('qty')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.slowItems.map((i) => (
                          <tr key={`slow-${i.category}-${i.title}`} className="">
                            <td className="px-3 py-2 font-semibold text-[#1E293B] dark:text-white">
                              {i.title}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  i.category === 'FOOD'
                                    ? 'bg-[var(--hms-glow-a)] text-[#FFD600] dark:text-[#FF5500]'
                                    : 'bg-[var(--hms-badge-bg)] text-[#1E293B] dark:text-white'
                                }`}
                              >
                                {i.category}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right text-[#1E293B] dark:text-white">
                              {i.qty}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Section>

            {/* WAITER PERFORMANCE */}
            <Section title={t('waiterPerf')}>
              <div className="overflow-hidden rounded-2xl">
                <table className="w-full text-sm">
                  <thead className="bg-[#F4F5F9] dark:bg-[#252631] text-left text-xs uppercase text-[#64748B] dark:text-[#94A3B8]">
                    <tr>
                      <th className="px-3 py-2">{t('waiter')}</th>
                      <th className="px-3 py-2 text-right">{t('orders')}</th>
                      <th className="px-3 py-2 text-right">{t('revenue')}</th>
                      <th className="px-3 py-2 text-right">{t('avgSpeed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.waiterPerf.length === 0 ? (
                      <tr className="">
                        <td
                          colSpan={4}
                          className="px-3 py-6 text-center text-sm text-[#64748B] dark:text-[#94A3B8]"
                        >
                          {t('noWaiter')}
                        </td>
                      </tr>
                    ) : (
                      data.waiterPerf.map((w, index) => (
                        <tr
                          key={w.waiterId ? `w-${w.waiterId}` : `w-${w.waiter}-${index}`}
                          className=""
                        >
                          <td className="px-3 py-2 font-semibold text-[#1E293B] dark:text-white">
                            {w.waiter}
                          </td>
                          <td className="px-3 py-2 text-right text-[#1E293B] dark:text-white">
                            {w.orders}
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-[#FFD600] dark:text-[#FF5500]">
                            {fmtETB(w.revenue)}
                          </td>
                          <td className="px-3 py-2 text-right text-[#1E293B] dark:text-white">
                            {fmtDur(w.avgFulfillmentSec)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* PAYMENT METHOD BREAKDOWN */}
            <Section title={t('paymentBreakdown')}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {(data.paymentBreakdown || []).map((p) => (
                  <div
                    key={`pay-${p.method}`}
                    className="rounded-2xl bg-[#F4F5F9] dark:bg-[#252631] p-4"
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
                      {String(p.method || '').toUpperCase() === 'TRANSFER' || String(p.method || '').toUpperCase() === 'TELEBIRR'
                        ? t('bankTransfer')
                        : p.method === 'CASH'
                          ? t('cash')
                          : p.method}
                    </p>
                    <p className="mt-2 text-2xl font-extrabold text-[#1E293B] dark:text-white">
                      {fmtETB(p.amount)}
                    </p>
                    <p className="mt-1 text-xs text-[#64748B] dark:text-[#94A3B8]">
                      {kpis.revenue > 0
                        ? `${Math.round((p.amount / kpis.revenue) * 100)}% of revenue`
                        : '0% of revenue'}
                    </p>
                  </div>
                ))}
              </div>
            </Section>

            {/* TRANSFER BY ACCOUNT — uses persisted snapshot, not fresh lookup */}
            {data.transferByAccount && data.transferByAccount.length > 0 && (
              <Section title="Transfer by Account">
                <div className="overflow-hidden rounded-2xl">
                  <table className="w-full text-sm">
                    <thead className="bg-[#F4F5F9] dark:bg-[#252631] text-left text-xs uppercase text-[#64748B] dark:text-[#94A3B8]">
                      <tr>
                        <th className="px-3 py-2">Bank</th>
                        <th className="px-3 py-2">Owner</th>
                        <th className="px-3 py-2">Account</th>
                        <th className="px-3 py-2 text-right">Transactions</th>
                        <th className="px-3 py-2 text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.transferByAccount.map((a) => (
                        <tr key={`tr-${a.paymentAccountId || a.accountNumber || a.bankName}`} className="">
                          <td className="px-3 py-2 font-semibold text-[#1E293B] dark:text-white">{a.bankName || "Unknown"}</td>
                          <td className="px-3 py-2 text-[#1E293B] dark:text-white">{a.ownerName || "—"}</td>
                          <td className="px-3 py-2 font-mono text-xs text-[#64748B] dark:text-[#94A3B8]">{a.accountNumber ? `${a.accountNumber.slice(0,4)}****${a.accountNumber.slice(-2)}` : "—"}</td>
                          <td className="px-3 py-2 text-right text-[#1E293B] dark:text-white">{a.count}</td>
                          <td className="px-3 py-2 text-right font-bold text-[#FFD600] dark:text-[#FF5500]">{fmtETB(a.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}

            {/* KITCHEN SPEED */}
            <Section title={t('kitchenBaristaSpeed')}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Stat
                  label="Overall Avg"
                  value={fmtDur(data.kitchen.avgFulfillmentSec)}
                />
                <Stat
                  label="Kitchen Avg"
                  value={fmtDur(data.kitchen.kitchenAvgSec)}
                />
                <Stat
                  label="Barista Avg"
                  value={fmtDur(data.kitchen.baristaAvgSec)}
                />
              </div>
              <p className="mt-3 text-xs text-[#64748B] dark:text-[#94A3B8]">
                {t('basedOn')} {data.kitchen.measuredOrders}{' '}
                {t('measuredOrdersUnit')} ({t('prepReady')}).
              </p>
            </Section>

            {/* CANCELLED ITEMS — line-level count + detail, bottom of the completed-order reporting area */}
            <Section title={t('cancelledItems')}>
              <div className="mb-3 flex items-baseline gap-2">
                <p className="text-2xl font-extrabold text-[#1E293B] dark:text-white">
                  {(kpis.cancelledItems ?? 0).toLocaleString()}
                </p>
                <p className="text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">
                  {t('cancelledItems')}
                </p>
              </div>
              {(!data.cancelledItemsDetail || data.cancelledItemsDetail.length === 0) ? (
                <p className="py-4 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">
                  {t('noSales')}
                </p>
              ) : (
                <div className="overflow-hidden rounded-2xl">
                  <table className="w-full text-sm">
                    <thead className="bg-[#F4F5F9] dark:bg-[#252631] text-left text-xs uppercase text-[#64748B] dark:text-[#94A3B8]">
                      <tr>
                        <th className="px-3 py-2">{t('item')}</th>
                        <th className="px-3 py-2 text-right">{t('qty')}</th>
                        <th className="px-3 py-2">{t('type')}</th>
                        <th className="px-3 py-2">{t('table')}</th>
                        <th className="px-3 py-2">{t('cancelled')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cancelledItemsDetail.map((c, idx) => (
                        <tr key={`cancelled-${c.orderNumber || 'na'}-${c.name}-${idx}`}>
                          <td className="px-3 py-2 font-semibold text-[#1E293B] dark:text-white">
                            {c.name}
                            {c.note ? (
                              <span className="block text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                                {c.note}
                              </span>
                            ) : null}
                            <span className="block text-[11px] font-medium text-[#64748B] dark:text-[#94A3B8]">
                              {c.orderNumber} {c.at ? formatOrderDateTime(c.at, lang) : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-[#1E293B] dark:text-white">
                            {c.quantity}
                          </td>
                          <td className="px-3 py-2 text-[#64748B] dark:text-[#94A3B8]">
                            {c.station || c.type || '—'}
                          </td>
                          <td className="px-3 py-2 text-right text-[#1E293B] dark:text-white">
                            {c.tableNumber ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-[#FFD600] dark:text-[#FF5500]">
                            {c.quantity}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

          </>
        )}
      </main>
      </div>

      {/* Dedicated print/PDF document — hidden on screen (.bono-print-only),
          the ONLY node printed via @media print. Same `data` object as the
          dashboard above; no values invented, no totals recalculated.
          Flat 2D tables with repeating headers; charts are intentionally
          excluded (data tables carry the same information). */}
      {printableDoc && (
        <div id="bono-report-doc" className="bono-print-only" aria-hidden="true">
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <h1 style={{ fontSize: 18, fontWeight: 800 }}>{reportBrand}</h1>
            <p style={{ fontWeight: 700 }}>{t('managerReports')}</p>
            <p>Period: {formatOrderDateTime(data.range?.from ?? from, lang)} to {formatOrderDateTime(data.range?.to ?? to, lang)}</p>
            <p>View: {interval} · Item filter: {itemFilter}</p>
            <p>Generated: {formatOrderDateTime(new Date().toISOString(), lang)}</p>
          </div>

          <h2>KPIs</h2>
          <table width="100%" cellPadding="4" cellSpacing="0" border="1">
            <thead><tr><th align="left">{t('csvKpi')}</th><th align="right">{t('csvValue')}</th></tr></thead>
            <tbody>
              <tr><td>{t('totalRevenue')}</td><td align="right">{fmtETB(kpis.revenue)}</td></tr>
              <tr><td>{t('revenueDelta')} %</td><td align="right">{kpis.revenueDeltaPct ?? '—'}</td></tr>
              <tr><td>{t('completedOrders')}</td><td align="right">{kpis.completedOrders ?? '—'}</td></tr>
              <tr><td>{t('cancelledOrders')}</td><td align="right">{kpis.cancelledOrders ?? '—'}</td></tr>
              <tr><td>{t('avgFulfillment')} (s)</td><td align="right">{kpis.avgFulfillmentSec ?? '—'}</td></tr>
              <tr><td>{t('peakHour')}</td><td align="right">{toAMPM(kpis.peakHourLabel, lang)} ({fmtETB(kpis.peakHourRevenue)})</td></tr>
            </tbody>
          </table>

          <h2>{t('topSelling')}</h2>
          <table width="100%" cellPadding="4" cellSpacing="0" border="1">
            <thead><tr><th align="left">{t('csvTopItem')}</th><th align="left">{t('csvCategory')}</th><th align="right">{t('csvQty')}</th><th align="right">{t('csvRevenue')}</th></tr></thead>
            <tbody>
              {(data.topItems || []).map((i, idx) => (
                <tr key={`doc-top-${idx}`}><td>{i.title}</td><td>{i.category}</td><td align="right">{i.qty}</td><td align="right">{fmtETB(i.revenue)}</td></tr>
              ))}
            </tbody>
          </table>

          <h2>{t('waiterPerf')}</h2>
          <table width="100%" cellPadding="4" cellSpacing="0" border="1">
            <thead><tr><th align="left">{t('csvWaiter')}</th><th align="right">{t('csvOrders')}</th><th align="right">{t('csvRevenue')}</th><th align="right">{t('csvAvgFulfillment')}</th></tr></thead>
            <tbody>
              {(data.waiterPerf || []).map((w, idx) => (
                <tr key={`doc-w-${idx}`}><td>{w.waiter}</td><td align="right">{w.orders}</td><td align="right">{fmtETB(w.revenue)}</td><td align="right">{fmtDur(w.avgFulfillmentSec)}</td></tr>
              ))}
            </tbody>
          </table>

          <h2>{t('paymentBreakdown')}</h2>
          <table width="100%" cellPadding="4" cellSpacing="0" border="1">
            <thead><tr><th align="left">Method</th><th align="right">Amount</th><th align="right">Share</th></tr></thead>
            <tbody>
              {(data.paymentBreakdown || []).map((p, idx) => (
                <tr key={`doc-pay-${idx}`}><td>{p.method}</td><td align="right">{fmtETB(p.amount)}</td><td align="right">{kpis.revenue > 0 ? `${Math.round((p.amount / kpis.revenue) * 100)}%` : '0%'}</td></tr>
              ))}
            </tbody>
          </table>

          {(data.transferByAccount || []).length > 0 && (
            <>
              <h2>Transfer by Account</h2>
              <table width="100%" cellPadding="4" cellSpacing="0" border="1">
                <thead><tr><th align="left">Bank</th><th align="left">Owner</th><th align="left">Account</th><th align="right">Transactions</th><th align="right">Revenue</th></tr></thead>
                <tbody>
                  {data.transferByAccount.map((a, idx) => (
                    <tr key={`doc-tr-${idx}`}><td>{a.bankName || 'Unknown'}</td><td>{a.ownerName || '—'}</td><td>{a.accountNumber ? `${a.accountNumber.slice(0, 4)}****${a.accountNumber.slice(-2)}` : '—'}</td><td align="right">{a.count}</td><td align="right">{fmtETB(a.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h2>{t('kitchenBaristaSpeed')}</h2>
          <table width="100%" cellPadding="4" cellSpacing="0" border="1">
            <tbody>
              <tr><td>Overall Avg</td><td align="right">{fmtDur(data.kitchen.avgFulfillmentSec)}</td></tr>
              <tr><td>Kitchen Avg</td><td align="right">{fmtDur(data.kitchen.kitchenAvgSec)}</td></tr>
              <tr><td>Barista Avg</td><td align="right">{fmtDur(data.kitchen.baristaAvgSec)}</td></tr>
            </tbody>
          </table>
          <p>{t('basedOn')} {data.kitchen.measuredOrders} {t('measuredOrdersUnit')} ({t('prepReady')}).</p>
          <p style={{ textAlign: 'center', marginTop: 12 }}>{reportBrand} · {t('managerReports')}</p>
        </div>
      )}
    </div>
  );
}

/* ---------- small presentational helpers ---------- */

function ReportsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={`kpi-sk-${i}`}
            className="rounded-2xl bg-white dark:bg-[#1C1D24] p-4 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
            <div className="mt-3 h-8 w-32 animate-pulse rounded bg-white dark:bg-[#1C1D24]" />
            <div className="mt-2 h-3 w-20 animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]/60" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-white dark:bg-[#1C1D24] p-4 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner sm:p-5">
        <div className="mb-4 h-4 w-56 animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
        <div className="h-64 animate-pulse rounded-xl bg-[#F4F5F9] dark:bg-[#252631]" />
      </div>
    </div>
  );
}

function KpiCard({ label, value, delta, suffix, sub, index = 0 }) {
  const up = delta != null && delta >= 0;
  return (
    <div
      style={{ '--stagger-index': index }}
      className="  rounded-2xl bg-white dark:bg-[#1C1D24] p-4 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner"
    >
      <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-extrabold text-[#1E293B] dark:text-white">{value}</p>
      {delta != null && (
        <p
          className={`mt-1 text-xs font-bold ${
            up ? 'text-[#1E293B] dark:text-white' : 'text-[#FFD600] dark:text-[#FF5500]'
          }`}
        >
          {up ? '▲' : '▼'} {Math.abs(delta)}
          {suffix}
        </p>
      )}
      {sub && <p className="mt-1 text-xs text-[#64748B] dark:text-[#94A3B8]">{sub}</p>}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] p-3">
      <p className="text-xs font-semibold uppercase text-[#64748B] dark:text-[#94A3B8]">{label}</p>
      <p className="mt-1 text-lg font-extrabold text-[#1E293B] dark:text-white">{value}</p>
    </div>
  );
}

function Section({ title, action, children }) {
  return (
    <section className="rounded-2xl bg-white dark:bg-[#1C1D24] p-4 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-extrabold text-[#1E293B] dark:text-white">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const HourlyBars = memo(function HourlyBars({ hourly, lang }) {
  const max = Math.max(1, ...hourly.map((h) => h.revenue));
  return (
    <div className="space-y-2">
          {hourly.map((h) => (
            <div key={`hr-${h.hour}`} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-sm font-semibold text-[#1E293B] dark:text-white">
                {toAMPM(h.label, lang)}
              </span>
          <div className="h-6 flex-1 overflow-hidden rounded-lg bg-[#F4F5F9] dark:bg-[#252631]">
            <div
              className="flex h-full items-center justify-end rounded-lg bg-gradient-to-r from-[#FFD600] to-[#FFD600] dark:from-[#FF5500] dark:to-[#FF5500] pr-2 text-[10px] font-bold text-[#1E293B] dark:text-white"
              style={{ width: `${(h.revenue / max) * 100}%` }}
            >
              {h.revenue > 0 ? fmtETB(h.revenue) : ''}
            </div>
          </div>
          <span className="w-12 text-right text-xs text-[#64748B] dark:text-[#94A3B8]">
            {h.orders}
          </span>
        </div>
      ))}
    </div>
  );
});

/* ---------- Category Breakdown Chart (Right Column) — Full Donut ---------- */

const CategoryBreakdownChart = memo(function CategoryBreakdownChart({ topItems, t }) {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  if (!topItems || topItems.length === 0) {
    return (
      <div className={`p-6 rounded-2xl border ${isDark ? 'bg-[#1C1D24] border-[#2A2B36] text-white' : 'bg-white border-gray-100 text-gray-800'}`}>
        <p className="py-6 text-center text-sm text-gray-400">{t('noDataRange')}</p>
      </div>
    );
  }

  // Aggregate by category (preserve dataset)
  const catMap = {};
  topItems.forEach((item) => {
    const cat = item.category || 'OTHER';
    if (!catMap[cat]) catMap[cat] = { revenue: 0, qty: 0, count: 0 };
    catMap[cat].revenue += item.revenue || 0;
    catMap[cat].qty += item.qty || 0;
    catMap[cat].count += 1;
  });

  const FOOD_COLOR = isDark ? "#FF5500" : "#F59E0B";
  const DRINK_COLOR = isDark ? "#3B82F6" : "#06B6D4";

  const categories = Object.entries(catMap).sort((a, b) => b[1].revenue - a[1].revenue);
  const foodEntry = categories.find(([c]) => c === 'FOOD');
  const drinkEntry = categories.find(([c]) => c === 'DRINK');
  const foodSales = foodEntry ? foodEntry[1].revenue : 0;
  const drinkSales = drinkEntry ? drinkEntry[1].revenue : 0;
  const foodCount = foodEntry ? foodEntry[1].count : 0;
  const drinkCount = drinkEntry ? drinkEntry[1].count : 0;

  const chartData = [
    { name: 'Food', value: foodSales, count: foodCount, color: FOOD_COLOR },
    { name: 'Drink', value: drinkSales, count: drinkCount, color: DRINK_COLOR },
  ].filter(d => d.value > 0);

  // Fallback to show empty donut if no Food/Drink but other categories exist
  const fallbackData = chartData.length ? chartData : categories.slice(0,2).map(([cat, info], idx) => ({
    name: cat, value: info.revenue, count: info.count, color: idx === 0 ? FOOD_COLOR : DRINK_COLOR
  }));

  const finalData = chartData.length ? chartData : fallbackData;
  const totalRevenue = finalData.reduce((acc, item) => acc + item.value, 0);
  const totalUnits = finalData.reduce((acc, item) => acc + item.count, 0);

  // Handle empty after filter
  if (finalData.length === 0 || totalRevenue === 0) {
    return (
      <div className={`p-6 rounded-2xl border ${isDark ? 'bg-[#1C1D24] border-[#2A2B36] text-white' : 'bg-white border-gray-100 text-gray-800'}`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-semibold tracking-wider text-gray-400 uppercase">{t('categoryPerformance')}</h3>
              <p className="text-lg font-bold">{t('salesDistribution')}</p>
            </div>
          </div>
        <p className="py-6 text-center text-sm text-gray-400">{t('noDataRange')}</p>
      </div>
    );
  }

  return (
    <div className={`p-6 rounded-2xl border ${isDark ? 'bg-[#1C1D24] border-[#2A2B36] text-white' : 'bg-white border-gray-100 text-gray-800'} shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-xs font-semibold tracking-wider text-gray-400 uppercase">{t('categoryPerformance')}</h3>
          <p className="text-lg font-bold">{t('salesDistribution')}</p>
        </div>
      </div>

      {/* Donut Chart Container */}
      <div className="relative w-full h-[220px] flex items-center justify-center">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie cx="50%" cy="50%" data={finalData} dataKey="value" innerRadius={65} outerRadius={85} paddingAngle={4} stroke="none">
              {finalData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ backgroundColor: isDark ? '#12131A' : '#FFFFFF', borderColor: isDark ? '#2A2B36' : '#E5E7EB', borderRadius: '12px' }} />
          </PieChart>
        </ResponsiveContainer>

        {/* Absolute Center Text Overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
          <span className="text-xs font-medium text-gray-400">{t('totalSales')}</span>
              <span className="text-xl font-extrabold tracking-tight mt-0.5">
                ETB {totalRevenue.toLocaleString()}
              </span>
              <span className="text-[11px] font-medium text-gray-400 mt-0.5">{totalUnits} {t('unitsSold')}</span>
        </div>
      </div>

      {/* Bottom Horizontal Legends (Matching image_3a6225.png) */}
      <div className="grid grid-cols-2 gap-4 mt-6 pt-4 border-t border-gray-700/20">
        {finalData.map((item, idx) => (
          <div key={idx} className="flex items-center space-x-3">
            {/* Vertical Pill Bar */}
            <div className="w-1.5 h-7 rounded-full" style={{ backgroundColor: item.color }} />
            <div className="flex flex-col">
              <span className="text-sm font-bold tracking-tight">
                ETB {item.value.toLocaleString()}
              </span>
              <span className="text-xs text-gray-400 font-medium">
                {item.name} ({item.count} {t('itemsUnit')})
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

/* ---------- executive trend chart (interactive SVG) ---------- */

function niceCeil(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = v / 10 ** exp;
  const nice =
    base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

function shortLabel(label) {
  return label.replace(/^Week of /, '');
}

function ethShortLabel(row, lang) {
  try {
    const ec = transportKeyToEthiopian(row.key);
    if (!ec) return shortLabel(row.label || '');
    const arr = lang === 'en' ? ET_MONTHS_EN : lang === 'om' ? ET_MONTHS_OM : ET_MONTHS_AM;
    const monthName = arr[ec.month - 1] || '';
    return `${monthName} ${ec.day}`;
  } catch {
    return shortLabel(row.label || '');
  }
}

const TrendChart = memo(function TrendChart({ rows, t, lang }) {
  const [active, setActive] = useState(rows.length ? rows.length - 1 : 0);
  const [isDarkChart, setIsDarkChart] = useState(false);
  useEffect(() => {
    const chk = () => setIsDarkChart(document.documentElement.classList.contains('dark'));
    chk();
    const o = new MutationObserver(chk);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => o.disconnect();
  }, []);
  const chartAccent = isDarkChart ? '#FF5500' : '#FFD600';
  const chartAccentDim = isDarkChart ? 'rgba(255,85,0,0.4)' : 'rgba(255,214,0,0.45)';

  if (!rows || rows.length === 0) {
    return (
      <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-[#1C1D24] p-4 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner sm:p-5">
        <p className="py-6 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">
          {t('noDataRange')}
        </p>
      </div>
    );
  }

  const n = rows.length;
  const maxRev = niceCeil(Math.max(...rows.map((r) => r.revenue)));
  const maxOrd = niceCeil(Math.max(...rows.map((r) => r.orders), 1));

  const W = 720;
  const H = 280;
  const PAD_L = 58;
  const PAD_R = 62;
  const PAD_T = 18;
  const PAD_B = 34;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const group = plotW / n;
  const barW = Math.max(6, Math.min(44, group * 0.52));
  const gridLines = 4;

  const yFor = (v, max) => PAD_T + plotH * (1 - v / max);
  const xFor = (i) => PAD_L + group * i + group / 2;

  const activeIdx =
    active == null ? null : Math.min(Math.max(active, 0), n - 1);
  const activeRow = activeIdx == null ? null : rows[activeIdx];
  const tipPct = Math.min(88, Math.max(12, ((activeIdx ?? 0) + 0.5) / n * 100));

  const sumRev = rows.reduce((s, r) => s + r.revenue, 0);
  const sumOrd = rows.reduce((s, r) => s + r.orders, 0);
  const peak = rows.reduce((a, b) => (b.revenue > a.revenue ? b : a), rows[0]);
  const labelStep = Math.ceil(n / 14);

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((rel - PAD_L) / group)));
    setActive(idx);
  }

  return (
    <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-[#1C1D24] p-4 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner sm:p-5">
      {/* ambient glow accents */}
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[var(--hms-glow-a)] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-[var(--hms-glow-b)] blur-3xl" />

      {/* header row */}
      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#FFD600] dark:text-[#FF5500]">
                {t('revenueOrderVelocity')}
          </p>
          <p className="mt-0.5 text-sm font-extrabold text-[#1E293B] dark:text-white">
            {ethShortLabel(rows[0], lang)} {ethShortLabel(rows[n - 1], lang)}
            <span className="ml-2 text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">
              {n} {n === 1 ? t('day') : t('days')}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
          <span className="flex items-center gap-1.5 text-[#64748B] dark:text-[#94A3B8]">
            <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-b from-[#FFD600] to-[#FFD600] dark:from-[#FF5500] dark:to-[#FF5500]" />
            {t('revenue')} (ETB)
          </span>
          <span className="flex items-center gap-1.5 text-[#64748B] dark:text-[#94A3B8]">
              <span className="h-0.5 w-4 rounded bg-[#FFD600] dark:bg-[#FF5500]" />
              {t('orders')}
          </span>
        </div>
      </div>

      {/* chart */}
      <div className="relative mt-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full select-none"
          onMouseMove={onMove}
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chartAccent} />
              <stop offset="100%" stopColor={chartAccent} />
            </linearGradient>
            <linearGradient id="revGradDim" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chartAccent} stopOpacity="0.4" />
              <stop offset="100%" stopColor={chartAccent} stopOpacity="0.4" />
            </linearGradient>
          </defs>

          {Array.from({ length: gridLines + 1 }).map((_, gi) => {
            const y = PAD_T + (plotH / gridLines) * gi;
            const revVal = maxRev * (1 - gi / gridLines);
            const ordVal = Math.round(maxOrd * (1 - gi / gridLines));
            return (
              <g key={`grid-${gi}`}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={y}
                  y2={y}
                  className="stroke-[#E2E8F0] dark:stroke-[#2A2B36]"
                  strokeOpacity="0.8"
                  strokeDasharray={gi === gridLines ? '0' : '3 4'}
                />
                <text
                  x={PAD_L - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="text-[10px] font-semibold fill-[#64748B] dark:fill-[#94A3B8]"
                >
                  {fmtCompact(revVal)}
                </text>
                <text
                  x={W - PAD_R + 8}
                  y={y + 3}
                  textAnchor="start"
                  className="text-[10px] font-semibold fill-[#1E293B] dark:fill-white"
                >
                  {fmtCompact(ordVal)}
                </text>
              </g>
            );
          })}
          <text
            x={PAD_L - 8}
            y={12}
            textAnchor="end"
            letterSpacing="0.15em"
            className="text-[9px] font-bold fill-[#64748B] dark:fill-[#94A3B8]"
          >
            ETB
          </text>
          <text
            x={W - PAD_R + 8}
            y={12}
            textAnchor="start"
            letterSpacing="0.15em"
            className="text-[9px] font-bold fill-[#1E293B] dark:fill-white"
          >
            {t('orders')}
          </text>

          {activeIdx != null && (
            <line
              x1={xFor(activeIdx)}
              x2={xFor(activeIdx)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="#FF5500"
              strokeOpacity="0.35"
              strokeWidth="1"
            />
          )}

          {rows.map((r, i) => {
            const h = Math.max(0, (r.revenue / maxRev) * plotH);
            return (
              <rect
                key={`bar-${i}`}
                x={xFor(i) - barW / 2}
                y={PAD_T + plotH - h}
                width={barW}
                height={h}
                rx={Math.min(5, barW / 3)}
                fill={i === activeIdx ? 'url(#revGrad)' : 'url(#revGradDim)'}
                className={`transition-all duration-200 ${
                  i === activeIdx
                    ? ''
                    : ''
                }`}
              />
            );
          })}

          <polyline
            points={rows
              .map((r, i) => `${xFor(i)},${yFor(r.orders, maxOrd)}`)
              .join(' ')}
              fill="none"
              className="stroke-[#FFD600] dark:stroke-[#FF5500]"
              strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity="0.9"
          />
          {rows.map((r, i) => (
            <circle
              key={`dot-${i}`}
              cx={xFor(i)}
              cy={yFor(r.orders, maxOrd)}
              r={i === activeIdx ? 5 : 3.5}
                style={{ fill: i === activeIdx ? chartAccent : 'var(--hms-surface)' }}
                stroke={i === activeIdx ? chartAccent : undefined}
                className={i === activeIdx ? 'stroke-[#FFD600] dark:stroke-[#FF5500]' : 'stroke-[#FFD600] dark:stroke-[#FF5500]'}
                strokeWidth={i === activeIdx ? 2.5 : 1.5}
            />
          ))}

          {rows.map((r, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text
                key={`xlabel-${i}`}
                x={xFor(i)}
                y={H - 8}
                textAnchor="middle"
                className={`text-[10px] font-semibold ${
                  i === activeIdx ? 'fill-[#FFD600] dark:fill-[#FF5500]' : 'fill-[#64748B] dark:fill-[#94A3B8]'
                }`}
              >
                {ethShortLabel(r, lang)}
              </text>
            ) : null
          )}

          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={PAD_T + plotH}
            y2={PAD_T + plotH}
            className="stroke-[#E2E8F0] dark:stroke-[#2A2B36]"
            strokeWidth="1.5"
          />
        </svg>

        {activeRow && (
          <div
            style={{ left: `${tipPct}%` }}
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-xl bg-white dark:bg-[#1C1D24] px-3.5 py-2.5 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner backdrop-blur"
          >
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
              {(() => { try { const start = addisYMDToUTCStart(activeRow.key); if (!start) return activeRow.label; return `${formatEthiopianDate(start, lang === 'en' ? 'en' : 'am')} (EC)`; } catch { return activeRow.label; } })()}
            </p>
              <p className="mt-1 flex items-center gap-1.5 text-sm font-extrabold text-[#FFD600] dark:text-[#FF5500]">
              <span className="h-2 w-2 rounded-full bg-[#FFD600] dark:bg-[#FF5500]" />
              {fmtETB(activeRow.revenue)}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs font-bold text-[#1E293B] dark:text-white">
              <span className="h-2 w-2 rounded-full bg-[#FFD600] dark:bg-[#FF5500]" />
              {activeRow.orders} {t('completed')}
            </p>
          </div>
        )}
      </div>

      {/* summary footer */}
      <div className="relative mt-4 grid grid-cols-1 divide-y divide-[#E2E8F0] dark:divide-[#2A2B36] rounded-xl bg-[#F4F5F9] dark:bg-[#252631] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
            {t('totalRevenue')}
          </p>
            <p className="mt-0.5 text-lg font-extrabold text-[#FFD600] dark:text-[#FF5500]">
              {fmtETB(sumRev)}
          </p>
        </div>
        <div className="px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
            {t('totalOrders')}
          </p>
          <p className="mt-0.5 text-lg font-extrabold text-[#1E293B] dark:text-white">
            {sumOrd.toLocaleString()}
          </p>
        </div>
        <div className="px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
            {t('peakDay')}
          </p>
          <p className="mt-0.5 text-lg font-extrabold text-[#1E293B] dark:text-white">
                {ethShortLabel(peak, lang)}
            <span className="ml-2 text-sm font-bold text-[#FFD600] dark:text-[#FF5500]">
              {fmtETB(peak.revenue)}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
});
