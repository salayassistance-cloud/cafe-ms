'use client';

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { safeFetchJson, updateOrderStatusClient, getSessionErrorKind, tabLogout } from '@/lib/clientFetch';
import { stationForView, stationStatusOf, stationActionOf, applyStationUpdate } from '@/lib/stationStatus';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useOrderEvents } from '@/lib/orderEvents';
import LanguageToggle from '@/app/components/LanguageToggle';
import SettingsGear from '@/app/components/SettingsGear';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';
import { useLanguage } from '@/app/components/LanguageProvider';
import { formatEthiopianClock } from '@/lib/ethiopianCalendar';
import { playChime, notifyBrowser } from '@/lib/notify';

// Canonical business clock: Ethiopian 12h day + 12h night (Addis-aware).
// `new Date(value)` only wraps an existing UTC instant, never local midnight.
function fmtCancelledClock(value, lang) {
  try {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return formatEthiopianClock(d, lang === 'en' ? 'en' : 'am');
  } catch {
    return '';
  }
}

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


  const { t, lang } = useLanguage();

  const hasMounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const [orders, setOrders] = useState([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [connError, setConnError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [newIds, setNewIds] = useState(() => new Set());
  const [confirmingId, setConfirmingId] = useState(null);
  // Single source of in-flight station-action truth.
  // Key: String(orderId) — value: { station: 'KITCHEN'|'BARISTA', action: 'START_PREP'|'MARK_READY'|'ARCHIVE', targetStatus }.
  // Station is fixed per mount (view), so orderId implies the station, but the
  // meta preserves the exact station+action for deterministic pending labels and
  // to block only this order's station action (never the whole board, never the
  // other station). Render reads the STATE map; callbacks/merge read the REF.
  const [pendingByOrder, setPendingByOrder] = useState(() => new Map());
  const pendingByOrderRef = useRef(new Map());
  const [itemPending, setItemPending] = useState(() => new Set());
  const itemPendingRef = useRef(new Set());
  const [actionError, setActionError] = useState("");
  const ordersRef = useRef([]);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  // AUTH-ARCH-6: explicit session-ended state (revoked/expired/invalid/
  // disabled). While set: authenticated polling stops (no storm), SSE is
  // suspended, stale in-flight results are discarded via authGenRef, and an
  // overlay requires an explicit re-login. Server order data is never
  // touched; no credentials are handled here (PinGuard owns login).
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
    try { window.location.assign(view === 'DRINK' ? '/barista' : '/kds'); } catch {}
  }, [view]);

  const seenIdsRef = useRef(new Set());
  const mutedRef = useRef(muted);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const fetchOrders = useCallback(async () => {
    // Session ended: never fire authenticated refreshes (no retry storm).
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    try {
      // Station-specific fetch: FOOD=Kitchen, DRINK=Barista via dest param (server filters items.type)
      // This prevents Kitchen seeing DRINK-only work and vice versa, and reduces payload.
      const dest = view === 'DRINK' ? 'DRINK' : view === 'FOOD' ? 'FOOD' : 'ALL';
      const url = dest === 'ALL' ? '/api/orders?status=ACTIVE' : `/api/orders?status=ACTIVE&dest=${dest}`;
      const data = await safeFetchJson(url, { cache: 'no-store' });
      // Stale success after revocation must not repopulate the board.
      if (gen !== authGenRef.current) return;
      if (!data.success) throw new Error('bad body');
      const incoming = Array.isArray(data.data?.orders) ? data.data.orders : [];

      const prevSeen = seenIdsRef.current;
      for (const o of incoming) {
        if (!prevSeen.has(o._id)) {
          if (!mutedRef.current) playChime();
          // Background tabs get a system notification where permission exists
          // (permission is granted via an explicit user gesture elsewhere).
          notifyBrowser({
            title: `${o.orderNumber || 'Order'} · Table ${o.tableNumber ?? '—'}`,
            body: `${(o.items || []).length} items · ${stationLabel}`,
            tag: `new-order-${o._id}`,
          });
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

      // Per-order reconciliation: polling/SSE must never regress an in-flight
      // station action with stale data. Only the exact in-flight order keeps its
      // optimistic station field; every other order takes canonical server truth.
      // No global board lock — other orders update normally while one is pending.
      setOrders((prev) => {
        if (pendingByOrderRef.current.size === 0 && itemPendingRef.current.size === 0) {
          return incoming;
        }
        const prevById = new Map();
        for (const o of prev) prevById.set(String(o._id), o);
        return incoming.map((inc) => {
          const pid = String(inc._id);
          const prevOrder = prevById.get(pid);
          if (!prevOrder) return inc;
          let merged = inc;
          const pending = pendingByOrderRef.current.get(pid) || pendingByOrderRef.current.get(inc._id);
          if (pending) {
            const field = pending.station === 'BARISTA' ? 'baristaStatus' : pending.station === 'KITCHEN' ? 'kitchenStatus' : null;
            if (field && prevOrder[field] !== undefined && inc[field] !== prevOrder[field]) {
              merged = { ...merged, [field]: prevOrder[field] };
            }
          }
          if (itemPendingRef.current.size > 0 && Array.isArray(inc.items) && Array.isArray(prevOrder.items)) {
            const prevLineById = new Map();
            for (const it of prevOrder.items) {
              if (it && it.lineId) prevLineById.set(String(it.lineId), it);
            }
            let itemsChanged = false;
            const nextItems = (merged.items || []).map((it) => {
              const lid = it && it.lineId ? String(it.lineId) : null;
              if (!lid || !itemPendingRef.current.has(lid)) return it;
              const prevLine = prevLineById.get(lid);
              if (prevLine && !!it.cancelled !== !!prevLine.cancelled) {
                itemsChanged = true;
                return { ...it, cancelled: prevLine.cancelled, cancelReason: prevLine.cancelReason, cancelledStation: prevLine.cancelledStation };
              }
              return it;
            });
            if (itemsChanged) merged = { ...merged, items: nextItems };
          }
          return merged;
        });
      });
      setConnError(false);
    } catch (err) {
      if (gen !== authGenRef.current) return;
      // Explicit session end enters the re-login state (polling/SSE stop).
      // Transient failures (503/network) keep state and cadence.
      if (getSessionErrorKind(err)) {
        enterSessionEnded();
        setActionError("");
        setConnError(false);
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
  }, [view, stationLabel, enterSessionEnded]);

  const refreshTimer = useRef(null);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(fetchOrders, 150);
  }, [fetchOrders]);

  // Only order events should trigger an order refresh — menu-changed (and any
  // other future event) must not cause redundant KDS/Barista order refetches.
  // SSE suspended while the session is ended (no reconnect until re-login).
  useOrderEvents((event) => {
    if (sessionEndedRef.current) return;
    if (event && (event.type === "orders-changed" || event.type === "ORDER_READY")) {
      scheduleRefresh();
    }
  }, !sessionEnded);

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
    // One action = one in-flight request for this exact order+station.
    // Stable identity is String(orderId); station is fixed per mount (view).
    const pid = String(orderId);
    if (pendingByOrderRef.current.has(pid)) return;
    // Session ended: station must not mutate with a stale identity.
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    // Optimistic: station-SCOPED ONLY — touches this station's status field
    // and nothing else. Overall order.status is left for the server response
    // (canonical derivation); failure reverts. The other station's field is
    // never written, never derived, never copied.
    const stationKey = stationForView(view);
    if (!stationKey) return;
    const action = status === 'PREPARING' ? 'START_PREP' : status === 'READY' ? 'MARK_READY' : null;
    if (!action) return;
    const meta = { station: stationKey, action, targetStatus: status };
    pendingByOrderRef.current.set(pid, meta);
    setPendingByOrder((prev) => new Map(prev).set(pid, meta));
    setActionError("");
    const prevOrdersRef = { current: null };
    setOrders((prev) => {
      prevOrdersRef.current = prev;
      return prev.map((o) => {
        if (String(o._id) !== pid) return o;
        return applyStationUpdate(o, stationKey, status);
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
      // Stale success after revocation: revert optimistic, apply nothing.
      if (gen !== authGenRef.current) {
        if (prevOrdersRef.current) setOrders(prevOrdersRef.current);
        return;
      }
      if (updated) {
        setOrders((prev) => prev.map((o) => (o._id === orderId ? { ...o, ...updated } : o)));
      }
    } catch (err) {
      // Revert optimistic on failure
      if (prevOrdersRef.current) setOrders(prevOrdersRef.current);
      if (getSessionErrorKind(err)) enterSessionEnded();
      else if (err && err.status === 403) setActionError("Your account does not have permission to perform this action.");
      else if (err && err.status === 503) setActionError("Service temporarily unavailable. Please try again.");
      else setActionError(err?.message || "Failed to update order. Please retry.");
      // AUTH-ARCH-11 §21: a valid server state conflict (another actor moved
      // first) reconciles instead of retrying — refetch canonical state once
      // so the now-invalid action disappears. No retry loop is scheduled.
      if (!getSessionErrorKind(err) && err && err.status !== 503 && /station is|no active|already finished|already cancelled|terminal state|Invalid .* request/i.test(err?.message || "")) {
        scheduleRefresh();
      } else {
        setTimeout(() => setActionError(""), 4000);
      }
    } finally {
      pendingByOrderRef.current.delete(pid);
      setPendingByOrder((prev) => {
        const n = new Map(prev);
        n.delete(pid);
        return n;
      });
    }
  }, [view, enterSessionEnded, scheduleRefresh]);

  // Legacy whole-order archive — preserved for history but X now means item Cancel/Reject (not archive).
  // Kept for backward compat; UI no longer uses global archive button.
  // Shares the single pending map so an in-flight station action blocks archive
  // for the same order (and vice versa) without a second duplicate lock.
  const handleArchiveOrder = useCallback(async (orderId) => {
    const pid = String(orderId);
    if (pendingByOrderRef.current.has(pid)) return;
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    const meta = { station: stationForView(view), action: 'ARCHIVE', targetStatus: 'ARCHIVED' };
    pendingByOrderRef.current.set(pid, meta);
    setPendingByOrder((prev) => new Map(prev).set(pid, meta));
    const prevRef = { current: null };
    setOrders((prev) => {
      prevRef.current = prev;
      return prev.filter((o) => String(o._id) !== pid);
    });
    seenIdsRef.current.delete(orderId);
    try {
      const data = await updateOrderStatusClient(orderId, 'ARCHIVED');
      if (!data?.success) throw new Error(data.error || data.message || "Archive failed");
      if (gen !== authGenRef.current) {
        if (prevRef.current) setOrders(prevRef.current);
        return;
      }
      setConfirmingId((cur) => (cur === orderId ? null : cur));
    } catch (err) {
      if (prevRef.current) setOrders(prevRef.current);
      if (getSessionErrorKind(err)) enterSessionEnded();
      else setActionError(err?.message || "Failed to archive. Please retry.");
      setTimeout(() => setActionError(""), 3000);
    } finally {
      pendingByOrderRef.current.delete(pid);
      setPendingByOrder((prev) => {
        const n = new Map(prev);
        n.delete(pid);
        return n;
      });
    }
  }, [enterSessionEnded, view]);

  // Item-level Cancel/Reject — station may cancel only own items, never whole order.
  const [cancelReason, setCancelReason] = useState("");
  const [cancelTarget, setCancelTarget] = useState(null); // {orderId, lineId}
  const handleCancelItem = useCallback(async (orderId, lineId) => {
    if (!lineId) return;
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    const key = String(lineId);
    if (itemPendingRef.current.has(key)) return;
    itemPendingRef.current.add(key);
    setItemPending((s) => new Set(s).add(key));
    setActionError("");
    const reason = cancelReason.trim().slice(0, 200);
    // Optimistic: mark item cancelled locally
    let prevRef = { current: null };
    setOrders((prev) => {
      prevRef.current = prev;
      return prev.map((o) => {
        if (o._id !== orderId) return o;
        return {
          ...o,
          items: (o.items || []).map((it) => {
            const lid = it.lineId ? String(it.lineId) : null;
            if (lid !== key) return it;
            return { ...it, cancelled: true, cancelReason: reason || it.cancelReason, cancelledStation: view === "DRINK" ? "BARISTA" : "KITCHEN" };
          }),
        };
      });
    });
    try {
      const data = await safeFetchJson(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "CANCEL_ITEM", lineId: key, reason: reason || undefined }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || "Cancel failed");
      const updated = data?.data?.order;
      // Stale success after revocation: revert optimistic, apply nothing.
      if (gen !== authGenRef.current) {
        if (prevRef.current) setOrders(prevRef.current);
        return;
      }
      if (updated) {
        setOrders((prev) => prev.map((o) => (o._id === orderId ? { ...o, ...updated } : o)));
        // If all active lines cancelled, order will be status CANCELLED and drop from ACTIVE query on next fetch
        if (updated.status === "CANCELLED") {
          // Keep in list until next fetch for audit visibility, then it will disappear from active view
          setTimeout(() => setOrders((prev) => prev.filter((o) => o._id !== orderId)), 800);
        }
      }
      setCancelTarget(null);
      setCancelReason("");
    } catch (err) {
      if (prevRef.current) setOrders(prevRef.current);
      if (getSessionErrorKind(err)) enterSessionEnded();
      else if (err && err.status === 403) setActionError(err.message || "Forbidden: cannot cancel this item.");
      else if (err && /already finished preparing/i.test(err?.message || "")) setActionError(t('cannotCancelReady'));
      else setActionError(err?.message || "Failed to cancel item. Please retry.");
      // AUTH-ARCH-11 §21: reconcile on state conflicts (already-cancelled /
      // finished lines changed by another actor); never retry the mutation.
      if (!getSessionErrorKind(err) && err && err.status !== 503 && /already cancelled|already finished|not found|terminal state/i.test(err?.message || "")) {
        scheduleRefresh();
      } else {
        setTimeout(() => setActionError(""), 4000);
      }
    } finally {
      itemPendingRef.current.delete(key);
      setItemPending((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }, [cancelReason, view, t, enterSessionEnded, scheduleRefresh]);

  const visibleOrders = orders.filter((o) =>
    view === 'ALL' ? true : o.items.some((it) => it.type === view && !it.cancelled)
  );
  // Also keep orders with only cancelled items of this station for history (faded) — but active view excludes fully cancelled
  const offline = connError;

  // stationLocked: this station already marked its lines READY (or the whole
  // order is READY) — finished lines cannot be cancelled (server enforces too).
  function renderItems(items, view, orderId, stationLocked) {
    if (!items || items.length === 0) return null;
    // Only render items belonging to THIS station (FOOD=Kitchen, DRINK=Barista).
    const relevant = items.filter((it) => it.type === view);
    if (relevant.length === 0) return null;
    return (
      <ul className="mt-3 space-y-2">
        {relevant.map((it, i) => {
          const lineId = it.lineId ? String(it.lineId) : null;
          const isCancelled = !!it.cancelled;
          const isPending = lineId && itemPending.has(lineId);
          return (
          <li
            key={`it-${lineId || i}`}
            className={`flex items-start gap-3 rounded-lg border px-2 py-2 text-lg ${isCancelled ? 'border-[#FECACA] bg-[#FEF2F2] dark:border-[#7F1D1D] dark:bg-[#1C1D24] opacity-75' : 'border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A]'}`}
          >
            <span className={`flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg px-2 text-base font-black ${isCancelled ? 'bg-[#FECACA] text-[#991B1B] dark:bg-[#7F1D1D] dark:text-white' : 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white'}`}>
              {it.quantity}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`truncate font-semibold ${isCancelled ? 'text-[#991B1B] dark:text-[#FCA5A5] line-through' : 'text-[#1E293B] dark:text-white'}`}>
                {getLocalizedSingleString(it.name)}
              </p>
              <p className="text-xs uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
                {it.type}{isCancelled && it.cancelReason ? ` · ${it.cancelReason}` : ""}
              </p>
              {isCancelled && (
                <p className="text-xs text-[#991B1B] dark:text-[#FCA5A5]">Cancelled{it.cancelledStation ? ` by ${it.cancelledStation}` : ""}{it.cancelledAt ? ` ${fmtCancelledClock(it.cancelledAt, lang)}` : ""}</p>
              )}
              {Array.isArray(it.components) && it.components.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {it.components.map((c, ci) => (
                    <li key={`${lineId || i}-comp-${ci}`} className={`truncate text-xs ${c.kind === "NOTE" ? "text-[#92400E] dark:text-[#FDBA74] italic" : "font-medium text-[#1E293B] dark:text-white"}`}>
                      {c.kind === "NOTE" ? `📝 ${c.note}` : `➕ ${c.name} ×${c.quantity} @ ${c.unitPrice} ETB = ${c.lineSum ?? Math.round(c.quantity * c.unitPrice * 100) / 100} ETB`}
                      {c.kind === "PRICED_COMPONENT" && c.inventoryItemId ? <span className="ml-1 text-[10px] text-[#64748B] dark:text-[#94A3B8]">· linked</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!isCancelled && !stationLocked ? (
              lineId ? (
                cancelTarget && cancelTarget.lineId === lineId && cancelTarget.orderId === orderId ? (
                  <div className="flex shrink-0 flex-col gap-1">
                    <input autoFocus type="text" placeholder="Reason (optional)" value={cancelReason} onChange={(e)=>setCancelReason(e.target.value)} maxLength={200} className="w-28 rounded-lg border border-[#FECACA] bg-white px-2 py-1 text-xs text-[#1E293B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-1 focus:ring-[#FCA5A5]" />
                    <div className="flex gap-1">
                      <button type="button" onClick={()=>handleCancelItem(orderId, lineId)} disabled={isPending} className="rounded-lg bg-[#DC2626] px-2 py-1 text-xs font-black text-white disabled:opacity-50">{isPending ? "..." : "Confirm"}</button>
                      <button type="button" onClick={()=>{setCancelTarget(null); setCancelReason("");}} className="rounded-lg border border-[#E2E8F0] bg-white px-2 py-1 text-xs font-bold text-[#64748B]">✕</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={()=>{setCancelTarget({orderId, lineId}); setCancelReason("");}} disabled={isPending} className="shrink-0 rounded-lg border border-[#FECACA] bg-white px-2 py-1 text-xs font-black text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50" title="Cancel this item">Cancel</button>
                )
              ) : (
                <span className="shrink-0 rounded-lg bg-[#F4F5F9] px-2 py-1 text-xs font-bold text-[#94A3B8]">Legacy</span>
              )
            ) : isCancelled ? (
              <span className="shrink-0 rounded-full bg-[#FECACA] px-2 py-1 text-xs font-black text-[#991B1B] dark:bg-[#7F1D1D] dark:text-white">Cancelled</span>
            ) : null}
          </li>
          );
        })}
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
    // FORCEFUL SEPARATION: overall order.status is NEVER consulted here — it can
    // reflect the OTHER station's progress (e.g. PREPARING after Kitchen's Start
    // Prep while Barista is still PENDING). Missing station state means PENDING,
    // identical to the server's null-as-not-started semantics.
    const stationKey = stationForView(view);
    const stationStatus = stationKey ? stationStatusOf(order, stationKey) : (order.status || 'PENDING');
    // UI parity with the server active-line definition (see visibleOrders):
    // Start/Ready require at least one active line for this station, so a stale
    // ticket left on screen after EDIT_ITEMS removes the last station line
    // offers no action. Cancel behavior is untouched (J.4 rules intact).
    // Active-line gating lives inside stationActionOf (no action without work).
    const stationAction = stationKey ? stationActionOf(order, stationKey) : null;
    const badge = statusBadge(stationStatus, t);
    // Exact in-flight identity for this ticket: String(orderId) in the single
    // pending map. Never array index / item name / table number.
    const pendingInfo = pendingByOrder.get(String(order._id));
    const isPending = !!pendingInfo;
    const stationShort = stationKey === 'BARISTA' ? 'Barista' : 'Kitchen';
    const pendingLabel = !pendingInfo
      ? null
      : pendingInfo.action === 'START_PREP'
        ? 'Starting…'
        : pendingInfo.action === 'MARK_READY'
          ? 'Marking Ready…'
          : 'Saving…';

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
          </div>
        </div>

        {renderItems(
          order.items,
          view,
          order._id,
          stationStatus === 'READY'
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
            {stationShort} · {t('order')}
          </span>
          <span
            title={`${stationShort} ${stationStatus}`}
            aria-label={`${stationShort} ${badge.label}`}
            className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badge.cls}`}
          >
            {badge.label}
          </span>
        </div>

        <div className="mt-2 flex gap-2">
          {isPending ? (
            <button
              type="button"
              disabled
              aria-live="polite"
              aria-label={`${stationShort} ${pendingLabel}`}
              className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-base font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {pendingLabel}
            </button>
          ) : (
            <>
              {stationAction === 'START_PREP' && (
                <button
                  type="button"
                  onClick={() => updateOrder(order._id, 'PREPARING')}
                  className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-base font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('startPrep')}
                </button>
              )}
              {stationAction === 'MARK_READY' && (
                <button
                  type="button"
                  onClick={() => updateOrder(order._id, 'READY', order.waiterInfo)}
                  className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-base font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('markReady')}
                </button>
              )}
            </>
          )}
          {stationStatus === 'READY' && !isPending && (
            <div className="flex-1 rounded-xl border border-[#FFD600]/20 dark:border-[#FF5E00]/20 bg-[rgba(255,214,0,0.12)] dark:bg-[rgba(255,94,0,0.12)] py-3 text-center text-base font-black text-[#8A6D00] dark:text-[#FF8A3D]">
              {t('awaitingPickup')}
            </div>
          )}
        </div>
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
      {/* AUTH-ARCH-6: explicit session-ended state. Blocks station actions
          until re-login (existing PinGuard flow). No credentials handled here,
          nothing auto-submitted, no order state touched. */}
      {sessionEnded && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/40 dark:bg-[#12131A]/80 px-4 py-6" role="alertdialog" aria-modal="true" aria-label="Session ended">
          <div className="w-full max-w-sm rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-6 text-center shadow-[0_10px_25px_-5px_rgba(0,0,0,0.15)]">
            <h2 className="text-lg font-extrabold tracking-tight text-[#1E293B] dark:text-white">
              Session ended
            </h2>
            <p className="mt-2 text-sm font-medium text-[#64748B] dark:text-[#94A3B8]">
              Please sign in again to continue.
            </p>
            <button
              type="button"
              onClick={signInAgain}
              className="mt-5 flex h-12 w-full items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner"
            >
              Sign in again
            </button>
          </div>
        </div>
      )}
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

      {/* Status summary — read-only, derived from already-fetched visibleOrders.
          Station-scoped like the ticket buttons: overall order.status is never
          consulted, so one station's progress cannot inflate the other's counts. */}
      {(() => {
        const summaryStation = stationForView(view);
        const counts = (() => {
          let newOrders = 0, inProgress = 0, ready = 0;
          for (const o of visibleOrders) {
            const st = summaryStation ? stationStatusOf(o, summaryStation) : (o.status || 'PENDING');
            if (st === 'PENDING') newOrders++;
            else if (st === 'PREPARING') inProgress++;
            else if (st === 'READY') ready++;
          }
          return { newOrders, inProgress, ready };
        })();
        return (
          <section aria-label="Order status summary" className="mx-4 mt-3 grid grid-cols-3 gap-3">
            <div className="rounded-2xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-3 text-center shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">{t('newOrders')}</p>
              <p className="mt-1 text-2xl font-black text-[#1E293B] dark:text-white">{counts.newOrders}</p>
            </div>
            <div className="rounded-2xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-3 text-center shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">{t('inProgress')}</p>
              <p className="mt-1 text-2xl font-black text-[#1E293B] dark:text-white">{counts.inProgress}</p>
            </div>
            <div className="rounded-2xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-3 text-center shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">{t('ready')}</p>
              <p className="mt-1 text-2xl font-black text-[#1E293B] dark:text-white">{counts.ready}</p>
            </div>
          </section>
        );
      })()}

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
