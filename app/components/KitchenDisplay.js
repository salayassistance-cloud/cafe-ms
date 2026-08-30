'use client';

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { safeFetchJson, updateOrderStatusClient } from '@/lib/clientFetch';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useOrderEvents } from '@/lib/orderEvents';
import LanguageToggle from '@/app/components/LanguageToggle';
import SettingsGear from '@/app/components/SettingsGear';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';
import { useLanguage } from '@/app/components/LanguageProvider';

const FALLBACK_POLL_MS = 30000;
const TICK_MS = 1000;
const NEW_FLASH_MS = 6000;

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function priorityOf(ms) {
  if (ms < 5 * 60 * 1000) return 'green';
  if (ms < 10 * 60 * 1000) return 'yellow';
  return 'red';
}

const PRIORITY = {
  green: { text: 'text-[#C9A900] dark:text-[#FF8A3D]' },
  yellow: { text: 'text-[#FFD600] dark:text-[#FF5E00]' },
  red: { text: 'text-[#1E293B] dark:text-white bg-[#FFD600] dark:bg-[#FF5E00] animate-pulse px-1.5 py-0.5 rounded' },
};

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

function statusBadge(status, t) {
  switch (status) {
    case 'PENDING':
      return { label: t('waiting'), cls: 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#64748B] dark:text-[#94A3B8] border border-[#E2E8F0] dark:border-[#2A2B36]' };
    case 'PREPARING':
      return { label: t('preparing'), cls: 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white font-black shadow-sm' };
    case 'READY':
      return { label: t('ready'), cls: 'bg-[rgba(255,214,0,0.12)] dark:bg-[rgba(255,94,0,0.12)] text-[#8A6D00] dark:text-[#FF8A3D] border border-[#FFD600]/20 dark:border-[#FF5E00]/20' };
    default:
      return { label: '', cls: '' };
  }
}

function emptyStateFor(station, t) {
  const isBarista = station === 'DRINK';
  return {
    title: t('emptyTitle'),
    sub: isBarista ? t('emptySubBarista') : t('emptySubKitchen'),
    glyph: isBarista ? '☕' : '🍽️',
  };
}

function BoardSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={`sk-${i}`}
          className="rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-4 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="h-7 w-28 animate-pulse rounded bg-[#F4F5F9] dark:bg-[#2A2B36]" />
              <div className="h-3 w-44 animate-pulse rounded bg-[#F4F5F9] dark:bg-[#2A2B36]/60" />
              <div className="h-3 w-24 animate-pulse rounded bg-[#F4F5F9] dark:bg-[#2A2B36]/40" />
            </div>
            <div className="h-8 w-16 animate-pulse rounded bg-[#FFD600]/20 dark:bg-[#FF5E00]/20" />
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-10 animate-pulse rounded-lg bg-[#F4F5F9] dark:bg-[#12131A]" />
            <div className="h-10 animate-pulse rounded-lg bg-[#F4F5F9] dark:bg-[#12131A]" />
          </div>
          <div className="mt-4 h-11 animate-pulse rounded-xl bg-[#FFD600]/10 dark:bg-[#FF5E00]/10" />
        </div>
      ))}
    </div>
  );
}

export default function KitchenDisplay({
  station = 'FOOD',
  stationLabel = 'KITCHEN ONLY',
  title = 'KDS · HOTEL MANAGEMENT SYSTEM',
}) {
  const [view] = useState(station);
  const VIEWS = [{ key: station, label: stationLabel }];


  const { t } = useLanguage();

  const hasMounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const [orders, setOrders] = useState([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [connError, setConnError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [newIds, setNewIds] = useState(() => new Set());
  const [confirmingId, setConfirmingId] = useState(null);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [actionError, setActionError] = useState("");

  const audioCtxRef = useRef(null);
  const seenIdsRef = useRef(new Set());
  const mutedRef = useRef(muted);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const playChime = useCallback(() => {
    const Ctx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!Ctx) return;
    let ctx = audioCtxRef.current;
    if (!ctx) {
      try {
        ctx = new Ctx();
        audioCtxRef.current = ctx;
      } catch {
        return;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    [880, 1320, 1760].forEach((freq, i) => {
      const start = t0 + i * 0.14;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.45);
    });
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      // Station-specific fetch: FOOD=Kitchen, DRINK=Barista via dest param (server filters items.type)
      // This prevents Kitchen seeing DRINK-only work and vice versa, and reduces payload.
      const dest = view === 'DRINK' ? 'DRINK' : view === 'FOOD' ? 'FOOD' : 'ALL';
      const url = dest === 'ALL' ? '/api/orders?status=ACTIVE' : `/api/orders?status=ACTIVE&dest=${dest}`;
      const data = await safeFetchJson(url, { cache: 'no-store' });
      if (!data.success) throw new Error('bad body');
      const incoming = Array.isArray(data.data?.orders) ? data.data.orders : [];

      const prevSeen = seenIdsRef.current;
      for (const o of incoming) {
        if (!prevSeen.has(o._id) && !mutedRef.current) {
          playChime();
          setNewIds((s) => new Set(s).add(o._id));
          setTimeout(() => {
            setNewIds((s) => {
              const n = new Set(s);
              n.delete(o._id);
              return n;
            });
          }, NEW_FLASH_MS);
        }
      }

      const nextSeen = new Set();
      for (const o of incoming) nextSeen.add(o._id);
      seenIdsRef.current = nextSeen;

      setOrders(incoming);
      setConnError(false);
    } catch (err) {
      if (err && err.status === 401) {
        setActionError("Your session has expired. Please sign in again.");
        setTimeout(() => { try { window.location.assign(view === 'DRINK' ? '/barista' : '/kds'); } catch {} }, 1500);
        setConnError(true);
      } else if (err && err.status === 403) {
        setActionError("Your account does not have permission to perform this action.");
        setConnError(false);
        setTimeout(() => setActionError(""), 4000);
      } else if (err && (err.status === 503 || /service.*unavailable|database/i.test(err?.message || ""))) {
        setConnError(true);
      } else {
        setConnError(true);
      }
    } finally {
      setInitialLoading(false);
    }
  }, [playChime, view]);

  const refreshTimer = useRef(null);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(fetchOrders, 150);
  }, [fetchOrders]);

  // Only order events should trigger an order refresh — menu-changed (and any
  // other future event) must not cause redundant KDS/Barista order refetches.
  useOrderEvents((event) => {
    if (event && (event.type === "orders-changed" || event.type === "ORDER_READY")) {
      scheduleRefresh();
    }
  });

  useEffect(() => {
    const t = setTimeout(fetchOrders, 0);
    return () => clearTimeout(t);
  }, [fetchOrders]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchOrders();
    }, FALLBACK_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchOrders();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchOrders]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const updateOrder = useCallback(async (orderId, status, waiterInfo) => {
    if (pendingIds.has(orderId)) return;
    setPendingIds((s) => new Set(s).add(orderId));
    setActionError("");
    // Optimistic: immediately show target status on the per-station field
    const prevOrdersRef = { current: null };
    setOrders((prev) => {
      prevOrdersRef.current = prev;
      return prev.map((o) => {
        if (o._id !== orderId) return o;
        // Keep optimistic in sync with station status for immediate UI
        const next = { ...o, status };
        if (view === 'DRINK') next.baristaStatus = status;
        else next.kitchenStatus = status;
        return next;
      });
    });
    try {
      const data = await updateOrderStatusClient(
        orderId,
        status,
        waiterInfo ? { waiterInfo } : {}
      );
      if (!data.success) throw new Error(data.error || data.message || "Update failed");
      const updated = data.data?.order;
      if (updated) {
        setOrders((prev) => prev.map((o) => (o._id === orderId ? { ...o, ...updated } : o)));
      }
    } catch (err) {
      // Revert optimistic on failure
      if (prevOrdersRef.current) setOrders(prevOrdersRef.current);
      if (err && err.status === 401) setActionError("Your session has expired. Please sign in again.");
      else if (err && err.status === 403) setActionError("Your account does not have permission to perform this action.");
      else if (err && err.status === 503) setActionError("Service temporarily unavailable. Please try again.");
      else setActionError(err?.message || "Failed to update order. Please retry.");
      setTimeout(() => setActionError(""), 4000);
    } finally {
      setPendingIds((s) => {
        const n = new Set(s);
        n.delete(orderId);
        return n;
      });
    }
  }, [pendingIds, view]);

  const handleArchiveOrder = useCallback(async (orderId) => {
    if (pendingIds.has(orderId)) return;
    setPendingIds((s) => new Set(s).add(orderId));
    const prevRef = { current: null };
    setOrders((prev) => {
      prevRef.current = prev;
      return prev.filter((o) => o._id !== orderId);
    });
    seenIdsRef.current.delete(orderId);
    try {
      const data = await updateOrderStatusClient(orderId, 'ARCHIVED');
      if (!data?.success) throw new Error(data.error || data.message || "Archive failed");
      setConfirmingId((cur) => (cur === orderId ? null : cur));
    } catch (err) {
      if (prevRef.current) setOrders(prevRef.current);
      setActionError(err?.message || "Failed to archive. Please retry.");
      setTimeout(() => setActionError(""), 3000);
    } finally {
      setPendingIds((s) => {
        const n = new Set(s);
        n.delete(orderId);
        return n;
      });
    }
  }, [pendingIds]);

  const visibleOrders = orders.filter((o) =>
    view === 'ALL' ? true : o.items.some((it) => it.type === view)
  );
  const offline = connError;

  function renderItems(items, view) {
    if (!items || items.length === 0) return null;
    // Only render items belonging to THIS station (FOOD=Kitchen, DRINK=Barista).
    const relevant = items.filter((it) => it.type === view);
    if (relevant.length === 0) return null;
    return (
      <ul className="mt-3 space-y-2">
        {relevant.map((it, i) => (
          <li
            key={`it-${i}`}
            className="flex items-start gap-3 rounded-lg border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-2 py-2 text-lg"
          >
            <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] px-2 text-base font-black text-[#1E293B] dark:text-white">
              {it.quantity}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-[#1E293B] dark:text-white">
                {getLocalizedSingleString(it.name)}
              </p>
              <p className="text-xs uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
                {it.type}
              </p>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  function renderTicket(order, idx) {
    const created = order.createdAt ? new Date(order.createdAt).getTime() : now;
    const elapsed = now - created;
    const prio = priorityOf(elapsed);
    const p = PRIORITY[prio];
    const isNew = newIds.has(order._id);
    // Per-station status — Kitchen shows kitchenStatus, Barista shows baristaStatus.
    // For mixed orders this keeps each station's preparation state independent.
    const stationStatus =
      view === "DRINK"
        ? order.baristaStatus || order.status
        : order.kitchenStatus || order.status;
    const badge = statusBadge(stationStatus, t);

    return (
      <article
        key={`ticket-${order._id}`}
        style={{ '--stagger-index': Math.min(idx, 12) }}
        className={`  rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-4 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:shadow-[0_14px_30px_-5px_rgba(0,0,0,0.08),0_10px_12px_-6px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_16px_36px_rgba(0,0,0,0.55)]   active:shadow-inner ${
          isNew ? 'ring-2 ring-[#FFD600]/40 dark:ring-[#FF5E00]/40' : ''
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-2xl font-extrabold leading-none text-[#FFD600] dark:text-[#FF5E00]">
              {t('table')} {order.tableNumber}
            </p>
            <p className="mt-1 text-sm text-[#64748B] dark:text-[#94A3B8]">
              {t('waiterLabel')} {order.waiterName || 'Staff'}
            </p>
            {order.waiterNumber != null && (
              <p className="mt-1 inline-flex w-fit items-center gap-1 rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-2 py-0.5 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">
                👤 Waiter {order.waiterNumber}
              </p>
            )}
            <p className="text-xs text-[#94A3B8]">{order.orderNumber}</p>
          </div>
          <div className="flex items-start gap-2">
            <div className="text-right">
              <p className={`text-2xl font-extrabold tabular-nums ${p.text}`}>
                {fmtElapsed(elapsed)}
              </p>
              <p className="text-xs text-[#64748B] dark:text-[#94A3B8]">{t('elapsed')}</p>
            </div>
            <button
              type="button"
              onClick={() =>
                confirmingId === order._id
                  ? handleArchiveOrder(order._id)
                  : setConfirmingId(order._id)
              }
              title={t('removeTitle')}
              aria-label={t('removeTitle')}
              className={`rounded-lg px-2 py-1 text-sm font-black leading-none transition-all duration-150 ease-out     ${
                confirmingId === order._id
                  ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm'
                  : 'bg-[#F4F5F9] dark:bg-[#12131A] text-[#94A3B8] hover:text-[#FFD600] dark:hover:text-[#FF5E00] border border-[#E2E8F0]/60 dark:border-[#2A2B36]'
              }`}
            >
              {confirmingId === order._id ? t('confirm') : '✕'}
            </button>
          </div>
        </div>

        {renderItems(order.items, view)}

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
            {t('order')}
          </span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badge.cls}`}>
            {badge.label}
          </span>
        </div>

        <div className="mt-2 flex gap-2">
          {stationStatus === 'PENDING' && (
            <button
              type="button"
              onClick={() => updateOrder(order._id, 'PREPARING')}
              disabled={pendingIds.has(order._id)}
              className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-base font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pendingIds.has(order._id) ? "PREPARING..." : t('startPrep')}
            </button>
          )}
          {stationStatus === 'PREPARING' && (
            <button
              type="button"
              onClick={() => updateOrder(order._id, 'READY', order.waiterInfo)}
              disabled={pendingIds.has(order._id)}
              className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-base font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pendingIds.has(order._id) ? "UPDATING..." : t('markReady')}
            </button>
          )}
          {stationStatus === 'READY' && (
            <div className="flex-1 rounded-xl border border-[#FFD600]/20 dark:border-[#FF5E00]/20 bg-[rgba(255,214,0,0.12)] dark:bg-[rgba(255,94,0,0.12)] py-3 text-center text-base font-black text-[#8A6D00] dark:text-[#FF8A3D]">
              {t('awaitingPickup')}
            </div>
          )}
        </div>
        {pendingIds.has(order._id) && stationStatus !== 'READY' && (
          <p className="mt-1 text-center text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">Updating…</p>
        )}
      </article>
    );
  }

  if (!hasMounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F4F5F9] dark:bg-[#12131A] text-[#1E293B] dark:text-white">
        <div className="font-bold text-[#FFD600] dark:text-[#FF5E00]">
          Loading {title.split(' · ')[0]} Terminal…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] text-[#1E293B] dark:text-white">
      <header className="sticky top-0 z-30 bg-[#FFDC00] dark:bg-transparent border-b border-[#E2E8F0]/60 dark:border-transparent dark:border-none px-4 py-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-none backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ThemeToggleHome />
            <div>
              <h1 className="text-xl font-extrabold tracking-wide text-[#1E293B] dark:text-white">
                {title}
              </h1>
              <p className="text-xs text-[#1E293B]/70 dark:text-[#94A3B8]">
                {visibleOrders.length} {t('active')} ·{' '}
                <span className={offline ? 'text-[#DC2626] dark:text-[#FF8A3D]' : 'text-[#15803D] dark:text-[#FF5E00]'}>
                  {offline ? t('reconnecting') : t('live')}
                </span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className="rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 py-2 text-sm font-bold text-[#64748B] dark:text-[#94A3B8] shadow-sm transition-all duration-150 ease-out     active:shadow-inner"
            >
              {muted ? t('muted') : t('soundOn')}
            </button>
            {/* Phase 6.6: Kitchen/Barista PIN is managed from /manager/reports — no PIN-change UI here */}
            <SettingsGear title="Change PIN" canChangeOwnPin={false} />
          </div>
        </div>

        <nav className="mt-3 grid grid-cols-1 gap-2">
          {VIEWS.map((v) => (
            <button
              key={`view-${v.key}`}
              type="button"
              aria-pressed="true"
              className="rounded-xl py-3 text-sm font-extrabold bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner"
            >
              {t(station === 'DRINK' ? 'baristaOnly' : 'kitchenOnly')}
            </button>
          ))}
        </nav>
      </header>
      {actionError && (
        <div role="alert" className="mx-4 mt-3 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-center text-xs font-semibold text-[#DC2626]">
          {actionError}
        </div>
      )}

      <main className="p-4">
        {initialLoading ? (
          <BoardSkeleton />
        ) : visibleOrders.length === 0 ? (
          (() => {
            const empty = emptyStateFor(station, t);
            return (
              <div className="rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] py-16 text-center text-sm text-[#64748B] dark:text-[#94A3B8] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
                <span className="block text-3xl" aria-hidden="true">
                  {empty.glyph}
                </span>
                <span className="mt-3 block font-bold text-[#1E293B] dark:text-white">
                  {empty.title}
                </span>
                <span className="mt-1 block text-xs text-[#64748B] dark:text-[#94A3B8]">
                  {empty.sub}
                </span>
              </div>
            );
          })()
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {visibleOrders.map((o, i) => renderTicket(o, i))}
          </div>
        )}
      </main>
    </div>
  );
}
