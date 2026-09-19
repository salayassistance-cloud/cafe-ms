'use client';

import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { safeFetchJson } from '@/lib/clientFetch';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useOrderEvents } from '@/lib/orderEvents';
import { formatPrice } from '@/lib/currency';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';
import LanguageToggle from '@/app/components/LanguageToggle';
import { useLanguage } from '@/app/components/LanguageProvider';

// Cashier POS — Phase 1 isolated UI
// Data sources verified: GET /api/orders (and ?status=SERVED/PAID) + PATCH /api/orders/[id] {status:"PAID",paymentMethod}
// Auth: MANAGER session (existing policy). No CASHIER role. No DB/API mutation.

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'SERVED', label: 'Served' },
  { key: 'READY', label: 'Ready' },
  { key: 'PREPARING', label: 'Preparing' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'PAID', label: 'Paid' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

const STATUS_META = {
  PENDING: { label: 'PENDING', cls: 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#64748B] dark:text-[#94A3B8] border border-[var(--c-border-soft)]' },
  PREPARING: { label: 'PREPARING', cls: 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm' },
  READY: { label: 'READY', cls: 'bg-[rgba(255,214,0,0.14)] dark:bg-[rgba(255,94,0,0.12)] text-[#8A6D00] dark:text-[#FF8A3D] border border-[#FFD600]/20 dark:border-[#FF5E00]/20' },
  SERVED: { label: 'SERVED', cls: 'bg-white dark:bg-[#1C1D24] text-[#475569] dark:text-[#94A3B8] border border-[var(--c-border-soft)]' },
  PAID: { label: 'PAID', cls: 'bg-[#1E293B] text-white dark:bg-white dark:text-[#12131A]' },
  CANCELLED: { label: 'CANCELLED', cls: 'bg-[#FEF2F2] text-[#DC2626] border border-[#FECACA]' },
  ARCHIVED: { label: 'ARCHIVED', cls: 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#94A3B8] border border-[var(--c-border-soft)]' },
};

const PAY_META = {
  CASH: { label: 'CASH', cls: 'bg-[#1E293B] text-white dark:bg-white dark:text-[#1E293B]' },
  TELEBIRR: { label: 'TELEBIRR', cls: 'bg-[rgba(255,214,0,0.14)] dark:bg-[rgba(255,94,0,0.12)] text-[#1E293B] dark:text-[#FF8A3D] border border-[#FFD600]/20 dark:border-[#FF5E00]/20' },
  NONE: { label: 'UNPAID', cls: 'bg-[#FEF2F2] text-[#DC2626] border border-[#FECACA] dark:bg-[#1C1D24] dark:text-[#FCA5A5] dark:border-[#2A2B36]' },
};

function statusBadge(status) {
  return STATUS_META[status] || { label: status || 'UNKNOWN', cls: 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#64748B] dark:text-[#94A3B8] border border-[var(--c-border-soft)]' };
}
function payBadge(method) {
  return PAY_META[method] || PAY_META.NONE;
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
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso).slice(0, 16);
  }
}
function fmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
function itemNameOf(it, lang) {
  return getLocalizedSingleString(it?.name, lang) || 'Item';
}

const POLL_MS = 30000;
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export default function CashierUI() {
  const { lang } = useLanguage();
  const hasMounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState('');
  const [paySuccess, setPaySuccess] = useState('');

  const refreshTimer = useRef(null);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const fetchOrders = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        safeFetchJson('/api/orders', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=SERVED', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=PAID', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=CANCELLED', { cache: 'no-store' }),
      ]);

      const byId = new Map();
      let hadSuccess = false;
      let lastError = null;

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.success) {
          hadSuccess = true;
          const list = r.value?.data?.orders || r.value?.orders || [];
          if (Array.isArray(list)) {
            for (const o of list) {
              if (o && o._id) byId.set(String(o._id), o);
            }
          }
        } else if (r.status === 'rejected') {
          lastError = r.reason;
        } else if (r.status === 'fulfilled' && r.value && !r.value.success) {
          lastError = new Error(r.value.error || r.value.message || 'Failed to load');
          lastError.status = 400;
        }
      }

      if (!hadSuccess) {
        const err = lastError || new Error('Failed to load orders');
        throw err;
      }

      const merged = Array.from(byId.values()).sort((a, b) => {
        const da = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

      setOrders(merged);
      setError('');
      if (merged.length === 0) {
        // Keep selection cleared if no data
      }
    } catch (err) {
      const s = err?.status;
      if (s === 401) {
        setError('Session expired or forbidden — please re-login as Manager.');
      } else if (s === 503 || /database|unavailable/i.test(err?.message || '')) {
        setError('Database temporarily unavailable. Retrying…');
      } else if (s === 429) {
        setError('Too many requests. Please slow down.');
      } else if (s === 403) {
        setError('Forbidden — cashier requires Manager authorization.');
      } else {
        setError(err?.message || 'Unable to load orders.');
      }
    } finally {
      setInitialLoading(false);
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(fetchOrders, 150);
  }, [fetchOrders]);

  useOrderEvents(useCallback((event) => {
    if (!event || event.type === 'ping') return;
    if (event.type === 'orders-changed' || event.type === 'ORDER_READY' || event.type === 'menu-changed' || !event.type) {
      scheduleRefresh();
    }
  }, [scheduleRefresh]));

  useEffect(() => {
    const t = setTimeout(fetchOrders, 0);
    return () => clearTimeout(t);
  }, [fetchOrders]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchOrders();
    }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') fetchOrders(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); clearTimeout(refreshTimer.current); };
  }, [fetchOrders]);

  useEffect(() => {
    if (paySuccess) {
      const t = setTimeout(() => setPaySuccess(''), 4000);
      return () => clearTimeout(t);
    }
  }, [paySuccess]);

  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(''), 3000);
      return () => clearTimeout(t);
    }
  }, [notice]);

  const filtered = useMemo(() => {
    let list = orders;
    if (filter !== 'ALL') {
      list = list.filter((o) => String(o.status).toUpperCase() === filter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      const asNum = Number(q);
      const isNum = Number.isInteger(asNum);
      list = list.filter((o) => {
        const hay = [
          String(o.orderNumber || '').toLowerCase(),
          String(o.tableNumber ?? '').toLowerCase(),
          String(o.waiterName || '').toLowerCase(),
        ].join(' ');
        if (isNum && Number(o.tableNumber) === asNum) return true;
        return hay.includes(q);
      });
    }
    return list;
  }, [orders, filter, search]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return orders.find((o) => String(o._id) === String(selectedId)) || null;
  }, [orders, selectedId]);

  // Keep selected in sync when orders refresh (updated status after pay)
  useEffect(() => {
    if (selectedId && !selected) {
      // Selected was removed (e.g., after filter) — keep id but show notice
    }
  }, [selected, selectedId]);

  const counts = useMemo(() => {
    const c = { ALL: orders.length, SERVED: 0, READY: 0, PREPARING: 0, PENDING: 0, PAID: 0, CANCELLED: 0 };
    for (const o of orders) {
      const s = String(o.status).toUpperCase();
      if (c[s] !== undefined) c[s] += 1;
      else c[s] = 1;
    }
    return c;
  }, [orders]);

  const handleSelect = useCallback((id) => {
    setSelectedId(String(id));
    setPayError('');
    setPaySuccess('');
  }, []);

  const handlePay = useCallback(async (method) => {
    if (!selected || payBusy) return;
    const m = method === 'TELEBIRR' ? 'TELEBIRR' : 'CASH';
    // Guard: only allow payment for non-terminal states that backend accepts (SERVED/READY/PAID)
    // But backend will return 400 for invalid transitions; we surface that.
    if (String(selected.status).toUpperCase() === 'PAID') {
      setPayError('Order is already PAID.');
      return;
    }
    if (String(selected.status).toUpperCase() === 'CANCELLED' || String(selected.status).toUpperCase() === 'ARCHIVED') {
      setPayError('Cancelled or archived orders cannot be paid.');
      return;
    }
    setPayBusy(true);
    setPayError('');
    setPaySuccess('');
    try {
      const data = await safeFetchJson(`/api/orders/${selected._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PAID', paymentMethod: m }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || 'Payment failed');
      const updated = data?.data?.order || data?.order;
      if (!updated || !updated._id) throw new Error('Payment succeeded but response was malformed');
      // Trust backend only — update list with returned order
      setOrders((prev) => {
        const idx = prev.findIndex((o) => String(o._id) === String(updated._id));
        if (idx >= 0) {
          const nxt = [...prev];
          nxt[idx] = updated;
          return nxt.sort((a, b) => {
            const da = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
            const db = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
            return db - da;
          });
        }
        return [updated, ...prev];
      });
      setPaySuccess(`Payment confirmed — ${updated.orderNumber} marked PAID via ${m}.`);
      setNotice(`✓ ${updated.orderNumber} PAID (${m})`);
    } catch (err) {
      const s = err?.status;
      if (s === 401) setPayError('Session expired. Please re-login as Manager.');
      else if (s === 403) setPayError('Forbidden — payment requires Manager authorization.');
      else if (s === 429) setPayError(`Too many requests. Retry after ${err?.retryAfter || 'a moment'}.`);
      else if (s === 503) setPayError('Database unavailable. Please retry.');
      else setPayError(err?.message ? `Payment failed: ${err.message}` : 'Payment failed. Please retry.');
    } finally {
      setPayBusy(false);
    }
  }, [selected, payBusy]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setPayError('');
    setPaySuccess('');
  }, []);

  if (!hasMounted) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-[var(--c-bg)]">
        <div className="text-sm font-bold text-[var(--c-muted)]">Loading Cashier…</div>
      </div>
    );
  }

  const selStatus = selected ? String(selected.status).toUpperCase() : null;
  const selIsPaid = selStatus === 'PAID';
  const selIsCancelled = selStatus === 'CANCELLED' || selStatus === 'ARCHIVED';
  const selIsUnpaid = selected && !selIsPaid && !selIsCancelled;
  // Reliable receipt only when we have orderNumber, items, totalAmount, createdAt
  const canShowReceipt = !!(selected && selected.orderNumber && Array.isArray(selected.items) && Number.isFinite(Number(selected.totalAmount)));

  return (
    <div className="min-h-screen bg-[var(--c-bg)] text-[var(--c-text)]">
      {/* Compact header — matches KDS/home tokens */}
      <header className="sticky top-0 z-30 bg-[var(--c-header)] dark:bg-transparent border-b border-[var(--c-border-soft)] dark:border-transparent px-3 sm:px-4 py-3 shadow-sm dark:shadow-none backdrop-blur">
        <div className="mx-auto max-w-[1600px] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] shadow-sm text-[var(--c-accent)]">
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M3 10h18" stroke="currentColor" strokeWidth="2" />
                <path d="M7 14h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <circle cx="15.5" cy="16.5" r="1" fill="currentColor" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--c-muted)] leading-none">Bono POS</h1>
              <p className="text-base sm:text-lg font-black tracking-tight leading-none mt-1 text-[var(--c-text)]">Cashier</p>
              <p className="hidden sm:block text-xs font-medium text-[var(--c-muted)] leading-none mt-1">Bill review &amp; authorized settlement — MANAGER session</p>
            </div>
            <span className="hidden lg:inline-flex ml-2 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-[var(--c-muted)]">
              {orders.length} tickets
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)] shadow-sm">
              <span className={`h-2 w-2 rounded-full ${error ? 'bg-[#DC2626] animate-pulse' : 'bg-[#16A34A]'}`} aria-hidden="true" />
              {error ? 'offline' : 'live'}
            </span>
            <LanguageToggle />
            <ThemeToggleHome />
            <a
              href="/"
              aria-label="Back to home"
              className="hidden sm:inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] shadow-sm tactile"
            >
              Home
            </a>
          </div>
        </div>
      </header>

      {/* Alerts */}
      {(error || paySuccess || notice) && (
        <div className="mx-auto max-w-[1600px] px-3 sm:px-4 pt-3 space-y-2">
          {error && (
            <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
              <span>{error}</span>
              <button type="button" onClick={fetchOrders} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626] hover:bg-[#FFF7ED]">Retry</button>
            </div>
          )}
          {paySuccess && (
            <div role="status" className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3.5 py-2.5 text-xs font-bold text-[#15803D]">{paySuccess}</div>
          )}
          {notice && !paySuccess && (
            <div role="status" className="rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3.5 py-2.5 text-xs font-bold text-[var(--c-text)] shadow-sm">{notice}</div>
          )}
        </div>
      )}

      {/* Main: responsive — queue + bill */}
      <main className="mx-auto max-w-[1600px] px-3 sm:px-4 py-4 grid gap-4 lg:grid-cols-12 items-start">
        {/* LEFT — Order Queue */}
        <section className="lg:col-span-5 xl:col-span-4 flex flex-col gap-4 min-h-0">
          <div className="card-elevated rounded-2xl p-3 sm:p-4 bg-[var(--c-card)]">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">Queue</h2>
              <span className="rounded-full bg-[var(--c-bg)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)] border border-[var(--c-border-soft)]">
                {filtered.length} / {orders.length}
              </span>
            </div>

            {/* Search — table/order identifier only where supported */}
            <label className="flex items-center gap-2 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] px-3 py-2 focus-within:ring-2 focus-within:ring-[var(--c-accent)]/30">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-[var(--c-muted)] shrink-0" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search table or order #  e.g. 3  ORD-1001  Abel"
                aria-label="Search by table or order"
                className="w-full bg-transparent text-sm font-medium text-[var(--c-text)] placeholder:text-[var(--c-muted)] focus:outline-none"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} className="shrink-0 rounded-full bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] h-6 w-6 flex items-center justify-center text-[var(--c-muted)] hover:text-[var(--c-text)]" aria-label="Clear search">✕</button>
              )}
            </label>

            {/* Filters — only statuses that exist */}
            <div className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1">
              {FILTERS.map((f) => {
                const active = filter === f.key;
                const n = counts[f.key] ?? 0;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    aria-pressed={active}
                    className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold border transition-all tactile ${active ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white border-transparent shadow-sm' : 'bg-white dark:bg-[#1C1D24] text-[var(--c-muted)] border-[var(--c-border-soft)] hover:text-[var(--c-text)]'}`}
                  >
                    {f.label} <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-black ${active ? 'bg-black/15 dark:bg-white/15 text-[#1E293B] dark:text-white' : 'bg-[var(--c-bg)] border border-[var(--c-border-soft)]'}`}>{n}</span>
                  </button>
                );
              })}
            </div>

            {/* Refresh */}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] font-medium text-[var(--c-muted)] hidden sm:block">
                {initialLoading ? 'Loading…' : `${filtered.length} ticket${filtered.length !== 1 ? 's' : ''} · tap to bill`}
              </p>
              <button
                type="button"
                onClick={fetchOrders}
                disabled={initialLoading}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] shadow-sm disabled:opacity-50 tactile"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><path d="M21 12a9 9 0 11-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Refresh
              </button>
            </div>
          </div>

          {/* Order list */}
          <div className="card-elevated rounded-2xl bg-[var(--c-card)] p-2 sm:p-3 flex flex-col min-h-[320px] max-h-[65vh] lg:max-h-[72vh] overflow-hidden">
            {initialLoading ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-[92px] animate-pulse rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)]" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-16 px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--c-border-soft)] bg-[var(--c-bg)] text-[var(--c-muted)] mb-3">—</div>
                <p className="text-sm font-bold text-[var(--c-text)]">{error ? 'Unavailable' : search || filter !== 'ALL' ? 'No matching tickets' : 'No tickets'}</p>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[28ch]">
                  {error ? 'Check connection and retry. Orders require Manager session.' : search ? `No results for “${search.trim()}”. Try order # or table number.` : filter !== 'ALL' ? `No ${filter} tickets in this window.` : 'New orders will appear here when waiters send them.'}
                </p>
                {!error && (search || filter !== 'ALL') && (
                  <button type="button" onClick={() => { setSearch(''); setFilter('ALL'); }} className="mt-3 rounded-xl bg-[var(--c-accent)] px-3 py-1.5 text-xs font-black text-[#1E293B] dark:text-white">Clear filters</button>
                )}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 -mr-1 custom-scrollbar">
                {filtered.map((o) => {
                  const isSelected = String(o._id) === String(selectedId);
                  const sb = statusBadge(o.status);
                  const pb = payBadge(o.paymentMethod);
                  const total = Number(o.totalAmount);
                  const itemsPreview = (o.items || []).slice(0, 2).map((it) => itemNameOf(it, lang)).join(', ');
                  const more = (o.items?.length || 0) > 2 ? ` +${o.items.length - 2} more` : '';
                  const table = o.tableNumber ?? '—';
                  return (
                    <button
                      key={o._id}
                      type="button"
                      onClick={() => handleSelect(o._id)}
                      aria-pressed={isSelected}
                      className={`w-full text-left rounded-xl border p-3 transition-all tactile flex flex-col gap-2 ${isSelected ? 'bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] border-[var(--c-accent)]/30 shadow-sm' : 'bg-white dark:bg-[#12131A] border-[var(--c-border-soft)] hover:border-[var(--c-accent)]/30 hover:bg-[var(--c-bg)]'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center rounded-lg bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-2 py-1 text-xs font-black text-[var(--c-text)]">T{table}</span>
                            <span className="text-xs font-bold text-[var(--c-muted)] truncate max-w-[14ch]" title={o.orderNumber}>{o.orderNumber}</span>
                            {o.isExternal && <span className="rounded-full bg-[#FEF3C7] text-[#92400E] border border-[#FDE68A] px-2 py-0.5 text-[10px] font-black uppercase">External</span>}
                          </div>
                          <p className="mt-1 text-xs font-semibold text-[var(--c-muted)] truncate">Waiter: {o.waiterName || '—'} {o.waiterNumber != null ? `· #${o.waiterNumber}` : ''}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide ${sb.cls}`}>{sb.label}</span>
                      </div>

                      <div className="flex items-end justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-[var(--c-muted)]" title={(o.items || []).map((it) => `${itemNameOf(it, lang)} ×${it.quantity}`).join(', ')}>
                            {itemsPreview}{more || (!itemsPreview ? 'No items' : '')}
                          </p>
                          <p className="mt-0.5 text-[11px] font-medium text-[var(--c-faint)]">{fmtDate(o.createdAt)}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-black text-[var(--c-text)]">{fmtMoney(total)}</p>
                          <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${pb.cls}`}>{pb.label}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* RIGHT — Selected Bill + Payment + Receipt */}
        <section className="lg:col-span-7 xl:col-span-8 flex flex-col gap-4 min-h-0">
          {!selected ? (
            <div className="card-elevated rounded-2xl bg-[var(--c-card)] p-6 sm:p-8 flex flex-col items-center justify-center text-center min-h-[420px]">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] text-[var(--c-muted)] mb-4">
                <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true"><path d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M9 5a2 2 0 012-2h2a2 2 0 012 2v1a2 2 0 01-2 2h-2a2 2 0 01-2-2V5z" stroke="currentColor" strokeWidth="2"/><path d="M9 12h6M9 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </div>
              <h3 className="text-base font-black text-[var(--c-text)]">Select a ticket to bill</h3>
              <p className="mt-2 max-w-[36ch] text-sm font-medium text-[var(--c-muted)]">Choose a ticket from the queue. You will see the itemized bill, payment state, and a receipt preview. Payments are recorded only after the backend confirms.</p>
              <p className="mt-4 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-3 py-2 text-xs font-bold text-[var(--c-muted)]">Tip: search by table number (e.g. 3) or order # (e.g. ORD-1001)</p>
            </div>
          ) : (
            <>
              {/* Bill Panel */}
              <div className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-3 py-1.5 shadow-sm">
                        <span className="text-xs font-black uppercase tracking-wide text-[var(--c-muted)]">Table</span>
                        <span className="text-base font-black text-[var(--c-text)]">{selected.tableNumber ?? '—'}</span>
                      </span>
                      <span className="rounded-xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)] shadow-sm truncate max-w-[20ch]" title={selected.orderNumber}>{selected.orderNumber}</span>
                      {selected.isExternal && <span className="rounded-full bg-[#FEF3C7] border border-[#FDE68A] px-2.5 py-1 text-xs font-black uppercase text-[#92400E]">External</span>}
                      <span className={`rounded-full px-2.5 py-1 text-xs font-black uppercase ${statusBadge(selected.status).cls}`}>{statusBadge(selected.status).label}</span>
                    </div>
                    <p className="mt-2 text-xs font-semibold text-[var(--c-muted)]">
                      Waiter <span className="font-black text-[var(--c-text)]">{selected.waiterName || '—'}</span>
                      {selected.waiterNumber != null ? ` · #${selected.waiterNumber}` : ''} · {fmtDate(selected.createdAt)}
                    </p>
                    {selected.updatedAt && selected.updatedAt !== selected.createdAt && (
                      <p className="text-[11px] font-medium text-[var(--c-faint)]">Updated {fmtDate(selected.updatedAt)}</p>
                    )}
                  </div>
                  <button type="button" onClick={clearSelection} className="shrink-0 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] tactile">Close</button>
                </div>

                {/* Items */}
                <div className="px-4 sm:px-5 py-4">
                  <h4 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)] mb-3">Items — {selected.items?.length ?? 0} line{selected.items?.length === 1 ? '' : 's'}</h4>
                  {!Array.isArray(selected.items) || selected.items.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-[var(--c-border-soft)] bg-[var(--c-bg)] px-4 py-6 text-center text-sm font-medium text-[var(--c-muted)]">No items on this ticket</p>
                  ) : (
                    <div className="space-y-2">
                      {(selected.items || []).map((it, idx) => {
                        const nm = itemNameOf(it, lang);
                        const qty = Number(it.quantity) || 0;
                        const price = Number(it.price) || 0;
                        const sub = Number(it.subTotal ?? price * qty);
                        return (
                          <div key={`${selected._id}-it-${idx}`} className="flex items-start gap-3 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] px-3 py-2.5">
                            <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--c-accent)] text-[#1E293B] dark:text-white text-xs font-black">{qty}</span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-bold text-[var(--c-text)]" title={nm}>{nm}</p>
                              <p className="text-xs font-medium text-[var(--c-muted)]">{it.type || 'FOOD'} · {fmtMoney(price)} each {it.isExternal ? '· External' : ''}</p>
                            </div>
                            <span className="shrink-0 text-sm font-black text-[var(--c-text)]">{fmtMoney(sub)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Totals — only from reliable totalAmount */}
                  <div className="mt-4 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] p-3 sm:p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">Total</span>
                      <span className="text-xl sm:text-2xl font-black text-[var(--c-text)]">{fmtMoney(selected.totalAmount)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--c-muted)]">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-black uppercase ${payBadge(selected.paymentMethod).cls}`}>{payBadge(selected.paymentMethod).label}</span>
                      {selected.paymentMethod && String(selected.paymentMethod).toUpperCase() !== 'NONE' && (
                        <span>· Method: <strong className="text-[var(--c-text)]">{selected.paymentMethod}</strong></span>
                      )}
                      {selIsPaid && selected.paidAt && <span>· Paid {fmtDate(selected.paidAt)} {fmtTime(selected.paidAt) && `at ${fmtTime(selected.paidAt)}`}</span>}
                      {selIsCancelled && <span className="text-[#DC2626]">· Voided</span>}
                      {!selIsPaid && !selIsCancelled && <span className="text-[var(--c-muted)]">· Unpaid — awaiting settlement</span>}
                    </div>
                    {selIsPaid && selected.paidAt && (
                      <p className="mt-2 text-[11px] font-medium text-[var(--c-muted)]">Payment confirmed by backend. Receipt preview below uses only this order&apos;s stored fields — no calculated tax/discount/change.</p>
                    )}
                  </div>

                  {/* Timestamps — only when present */}
                  {(selected.preparingAt || selected.readyAt || selected.servedAt || selected.paidAt || selected.completedAt) && (
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        ['Preparing', selected.preparingAt],
                        ['Ready', selected.readyAt],
                        ['Served', selected.servedAt],
                        ['Paid', selected.paidAt],
                      ].map(([lbl, iso]) => (
                        <div key={lbl} className="rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-2.5 py-2">
                          <p className="text-[10px] font-black uppercase tracking-wide text-[var(--c-muted)]">{lbl}</p>
                          <p className="text-xs font-bold text-[var(--c-text)]">{iso ? fmtTime(iso) : '—'}</p>
                          <p className="text-[10px] font-medium text-[var(--c-muted)]">{iso ? fmtDate(iso).split(',')[0] : ''}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Payment Action Area */}
              <div className="card-elevated rounded-2xl bg-[var(--c-card)] p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h4 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">Payment</h4>
                  {selIsPaid && <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F0FDF4] border border-[#BBF7D0] px-2.5 py-1 text-xs font-black text-[#15803D]">✓ Settled</span>}
                  {selIsCancelled && <span className="inline-flex rounded-full bg-[#FEF2F2] border border-[#FECACA] px-2.5 py-1 text-xs font-black text-[#DC2626]">Voided</span>}
                  {selIsUnpaid && <span className="inline-flex rounded-full bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)]">Awaiting</span>}
                </div>

                {payError && (
                  <div role="alert" className="mb-3 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626]">{payError}</div>
                )}

                {selIsPaid ? (
                  <div className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] dark:bg-[#1C1D24] dark:border-[#2A2B36] p-4">
                    <p className="text-sm font-black text-[#15803D] dark:text-[#86EFAC]">This ticket is PAID — no further payment required.</p>
                    <p className="mt-1 text-xs font-medium text-[#15803D]/80 dark:text-[#94A3B8]">Backend confirmed <strong>{selected.paymentMethod}</strong> at {fmtDate(selected.paidAt)}. Buttons are disabled to prevent duplicate settlement.</p>
                    {canShowReceipt && <p className="mt-2 text-xs font-bold text-[var(--c-muted)]">Receipt preview below is printable.</p>}
                  </div>
                ) : selIsCancelled ? (
                  <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-4">
                    <p className="text-sm font-bold text-[#DC2626]">This ticket is {String(selected.status).toUpperCase()} and cannot be paid.</p>
                    <p className="mt-1 text-xs font-medium text-[#DC2626]/80">Create a new order if payment is still required.</p>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-medium text-[var(--c-muted)] mb-3">
                      Settle <strong className="text-[var(--c-text)]">{selected.orderNumber}</strong> for <strong className="text-[var(--c-text)]">{fmtMoney(selected.totalAmount)}</strong>. Amount is taken directly from the order&apos;s stored <code className="rounded bg-[var(--c-bg)] px-1 py-0.5 text-xs">totalAmount</code> — no manual entry.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => handlePay('CASH')}
                        disabled={payBusy}
                        aria-disabled={payBusy}
                        className="flex items-center justify-center gap-2 rounded-xl bg-[var(--c-accent)] text-[#1E293B] dark:text-white px-4 py-3.5 text-sm font-black uppercase tracking-wide shadow-sm disabled:opacity-50 disabled:cursor-not-allowed tactile"
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/90 dark:bg-white text-[#1E293B] text-sm">₵</span>
                        {payBusy ? 'Processing…' : 'Cash — Mark Paid'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePay('TELEBIRR')}
                        disabled={payBusy}
                        aria-disabled={payBusy}
                        className="flex items-center justify-center gap-2 rounded-xl bg-[#1E293B] dark:bg-white text-white dark:text-[#12131A] px-4 py-3.5 text-sm font-black uppercase tracking-wide shadow-sm disabled:opacity-50 disabled:cursor-not-allowed tactile"
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 dark:bg-[#1E293B]/10 text-white dark:text-[#12131A] text-xs font-black">Tx</span>
                        {payBusy ? 'Processing…' : 'Telebirr — Mark Paid'}
                      </button>
                    </div>
                    <p className="mt-3 text-[11px] font-medium text-[var(--c-muted)]">
                      Payment is recorded via <code className="rounded bg-[var(--c-bg)] px-1 py-0.5">PATCH /api/orders/{String(selected._id).slice(0, 8)}… {"{status:'PAID', paymentMethod}"}</code>. Success is shown only after the backend returns the updated order. Duplicate taps are blocked while processing.
                    </p>
                  </>
                )}
              </div>

              {/* Receipt Preview — only when reliable data */}
              <div className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
                <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                  <h4 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">Receipt Preview</h4>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${canShowReceipt ? 'bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] text-[var(--c-muted)]' : 'bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626]'}`}>
                    {canShowReceipt ? (selIsPaid ? 'Issuable' : 'Preview') : 'Unavailable'}
                  </span>
                </div>
                {!canShowReceipt ? (
                  <div className="px-4 sm:px-5 py-8 text-center">
                    <p className="text-sm font-bold text-[var(--c-muted)]">Receipt unavailable</p>
                    <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[36ch] mx-auto">Receipt requires at least order number, items, and total. This ticket is missing one of those fields and no receipt is fabricated.</p>
                  </div>
                ) : (
                  <div className="px-4 sm:px-5 py-5 font-mono text-xs leading-relaxed">
                    <div className="mx-auto max-w-md rounded-xl border border-dashed border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] p-4 shadow-sm">
                      <div className="text-center border-b border-dashed border-[var(--c-border-soft)] pb-3 mb-3">
                        <p className="font-sans text-sm font-black tracking-tight text-[var(--c-text)]">BONO HOTEL</p>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--c-muted)]">Cashier Receipt — Preview</p>
                        <p className="mt-1 text-[11px] font-bold text-[var(--c-text)]">{selected.orderNumber} · Table {selected.tableNumber}</p>
                        <p className="text-[11px] text-[var(--c-muted)]">{fmtDate(selected.createdAt)} {selected.paidAt ? `· Paid ${fmtDate(selected.paidAt)}` : '· Unpaid'}</p>
                      </div>
                      <div className="space-y-1">
                        {(selected.items || []).map((it, i) => (
                          <div key={`rcpt-${i}`} className="flex gap-2">
                            <span className="shrink-0 w-6 text-right font-bold">{Number(it.quantity)}×</span>
                            <span className="flex-1 truncate font-medium" title={itemNameOf(it, lang)}>{itemNameOf(it, lang)}</span>
                            <span className="shrink-0 w-20 text-right font-bold">{fmtMoney(Number(it.subTotal ?? Number(it.price) * Number(it.quantity)))}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 border-t border-dashed border-[var(--c-border-soft)] pt-3 flex items-center justify-between font-sans font-black text-sm">
                        <span className="uppercase tracking-wide text-[var(--c-muted)]">Total</span>
                        <span className="text-[var(--c-text)]">{fmtMoney(selected.totalAmount)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px]">
                        <span className="font-bold uppercase tracking-wide text-[var(--c-muted)]">Method</span>
                        <span className={`rounded-full px-2 py-0.5 font-black uppercase text-[10px] ${payBadge(selected.paymentMethod).cls}`}>{String(selected.paymentMethod || 'NONE')}</span>
                      </div>
                      {selected.waiterName && (
                        <p className="mt-2 text-center text-[11px] font-medium text-[var(--c-muted)]">Served by {selected.waiterName}{selected.waiterNumber != null ? ` #${selected.waiterNumber}` : ''}</p>
                      )}
                      <p className="mt-3 text-center text-[10px] font-medium text-[var(--c-muted)]">Thank you — amounts from stored order only. No tax/discount simulated.</p>
                      <div className="mt-3 flex justify-center">
                        <button
                          type="button"
                          onClick={() => window.print()}
                          className="rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-3 py-1.5 font-sans text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] tactile"
                        >
                          Print (browser)
                        </button>
                      </div>
                    </div>
                    {!selIsPaid && (
                      <p className="mt-3 text-center font-sans text-[11px] font-medium text-[var(--c-muted)]">This is a preview — payment not yet confirmed by backend. Print after PAID for an issuable receipt.</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>

      <footer className="mx-auto max-w-[1600px] px-4 py-6 text-center text-xs font-medium text-[var(--c-muted)]">
        Cashier · Phase 1 — MANAGER-authorized settlement only · Amounts from <code className="rounded bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-1">totalAmount</code> · No fabricated totals
      </footer>
    </div>
  );
}
