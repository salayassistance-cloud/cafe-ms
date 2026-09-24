'use client';

import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { safeFetchJson, getSessionErrorKind, tabLogout } from '@/lib/clientFetch';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useOrderEvents } from '@/lib/orderEvents';
import { formatPrice } from '@/lib/currency';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';
import LanguageToggle from '@/app/components/LanguageToggle';
import { useLanguage } from '@/app/components/LanguageProvider';
import {
  formatEthiopianDate,
  formatEthiopianDateTime,
  formatEthiopianClock,
} from '@/lib/ethiopianCalendar';

// Cashier POS — Phase 1 isolated UI
// Data sources verified: GET /api/orders (and ?status=SERVED/PAID) + PATCH /api/orders/[id] {status:"PAID",paymentMethod}
// Auth: STRICT CASHIER-only portal (app/cashier/layout.js enforces LIVE
// Staff.role === CASHIER; MANAGER portal access removed). Payment-confirm
// BUSINESS operations remain policy-gated (orders:payment:confirm). Identity
// is never converted. No DB/API mutation.

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'SERVED', label: 'Served' },
  { key: 'READY', label: 'Ready' },
  { key: 'PREPARING', label: 'Preparing' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'PAYMENT_PENDING', label: 'Payment Pending' },
  { key: 'PAID', label: 'Paid' },
  { key: 'CANCELLED', label: 'Cancelled' },
  { key: 'ARCHIVED', label: 'Archived' },
];

const STATUS_META = {
  PENDING: { label: 'PENDING', cls: 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#64748B] dark:text-[#94A3B8] border border-[var(--c-border-soft)]' },
  PREPARING: { label: 'PREPARING', cls: 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm' },
  READY: { label: 'READY', cls: 'bg-[rgba(255,214,0,0.14)] dark:bg-[rgba(255,94,0,0.12)] text-[#8A6D00] dark:text-[#FF8A3D] border border-[#FFD600]/20 dark:border-[#FF5E00]/20' },
  SERVED: { label: 'SERVED', cls: 'bg-white dark:bg-[#1C1D24] text-[#475569] dark:text-[#94A3B8] border border-[var(--c-border-soft)]' },
  PAYMENT_PENDING: { label: 'PAYMENT PENDING', cls: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#7C2D12] dark:text-[#FDBA74] border border-[#FDE68A] dark:border-[#7C2D12]' },
  PAID: { label: 'PAID', cls: 'bg-[#1E293B] text-white dark:bg-white dark:text-[#12131A]' },
  CANCELLED: { label: 'CANCELLED', cls: 'bg-[#FEF2F2] text-[#DC2626] border border-[#FECACA]' },
  ARCHIVED: { label: 'ARCHIVED', cls: 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#94A3B8] border border-[var(--c-border-soft)]' },
};

function statusBadge(status) {
  const key = String(status || '').toUpperCase();
  return STATUS_META[key] || { label: key || 'UNKNOWN', cls: 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#64748B] dark:text-[#94A3B8] border border-[var(--c-border-soft)]' };
}

const PAY_META = {
  CASH: { label: 'CASH', cls: 'bg-[#1E293B] text-white dark:bg-white dark:text-[#1E293B]' },
  TRANSFER: { label: 'TRANSFER', cls: 'bg-[rgba(255,214,0,0.14)] dark:bg-[rgba(255,94,0,0.12)] text-[#1E293B] dark:text-[#FF8A3D] border border-[#FFD600]/20 dark:border-[#FF5E00]/20' },
  NONE: { label: 'UNPAID', cls: 'bg-[#FEF2F2] text-[#DC2626] border border-[#FECACA] dark:bg-[#1C1D24] dark:text-[#FCA5A5] dark:border-[#2A2B36]' },
};

function normalizePayMethod(m) {
  const v = String(m || '').toUpperCase();
  if (v === 'TELEBIRR') return 'TRANSFER'; // legacy brand displayed as generic Transfer
  return v || 'NONE';
}
function payBadge(method) {
  const norm = normalizePayMethod(method);
  return PAY_META[norm] || PAY_META.NONE;
}
function payLabel(method) {
  const norm = normalizePayMethod(method);
  if (norm === 'TRANSFER') return 'TRANSFER';
  if (norm === 'CASH') return 'CASH';
  if (norm === 'NONE') return 'UNPAID';
  return norm;
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
// Canonical business display: Ethiopian Calendar + Africa/Addis_Ababa +
// Ethiopian clock (12h day + 12h night). `new Date(iso)` only wraps an
// existing UTC instant; interpretation is Addis-aware, never browser-local.
function fmtDate(iso, lang) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return formatEthiopianDateTime(d, lang === 'en' ? 'en' : 'am');
  } catch {
    return '—';
  }
}
// Date-only Ethiopian business date (no time duplication in combined cells).
function fmtDay(iso, lang) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return formatEthiopianDate(d, lang === 'en' ? 'en' : 'am');
  } catch {
    return '';
  }
}
function fmtTime(iso, lang) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return formatEthiopianClock(d, lang === 'en' ? 'en' : 'am');
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
  const { lang, t } = useLanguage();
  const router = useRouter();
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

  // Business brand for the printed ticket header — existing /api/brand
  // config (read-only here), operational fallback otherwise. Never written
  // from this component; never part of order/payment logic.
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
  const ticketBrand = (brandName || 'AVENUE HOTEL').toUpperCase();

  // AUTH-ARCH-6: explicit session-ended state (revoked/expired/invalid/
  // disabled). While set: authenticated polling stops (no storm), SSE is
  // suspended, stale in-flight results are discarded via authGenRef, and an
  // overlay requires explicit CASHIER re-login. No credentials handled here;
  // server order/payment state is never touched.
  const [sessionEnded, setSessionEnded] = useState(false);
  const sessionEndedRef = useRef(false);
  const authGenRef = useRef(0);

  const enterSessionEnded = useCallback(() => {
    authGenRef.current += 1;
    sessionEndedRef.current = true;
    setSessionEnded(true);
    // No timer clearing needed: scheduleRefresh/fetchOrders early-return on
    // sessionEndedRef, so any already-scheduled tick is a harmless no-op.
  }, []);

  const signInAgain = useCallback(async () => {
    // Tab-scoped logout: only this tab's Session is revoked.
    try {
      await tabLogout();
    } catch {}
    authGenRef.current += 1;
    sessionEndedRef.current = false;
    setSessionEnded(false);
    try { router.push('/cashier'); } catch {}
  }, [router]);


  const refreshTimer = useRef(null);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const fetchOrders = useCallback(async () => {
    // Session ended: never fire authenticated refreshes (no retry storm).
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    try {
      const results = await Promise.allSettled([
        safeFetchJson('/api/orders', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=SERVED', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=PAYMENT_PENDING', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=PAID', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=CANCELLED', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=ARCHIVED', { cache: 'no-store' }),
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
      // Stale success after revocation must not repopulate the board.
      if (gen !== authGenRef.current) return;

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
      if (gen !== authGenRef.current) return;
      // Explicit session end enters the re-login state (polling/SSE stop).
      // Transient failures (503/429/network) keep state and cadence.
      if (getSessionErrorKind(err)) {
        enterSessionEnded();
        return;
      }
      const s = err?.status;
      if (s === 503 || /database|unavailable/i.test(err?.message || '')) {
        setError(t('cashierDbUnavailable'));
      } else if (s === 429) {
        setError(t('cashierTooMany'));
      } else if (s === 403) {
        setError(err?.data?.error || err?.message || t('cashierForbidden'));
      } else {
        setError(err?.message || t('cashierUnableLoad'));
      }
    } finally {
      setInitialLoading(false);
    }
  }, [enterSessionEnded, t]);

  const scheduleRefresh = useCallback(() => {
    if (sessionEndedRef.current) return;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(fetchOrders, 150);
  }, [fetchOrders]);

  useOrderEvents(useCallback((event) => {
    if (sessionEndedRef.current) return;
    if (!event || event.type === 'ping') return;
    if (event.type === 'orders-changed' || event.type === 'ORDER_READY' || event.type === 'menu-changed' || !event.type) {
      scheduleRefresh();
    }
  }, [scheduleRefresh]), !sessionEnded);

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
    const c = { ALL: orders.length, SERVED: 0, READY: 0, PREPARING: 0, PENDING: 0, PAYMENT_PENDING: 0, PAID: 0, CANCELLED: 0, ARCHIVED: 0 };
    for (const o of orders) {
      const s = String(o.status).toUpperCase();
      if (c[s] !== undefined) c[s] += 1;
      else c[s] = 1;
    }
    return c;
  }, [orders]);

  const handleSelect = useCallback((id) => {
    const sid = String(id);
    setSelectedId(sid);
    setPayError('');
    setPaySuccess('');
  }, []);

  // Identity pre-flight for irreversible payment mutations. Resolves THIS tab
  // through the canonical session engine (/api/auth/me is tab-aware): only a
  // live CASHIER or MANAGER may proceed. Anything else enters the re-login
  // state instead of issuing a doomed mutation. Transient failures block with
  // a retryable message (fail-closed UX, no state change).
  const verifyCashierIdentity = useCallback(async (gen) => {
    try {
      const me = await safeFetchJson('/api/auth/me', { cache: 'no-store' });
      if (gen !== authGenRef.current || sessionEndedRef.current) return false;
      const role = String(me?.data?.role || '').toUpperCase();
      if (role !== 'CASHIER' && role !== 'MANAGER') {
        enterSessionEnded('expired');
        return false;
      }
      return true;
    } catch (e) {
      if (gen !== authGenRef.current || sessionEndedRef.current) return false;
      const kind = getSessionErrorKind(e);
      if (kind) enterSessionEnded(kind);
      else setPayError(t('cashierVerifySession'));
      return false;
    }
  }, [enterSessionEnded, t]);

  const handleConfirmPending = useCallback(async () => {    if (!selected || payBusy) return;
    // Session ended: cashier must not confirm with a stale identity.
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    if (String(selected.status).toUpperCase() !== 'PAYMENT_PENDING') {
      setPayError(t('cashierOnlyPendingConfirm'));
      return;
    }
    setPayBusy(true);
    setPayError('');
    setPaySuccess('');
    try {
      // Identity pre-flight: resolve THIS tab through the canonical session
      // engine before firing the mutation. A tab without a live CASHIER (or
      // MANAGER) identity — e.g. operating on another tab's cookie — enters
      // re-login instead of issuing a doomed request.
      if (!(await verifyCashierIdentity(gen))) return;
      const data = await safeFetchJson(`/api/orders/${selected._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PAID' }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || t('cashierConfirmFailed'));
      const updated = data?.data?.order || data?.order;
      if (!updated || !updated._id) throw new Error(t('cashierConfirmMalformed'));
      // Stale success after revocation: apply nothing, show no receipt.
      if (gen !== authGenRef.current) return;
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
      setPaySuccess(`${t('cashierPaymentVerified')}: ${updated.orderNumber}`);
      setNotice(`✓ ${updated.orderNumber} — ${t('cashierPaid')}`);
    } catch (err) {
      if (gen !== authGenRef.current) return;
      if (getSessionErrorKind(err)) { enterSessionEnded(); return; }
      const s = err?.status;
      // Surface the server's precise authorization error instead of masking
      // every 403 behind one string (the server distinguishes role mismatch,
      // disabled accounts, and policy denials).
      if (s === 403) setPayError(err?.data?.error || err?.message || t('cashierConfirmForbidden'));
      else if (s === 409) setPayError(t('cashierAlreadyConfirmed'));
      else setPayError(err?.message ? `${t('cashierConfirmFailed')}: ${err.message}` : t('cashierConfirmFailedRetry'));
    } finally {
      setPayBusy(false);
    }
  }, [selected, payBusy, enterSessionEnded, verifyCashierIdentity, t]);

  const handleRejectPending = useCallback(async () => {
    if (!selected || payBusy) return;
    // Session ended: cashier must not reject with a stale identity.
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    if (String(selected.status).toUpperCase() !== 'PAYMENT_PENDING') {
      setPayError(t('cashierOnlyPendingReject'));
      return;
    }
    const reason = window.prompt(t('cashierRejectReasonPrompt')) || '';
    if (reason && (/<script/i.test(reason) || /javascript:/i.test(reason))) {
      setPayError(t('cashierRejectInvalid'));
      return;
    }
    setPayBusy(true);
    setPayError('');
    setPaySuccess('');
    try {
      // Same identity pre-flight as confirmation (see above).
      if (!(await verifyCashierIdentity(gen))) return;
      const data = await safeFetchJson(`/api/orders/${selected._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'REJECT_PAYMENT', reason: reason || undefined }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || t('cashierRejectFailed'));
      const updated = data?.data?.order || data?.order;
      if (!updated || !updated._id) throw new Error(t('cashierRejectMalformed'));
      // Stale success after revocation: apply nothing, show no receipt.
      if (gen !== authGenRef.current) return;
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
      setPaySuccess(`${t('cashierPaymentRejected')}: ${updated.orderNumber}`);
      setNotice(`↩ ${updated.orderNumber} — ${t('cashierRejectedWord')}`);
    } catch (err) {
      if (gen !== authGenRef.current) return;
      if (getSessionErrorKind(err)) { enterSessionEnded(); return; }
      const s = err?.status;
      if (s === 403) setPayError(err?.data?.error || err?.message || t('cashierRejectForbidden'));
      else setPayError(err?.message ? `${t('cashierRejectFailed')}: ${err.message}` : t('cashierRejectFailedRetry'));
    } finally {
      setPayBusy(false);
    }
  }, [selected, payBusy, enterSessionEnded, verifyCashierIdentity, t]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setPayError('');
    setPaySuccess('');
  }, []);

  const selStatus = selected ? String(selected.status).toUpperCase() : null;
  const selIsPaid = selStatus === 'PAID';
  const selIsPaymentPending = selStatus === 'PAYMENT_PENDING';
  const selIsCancelled = selStatus === 'CANCELLED' || selStatus === 'ARCHIVED';
  const selIsUnpaid = selected && !selIsPaid && !selIsCancelled && !selIsPaymentPending;
  // Reliable receipt only when we have orderNumber, items, totalAmount, createdAt
  const canShowReceipt = !!(selected && selected.orderNumber && Array.isArray(selected.items) && Number.isFinite(Number(selected.totalAmount)));

  // Gate @media print on the dedicated ticket: while a printable ticket is
  // mounted the browser prints ONLY #bono-thermal-ticket; otherwise printing
  // behaves normally (never a blank page). No navigation/state changes.
  const printableTicket = !!(canShowReceipt && selected);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (printableTicket) document.body.classList.add('bono-print-ticket');
    else document.body.classList.remove('bono-print-ticket');
    return () => document.body.classList.remove('bono-print-ticket');
  }, [printableTicket]);

  if (!hasMounted) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-[var(--c-bg)]">
        <div className="text-sm font-bold text-[var(--c-muted)]">{t('cashierLoading')}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--c-bg)] text-[var(--c-text)]">
      {/* AUTH-ARCH-6: explicit session-ended state. Blocks actions until
          CASHIER re-login via the existing PinGuard flow. No credentials
          handled here. */}
      {sessionEnded && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4 py-6" role="alertdialog" aria-modal="true" aria-label="Session ended">
          <div className="w-full max-w-sm rounded-2xl border border-[var(--c-border-soft)] bg-[var(--c-card)] p-6 text-center shadow-lg">
            <h2 className="text-lg font-black tracking-tight text-[var(--c-text)]">
              {t('cashierSessionEnded')}
            </h2>
            <p className="mt-2 text-sm font-medium text-[var(--c-muted)]">
              {t('cashierPleaseSignIn')}
            </p>
            <button
              type="button"
              onClick={signInAgain}
              className="mt-5 flex h-12 w-full items-center justify-center rounded-xl bg-[var(--c-accent)] text-sm font-black uppercase tracking-wide text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner"
            >
              {t('cashierSignInAgain')}
            </button>
          </div>
        </div>
      )}
      {/* Compact header — contained curved container matching Menu CRUD / Manager Reports */}
      <header className="relative mx-3 sm:mx-4 mt-4 rounded-2xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] dark:border-[#2A2B36] px-3 sm:px-4 py-3 shadow-sm backdrop-blur">
        <div className="mx-auto max-w-[1600px] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <p className="text-base sm:text-lg font-black tracking-tight leading-none mt-1 text-[var(--c-text)]">{t('cashierTitle')}</p>
            </div>
            <span className="hidden lg:inline-flex ml-2 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-[var(--c-muted)]">
              {orders.length} {t('cashierTickets')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link
              href="/"
              aria-label={t('home')}
              title={t('home')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] text-[var(--c-muted)] shadow-sm hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
              </svg>
            </Link>
            <ThemeToggleHome />
          </div>
        </div>
      </header>

      {/* Alerts */}
      {(error || paySuccess || notice) && (
        <div className="mx-auto max-w-[1600px] px-3 sm:px-4 pt-3 space-y-2">
          {error && (
            <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
              <span>{error}</span>
              <button type="button" onClick={fetchOrders} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626] hover:bg-[#FFF7ED]">{t('uiRetry')}</button>
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
            <div className="rounded-2xl p-3 sm:p-4 bg-[var(--c-card)] border border-[var(--c-border-soft)] shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('cashierQueue')}</h2>
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
                placeholder={t('cashierSearchPh')}
                aria-label={t('cashierSearchAria')}
                className="w-full bg-transparent text-sm font-medium text-[var(--c-text)] placeholder:text-[var(--c-muted)] focus:outline-none"
              />
                {search && (
                <button type="button" onClick={() => setSearch('')} className="shrink-0 rounded-full bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] h-6 w-6 flex items-center justify-center text-[var(--c-muted)] hover:bg-[#F8FAFC] dark:hover:bg-[#252631]" aria-label={t('cashierClearSearch')}>✕</button>
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
                    className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold border transition-all duration-150 ease-out active:shadow-inner ${active ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white border-transparent shadow-sm' : 'bg-white dark:bg-[#1C1D24] text-[var(--c-muted)] border-[var(--c-border-soft)]'}`}
                  >
                    {({ ALL: t('all'), SERVED: t('cashierServed'), READY: t('ready'), PREPARING: t('preparing'), PENDING: t('cashierPending'), PAYMENT_PENDING: t('cashierPayPending'), PAID: t('cashierPaid'), CANCELLED: t('cashierCancelledWord'), ARCHIVED: t('cashierArchived') }[f.key] || f.label)} <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-black ${active ? 'bg-black/15 dark:bg-white/15 text-[#1E293B] dark:text-white' : 'bg-[var(--c-bg)] border border-[var(--c-border-soft)]'}`}>{n}</span>
                  </button>
                );
              })}
            </div>

            {/* Refresh */}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] font-medium text-[var(--c-muted)] hidden sm:block">
                {initialLoading ? t('cashierLoading') : `${filtered.length} ${t('cashierTickets')} · ${t('cashierTapToBill')}`}
              </p>
              <button
                type="button"
                onClick={fetchOrders}
                disabled={initialLoading}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)] shadow-sm disabled:opacity-50"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><path d="M21 12a9 9 0 11-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                {t('cashierRefresh')}
              </button>
            </div>
          </div>

          {/* Order list */}
          <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-2 sm:p-3 flex flex-col min-h-[320px] max-h-[65vh] lg:max-h-[72vh] overflow-hidden">
            {initialLoading ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-[92px] animate-pulse rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)]" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-16 px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--c-border-soft)] bg-[var(--c-bg)] text-[var(--c-muted)] mb-3">—</div>
                <p className="text-sm font-bold text-[var(--c-text)]">{error ? t('cashierUnavailable') : search || filter !== 'ALL' ? t('cashierNoMatching') : t('cashierNoTickets')}</p>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[28ch]">
                  {error ? t('cashierConnHint') : search ? `${t('cashierNoResults')} “${search.trim()}”. ${t('cashierTryHint')}` : filter !== 'ALL' ? `${filter} · ${t('cashierNoTickets')}` : t('cashierNewOrdersHint')}
                </p>
                {!error && (search || filter !== 'ALL') && (
                  <button type="button" onClick={() => { setSearch(''); setFilter('ALL'); }} className="mt-3 rounded-xl bg-[var(--c-accent)] px-3 py-1.5 text-xs font-black text-[#1E293B] dark:text-white">{t('cashierClearFilters')}</button>
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
                    const more = (o.items?.length || 0) > 2 ? ` +${o.items.length - 2} ${t('cashierMore')}` : '';
                  const table = o.tableNumber ?? '—';
                  return (
                    <button
                      key={o._id}
                      type="button"
                      onClick={() => handleSelect(o._id)}
                      aria-pressed={isSelected}
                      className={`w-full text-left rounded-xl border p-3 flex flex-col gap-2 ${isSelected ? 'bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] border-[var(--c-accent)]/30 shadow-sm' : 'bg-white dark:bg-[#12131A] border-[var(--c-border-soft)]'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center rounded-lg bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-2 py-1 text-xs font-black text-[var(--c-text)]">T{table}</span>
                            <span className="text-xs font-bold text-[var(--c-muted)] truncate max-w-[14ch]" title={o.orderNumber}>{o.orderNumber}</span>
                            {o.isExternal && <span className="rounded-full bg-[#FEF3C7] text-[#92400E] border border-[#FDE68A] px-2 py-0.5 text-[10px] font-black uppercase">{t('cashierExternal')}</span>}
                          </div>
                          <p className="mt-1 text-xs font-semibold text-[var(--c-muted)] truncate">{t('waiter')}: {o.waiterName || '—'} {o.waiterNumber != null ? `#${o.waiterNumber}` : ''}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide ${sb.cls}`}>{sb.label}</span>
                      </div>

                      <div className="flex items-end justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-[var(--c-muted)]" title={(o.items || []).map((it) => `${itemNameOf(it, lang)} ×${it.quantity}`).join(', ')}>
                              {itemsPreview}{more || (!itemsPreview ? t('cashierNoItems') : '')}
                            </p>
                          <p className="mt-0.5 text-[11px] font-medium text-[var(--c-faint)]">{fmtDate(o.createdAt, lang)}</p>
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
            <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-6 sm:p-8 flex flex-col items-center justify-center text-center min-h-[420px]">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] text-[var(--c-muted)] mb-4">
                <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true"><path d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M9 5a2 2 0 012-2h2a2 2 0 012 2v1a2 2 0 01-2 2h-2a2 2 0 01-2-2V5z" stroke="currentColor" strokeWidth="2"/><path d="M9 12h6M9 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </div>
              <h3 className="text-base font-black text-[var(--c-text)]">{t('cashierSelectTicket')}</h3>
              <p className="mt-2 max-w-[36ch] text-sm font-medium text-[var(--c-muted)]">{t('cashierSelectTicketDesc')}</p>
              <p className="mt-4 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-3 py-2 text-xs font-bold text-[var(--c-muted)]">{t('cashierSearchTip')}</p>
            </div>
          ) : (
            <>
              {/* Bill Panel */}
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-3 py-1.5 shadow-sm">
                        <span className="text-xs font-black uppercase tracking-wide text-[var(--c-muted)]">{t('table')}</span>
                        <span className="text-base font-black text-[var(--c-text)]">{selected.tableNumber ?? '—'}</span>
                      </span>
                      <span className="rounded-xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)] shadow-sm truncate max-w-[20ch]" title={selected.orderNumber}>{selected.orderNumber}</span>
                      {selected.isExternal && <span className="rounded-full bg-[#FEF3C7] border border-[#FDE68A] px-2.5 py-1 text-xs font-black uppercase text-[#92400E]">{t('cashierExternal')}</span>}
                      <span className={`rounded-full px-2.5 py-1 text-xs font-black uppercase ${statusBadge(selected.status).cls}`}>{statusBadge(selected.status).label}</span>
                    </div>
                    <p className="mt-2 text-xs font-semibold text-[var(--c-muted)]">
                      {t('waiter')} <span className="font-black text-[var(--c-text)]">{selected.waiterName || '—'}</span>
                      {selected.waiterNumber != null ? ` #${selected.waiterNumber}` : ''} {fmtDate(selected.createdAt, lang)}
                    </p>
                    {selected.updatedAt && selected.updatedAt !== selected.createdAt && (
                      <p className="text-[11px] font-medium text-[var(--c-faint)]">{t('cashierUpdated')} {fmtDate(selected.updatedAt, lang)}</p>
                    )}
                    {selected.paymentRejectedAt && String(selected.status).toUpperCase() === 'SERVED' && (
                      <p className="mt-2 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#DC2626]">{t('cashierReturnedToWaiter')}{selected.paymentRejectionReason ? `: ${selected.paymentRejectionReason}` : ''} {t('cashierWaitingResubmit')}</p>
                    )}
                  </div>
                  <button type="button" onClick={clearSelection} className="shrink-0 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)]">{t('close')}</button>
                </div>

                {/* Items */}
                <div className="px-4 sm:px-5 py-4">
                  <h4 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)] mb-3">{t('cashierItemsTitle')} ({selected.items?.length ?? 0})</h4>
                  {!Array.isArray(selected.items) || selected.items.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-[var(--c-border-soft)] bg-[var(--c-bg)] px-4 py-6 text-center text-sm font-medium text-[var(--c-muted)]">{t('cashierNoItemsOnTicket')}</p>
                  ) : (
                    <div className="space-y-2">
                      {(selected.items || []).map((it, idx) => {
                        const nm = itemNameOf(it, lang);
                        const qty = Number(it.quantity) || 0;
                        const price = Number(it.price) || 0;
                        const sub = Number(it.subTotal ?? price * qty);
                        const isCancelled = !!it.cancelled;
                        return (
                          <div key={`${selected._id}-it-${it.lineId || idx}`} className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${isCancelled ? 'border-[#FECACA] bg-[#FEF2F2] dark:border-[#7F1D1D] dark:bg-[#1C1D24] opacity-80' : 'border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A]'}`}>
                            <span className={`flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg text-xs font-black ${isCancelled ? 'bg-[#FECACA] text-[#991B1B] dark:bg-[#7F1D1D] dark:text-white' : 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white'}`}>{qty}</span>
                            <div className="min-w-0 flex-1">
                              <p className={`truncate text-sm font-bold ${isCancelled ? 'line-through text-[#991B1B] dark:text-[#FCA5A5]' : 'text-[var(--c-text)]'}`} title={nm}>{nm}{isCancelled ? ` ${t('cashierCancelledWord')}` : ''}</p>
                              <p className="text-xs font-medium text-[var(--c-muted)]">{it.type || 'FOOD'} {fmtMoney(price)} {t('cashierEach')} {it.isExternal ? t('cashierLegacyExternal') : ''}{isCancelled ? ` ${it.cancelledStation || t('cashierStationWord')}${it.cancelReason ? `: ${it.cancelReason}` : ''}` : ''}</p>
                              {isCancelled && it.cancelledAt && <p className="text-[10px] text-[#991B1B] dark:text-[#FCA5A5]">{t('cashierCancelledWord')} {fmtDate(it.cancelledAt, lang)}</p>}
                              {Array.isArray(it.components) && it.components.length > 0 && (
                                <ul className="mt-1 space-y-0.5">
                                  {it.components.map((c, ci) => (
                                    <li key={`${it.lineId || idx}-c-${ci}`} className={`truncate text-xs ${c.kind === "NOTE" ? "italic text-[#92400E] dark:text-[#FDBA74]" : "font-medium text-[var(--c-text)]"}`}>
                                      {c.kind === "NOTE" ? `📝 ${c.note}` : `➕ ${c.name} ×${c.quantity} @ ${fmtMoney(c.unitPrice)} = ${fmtMoney(c.lineSum ?? c.quantity * c.unitPrice)}${c.inventoryItemId ? " linked" : ""}`}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <span className={`shrink-0 text-sm font-black ${isCancelled ? 'line-through text-[#991B1B] dark:text-[#FCA5A5]' : 'text-[var(--c-text)]'}`}>{fmtMoney(sub + (it.components||[]).filter(c=>c.kind==="PRICED_COMPONENT").reduce((s,c)=>s+(Number(c.lineSum)||0),0))}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Totals — gross vs net payable (cancelled excluded) */}
                  <div className="mt-4 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] p-3 sm:p-4">
                    {(() => {
                      const gross = Number(selected.totalAmount) || 0;
                      const net = Number(selected.netAmount ?? gross);
                      const cancelled = Number(selected.cancelledAmount ?? gross - net);
                      const hasCancelled = cancelled > 0.001;
                      return (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{hasCancelled ? t('cashierPayableNet') : t('cashierTotal')}</span>
                            <span className="text-xl sm:text-2xl font-black text-[var(--c-text)]">{fmtMoney(hasCancelled ? net : gross)}</span>
                          </div>
                          {hasCancelled && (
                              <div className="mt-1 flex items-center justify-between text-xs font-semibold text-[#DC2626] dark:text-[#FCA5A5]">
                                <span>{t('cashierGross')} {fmtMoney(gross)} {t('cashierCancelledAmt')} {fmtMoney(cancelled)}</span>
                                <span className="rounded-full bg-[#FEF2F2] border border-[#FECACA] px-2 py-0.5 text-[10px] font-black">{t('cashierCancelledExcluded')}</span>
                              </div>
                          )}
                        </>
                      );
                    })()}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--c-muted)]">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-black uppercase ${payBadge(selected.paymentMethod).cls}`}>{payLabel(selected.paymentMethod)}</span>
                      {selected.paymentMethod && String(selected.paymentMethod).toUpperCase() !== 'NONE' && (
                        <span>{t('cashierMethod')}: <strong className="text-[var(--c-text)]">{payLabel(selected.paymentMethod)}</strong></span>
                      )}
                      {normalizePayMethod(selected.paymentMethod) === 'TRANSFER' && selected.paymentAccountSnapshot && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-bold text-[var(--c-text)]">
                          🏦 {selected.paymentAccountSnapshot.bankName} {selected.paymentAccountSnapshot.ownerName} {selected.paymentAccountSnapshot.accountNumber}
                        </span>
                      )}
                      {normalizePayMethod(selected.paymentMethod) === 'TRANSFER' && !selected.paymentAccountSnapshot && selIsPaid && (
                        <span className="rounded-full bg-[#FEF3C7] border border-[#FDE68A] px-2.5 py-1 text-xs font-bold text-[#92400E]">{t('cashierLegacyAccount')}</span>
                      )}
                      {selIsPaid && selected.paidAt && <span>{t('cashierPaid')} {fmtDate(selected.paidAt, lang)}</span>}
                      {selIsCancelled && <span className="text-[#DC2626]">{t('cashierVoided')}</span>}
                      {!selIsPaid && !selIsCancelled && <span className="text-[var(--c-muted)]">{t('cashierUnpaidAwaiting')}</span>}
                    </div>
                  </div>

                  {/* Timestamps — only when present */}
                  {(selected.preparingAt || selected.readyAt || selected.servedAt || selected.paidAt || selected.completedAt) && (
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        [t('preparing'), selected.preparingAt],
                        [t('ready'), selected.readyAt],
                        [t('cashierServed'), selected.servedAt],
                        [t('cashierPaid'), selected.paidAt],
                      ].map(([lbl, iso]) => (
                        <div key={lbl} className="rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-2.5 py-2">
                          <p className="text-[10px] font-black uppercase tracking-wide text-[var(--c-muted)]">{lbl}</p>
                          <p className="text-xs font-bold text-[var(--c-text)]">{iso ? fmtTime(iso, lang) : '—'}</p>
                          <p className="text-[10px] font-medium text-[var(--c-muted)]">{iso ? fmtDay(iso, lang) : ''}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Payment Action Area */}
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h4 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('cashierPayment')}</h4>
                  {selIsPaid && <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F0FDF4] border border-[#BBF7D0] px-2.5 py-1 text-xs font-black text-[#15803D]">✓ {t('cashierPaid')}</span>}
                  {selIsCancelled && <span className="inline-flex rounded-full bg-[#FEF2F2] border border-[#FECACA] px-2.5 py-1 text-xs font-black text-[#DC2626]">{t('cashierVoided')}</span>}
                  {selIsUnpaid && <span className="inline-flex rounded-full bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)]">{t('cashierAwaitingWord')}</span>}
                </div>

                {payError && (
                  <div role="alert" className="mb-3 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626]">{payError}</div>
                )}

                {selIsPaid ? (
                  <div className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] dark:bg-[#1C1D24] dark:border-[#2A2B36] p-4">
                    <p className="text-sm font-black text-[#15803D] dark:text-[#86EFAC]">{t('cashierTicketPaid')}</p>
                    {canShowReceipt && <p className="mt-2 text-xs font-bold text-[var(--c-muted)]">{t('cashierReceiptPrintable')}</p>}
                  </div>
                ) : selIsPaymentPending ? (
                  <div className="rounded-xl border border-[#FEF3C7] bg-[#FEF3C7]/50 dark:bg-[#7C2D12]/30 dark:border-[#7C2D12] p-4">
                    <p className="text-sm font-black text-[#92400E] dark:text-[#FDBA74]">{t('cashierPendingVerification')} {payLabel(selected.paymentMethod)} {selected.paymentAccountSnapshot ? `${selected.paymentAccountSnapshot.bankName} ${selected.paymentAccountSnapshot.ownerName} ${selected.paymentAccountSnapshot.accountNumber}` : ""}</p>
                    <p className="mt-1 text-xs font-medium text-[#92400E]/80 dark:text-[#FDBA74]/80">{t('cashierSubmitted')} {selected.paymentSubmittedAt ? fmtDate(selected.paymentSubmittedAt, lang) : ""}</p>
                    <p className="mt-1 text-xs font-medium text-[#92400E]/80 dark:text-[#FDBA74]/80">{t('cashierAmount')}: <strong>{fmtMoney(selected.totalAmount)}</strong> ({t('cashierNet')} {fmtMoney(selected.netAmount ?? selected.totalAmount)})</p>
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button type="button" onClick={handleConfirmPending} disabled={payBusy} className="flex items-center justify-center gap-2 rounded-xl bg-[#16A34A] text-white px-4 py-3 text-sm font-black shadow-sm disabled:opacity-50">✓ {t('cashierConfirm')} {t('cashierPaid')}</button>
                      <button type="button" onClick={handleRejectPending} disabled={payBusy} className="flex items-center justify-center gap-2 rounded-xl border border-[#FECACA] bg-white text-[#DC2626] px-4 py-3 text-sm font-black shadow-sm disabled:opacity-50">↩ {t('cashierReject')} / {t('cashierReturnWord')}</button>
                    </div>
                  </div>
                ) : selIsCancelled ? (
                  <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-4">
                    <p className="text-sm font-bold text-[#DC2626]">{t('cashierTicketIs')} {String(selected.status).toUpperCase()} {t('cashierCannotBePaid')}</p>
                    <p className="mt-1 text-xs font-medium text-[#DC2626]/80">{t('cashierCreateNewOrder')}</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-4">
                    <p className="text-sm font-bold text-[#1E293B] dark:text-white">
                      {selected.orderNumber} · {fmtMoney(selected.totalAmount)}
                    </p>
                    <p className="mt-1 text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">
                      {t('cashierAwaitingWaiter')}
                    </p>
                  </div>
                )}
              </div>

              {/* Receipt Preview — only when reliable data */}
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
                <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                  <h4 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('cashierReceiptPreview')}</h4>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${canShowReceipt ? 'bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] text-[var(--c-muted)]' : 'bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626]'}`}>
                    {canShowReceipt ? (selIsPaid ? t('cashierIssuable') : t('cashierPreviewWord')) : t('cashierUnavailableWord')}
                  </span>
                </div>
                {!canShowReceipt ? (
                  <div className="px-4 sm:px-5 py-8 text-center">
                    <p className="text-sm font-bold text-[var(--c-muted)]">{t('cashierReceiptUnavailable')}</p>
                    <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[36ch] mx-auto">{t('cashierReceiptUnavailableDesc')}</p>
                  </div>
                ) : (
                  <div className="px-4 sm:px-5 py-5 font-mono text-xs leading-relaxed">
                    <div className="mx-auto max-w-md rounded-xl border border-dashed border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] p-4 shadow-sm">
                      <div className="text-center border-b border-dashed border-[var(--c-border-soft)] pb-3 mb-3">
                        <p className="font-sans text-sm font-black tracking-tight text-[var(--c-text)]">{ticketBrand}</p>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--c-muted)]">{t('cashierReceiptPreviewTitle')}</p>
                        <p className="mt-1 text-[11px] font-bold text-[var(--c-text)]">{selected.orderNumber} {t('table')} {selected.tableNumber}</p>
                        <p className="text-[11px] text-[var(--c-muted)]">{fmtDate(selected.createdAt, lang)} {selected.paidAt ? `${t('cashierPaid')} ${fmtDate(selected.paidAt, lang)}` : t('cashierUnpaidWord')}</p>
                      </div>
                      <div className="space-y-1">
                        {(selected.items || []).map((it, i) => (
                          <div key={`rcpt-${i}`}>
                            <div className={`flex gap-2 ${it.cancelled ? "line-through text-[#DC2626]" : ""}`}>
                              <span className="shrink-0 w-6 text-right font-bold">{Number(it.quantity)}×</span>
                              <span className="flex-1 truncate font-medium" title={itemNameOf(it, lang)}>{itemNameOf(it, lang)}{it.cancelled ? " (Cancelled)" : ""}</span>
                              <span className="shrink-0 w-20 text-right font-bold">{fmtMoney(Number(it.subTotal ?? Number(it.price) * Number(it.quantity)))}</span>
                            </div>
                            {Array.isArray(it.components) && it.components.map((c, ci) => (
                              <div key={`rcpt-${i}-c-${ci}`} className={`ml-6 flex gap-2 text-[11px] ${c.kind === "NOTE" ? "italic text-[#92400E]" : "font-medium text-[var(--c-muted)]"}`}>
                                <span className="shrink-0 w-6 text-right">{c.kind === "NOTE" ? "" : `${c.quantity}×`}</span>
                                <span className="flex-1 truncate" title={c.kind === "NOTE" ? c.note : c.name}>{c.kind === "NOTE" ? c.note : c.name}</span>
                                <span className="shrink-0 w-20 text-right font-bold">{c.kind === "NOTE" ? "" : fmtMoney(c.lineSum ?? c.quantity * c.unitPrice)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 border-t border-dashed border-[var(--c-border-soft)] pt-3 flex items-center justify-between font-sans font-black text-sm">
                        <span className="uppercase tracking-wide text-[var(--c-muted)]">{t('cashierTotal')}</span>
                        <span className="text-[var(--c-text)]">{fmtMoney(Number(selected.cancelledAmount) > 0 ? selected.netAmount : selected.totalAmount)}</span>
                      </div>
                      {Number(selected.cancelledAmount) > 0 && (
                        <p className="mt-1 text-right font-mono text-[10px] text-[#DC2626]">{t('cashierGross')} {fmtMoney(selected.totalAmount)} {t('cashierCancelledAmt')} {fmtMoney(selected.cancelledAmount)} {t('cashierExcludedWord')}</p>
                      )}
                      <div className="mt-2 flex items-center justify-between text-[11px]">
                        <span className="font-bold uppercase tracking-wide text-[var(--c-muted)]">{t('cashierMethod')}</span>
                        <span className={`rounded-full px-2 py-0.5 font-black uppercase text-[10px] ${payBadge(selected.paymentMethod).cls}`}>{payLabel(selected.paymentMethod)}</span>
                      </div>
                      {normalizePayMethod(selected.paymentMethod) === 'TRANSFER' && selected.paymentAccountSnapshot && (
                        <p className="mt-1 text-right font-mono text-[10px] text-[var(--c-muted)]">🏦 {selected.paymentAccountSnapshot.bankName} {selected.paymentAccountSnapshot.ownerName} {selected.paymentAccountSnapshot.accountNumber}</p>
                      )}
                      {selected.waiterName && (
                        <p className="mt-2 text-center text-[11px] font-medium text-[var(--c-muted)]">{t('cashierServedBy')} {selected.waiterName}{selected.waiterNumber != null ? ` #${selected.waiterNumber}` : ''}</p>
                      )}
                      <p className="mt-3 text-center text-[10px] font-medium text-[var(--c-muted)]">{t('cashierReceiptNote')}</p>
                      <div className="mt-3 flex justify-center">
                        <button
                          type="button"
                          onClick={() => window.print()}
                          className="rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-3 py-1.5 font-sans text-xs font-bold text-[var(--c-muted)]"
                        >
                          {t('cashierPrint')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Dedicated thermal ticket — hidden on screen (.bono-print-only),
                  the ONLY node printed via @media print. Same order object as
                  the preview above; no values invented, no totals recalculated
                  differently. Text/vector only, monochrome thermal friendly. */}
              {printableTicket && (
                <div id="bono-thermal-ticket" className="bono-print-only" aria-hidden="true">
                  <div className="bono-ticket-block" style={{ textAlign: 'center' }}>
                    <p style={{ fontWeight: 700, fontSize: 15 }}>{ticketBrand}</p>
                    <p style={{ fontWeight: 700 }}>{t('cashierReceiptTitle')}</p>
                  </div>
                  <p>--------------------------------</p>
                  <div className="bono-ticket-block">
                    <p>{t('order')}: {selected.orderNumber}</p>
                    <p>{t('table')}: {selected.tableNumber ?? '—'}</p>
                    <p>{t('cashierDateLabel')}: {fmtDay(selected.createdAt, lang)}</p>
                    <p>{t('cashierTimeLabel')}: {fmtTime(selected.createdAt, lang)}</p>
                    {selected.paidAt && <p>{t('cashierPaid')}: {fmtDate(selected.paidAt, lang)}</p>}
                  </div>
                  <p>--------------------------------</p>
                  <div className="bono-ticket-block">
                    <p>{t('cashierTicketCols')}</p>
                    <p>--------------------------------</p>
                    {(selected.items || []).map((it, i) => (
                      <div key={`pt-${i}`}>
                        <p>{Number(it.quantity) || 0}x   {itemNameOf(it, lang)}{it.cancelled ? ` (${t('cashierCancelledWord')})` : ''}   {fmtMoney(Number(it.subTotal ?? Number(it.price) * Number(it.quantity)))}</p>
                        {Array.isArray(it.components) && it.components.map((c, ci) => (
                          <p key={`pt-${i}-c-${ci}`}>{c.kind === 'NOTE' ? `     * ${c.note}` : `     + ${c.name} x${c.quantity} ${fmtMoney(c.lineSum ?? c.quantity * c.unitPrice)}`}</p>
                        ))}
                      </div>
                    ))}
                  </div>
                  <p>--------------------------------</p>
                  <div className="bono-ticket-block">
                    <p style={{ fontWeight: 700 }}>{t('cashierTotal')}  {fmtMoney(Number(selected.cancelledAmount) > 0 ? selected.netAmount : selected.totalAmount)}</p>
                    {Number(selected.cancelledAmount) > 0 && (
                      <p>{t('cashierGross')} {fmtMoney(selected.totalAmount)} {t('cashierCancelledAmt')} {fmtMoney(selected.cancelledAmount)} {t('cashierExcludedWord')}</p>
                    )}
                    <p>{t('cashierPayment')}: {payLabel(selected.paymentMethod)}</p>
                    <p>{t('status')}: {String(selected.status || '').toUpperCase() || '—'}</p>
                    {normalizePayMethod(selected.paymentMethod) === 'TRANSFER' && selected.paymentAccountSnapshot && (
                      <p>{selected.paymentAccountSnapshot.bankName} {selected.paymentAccountSnapshot.ownerName} {selected.paymentAccountSnapshot.accountNumber}</p>
                    )}
                    {selected.waiterName && (
                      <p>{t('cashierServedBy')}: {selected.waiterName}{selected.waiterNumber != null ? ` #${selected.waiterNumber}` : ''}</p>
                    )}
                  </div>
                  <p>--------------------------------</p>
                  <div className="bono-ticket-block" style={{ textAlign: 'center' }}>
                    <p>{t('cashierThanks')}</p>
                  </div>
                  <p>--------------------------------</p>
                </div>
              )}
            </>
          )}
        </section>
      </main>

    </div>
  );
}
