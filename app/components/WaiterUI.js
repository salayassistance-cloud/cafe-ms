'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { safeFetchJson, sendOrder, updateOrderStatusClient, getSessionErrorKind, tabLogout } from '@/lib/clientFetch';
import { playChime, notifyBrowser, ensureBrowserNotifyPermission } from '@/lib/notify';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useOrderEvents } from '@/lib/orderEvents';
import MenuItemImage from '@/app/components/MenuItemImage';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';

const TABLE_NUMBERS = Array.from({ length: 50 }, (_, i) => i + 1);

const LANGUAGES = [
  { code: 'am', label: 'አማርኛ' },
  { code: 'en', label: 'English' },
  { code: 'om', label: 'Oromia' },
];

const LABELS = {
  all: { am: 'ሁሉንም', en: 'All', om: 'Hunda' },
  empty: { am: 'ምንም ምግቦች አልተገኙም', en: 'No items found', om: 'Nyaanni hin argamne' },
  add: { am: 'ጨምር', en: 'Add', om: 'Iduu' },
  cart: { am: 'ጋሪ', en: 'Cart', om: 'Kaartaa' },
  send: { am: 'ትይዩ', en: 'Send Order', om: 'Ajaja Erguu' },
  table: { am: 'ጠረጴዛ', en: 'Table', om: 'Teebuu' },
  inStock: { am: 'በክምችት ላይ ያለ', en: 'In Stock', om: 'Ku jira' },
  outStock: { am: 'ያለቀ', en: 'Out of Stock', om: 'Dhuma' },
  ordered: { am: 'ትዕዛዙ ተልኳል!', en: 'Order sent!', om: 'Ajajni ergame!' },
  sortDefault: { am: 'ነባሪ', en: 'Default', om: 'Durtii' },
  sortPrice: { am: 'ዋጋ፡ ከዝቅተኛ ወደ ከፍተኛ', en: 'Price: Low → High', om: 'Gatii: Xiqqaa → Guddaa' },
  sortAlpha: { am: 'ከሀ እስከ ፐ', en: 'A → Z', om: 'A → Z' },
  filter: { am: 'አጣራ እና ደርድር', en: 'Filter & Sort', om: 'Filtar' },
  sortLabel: { am: 'ቅደም ተከተል', en: 'Sort', om: 'Tartiba' },
  activeOrders: { am: 'ንቁ ትዕዛዞች', en: 'Active Orders', om: 'Ajajoota Hojii' },
  refresh: { am: 'አድስ', en: 'Refresh', om: 'Haaraa' },
  close: { am: 'ዝጋ', en: 'Close', om: 'Cufi' },
  noOrders: { am: 'ንቁ ትዕዛዞች የሉም', en: 'No active orders', om: 'Ajajoota hojii hin jiran' },
  kitchen: { am: 'ኩሽና', en: 'Kitchen', om: 'Kichina' },
  barista: { am: 'ባሪስታ', en: 'Barista', om: 'Barista' },
  paymentTitle: { am: 'የክፍያ መንገድ ይምረጡ', en: 'Select Payment Method', om: 'Karaa Kaffaltii Filadhu' },
  cash: { am: 'ጥሬ ገንዘብ', en: 'Cash', om: 'Maallaqa' },
  transfer: { am: 'በባንክ/ትራንስፈር', en: 'Bank / Transfer', om: 'Baankii' },
  paidToast: { am: 'ክፍያው በተካሄደ ተጠናቋል!', en: 'Payment completed!', om: 'Kaffaltiin xumurame!' },
  payError: { am: 'ክፍያው አልተሳካም', en: 'Payment failed', om: 'Kaffaltiin hin milkoofne' },
  orderError: { am: 'ትዕዛዙ መላክ አልተሳካም፣ እባክዎ ደግመው ይሞክሩ', en: 'Order submission failed', om: 'Ajajni erguun hin milkoofne' },
  cancel: { am: 'ሰርዝ', en: 'Cancel', om: 'Haqi' },
  addExternal: { am: 'የውጭ እቃ/ምግብ ጨምር', en: 'External Request', om: 'Kabaa dabali' },
  extName: { am: 'የእቃ ስም', en: 'Item Name', om: 'Maqaa' },
  extPrice: { am: 'ዋጋ', en: 'Price', om: 'Gatii' },
  extSaved: { am: 'የውጭ እቃ ተጨምሯል', en: 'External item added', om: 'Kaba dabalame' },
  required: { am: 'አስፈላጊ ነው', en: 'is required', om: 'bara' },
  add: { am: 'ጨምር', en: 'Add', om: 'Dabali' },
  edit: { am: 'አርትዕ', en: 'Edit', om: 'Sirreessi' },
  cancelOrder: { am: 'ትዕዛዝ ሰርዝ', en: 'Cancel Order', om: 'Ajaja Haqi' },
  tapAgain: { am: 'እርግጠኛ ነዎት? እንደገና ይጫኑ', en: 'Sure? Tap again to confirm', om: 'Irra deebi tuqi' },
  cancelFailed: { am: 'መሰረዝ አልተሳካም', en: 'Cancel failed', om: 'Haqni hin milkoofne' },
  save: { am: 'አስቀምጥ', en: 'Save', om: "Olkaa'i" },
  remove: { am: 'አስወግድ', en: 'Remove', om: 'Kaasi' },
  addItem: { am: 'እቃ ጨምር', en: 'Add Item', om: 'Meeshaa Dabali' },
  note: { am: 'ማስታወሻ', en: 'Note', om: 'Yaada' },
  qty: { am: 'ብዛት', en: 'Qty', om: 'Baayyina' },
  orderLocked: { am: 'ዝግጅት ተጀምሯል፤ ማርትዕ አይቻልም', en: 'Preparation started — editing locked', om: 'Qophi jalqabe — fooyyessi hin dandaamu' },
  editFailed: { am: 'ማርትዕ አልተሳካም', en: 'Edit failed', om: 'Fooyyessi hin milkoofne' },
  editSaved: { am: 'ትዕዛዙ ተስተካክሏል', en: 'Order updated', om: 'Ajajni haaromfame' },
  alertsOn: { am: 'ማሳወቂያ በርቷል', en: 'Alerts On', om: 'Beeksisni ban' },
  alertsOff: { am: 'ማሳወቂያ ዝግ ነው', en: 'Alerts Off', om: 'Beeksisni cufame' },
  notifReady: { am: 'ዝግጁ ነው', en: 'is ready', om: 'qophaawe' },
  notifCancelled: { am: 'ተሰርዟል', en: 'cancelled', om: 'haqame' },
  sessionEnded: { am: 'ክፍለ-ጊዜው አብቅቷል', en: 'Session ended', om: 'Yeroon dhumate' },
  sessionEndedBody: { am: 'እባክዎ እንደገና ይግቡ።', en: 'Please sign in again to continue.', om: 'Maaloo akka itti fufitaniif irra deebiʼi seenaa.' },
  sessionDisabledBody: { am: 'መለያዎ ንቁ አይደለም። እባክዎ ሥራ አስኪያጁን ያነጋግሩ።', en: 'Your account is inactive. Please contact the manager.', om: 'Herregni kee hin hojjenne. Maaloo abbaa hojii qunnami.' },
  signInAgain: { am: 'እንደገና ይግቡ', en: 'Sign in again', om: 'Irra deebiʼi seeni' },
};

const STATUS_BADGE = {
  PENDING: 'bg-[rgba(255,214,0,0.12)] text-[#8A6D00] dark:bg-[rgba(255,94,0,0.12)] dark:text-[#FF8A3D] border border-[#FFD600]/20 dark:border-[#FF5E00]/20',
  PREPARING: 'bg-white text-[#64748B] dark:bg-[#1C1D24] dark:text-[#94A3B8] border border-[#E2E8F0] dark:border-[#2A2B36]',
  READY: 'bg-[#FFD600] text-[#1E293B] dark:bg-[#FF5E00] dark:text-white shadow-sm',
  SERVED: 'bg-[#F4F5F9] text-[#475569] dark:bg-[#12131A] dark:text-[#94A3B8] border border-[#E2E8F0]/60 dark:border-[#2A2B36]',
  PAYMENT_PENDING: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#7C2D12] dark:text-[#FDBA74] border border-[#FDE68A] dark:border-[#7C2D12]',
  PAID: 'bg-[#1E293B] text-white dark:bg-white dark:text-[#12131A]',
};

const SORT_MODES = ['default', 'price', 'alpha'];

function buildSearchHaystack(item) {
  const name = item.name || {};
  return [
    name.am,
    name.en,
    name.om,
    item.title,
    item.titleAmharic,
    typeof item.title === 'string' ? item.title : '',
    item.description,
    typeof item.description === 'string' ? item.description : '',
    item.category,
    item.categorySlug,
    item.categoryName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function localizedName(item, lang) {
  return (
    getLocalizedSingleString(item?.name, lang) ||
    getLocalizedSingleString(item?.title, lang)
  );
}
function localizedDesc(item, lang) {
  const obj =
    item?.description && typeof item.description === 'object'
      ? item.description
      : { en: item?.descriptionEn, am: item?.descriptionAm, om: item?.descriptionOm };
  return getLocalizedSingleString(obj, lang);
}

const SKELETON_COUNT = 8;
// Phase 5: SSE-first — fallback 30s (was 10s), menu 60s (was 15s). Reduces ~12 req/min → ~4 req/min per waiter.
const ORDERS_FALLBACK_POLL_MS = 30000;
const MENU_FALLBACK_POLL_MS = 60000;

export default function WaiterUI() {
  const router = useRouter();
  const t = (key) => LABELS[key]?.[lang] || LABELS[key]?.en || '';

  const [lang, setLang] = useState('am');
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const langBtnRef = useRef(null);
  const [selectedTable, setSelectedTable] = useState(1);
  const [waiterName, setWaiterName] = useState('Waiter');
  const [waiterId, setWaiterId] = useState(null);

  // Mount-time identity load lives below (after the AUTH-ARCH-5 session
  // helpers) so declarations textually precede uses.

  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState('default');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const [loading, setLoading] = useState(true);

  const [cart, setCart] = useState({});
  const [cartOpen, setCartOpen] = useState(false);
  const [cartBump, setCartBump] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [orderDone, setOrderDone] = useState(null);
  const [orderError, setOrderError] = useState('');

  // Components per cart line — Type A NOTE (no price) and Type B PRICED_COMPONENT (billable)
  const [editingComponent, setEditingComponent] = useState(null); // { cartKey, kind: "NOTE"|"PRICED" }
  const [compNote, setCompNote] = useState('');
  const [compName, setCompName] = useState('');
  const [compQty, setCompQty] = useState('1');
  const [compPrice, setCompPrice] = useState('');
  const [compError, setCompError] = useState('');

  const [readyToasts, setReadyToasts] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const [ordersDrawerOpen, setOrdersDrawerOpen] = useState(false);
  const ordersDrawerOpenRef = useRef(false);

  const [payTarget, setPayTarget] = useState(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState('');
  const [paymentToast, setPaymentToast] = useState('');
  // Transfer accounts from existing PaymentInfo source — active only, no hardcoded values
  const [paymentAccounts, setPaymentAccounts] = useState([]);
  const [selectedTransferAccount, setSelectedTransferAccount] = useState(null);
  const [paymentAccountsLoading, setPaymentAccountsLoading] = useState(false);

  useEffect(() => {
    if (!payTarget) {
      // Defer to next microtask to avoid setState-in-effect cascading (behavior preserved before paint)
      queueMicrotask(() => setSelectedTransferAccount(null));
      return;
    }
    let cancelled = false;
    const loadPaymentAccounts = async () => {
      // Subscription pattern: set loading inside async callback, not direct effect body
      if (!cancelled) setPaymentAccountsLoading(true);
      try {
        const data = await safeFetchJson('/api/payment-info', { cache: 'no-store' });
        if (cancelled) return;
        const list = data?.data?.paymentInfos || data?.paymentInfos || data?.paymentInfo || [];
        const active = (Array.isArray(list) ? list : []).filter((a) => a.isActive !== false);
        setPaymentAccounts(active);
        if (active.length === 1) setSelectedTransferAccount(String(active[0]._id || active[0].id));
        else setSelectedTransferAccount(null);
      } catch {
        if (!cancelled) setPaymentAccounts([]);
      } finally {
        if (!cancelled) setPaymentAccountsLoading(false);
      }
    };
    loadPaymentAccounts();
    return () => {
      cancelled = true;
    };
  }, [payTarget]);

  // Favorites — per-waiter localStorage, store only IDs, re-resolved against current menu
  // Browser-local, does not sync across devices. Keyed by staffId to isolate waiters on same browser.
  const [favorites, setFavorites] = useState(() => new Set());
  const favoritesLoadedRef = useRef(null);
  const FAVORITES_KEY_PREFIX = 'bono_waiter_favorites:';

  // Fully-cancelled orders are never shown to the waiter: an order whose
  // every line is cancelled (or whose status is CANCELLED) is filtered out
  // below using only server-side cancellation state — no Remove button, no
  // dismissal storage, no persistence. Partially cancelled orders (any active
  // line) keep existing behavior. No backend meaning.
  const isOrderFullyCancelled = (o) => {
    const orderItems = o?.items || [];
    if (orderItems.length === 0) return false;
    return orderItems.every((it) => it?.cancelled || o.status === 'CANCELLED');
  };
  // Visible active orders: fully cancelled orders excluded before badge/notification/render
  const visibleActiveOrders = (() => {
    // Inline derivation without useMemo to avoid extra dependency tracking complexity in this large component;
    // recomputed on every render (activeOrders is small, <200).
    const filtered = [];
    for (const o of activeOrders) {
      if (!isOrderFullyCancelled(o)) filtered.push(o);
    }
    return filtered;
  })();

  // Order editing (pre-preparation only) — draft lives here; the server enforces
  // the PENDING lock atomically, so stale drafts can never mutate a started order.
  const [editingOrderId, setEditingOrderId] = useState(null);
  const [editLines, setEditLines] = useState([]); // [{lineId,name,qty,origQty}]
  const [editRemoved, setEditRemoved] = useState(() => new Set()); // lineIds
  const [editAdds, setEditAdds] = useState([]); // [{key,menuId,qty}]
  const [editAddMenu, setEditAddMenu] = useState('');
  const [editAddQty, setEditAddQty] = useState('1');
  const [editNotes, setEditNotes] = useState({}); // lineId -> text
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [editSavedMsg, setEditSavedMsg] = useState('');

  // Alerts (sound + browser notification) — same chime convention as KDS.
  const [alertsOn, setAlertsOn] = useState(true);
  const alertsOnRef = useRef(true);
  const notifiedKeysRef = useRef(new Set());
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);

  // Single source of truth — unified MongoDB via /api/menu. Phase 5: menu cache 60s s-maxage, so allow cache.
  // all=true → existing API flag returning the full catalog incl. unavailable
  // items so they can be DISPLAYED with a disabled action (ordering still blocked).
  async function loadMenuData(l) {
    const raw = await safeFetchJson(`/api/menu?all=true&lang=${l}`);
    const payload = raw?.data && (raw.data.categories || raw.data.items) ? raw.data : raw;
    return { categories: payload?.categories || [], items: payload?.items || [] };
  }

  useEffect(() => {
    let ignore = false;
    async function fetchData() {
      try {
        setLoading(true);
        const data = await loadMenuData(lang);
        if (ignore) return;
        // Normalize for unified _id/id handling (spec + legacy)
        const cats = (data.categories || []).map((c) => ({ ...c, _id: c._id || c.id, id: c.id || c._id }));
        const its = (data.items || []).map((i) => ({
          ...i,
          _id: i._id || i.id,
          id: i.id || i._id,
          title: i.title || i.name || "",
          imageUrl: i.imageUrl || i.image || "",
        }));
        // Unavailable items remain VISIBLE with a disabled "Out of Stock" action —
        // only adding them to the cart is blocked. Cart hygiene unchanged: entries
        // whose item became unavailable/deleted are still pruned.
        const orderable = (it) => it.isAvailable !== false && it.inStock !== false;
        // Prune cart of any items that are now unavailable/deleted (dynamic sync)
        setCart((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const key of Object.keys(next)) {
            const match = its.find((a) => String(a._id) === String(key));
            if (!match || !orderable(match)) {
              delete next[key];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        setCategories(cats);
        setItems(its);
      } catch {
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    fetchData();
    return () => {
      ignore = true;
    };
  }, [lang]);

  useEffect(() => {
    if (!filterOpen) return;
    function onPointerDown(e) {
      if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setFilterOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [filterOpen]);

  useEffect(() => {
    if (!langMenuOpen) return;
    function onPointerDown(e) {
      if (langBtnRef.current && !langBtnRef.current.contains(e.target)) setLangMenuOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setLangMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [langMenuOpen]);

  const langRef = useRef(lang);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

const prevActiveRef = useRef(new Map());
const waiterIdRef = useRef(null);
const waiterNameRef = useRef(waiterName);
useEffect(() => {
  waiterIdRef.current = waiterId;
}, [waiterId]);
useEffect(() => {
  waiterNameRef.current = waiterName;
}, [waiterName]);

// AUTH-ARCH-5 + AUTH-ARCH-12: explicit session-ended state for REAL security
// events only (SESSION_REVOKED / EXPIRED / INVALID / disabled). While set:
// authenticated polling stops (no storm), SSE is suspended, stale in-flight
// successes are discarded via authGenRef, and an overlay requires explicit
// re-login. There is NO "switched identity" state: under the canonical
// tab-scoped model another tab's login can never change this tab's identity,
// so no continue-as / adopt flow exists. No credentials are ever handled
// here; login itself stays in PinGuard. Server order data is never touched;
// localStorage UI keys (favorites/dismissals/language/theme) stay.
const [sessionEnded, setSessionEnded] = useState(null); // null | { kind }
const sessionEndedRef = useRef(null);
const authGenRef = useRef(0);

const enterSessionEnded = useCallback((kind) => {
  authGenRef.current += 1; // invalidate in-flight successes (stale guard)
  const state = { kind };
  sessionEndedRef.current = state;
  setSessionEnded(state);
  setActiveOrders([]);
  prevActiveRef.current = new Map();
  setReadyToasts([]);
  setPayTarget(null);
  setPayError('');
  setOrderError('');
  setOrdersDrawerOpen(false);
  ordersDrawerOpenRef.current = false;
  setCart({});
  setCartOpen(false);
  setOrderDone(null);
  setCartBump(0);
  setFavorites(new Set());
  favoritesLoadedRef.current = null;
  try {
    if (notifiedKeysRef.current) notifiedKeysRef.current = new Set();
  } catch {}
  setWaiterId(null);
  setWaiterName('Waiter');
}, []);

// Explicit re-login: tab-scoped logout (revokes ONLY this tab's Session,
// stops its heartbeat, clears its memory), then navigate to the portal
// so PinGuard renders the login flow (no credentials handled here).
const signInAgain = useCallback(async () => {
  try {
    await tabLogout();
  } catch {}
  authGenRef.current += 1;
  sessionEndedRef.current = null;
  setSessionEnded(null);
  try { router.push('/waiter'); } catch {}
}, [router]);

// Mount-time identity load. A revoked/expired session enters the re-login
// state; transient network/503 failures are ignored (polling + SSE continue).
useEffect(() => {
  let cancelled = false;
  safeFetchJson('/api/auth/me', { cache: 'no-store' }).then((data) => {
    if (cancelled) return;
    if (data?.success && data?.data?.name) {
      setWaiterName(data.data.name);
      setWaiterId(data.data.staffId);
    }
  }).catch((e) => {
    if (cancelled) return;
    const kind = getSessionErrorKind(e);
    if (kind) enterSessionEnded(kind);
  });
  return () => { cancelled = true; };
}, [enterSessionEnded]);

// Identity watchdog: re-resolves THIS tab's own session on an interval and
// on visibility/focus. Under the canonical tab-scoped model the identity
// cannot be replaced by another tab, so there is no adopt/switch flow: a
// different staffId here means this tab's own context is gone (cookie-mode
// drift), which requires re-login — same as any other session end.
// Favorites are per-waiter localStorage (bono_waiter_favorites:<staffId>), browser-local, not synced.
useEffect(() => {
  let cancelled = false;
  let intervalId = null;
  async function checkIdentity() {
    // Session ended: no polling storm — wait for the explicit overlay action.
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    try {
      const data = await safeFetchJson('/api/auth/me', { cache: 'no-store' });
      // Stale response arriving after revocation must not restore state.
      if (cancelled || gen !== authGenRef.current) return;
      const newId = data?.data?.staffId || null;
      const newName = data?.data?.name || 'Waiter';
      const oldId = waiterIdRef.current;
      if (oldId && newId && String(oldId) !== String(newId)) {
        // AUTH-ARCH-12: this tab's own context changed underneath it (only
        // possible without a tab credential, i.e. cookie-mode drift). Never
        // adopt the other identity and never prompt to continue as them:
        // require re-login exactly like any other session end.
        enterSessionEnded('expired');
        return;
      }
      if (!newId && oldId) {
        enterSessionEnded('expired');
        return;
      }
      if (data?.success && newId) {
        setWaiterName(newName);
        setWaiterId(newId);
      }
    } catch (e) {
      if (cancelled || gen !== authGenRef.current) return;
      const kind = getSessionErrorKind(e);
      // Transient failures (503/network => kind null) keep state and cadence;
      // only true session ends clear and stop. Requires a known identity so a
      // first-load blip never logs out a never-authenticated view.
      if (kind && waiterIdRef.current) {
        enterSessionEnded(kind);
      }
    }
  }
  intervalId = setInterval(checkIdentity, 30000);
  const onVisibility = () => { if (document.visibilityState === 'visible') checkIdentity(); };
  const onFocus = () => checkIdentity();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  return () => {
    cancelled = true;
    if (intervalId) clearInterval(intervalId);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
  };
}, [enterSessionEnded]);

  // Favorites per-waiter persistence — store only IDs, re-resolved against current menu (deferred to avoid cascading effect)
  useEffect(() => {
    if (!waiterId) {
      favoritesLoadedRef.current = null;
      queueMicrotask(() => setFavorites(new Set()));
      return;
    }
    const key = `${FAVORITES_KEY_PREFIX}${String(waiterId)}`;
    favoritesLoadedRef.current = String(waiterId);
    const loadedFor = String(waiterId);
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
      if (!raw) {
        queueMicrotask(() => { if (favoritesLoadedRef.current === loadedFor) setFavorites(new Set()); });
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not array');
      const ids = parsed.filter((id) => typeof id === 'string' && id.trim()).map((id) => String(id).trim());
      if (favoritesLoadedRef.current !== loadedFor) return;
      queueMicrotask(() => { if (favoritesLoadedRef.current === loadedFor) setFavorites(new Set(ids)); });
    } catch {
      queueMicrotask(() => { if (favoritesLoadedRef.current === loadedFor) setFavorites(new Set()); });
    }
  }, [waiterId]);

  useEffect(() => {
    if (!waiterId) return;
    if (favoritesLoadedRef.current !== String(waiterId)) return;
    try {
      const key = `${FAVORITES_KEY_PREFIX}${String(waiterId)}`;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, JSON.stringify([...favorites]));
      }
    } catch {}
  }, [favorites, waiterId]);

  // Auto-exit edit mode when the edited order leaves PENDING (preparation started
  // elsewhere). Deferred like other state syncs; the draft is discarded safely.
  useEffect(() => {
    if (!editingOrderId) return;
    const current = activeOrders.find((o) => String(o._id) === String(editingOrderId));
    if (current && current.status === 'PENDING') return;
    queueMicrotask(() => {
      setEditingOrderId(null);
      setEditLines([]);
      setEditRemoved(new Set());
      setEditAdds([]);
      setEditNotes({});
      setEditError('');
    });
  }, [activeOrders, editingOrderId]);

  // Waiter alerts — one chime + one background system notification per stable event
  // key. Poll diffs and SSE share the dedupe set so the same event never sounds twice.
  const fireWaiterAlert = useCallback((key, title, body) => {
    if (notifiedKeysRef.current.has(key)) return;
    notifiedKeysRef.current.add(key);
    if (alertsOnRef.current) playChime();
    notifyBrowser({ title, body, tag: key });
  }, []);

const pushReadyToast = useCallback((orderNumber, tableNumber) => {
    const id = `ready-${orderNumber}`;
    setReadyToasts((prevT) =>
      prevT.some((x) => x.id === id)
        ? prevT
        : [
            ...prevT,
            {
              id,
              text: `🔔 Order #${orderNumber} for Table ${tableNumber} is READY!`,
            },
          ]
    );
    setTimeout(() => {
      setReadyToasts((prevT) => prevT.filter((x) => x.id !== id));
    }, 7000);
  }, [setReadyToasts]);

  const pollMenu = useCallback(async (opts) => {
    try {
      // A real-time SSE refresh passes fresh=1 and no-store so the route returns
      // authoritative DB data (no-store) instead of the 60s-cached catalog.
      const url = `/api/menu?all=true&lang=${langRef.current}${opts?.noStore ? "&fresh=1" : ""}`;
      const raw = await safeFetchJson(url, opts?.noStore ? { cache: 'no-store' } : undefined);
      const payload = raw?.data && (raw.data.categories || raw.data.items) ? raw.data : raw;
      const cats = (payload?.categories || []).map((c) => ({ ...c, _id: c._id || c.id, id: c.id || c._id }));
      const its = (payload?.items || []).map((i) => ({ ...i, _id: i._id || i.id, id: i.id || i._id, title: i.title || i.name || "", imageUrl: i.imageUrl || i.image || "" }));
      // Unavailable items stay visible with a disabled action; cart prunes unavailable/deleted
      const orderable = (it) => it.isAvailable !== false && it.inStock !== false;
      setCategories(cats);
      setItems(its);
      setCart((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const key of Object.keys(next)) {
          const match = its.find((a) => String(a._id) === String(key));
          if (!match || !orderable(match)) {
            delete next[key];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    } catch {
    }
  }, [setCategories, setItems]);

  // Lazily fetch SERVED + CANCELLED orders only when the drawer is opened, then merge
  // them into the single display list so the drawer shows SERVED exactly as before and
  // fully-cancelled orders stay visible until the waiter dismisses their lines.
  // Server already filters to current waiter (waiterId == session.staffId),
  // client filters as defense-in-depth to avoid mixing after same-browser identity switch.
  const loadServedOrders = useCallback(async () => {
    try {
      const [served, cancelled] = await Promise.all([
        safeFetchJson('/api/orders?status=SERVED', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=CANCELLED', { cache: 'no-store' }).catch(() => ({ success: false })),
      ]);
      const currentId = waiterIdRef.current;
      setActiveOrders((prev) => {
        // Filter prev to current waiter only — prevents merging old waiter's orders after shared-cookie switch
        const filteredPrev = currentId ? prev.filter((o) => !o.waiterId || String(o.waiterId) === String(currentId)) : prev;
        const byId = new Map(filteredPrev.map((o) => [o._id, o]));
        for (const src of [served, cancelled]) {
          if (!src?.success) continue;
          for (const o of (src.data?.orders || [])) {
            if (!currentId || !o.waiterId || String(o.waiterId) === String(currentId)) byId.set(o._id, o);
          }
        }
        return Array.from(byId.values());
      });
    } catch {
      // Keep current ACTIVE list on failure; drawer remains usable for active orders
    }
  }, []);

  // Background refresh: ACTIVE (PENDING,PREPARING,READY) + PAYMENT_PENDING (pending verification) are always fetched for waiter;
  // SERVED + CANCELLED are fetched only when drawer open (cancelled orders stay visible until lines are dismissed).
  const pollActiveOrders = useCallback(async (opts) => {
    // Session ended: never fire authenticated refreshes (no retry storm).
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    const includeServed = (opts && opts.includeServed) || ordersDrawerOpenRef.current;
    try {
      const baseRequests = [
        safeFetchJson('/api/orders', { cache: 'no-store' }),
        safeFetchJson('/api/orders?status=PAYMENT_PENDING', { cache: 'no-store' }).catch(() => ({ success: false })),
      ];
      if (includeServed) {
        baseRequests.push(safeFetchJson('/api/orders?status=SERVED', { cache: 'no-store' }).catch(() => ({ success: false })));
        baseRequests.push(safeFetchJson('/api/orders?status=CANCELLED', { cache: 'no-store' }).catch(() => ({ success: false })));
      }
      const results = await Promise.all(baseRequests);
      // Stale success after revocation must not repopulate/clear state.
      if (gen !== authGenRef.current) return;
      const prep = results[0];
      const pending = results[1];
      const served = includeServed ? results[2] : null;
      const cancelled = includeServed ? results[3] : null;
      if (!prep?.success) return;
      const byId = new Map();
      for (const o of (prep.data?.orders || [])) byId.set(o._id, o);
      if (pending?.success) {
        for (const o of (pending.data?.orders || [])) byId.set(o._id, o);
      }
      if (includeServed && served?.success) {
        for (const o of (served.data?.orders || [])) byId.set(o._id, o);
      }
      if (includeServed && cancelled?.success) {
        for (const o of (cancelled.data?.orders || [])) byId.set(o._id, o);
      }
      const list = Array.from(byId.values());
      const prev = prevActiveRef.current;
      if (prev.size > 0) {
        const L = (k) => LABELS[k]?.[langRef.current] || LABELS[k]?.en || '';
        for (const o of list) {
          const was = prev.get(o._id);
          if (was && was.status !== 'READY' && o.status === 'READY') {
            // Server already filters to own orders (waiterId == session.staffId), so any READY here is own
            pushReadyToast(o.orderNumber, o.tableNumber);
            fireWaiterAlert(
              `ready:${o._id}`,
              `Table ${o.tableNumber} · ${o.orderNumber}`,
              `${o.orderNumber} — ${L('notifReady')}`
            );
          }
           // Newly-cancelled lines on own orders (kitchen/barista action).
            // Requires the prior snapshot to contain the order: historical
            // CANCELLED orders merging in for the first time must not burst.
            if (!was) continue;
            const wasLines = new Map((was?.items || []).map((it) => [it.lineId ? String(it.lineId) : null, it]));
            for (const it of o.items || []) {
              if (!it.cancelled || !it.lineId) continue;
              const before = wasLines.get(String(it.lineId));
             if (before && before.cancelled) continue;
             const itemName = getLocalizedSingleString(it.name) || getLocalizedSingleString(it.title) || 'Item';
             fireWaiterAlert(
               `cancel:${o._id}|${it.lineId}`,
               `Table ${o.tableNumber} · ${o.orderNumber}`,
               `${itemName} — ${L('notifCancelled')}`
             );
           }
        }
      }
      prevActiveRef.current = new Map(list.map((o) => [o._id, o]));
      setActiveOrders(list);
    } catch (err) {
      // Stale failure after revocation: ignore.
      if (gen !== authGenRef.current) return;
      // Explicit session end (revoked/expired/invalid/disabled) enters the
      // re-login state. Transient failures (503/network) keep current state
      // and the normal polling cadence — never a retry storm.
      const kind = getSessionErrorKind(err);
      if (kind) enterSessionEnded(kind);
    }
  }, [pushReadyToast, fireWaiterAlert, enterSessionEnded]);

  const refreshTimer = useRef(null);
  const scheduleOrdersRefresh = useCallback(() => {
    if (sessionEndedRef.current) return;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(pollActiveOrders, 150);
  }, [pollActiveOrders]);

  const handleOrderEvent = useCallback(
    (event) => {
      if (sessionEndedRef.current) return;
      // Real-time menu sync: manager CRUD publishes "menu-changed" → refetch the
      // authoritative catalog through the SAME SSE connection used for orders.
      if (event && event.type === "menu-changed") {
        pollMenu({ noStore: true });
        return;
      }
      scheduleOrdersRefresh();
      if (event && event.type === "ORDER_READY") {
        const ownId = waiterIdRef.current;
        // Server sets waiterId = Staff._id of order owner; only toast if matches own session
        if (ownId && event.waiterId && String(event.waiterId) === String(ownId)) {
          pushReadyToast(event.orderNumber, event.tableNumber);
          const L = (k) => LABELS[k]?.[langRef.current] || LABELS[k]?.en || '';
          fireWaiterAlert(
            `ready:${event.orderId || event.orderNumber}`,
            `Table ${event.tableNumber ?? '—'} · ${event.orderNumber}`,
            `${event.orderNumber} — ${L('notifReady')}`
          );
        }
      }
    },
    [scheduleOrdersRefresh, pushReadyToast, pollMenu, fireWaiterAlert]
  );

  // SSE suspended while the session is ended (no reconnect until re-auth).
  useOrderEvents(handleOrderEvent, !sessionEnded);

  useEffect(() => {
    const initId = setTimeout(pollActiveOrders, 0);
    const ordersId = setInterval(() => {
      // Only poll when page visible and SSE may be stale — 30s fallback (SSE is primary)
      if (document.visibilityState === "visible") pollActiveOrders();
    }, ORDERS_FALLBACK_POLL_MS);
    const menuId = setInterval(() => {
      if (document.visibilityState === "visible") pollMenu();
    }, MENU_FALLBACK_POLL_MS);
    return () => {
      clearTimeout(initId);
      clearInterval(ordersId);
      clearInterval(menuId);
      clearTimeout(refreshTimer.current);
    };
  }, [pollActiveOrders, pollMenu, scheduleOrdersRefresh]);

  const categoryFiltered =
    selectedCategory === 'ALL'
      ? items
      : items.filter((item) => item.categoryId === selectedCategory);

  const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searchedItems = terms.length
    ? categoryFiltered.filter((item) => {
        const haystack = buildSearchHaystack(item);
        return terms.every((term) => haystack.includes(term));
      })
    : categoryFiltered;

  const visibleItems = [...searchedItems];
  if (sortMode === 'price') {
    visibleItems.sort((a, b) => (a.price || 0) - (b.price || 0));
  } else if (sortMode === 'alpha') {
    visibleItems.sort((a, b) =>
      getLocalizedSingleString(a.title).localeCompare(
        getLocalizedSingleString(b.title),
        undefined,
        { sensitivity: 'base' }
      )
    );
  }

  // Favorites — re-resolved against current visibleItems (current filters), ignore missing/deleted
  const favoriteVisible = visibleItems.filter((it) => favorites.has(String(it._id || it.id)));
  const nonFavoriteVisible = visibleItems.filter((it) => !favorites.has(String(it._id || it.id)));

  const cartEntries = Object.values(cart);
  const cartCount = cartEntries.reduce((sum, entry) => sum + entry.qty, 0);
  const cartTotal = cartEntries.reduce((sum, entry) => {
    const base = entry.qty * (entry.item.price || 0);
    const comps = (entry.components || [])
      .filter((c) => c.kind === "PRICED_COMPONENT")
      .reduce((s, c) => s + (Number(c.quantity) || 0) * (Number(c.unitPrice) || 0), 0);
    return sum + base + comps;
  }, 0);

  function addToCart(item) {
    if (!item.isAvailable) return;
    setCart((prev) => {
      const existing = prev[item._id];
      return {
        ...prev,
        [item._id]: {
          item,
          qty: (existing?.qty || 0) + 1,
          components: existing?.components || [],
        },
      };
    });
    setCartBump((n) => n + 1);
    setOrderDone(null);
  }

  function changeQty(itemId, delta) {
    setCart((prev) => {
      const current = prev[itemId];
      if (!current) return prev;
      const qty = current.qty + delta;
      const next = { ...prev };
      if (qty <= 0) delete next[itemId];
      else next[itemId] = { ...current, qty };
      return next;
    });
  }

  function removeFromCart(itemId) {
    setCart((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  function addComponentToCart(cartKey, comp) {
    setCart((prev) => {
      const entry = prev[cartKey];
      if (!entry) return prev;
      const list = Array.isArray(entry.components) ? entry.components : [];
      if (list.length >= 20) return prev;
      return { ...prev, [cartKey]: { ...entry, components: [...list, comp] } };
    });
  }
  function removeComponentFromCart(cartKey, compIdx) {
    setCart((prev) => {
      const entry = prev[cartKey];
      if (!entry || !Array.isArray(entry.components)) return prev;
      const nextComps = entry.components.filter((_, i) => i !== compIdx);
      return { ...prev, [cartKey]: { ...entry, components: nextComps } };
    });
  }

  function isFavorite(itemId) {
    return favorites.has(String(itemId));
  }
  function toggleFavorite(itemId) {
    const id = String(itemId);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Components — Type A NOTE (no price, no inventory) and Type B PRICED_COMPONENT (billable, no inventory link)
  function addNoteToCart(cartKey) {
    const note = compNote.trim();
    if (!note) {
      setCompError("Note is required (max 500 chars)");
      return;
    }
    if (note.length > 500) {
      setCompError("Note max 500 chars");
      return;
    }
    if (/<script/i.test(note) || /javascript:/i.test(note)) {
      setCompError("Note contains invalid characters");
      return;
    }
    addComponentToCart(cartKey, { kind: "NOTE", note: note.slice(0, 500) });
    setCompNote("");
    setCompError("");
    setEditingComponent(null);
    setOrderDone(null);
  }
  function addPricedToCart(cartKey) {
    const name = compName.trim();
    const qty = Number(compQty);
    const price = Number(compPrice);
    if (!name) {
      setCompError("Component name is required");
      return;
    }
    if (name.length > 100) {
      setCompError("Component name max 100 chars");
      return;
    }
    if (/<script/i.test(name)) {
      setCompError("Component name contains invalid characters");
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      setCompError("Quantity must be 1-99");
      return;
    }
    if (!Number.isFinite(price) || price < 0 || price > 100000) {
      setCompError("Unit price must be 0-100000");
      return;
    }
    // No inventory link collected here — the backend accepts priced components
    // without inventory fields and handles absence safely.
    addComponentToCart(cartKey, {
      kind: "PRICED_COMPONENT",
      name: name.slice(0, 100),
      quantity: qty,
      unitPrice: Math.round(price * 100) / 100,
    });
    setCompName("");
    setCompQty("1");
    setCompPrice("");
    setCompError("");
    setEditingComponent(null);
    setOrderDone(null);
  }

  // Post-submit ownership check (non-blocking): confirms THIS tab's session
  // still resolves to the same waiter. With a tab credential the identity
  // cannot drift; without one (cookie mode) a mismatch means this tab's own
  // context changed, which ends the session like any other session end.
  // Never delays success and never adopts another identity.
  const verifySubmitIdentity = useCallback((gen) => {
    safeFetchJson('/api/auth/me', { cache: 'no-store' }).then((data) => {
      if (gen !== authGenRef.current || sessionEndedRef.current) return;
      const meId = data?.data?.staffId || null;
      const ownId = waiterIdRef.current;
      if (ownId && meId && String(ownId) !== String(meId)) {
        enterSessionEnded('expired');
      }
    }).catch((e) => {
      if (gen !== authGenRef.current || sessionEndedRef.current) return;
      const kind = getSessionErrorKind(e);
      if (kind) enterSessionEnded(kind);
    });
  }, [enterSessionEnded]);

  async function submitOrder() {
    if (cartEntries.length === 0 || submitting) return;
    // Revoked session: never auto-submit — explicit re-login first.
    if (sessionEndedRef.current) return;
    const gen = authGenRef.current;
    setSubmitting(true);
    setOrderError('');
    try {
      // Components are attached to parent menu item, not standalone orders
      const payload = {
        tableNumber: selectedTable,
        items: cartEntries.map(({ item, qty, components }) => ({
          itemId: item._id,
          name: item.title,
          price: item.price,
          quantity: qty,
          type: item.type || item.categoryType || (item.targetStation === "BARISTA" || item.barista ? "DRINK" : "FOOD"),
          components: Array.isArray(components)
            ? components.map((c) => {
                if (c.kind === "NOTE") return { kind: "NOTE", note: c.note };
                return {
                  kind: "PRICED_COMPONENT",
                  name: c.name,
                  quantity: c.quantity,
                  unitPrice: c.unitPrice,
                  ...(c.inventoryItemId ? { inventoryItemId: c.inventoryItemId, stockQuantity: c.stockQuantity, stockUnit: c.stockUnit } : {}),
                };
              })
            : [],
        })),
      };
      const data = await sendOrder(payload);
      // Session ended mid-flight: do not present another identity's result.
      if (gen !== authGenRef.current) return;
      const total = data.data?.order?.totalAmount ?? 0;
      setOrderDone({ total });
      setCart({});
      setCartOpen(false);
      verifySubmitIdentity(gen);
    } catch (err) {
      // Stale failure after revocation: ignore.
      if (gen !== authGenRef.current) return;
      const kind = getSessionErrorKind(err);
      const s = err && err.status;
      if (kind) enterSessionEnded(kind);
      else if (s === 403) setOrderError("Your account does not have permission to perform this action.");
      else if (s === 503 || /service.*unavailable|database/i.test(err?.message || "")) setOrderError("Service temporarily unavailable. Please try again.");
      else setOrderError(t('orderError'));
    } finally {
      setSubmitting(false);
    }
  }

  const serveActiveOrder = useCallback(async (orderId) => {
    try {
      const data = await updateOrderStatusClient(orderId, 'SERVED');
      if (data.success && data.data?.order) {
        setActiveOrders((prev) => prev.map((o) => (o._id === orderId ? data.data.order : o)));
      }
    } catch {
    }
  }, []);

  // Waiter whole-order cancel (PENDING own orders only). Two-tap inline confirm;
  // the server enforces ownership + PENDING atomically. Success removes the order
  // from view immediately; later CANCELLED fetches are excluded by the
  // fully-cancelled filter. Server history is never deleted.
  const [cancelOrderBusy, setCancelOrderBusy] = useState(false);
  const [confirmCancelId, setConfirmCancelId] = useState(null);
  const cancelOwnOrder = async (orderId) => {
    if (cancelOrderBusy) return;
    if (confirmCancelId !== String(orderId)) {
      setConfirmCancelId(String(orderId));
      return;
    }
    setConfirmCancelId(null);
    setCancelOrderBusy(true);
    try {
      const data = await safeFetchJson(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CANCEL_ORDER' }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || 'Cancel failed');
      // The cancelled order becomes fully cancelled server-side and is
      // therefore excluded by the fully-cancelled filter on next fetch;
      // remove it from view immediately. No dismissal storage needed.
      setActiveOrders((prev) => prev.filter((o) => String(o._id) !== String(orderId)));
      scheduleOrdersRefresh();
    } catch (err) {
      if (err && (err.status === 409 || err.status === 400)) setOrderError(t('orderLocked'));
      else setOrderError(t('cancelFailed'));
      scheduleOrdersRefresh();
    } finally {
      setCancelOrderBusy(false);
    }
  };

  // Pre-preparation order editing — order-level lock: editable only while the
  // canonical order status is PENDING. The server re-checks atomically.
  const openOrderEdit = (order) => {
    if (!order || order.status !== 'PENDING') return;
    setEditLines(
      (order.items || [])
        .filter((it) => !it.cancelled && it.lineId)
        .map((it) => ({
          lineId: String(it.lineId),
          name: getLocalizedSingleString(it.name) || getLocalizedSingleString(it.title) || 'Item',
          qty: Number(it.quantity) || 1,
          origQty: Number(it.quantity) || 1,
        }))
    );
    setEditRemoved(new Set());
    setEditAdds([]);
    setEditAddMenu('');
    setEditAddQty('1');
    setEditNotes({});
    setEditError('');
    setEditSavedMsg('');
    setEditingOrderId(order._id);
  };
  const closeOrderEdit = () => {
    setEditingOrderId(null);
    setEditLines([]);
    setEditRemoved(new Set());
    setEditAdds([]);
    setEditNotes({});
    setEditError('');
  };

  const saveOrderEdit = async (orderId) => {
    if (editBusy) return;
    const changes = [];
    for (const ln of editLines) {
      if (editRemoved.has(ln.lineId)) {
        changes.push({ op: 'remove', lineId: ln.lineId });
        continue;
      }
      const q = Number(ln.qty);
      if (Number.isInteger(q) && q >= 1 && q <= 99 && q !== ln.origQty) {
        changes.push({ op: 'setQty', lineId: ln.lineId, quantity: q });
      }
      const note = (editNotes[ln.lineId] || '').trim();
      if (note) changes.push({ op: 'note', lineId: ln.lineId, note: note.slice(0, 500) });
    }
    for (const a of editAdds) {
      const q = Number(a.qty);
      if (!a.menuId || !Number.isInteger(q) || q < 1 || q > 99) continue;
      changes.push({ op: 'add', menuItemId: a.menuId, quantity: q });
    }
    if (changes.length === 0) {
      closeOrderEdit();
      return;
    }
    setEditBusy(true);
    setEditError('');
    try {
      const data = await safeFetchJson(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'EDIT_ITEMS', changes }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || 'Edit failed');
      const updated = data?.data?.order;
      if (updated) {
        setActiveOrders((prev) => prev.map((o) => (o._id === orderId ? updated : o)));
      }
      setEditSavedMsg(t('editSaved'));
      setTimeout(() => setEditSavedMsg(''), 2500);
      closeOrderEdit();
      scheduleOrdersRefresh();
    } catch (err) {
      // Locked orders (409/400 lifecycle conflict) refresh to canonical state; no technical text shown.
      if (err && (err.status === 409 || err.status === 400)) setEditError(t('orderLocked'));
      else setEditError(t('editFailed'));
      scheduleOrdersRefresh();
    } finally {
      setEditBusy(false);
    }
  };

  async function confirmPayment(method) {
    if (!payTarget || payBusy) return;
    const paymentMethod = method === 'TRANSFER' ? 'TRANSFER' : 'CASH';
    // Transfer requires active account selection
    let paymentAccountId = null;
    if (paymentMethod === 'TRANSFER') {
      if (!selectedTransferAccount) {
        setPayError('Please select a transfer account.');
        return;
      }
      paymentAccountId = selectedTransferAccount;
    }
    setPayBusy(true);
    setPayError('');
    try {
      // Waiter submits for cashier verification — PAYMENT_PENDING, not PAID
      const body = { status: 'PAYMENT_PENDING', paymentMethod };
      if (paymentMethod === 'TRANSFER' && paymentAccountId) body.paymentAccountId = paymentAccountId;
      const data = await safeFetchJson(`/api/orders/${payTarget._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (data.success) {
        const updated = data.data?.order;
        if (updated) {
          setActiveOrders((prev) => prev.map((o) => (o._id === payTarget._id ? updated : o)));
        }
        setPaymentToast('Payment submitted — waiting for cashier verification');
        setTimeout(() => setPaymentToast(''), 4000);
        setPayTarget(null);
      }
    } catch (err) {
      setPayError(
        err?.message ? `${t('payError')}: ${err.message}` : t('payError')
      );
    } finally {
      setPayBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-[#F4F5F9] dark:bg-[#12131A] text-[#1E293B] dark:text-white pb-4 h-full max-h-full min-h-0 overflow-hidden">
      {/* AUTH-ARCH-5 + AUTH-ARCH-12: explicit session-ended state for real
          security events only. Single action: re-login. There is no
          continue-as / switched-identity flow — another tab's login can never
          change this tab's identity. No credentials are collected here and
          nothing is auto-submitted. */}
      {sessionEnded && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/40 dark:bg-[#12131A]/80 px-4 py-6" role="alertdialog" aria-modal="true" aria-label={t('sessionEnded')}>
          <div className="w-full max-w-sm rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-6 text-center shadow-[0_10px_25px_-5px_rgba(0,0,0,0.15)]">
            <h2 className="text-lg font-extrabold tracking-tight text-[#1E293B] dark:text-white">
              {t('sessionEnded')}
            </h2>
            <p className="mt-2 text-sm font-medium text-[#64748B] dark:text-[#94A3B8]">
              {sessionEnded.kind === 'disabled'
                ? t('sessionDisabledBody')
                : t('sessionEndedBody')}
            </p>
            <button
              type="button"
              onClick={signInAgain}
              className="mt-5 flex h-12 w-full items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner"
            >
              {t('signInAgain')}
            </button>
          </div>
        </div>
      )}
      {/* HEADER — Sunshine Yellow in light, transparent in dark */}
      <header className="sticky top-0 z-40 bg-[#FFDC00] dark:bg-transparent border-b border-[#E2E8F0]/60 dark:border-transparent dark:border-none pt-[env(safe-area-inset-top)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-none backdrop-blur">
        <div className="px-3 pb-3 pt-3">
          {/* SINGLE NAVBAR — Table · Language · Active Orders · Cart (4 equal buttons) */}
          <div className="grid grid-cols-4 gap-2 w-full mb-3">
            {/* 1. TABLE SELECTOR */}
            <div className="relative w-full">
              <select
                value={selectedTable}
                onChange={(e) => setSelectedTable(Number(e.target.value))}
                aria-label={t('table')}
                className="h-11 w-full appearance-none rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-2 text-center text-xs sm:text-sm font-semibold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40"
              >
                {TABLE_NUMBERS.map((num) => (
                  <option key={`table-opt-${num}`} value={num}>
                    {`${t('table')} ${num}`}
                  </option>
                ))}
              </select>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B] dark:text-[#94A3B8]"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </div>

            {/* 2. LANGUAGE DROPDOWN — between Table and Active Orders */}
            <div ref={langBtnRef} className="relative">
              <button
                type="button"
                onClick={() => setLangMenuOpen((o) => !o)}
                aria-label="Language"
                aria-haspopup="menu"
                aria-expanded={langMenuOpen}
                className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-2 text-xs sm:text-sm font-semibold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-[#64748B] dark:text-[#94A3B8]" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                  <path d="M3 12h18" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span className="hidden sm:inline truncate">{LANGUAGES.find((l) => l.code === lang)?.label || 'አማርኛ'}</span>
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-[#64748B] dark:text-[#94A3B8]" aria-hidden="true">
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              {langMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-0 top-full z-50 mt-2 w-44 origin-top-left overflow-hidden rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
                >
                  {LANGUAGES.map((lo) => (
                    <button
                      key={lo.code}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setLang(lo.code);
                        setLangMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-semibold transition-colors ${
                        lo.code === lang
                          ? 'bg-[#FFD600]/15 text-[#1E293B] dark:bg-[rgba(255,94,0,0.12)] dark:text-[#FF5E00]'
                          : 'text-[#1E293B] dark:text-white hover:bg-[#F4F5F9] dark:hover:bg-[#252631]'
                      }`}
                    >
                      <span>{lo.label}</span>
                      {lo.code === lang && (
                        <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3 text-[#FFD600] dark:text-[#FF5E00]" aria-hidden="true">
                          <path d="M2.5 6l2.5 2.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  ))}
                  {/* LOWER SECTION — Theme toggle + Logout */}
                  <div className="border-t border-[#E2E8F0]/60 dark:border-[#2A2B36] p-3 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={async () => {
                        // Tab-scoped logout: only this tab's Session is revoked.
                        try {
                          await tabLogout();
                        } catch {}
                        router.push('/waiter');
                      }}
                      className="flex h-10 items-center gap-1.5 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 text-xs font-bold text-[#64748B] dark:text-[#94A3B8] hover:text-[#1E293B] dark:hover:text-white"
                    >
                      Logout
                    </button>
                    <ThemeToggleHome />
                  </div>
                </div>
              )}
            </div>

            {/* 3. ACTIVE ORDERS */}
            <button
              type="button"
              onClick={() => {
                const next = !ordersDrawerOpen;
                setOrdersDrawerOpen(next);
                ordersDrawerOpenRef.current = next;
                if (next) loadServedOrders();
              }}
              aria-label={`${t('activeOrders')} (${visibleActiveOrders.length})`}
              aria-haspopup="dialog"
              aria-expanded={ordersDrawerOpen}
              className="relative flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-xs sm:text-sm font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
            >
              <span>{t('activeOrders')}</span>
              {visibleActiveOrders.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white dark:bg-white px-1 text-[11px] font-extrabold text-[#1E293B] shadow-sm border border-[#E2E8F0] dark:border-white">
                  {visibleActiveOrders.length}
                </span>
              )}
            </button>

            {/* 4. CART */}
            <button
              key={cartBump}
              type="button"
              onClick={() => setCartOpen(true)}
              aria-label={`${t('cart')} (${cartCount})`}
              className={`relative flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-xs sm:text-sm font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none ${cartBump > 0 ? 'cart-bump' : ''}`}
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M3 3h2l2.4 12.2a2 2 0 002 1.8h8.4a2 2 0 002-1.6L21 7H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="10" cy="20" r="1.4" fill="currentColor" />
                <circle cx="17.5" cy="20" r="1.4" fill="currentColor" />
              </svg>
              <span>{t('cart')}</span>
              {cartCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-extrabold text-[#1E293B] shadow-sm border border-[#E2E8F0]">
                  {cartCount}
                </span>
              )}
            </button>


          </div>

          {/* ROW 2 — Unified capsule with embedded filter */}
          <div className="flex w-full items-center justify-between rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-1.5 pl-4 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
              {/* LEFT — Search field */}
              <div className="flex min-w-0 flex-1 items-center mr-2">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="mr-2.5 h-5 w-5 shrink-0 text-[#64748B] dark:text-[#94A3B8]"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                  <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="ቡና፣ ምግቦችን ይፈልጉ... / Search menu"
                  aria-label="Search menu"
                  className="w-full bg-transparent border-none pl-1 pr-1 text-xs sm:text-sm text-[#1E293B] dark:text-white placeholder-[#64748B] dark:placeholder-[#94A3B8] focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[#64748B] dark:text-[#94A3B8] transition-colors hover:bg-[#F4F5F9] dark:hover:bg-[#252631] hover:text-[#1E293B] dark:hover:text-white"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                    </svg>
                  </button>
                )}
              </div>

              {/* RIGHT — Embedded Filter Button */}
              <div ref={filterRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setFilterOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={filterOpen}
                  aria-label={t('filter')}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                    <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>

              {filterOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-2 w-56 origin-top-right   overflow-hidden rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
                >
                  <p className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#64748B] dark:text-[#94A3B8]">
                    {t('sortLabel')}
                  </p>
                  {SORT_MODES.map((mode) => {
                    const active = sortMode === mode;
                    return (
                      <button
                        key={`sort-${mode}`}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setSortMode(mode);
                          setFilterOpen(false);
                        }}
                        className={`flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm font-semibold transition-colors ${
                          active
                            ? 'bg-[#FFD600]/15 text-[#1E293B] dark:bg-[rgba(255,94,0,0.12)] dark:text-[#FF5E00]'
                            : 'text-[#1E293B] dark:text-white hover:bg-[#F4F5F9] dark:hover:bg-[#252631]'
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                            active ? 'bg-[#FFD600] dark:bg-[#FF5E00] border-[#FFD600] dark:border-[#FF5E00]' : 'border-[#CBD5E1] dark:border-[#2A2B36]'
                          }`}
                          aria-hidden="true"
                        >
                          {active && (
                            <svg viewBox="0 0 12 12" fill="none" className="h-2.5 w-2.5 text-[#1E293B] dark:text-white" aria-hidden="true">
                              <path
                                d="M2.5 6l2.5 2.5L9.5 3.5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                        {t(`sort${mode[0].toUpperCase()}${mode.slice(1)}`)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* CATEGORY PILLS */}
        <nav className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3 pt-1">
          <button
            type="button"
            onClick={() => setSelectedCategory('ALL')}
            className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold transition-all duration-150 ease-out     active:shadow-inner ${
              selectedCategory === 'ALL'
                ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm'
                : 'border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]'
            }`}
          >
            {t('all')}
          </button>
          {categories.map((cat) => {
            const active = selectedCategory === (cat.id || cat._id);
            return (
              <button
                type="button"
                key={`cat-${cat._id || cat.id || cat.slug}`}
                onClick={() => setSelectedCategory(cat.id || cat._id)}
                className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold transition-all duration-150 ease-out     active:shadow-inner ${
                  active
                    ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm'
                    : 'border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]'
                }`}
              >
                {cat.displayName || getLocalizedSingleString(cat.nameObj || cat.name, lang)}
              </button>
            );
          })}
        </nav>
      </header>
      {/* MAIN LIST */}
      <main className="bg-[#F4F5F9] dark:bg-[#12131A] p-4 flex-1 overflow-y-auto custom-scrollbar">
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: SKELETON_COUNT }).map((_, idx) => (
              <div
                key={`skeleton-card-${idx}`}
                className="flex items-center gap-3 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
              >
                <div className="h-20 w-20 shrink-0 animate-pulse rounded-2xl bg-[#F4F5F9] dark:bg-[#252631]" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
                  <div className="h-2 w-full animate-pulse rounded bg-[#F4F5F9] dark:bg-[#2A2B36]/50" />
                </div>
                <div className="flex shrink-0 items-center gap-2 pl-3">
                  <div className="h-3 w-12 animate-pulse rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
                  <div className="h-7 w-14 animate-pulse rounded-xl bg-[#FFD600]/20 dark:bg-[#FF5E00]/20" />
                </div>
              </div>
            ))}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">
            {t('empty')}
            {searchQuery && (
              <span className="mt-1 block text-xs text-[#94A3B8]">
                «{searchQuery.trim()}»
              </span>
            )}
          </div>
        ) : (
          <>
            {favoriteVisible.length > 0 && (
              <div className="mb-6">
                <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-widest text-[#1E293B] dark:text-white">Favorites ({favoriteVisible.length})</h3>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {favoriteVisible.map((item, idx) => {
              const available = item.isAvailable !== false;
              const inCart = cart[item._id];
              return (
                <article
                  key={`item-${item._id || item.id}`}
                  style={{ '--stagger-index': Math.min(idx, 14) }}
                  className="  flex items-center gap-3 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:shadow-[0_14px_30px_-5px_rgba(0,0,0,0.08),0_10px_12px_-6px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_16px_36px_rgba(0,0,0,0.55)]   active:shadow-inner"
                >
                  {/* LEFT SIDE: IMAGE + NAME + DESCRIPTION */}
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {/* IMAGE CONTAINER */}
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-transparent dark:bg-transparent border-0">
                      <MenuItemImage
                        key={`menu-image-${item._id || item.id}-${item.imageUrl || 'none'}`}
                        src={item.imageUrl}
                        alt={localizedName(item, lang) || t('empty')}
                        className="h-full w-full object-cover object-center"
                        loading="lazy"
                      />
                    </div>

                    {/* TEXT */}
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-bold leading-snug text-[#1E293B] dark:text-white">
                        {localizedName(item, lang)}
                      </h3>
                      {localizedDesc(item, lang) ? (
                        <p className="mt-0.5 truncate text-xs text-[#64748B] dark:text-[#94A3B8]">
                          {localizedDesc(item, lang)}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* RIGHT SIDE: PRICE + FAVORITE + ADD */}
                  <div className="flex shrink-0 items-center gap-2 pl-3">
                    <button
                      type="button"
                      onClick={() => toggleFavorite(item._id || item.id)}
                      aria-label={isFavorite(item._id || item.id) ? "Remove from favorites" : "Add to favorites"}
                      className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs transition ${isFavorite(item._id || item.id) ? 'bg-[#FFD600] border-[#FFD600] text-[#1E293B]' : 'bg-white dark:bg-[#1C1D24] border-[#E2E8F0] dark:border-[#2A2B36] text-[#64748B]'}`}
                    >
                      {isFavorite(item._id || item.id) ? '★' : '☆'}
                    </button>
                    <span className="whitespace-nowrap text-sm font-bold text-[#1E293B] dark:text-white">
                      {item.price ? `${item.price} ETB` : ''}
                    </span>

                    {!available ? (
                      <span
                        className="cursor-not-allowed rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-2.5 py-1.5 text-xs font-bold text-[#94A3B8]"
                        aria-disabled="true"
                      >
                        {t('outStock')}
                      </span>
                    ) : inCart ? (
                      <div className="flex items-center gap-1.5 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-1.5 py-1">
                        <button
                          type="button"
                          onClick={() => changeQty(item._id, -1)}
                          aria-label="decrease quantity"
                          className="flex h-6 w-6 items-center justify-center rounded-lg bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0] dark:border-[#2A2B36] shadow-sm transition-all duration-150 ease-out    "
                        >
                          −
                        </button>
                        <span className="min-w-4 text-center text-xs font-bold text-[#1E293B] dark:text-white">
                          {inCart.qty}
                        </span>
                        <button
                          type="button"
                          onClick={() => changeQty(item._id, 1)}
                          aria-label="increase quantity"
                          className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out    "
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => addToCart(item)}
                        disabled={!available}
                        className="rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-2.5 py-1.5 text-xs font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        + {t('add')}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {nonFavoriteVisible.map((item, idx) => {
                const available = item.isAvailable !== false;
                const inCart = cart[item._id];
                return (
                  <article
                    key={`item-${item._id || item.id}`}
                    style={{ '--stagger-index': Math.min(idx, 14) }}
                    className="  flex items-center gap-3 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:shadow-[0_14px_30px_-5px_rgba(0,0,0,0.08),0_10px_12px_-6px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_16px_36px_rgba(0,0,0,0.55)]   active:shadow-inner"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-transparent dark:bg-transparent border-0">
                        <MenuItemImage
                          key={`menu-image-${item._id || item.id}-${item.imageUrl || 'none'}`}
                          src={item.imageUrl}
                          alt={localizedName(item, lang) || t('empty')}
                          className="h-full w-full object-cover object-center"
                          loading="lazy"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-bold leading-snug text-[#1E293B] dark:text-white">
                          {localizedName(item, lang)}
                        </h3>
                        {localizedDesc(item, lang) ? (
                          <p className="mt-0.5 truncate text-xs text-[#64748B] dark:text-[#94A3B8]">
                            {localizedDesc(item, lang)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pl-3">
                      <button
                        type="button"
                        onClick={() => toggleFavorite(item._id || item.id)}
                        aria-label={isFavorite(item._id || item.id) ? "Remove from favorites" : "Add to favorites"}
                        className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs transition ${isFavorite(item._id || item.id) ? 'bg-[#FFD600] border-[#FFD600] text-[#1E293B]' : 'bg-white dark:bg-[#1C1D24] border-[#E2E8F0] dark:border-[#2A2B36] text-[#64748B]'}`}
                      >
                        {isFavorite(item._id || item.id) ? '★' : '☆'}
                      </button>
                      <span className="whitespace-nowrap text-sm font-bold text-[#1E293B] dark:text-white">
                        {item.price ? `${item.price} ETB` : ''}
                      </span>
                      {!available ? (
                        <span
                          className="cursor-not-allowed rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-2.5 py-1.5 text-xs font-bold text-[#94A3B8]"
                          aria-disabled="true"
                        >
                          {t('outStock')}
                        </span>
                      ) : inCart ? (
                        <div className="flex items-center gap-1.5 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-1.5 py-1">
                          <button
                            type="button"
                            onClick={() => changeQty(item._id, -1)}
                            aria-label="decrease quantity"
                            className="flex h-6 w-6 items-center justify-center rounded-lg bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0] dark:border-[#2A2B36] shadow-sm transition-all duration-150 ease-out    "
                          >
                            −
                          </button>
                          <span className="min-w-4 text-center text-xs font-bold text-[#1E293B] dark:text-white">
                            {inCart.qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => changeQty(item._id, 1)}
                            aria-label="increase quantity"
                            className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out    "
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addToCart(item)}
                          disabled={!available}
                          className="rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-2.5 py-1.5 text-xs font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          + {t('add')}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

      </main>
      {/* REAL-TIME READY NOTIFICATIONS — inside frame on desktop */}
      {readyToasts.length > 0 && (
        <div className="pointer-events-none fixed md:absolute inset-x-0 top-[env(safe-area-inset-top)] z-[60] flex flex-col items-center gap-2 px-4 pt-2">
          {readyToasts.map((toast) => (
            <div
              key={`toast-${toast.id}`}
              className="  pointer-events-auto rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-3 text-center text-sm font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
            >
              {toast.text}
            </div>
          ))}
        </div>
      )}

      {/* ACTIVE ORDERS VERTICAL DRAWER — inside frame on desktop */}
      {ordersDrawerOpen && (
        <div className="fixed md:absolute inset-0 z-50 flex">
          <div
            className="flex-1 bg-[#1E293B]/20 dark:bg-[#12131A]/60 backdrop-blur-sm"
            onClick={() => setOrdersDrawerOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t('activeOrders')}
            className="flex h-full w-[88%] max-w-md   flex-col border-l border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
          >
            <div className="flex items-center justify-between border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-4">
              <h2 className="text-base font-bold text-[#1E293B] dark:text-white">{t('activeOrders')}</h2>
              <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  const next = !alertsOn;
                  setAlertsOn(next);
                  if (next) {
                    // User gesture: unlock audio + request system-notification permission (once).
                    playChime();
                    await ensureBrowserNotifyPermission().catch(() => {});
                  }
                }}
                aria-label={alertsOn ? t('alertsOff') : t('alertsOn')}
                title={alertsOn ? t('alertsOff') : t('alertsOn')}
                className="rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-3 py-1 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]"
              >
                {alertsOn ? t('alertsOn') : t('alertsOff')}
              </button>
              <button
                type="button"
                onClick={() => setOrdersDrawerOpen(false)}
                aria-label={t('close')}
                className="rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-3 py-1 text-sm font-bold text-[#64748B] dark:text-[#94A3B8] transition-all duration-150 ease-out     active:shadow-inner"
              >
                ✕
              </button>
              </div>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              {visibleActiveOrders.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">
                  {t('noOrders')}
                </p>
              ) : (
                visibleActiveOrders.map((o) => {
                  return (
                  <div
                    key={o._id}
                    className="rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 truncate font-bold text-[#1E293B] dark:text-white">
                          <span>{`${t('table')} ${o.tableNumber}`}</span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              STATUS_BADGE[o.status] || 'bg-[#F4F5F9] text-[#94A3B8] dark:bg-[#12131A] dark:text-[#94A3B8]'
                            }`}
                          >
                            {o.status}
                          </span>
                        </p>
                        <p className="mt-0.5 truncate text-xs text-[#64748B] dark:text-[#94A3B8]">
                          {o.waiterName || 'Waiter'}
                        </p>
                        {/* Mixed-order readiness: distinguish FOOD (Kitchen) vs DRINK (Barista) */}
                        {(() => {
                          const its = o.items || [];
                          const hf = its.some((i) => i.type === 'FOOD');
                          const hd = its.some((i) => i.type === 'DRINK');
                          if (!hf || !hd) return null;
                          const fk = o.kitchenStatus || 'PENDING';
                          const bk = o.baristaStatus || 'PENDING';
                          return (
                            <p className="mt-1 flex flex-wrap gap-1 text-[10px] font-bold">
                              <span className="rounded-full bg-[#FFD600]/15 px-2 py-0.5 text-[#8A6D00] dark:bg-[rgba(255,94,0,0.12)] dark:text-[#FF8A3D]">
                                Kitchen: {fk}
                              </span>
                              <span className="rounded-full bg-[#E2E8F0] px-2 py-0.5 text-[#64748B] dark:bg-[#2A2B36] dark:text-[#94A3B8]">
                                Barista: {bk}
                              </span>
                            </p>
                          );
                        })()}
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        {o.status === 'READY' && (
                          <button
                            type="button"
                            onClick={() => serveActiveOrder(o._id)}
                            className="rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1 text-xs font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner"
                          >
                            SERVE
                          </button>
                        )}
                        {o.status === 'SERVED' && (
                          <button
                            type="button"
                            onClick={() => setPayTarget(o)}
                            className="rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1 text-xs font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner"
                          >
                            {o.paymentRejectedAt ? 'RESUBMIT' : 'PAY'}
                          </button>
                        )}
                        {o.status === 'PAYMENT_PENDING' && (
                          <span className="rounded-xl bg-[#FEF3C7] border border-[#FDE68A] px-3 py-1 text-xs font-bold text-[#92400E]">Waiting for Cashier</span>
                        )}
                        {o.status === 'PENDING' && editingOrderId !== o._id && (
                          <span className="flex shrink-0 flex-col gap-1.5">
                            <button
                              type="button"
                              onClick={() => openOrderEdit(o)}
                              className="rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-1 text-xs font-bold text-[#64748B] dark:text-[#94A3B8] hover:text-[#1E293B] dark:hover:text-white"
                            >
                              {t('edit')}
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelOwnOrder(o._id)}
                              disabled={cancelOrderBusy}
                              className="rounded-xl border border-[#FECACA] bg-white dark:bg-[#1C1D24] px-3 py-1 text-xs font-bold text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50"
                            >
                              {confirmCancelId === String(o._id) ? t('tapAgain') : t('cancelOrder')}
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                    {o.paymentRejectedAt && o.status === 'SERVED' && (
                      <div className="mt-2 rounded-xl border border-[#FECACA] bg-[#FEF2F2] dark:bg-[rgba(255,94,0,0.12)] px-3 py-2 text-xs font-semibold text-[#DC2626] dark:text-[#FF8A3D]">
                        Payment returned by cashier{o.paymentRejectionReason ? `: ${o.paymentRejectionReason}` : '. Please correct and resubmit.'}
                      </div>
                    )}
                    <ul className="mt-2 space-y-1 text-xs">
                      {(o.items || []).map((it, i) => {
                        const isCancelled = !!it.cancelled;
                        const comps = Array.isArray(it.components) ? it.components : [];
                        return (
                          <li key={`${o._id}-${it.lineId || i}`} className={isCancelled ? "line-through text-[#DC2626] dark:text-[#FCA5A5]" : "text-[#64748B] dark:text-[#94A3B8]"}>
                            <div>
                              {`${it.quantity || 1}x ${
                                getLocalizedSingleString(it.name) ||
                                getLocalizedSingleString(it.title) ||
                                'Item'
                              }`}{isCancelled ? ` Cancelled${it.cancelReason ? `: ${it.cancelReason}` : ""}` : ""}
                            </div>
                            {comps.length > 0 && (
                              <ul className="ml-3 mt-0.5 space-y-0.5">
                                {comps.map((c, ci) => (
                                  <li key={`${o._id}-${it.lineId || i}-c-${ci}`} className={c.kind === "NOTE" ? "italic text-[#92400E] dark:text-[#FDBA74]" : "font-medium text-[#1E293B] dark:text-white"}>
                                    {c.kind === "NOTE" ? `• ${c.note}` : `• ${c.name} ×${c.quantity} @ ${c.unitPrice} ETB = ${c.lineSum ?? Math.round(c.quantity * c.unitPrice * 100) / 100} ETB`}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {editingOrderId === o._id && (
                      <div className="mt-2 space-y-2 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-2 text-xs">
                        {editLines
                          .filter((ln) => !editRemoved.has(ln.lineId))
                          .map((ln) => (
                            <div key={`edit-${ln.lineId}`} className="rounded-lg bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-2 py-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate font-bold text-[#1E293B] dark:text-white">{ln.name}</span>
                                <span className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    aria-label="decrease quantity"
                                    onClick={() => setEditLines((prev) => prev.map((x) => (x.lineId === ln.lineId ? { ...x, qty: Math.max(1, (Number(x.qty) || 1) - 1) } : x)))}
                                    className="flex h-6 w-6 items-center justify-center rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] font-bold text-[#1E293B] dark:text-white"
                                  >
                                    −
                                  </button>
                                  <span className="w-6 text-center font-bold text-[#1E293B] dark:text-white">{ln.qty}</span>
                                  <button
                                    type="button"
                                    aria-label="increase quantity"
                                    onClick={() => setEditLines((prev) => prev.map((x) => (x.lineId === ln.lineId ? { ...x, qty: Math.min(99, (Number(x.qty) || 1) + 1) } : x)))}
                                    className="flex h-6 w-6 items-center justify-center rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] font-bold text-[#1E293B] dark:text-white"
                                  >
                                    +
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditRemoved((prev) => new Set(prev).add(ln.lineId))}
                                    className="rounded-lg px-2 py-1 text-[11px] font-bold text-[#DC2626]"
                                  >
                                    {t('remove')}
                                  </button>
                                </span>
                              </div>
                              <input
                                type="text"
                                value={editNotes[ln.lineId] || ''}
                                onChange={(e) => setEditNotes((prev) => ({ ...prev, [ln.lineId]: e.target.value }))}
                                placeholder={t('note')}
                                maxLength={500}
                                className="mt-1.5 w-full rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-2 py-1.5 text-xs text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]"
                              />
                            </div>
                          ))}
                        <div className="flex gap-2">
                          <select
                            value={editAddMenu}
                            onChange={(e) => setEditAddMenu(e.target.value)}
                            aria-label={t('addItem')}
                            className="h-9 min-w-0 flex-1 rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-2 text-xs font-medium text-[#1E293B] dark:text-white focus:outline-none"
                          >
                            <option value="">{t('addItem')}</option>
                            {items
                              .filter((m) => m.isAvailable !== false && m.inStock !== false)
                              .map((m) => (
                                <option key={m._id || m.id} value={m._id || m.id}>
                                  {localizedName(m, lang)}
                                </option>
                              ))}
                          </select>
                          <input
                            type="number"
                            min="1"
                            max="99"
                            step="1"
                            value={editAddQty}
                            onChange={(e) => setEditAddQty(e.target.value)}
                            aria-label={t('qty')}
                            className="h-9 w-14 shrink-0 rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-2 text-xs text-[#1E293B] dark:text-white focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (!editAddMenu) return;
                              const q = Number(editAddQty);
                              if (!Number.isInteger(q) || q < 1 || q > 99) return;
                              setEditAdds((prev) => [...prev, { key: `${Date.now()}-${prev.length}`, menuId: editAddMenu, qty: q }]);
                              setEditAddMenu('');
                              setEditAddQty('1');
                            }}
                            className="h-9 shrink-0 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-3 text-xs font-bold text-[#1E293B] dark:text-white"
                          >
                            {t('add')}
                          </button>
                        </div>
                        {editAdds.length > 0 && (
                          <ul className="space-y-1">
                            {editAdds.map((a) => (
                              <li key={a.key} className="flex items-center justify-between gap-2 rounded-lg bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-2 py-1.5 text-xs font-bold text-[#1E293B] dark:text-white">
                                <span className="min-w-0 truncate">
                                  {(localizedName(items.find((m) => String(m._id || m.id) === String(a.menuId)), lang) || a.menuId)} ×{a.qty}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setEditAdds((prev) => prev.filter((x) => x.key !== a.key))}
                                  className="shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-bold text-[#DC2626]"
                                >
                                  {t('remove')}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {editError ? <p className="text-xs font-semibold text-[#DC2626]">{editError}</p> : null}
                        {editSavedMsg ? <p className="text-xs font-semibold text-[#15803D] dark:text-[#6EE7B7]">{editSavedMsg}</p> : null}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => saveOrderEdit(o._id)}
                            disabled={editBusy}
                            className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-2 text-xs font-bold text-[#1E293B] dark:text-white disabled:opacity-50"
                          >
                            {t('save')}
                          </button>
                          <button
                            type="button"
                            onClick={closeOrderEdit}
                            disabled={editBusy}
                            className="flex-1 rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] py-2 text-xs font-bold text-[#64748B] dark:text-[#94A3B8] disabled:opacity-50"
                          >
                            {t('cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                    {(() => {
                      const active = (o.items || []).filter((it) => !it.cancelled);
                      const cancelled = (o.items || []).filter((it) => it.cancelled);
                      if (cancelled.length === 0 && active.every((it) => !(it.components||[]).some((c)=>c.kind==="PRICED_COMPONENT"))) return null;
                      const net = active.reduce((s,it)=>{
                        const base = (Number(it.price)||0)*(Number(it.quantity)||0);
                        const comps = (it.components||[]).filter((c)=>c.kind==="PRICED_COMPONENT").reduce((cs,c)=>cs+(Number(c.lineSum)||Number(c.quantity)*Number(c.unitPrice)||0),0);
                        return s+base+comps;
                      },0);
                      const gross = Number(o.totalAmount)||0;
                      const compSum = active.reduce((s,it)=>(it.components||[]).filter((c)=>c.kind==="PRICED_COMPONENT").reduce((cs,c)=>cs+(Number(c.lineSum)||0),0)+s,0);
                      return (
                        <div className="mt-2 space-y-1 text-xs font-semibold">
                          {cancelled.length>0 && <p className="text-[#DC2626] dark:text-[#FCA5A5]">Net: {Math.round(net*100)/100} ETB {gross>net ? `(Gross ${gross} ETB, Cancelled ${Math.round((gross-net)*100)/100} ETB)` : ""}</p>}
                          {compSum>0 && <p className="text-[#1E293B] dark:text-white">Components: {Math.round(compSum*100)/100} ETB included</p>}
                        </div>
                      );
                    })()}
                  </div>
                  )}
                ))}
            </div>

            <div className="flex gap-2 border-t border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-4">
              <button
                type="button"
                onClick={() => pollActiveOrders({ includeServed: true })}
                className="flex-1 rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] py-3 text-sm font-bold text-[#1E293B] dark:text-white transition-all duration-150 ease-out     active:shadow-inner"
              >
                {t('refresh')}
              </button>
              <button
                type="button"
                onClick={() => setOrdersDrawerOpen(false)}
                className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-sm font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner"
              >
                {t('close')}
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* PAYMENT METHOD MODAL — inside frame on desktop */}
      {payTarget && (
        <div
          className="fixed md:absolute inset-0 z-[70] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 p-4 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !payBusy) setPayTarget(null);
          }}
        >
          <div className="w-full max-w-sm   overflow-hidden rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
            <div className="flex items-center gap-3 border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] px-5 py-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] text-lg">
                💳
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-base font-extrabold text-[#1E293B] dark:text-white">
                  {t('paymentTitle')}
                </h2>
                <p className="truncate text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
                  {`${t('table')} ${payTarget.tableNumber} ${payTarget.totalAmount} ETB`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPayTarget(null)}
                disabled={payBusy}
                aria-label={t('close')}
                className="ml-auto rounded-lg p-2 text-[#64748B] dark:text-[#94A3B8] transition-colors hover:bg-[#F4F5F9] dark:hover:bg-[#252631] hover:text-[#1E293B] dark:hover:text-white disabled:opacity-40"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 px-5 py-5">
              {payError && (
                <div
                  role="alert"
                  className="rounded-xl bg-[#FEF2F2] dark:bg-[rgba(255,94,0,0.12)] border border-[#FECACA] dark:border-[#FF5E00]/20 px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] dark:text-[#FF8A3D]"
                >
                  {payError}
                </div>
              )}
              {payTarget.paymentRejectedAt && (
                <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] dark:bg-[rgba(255,94,0,0.12)] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] dark:text-[#FF8A3D]">
                  Payment returned by cashier{payTarget.paymentRejectionReason ? `: ${payTarget.paymentRejectionReason}` : '. Please correct and resubmit.'}
                </div>
              )}

              <button
                type="button"
                onClick={() => confirmPayment('CASH')}
                disabled={payBusy}
                className="flex h-14 w-full items-center gap-3 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-4 text-left shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:opacity-50"
              >
                <span className="text-xl" aria-hidden="true">
                  💵
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-black text-[#1E293B] dark:text-white">{payTarget.paymentRejectedAt ? 'RESUBMIT CASH FOR VERIFICATION' : 'SUBMIT CASH FOR VERIFICATION'}</span>
                  <span className="block text-[11px] font-semibold text-[#1E293B]/70 dark:text-white/80">
                    {t('cash')} Waiting for cashier not paid yet
                  </span>
                </span>
              </button>

              <div className="rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] p-3">
                <p className="mb-2 text-xs font-black uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Transfer select account</p>
                {paymentAccountsLoading ? (
                  <p className="py-3 text-center text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">Loading accounts…</p>
                ) : paymentAccounts.length === 0 ? (
                  <p className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-xs font-semibold text-[#DC2626]">No transfer account is currently available. Please contact manager.</p>
                ) : (
                  <div className="space-y-1.5">
                    {paymentAccounts.map((acc) => {
                      const accId = String(acc._id || acc.id);
                      const selected = selectedTransferAccount === accId;
                      return (
                        <button
                          key={accId}
                          type="button"
                          onClick={() => setSelectedTransferAccount(accId)}
                          className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${selected ? "border-[#FFD600] dark:border-[#FF5E00] bg-[#FFD600]/15 dark:bg-[rgba(255,94,0,0.12)]" : "border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] hover:border-[#FFD600]/40"}`}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${selected ? "border-[#FFD600] dark:border-[#FF5E00] bg-[#FFD600] dark:bg-[#FF5E00]" : "border-[#CBD5E1] dark:border-[#2A2B36]"}`}>
                            {selected && <span className="h-2 w-2 rounded-full bg-[#1E293B] dark:bg-white" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-bold text-[#1E293B] dark:text-white">{acc.bankName} {acc.ownerName}</span>
                            <span className="block truncate text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">{acc.accountNumber}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => confirmPayment('TRANSFER')}
                  disabled={payBusy || paymentAccounts.length === 0 || !selectedTransferAccount}
                  className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-4 text-sm font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {payTarget.paymentRejectedAt ? 'Resubmit Transfer for Verification' : 'Submit Transfer for Verification'}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setPayTarget(null)}
                disabled={payBusy}
                className="w-full rounded-xl py-2.5 text-xs font-bold text-[#64748B] dark:text-[#94A3B8] transition-colors hover:bg-[#F4F5F9] dark:hover:bg-[#252631] disabled:opacity-40"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PAYMENT SUCCESS TOAST — inside frame on desktop */}
      {paymentToast && (
        <div className="pointer-events-none fixed md:absolute inset-x-0 top-[env(safe-area-inset-top)] z-[75] flex justify-center px-4 pt-2">
          <div className="  pointer-events-auto flex items-center gap-2 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-3 text-sm font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
            <span aria-hidden="true">✅</span>
            {paymentToast}
          </div>
        </div>
      )}

      {/* FLOATING CART BAR — inside frame on desktop */}
      {cartCount > 0 && !cartOpen && (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="fixed md:absolute inset-x-4 md:inset-x-3 bottom-4 md:bottom-3 z-40 flex items-center justify-between rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-5 py-3 font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner"
        >
          <span className="text-sm">{`${t('cart')} ${cartCount}`}</span>
          <span className="text-sm text-[#FFD600] dark:text-[#FF5E00]">{`${cartTotal} ETB`}</span>
        </button>
      )}

      {/* CART DRAWER — inside frame on desktop */}
      {cartOpen && (
        <div className="fixed md:absolute inset-0 z-50 flex">
          <div
            className="flex-1 bg-[#1E293B]/20 dark:bg-[#12131A]/60 backdrop-blur-sm"
            onClick={() => setCartOpen(false)}
          />
          <aside className="flex w-[88%] max-w-md   flex-col border-l border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-4">
              <h2 className="text-base font-bold text-[#1E293B] dark:text-white">{t('cart')}</h2>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-3 py-1 text-sm font-bold text-[#64748B] dark:text-[#94A3B8] transition-all duration-150 ease-out     active:shadow-inner"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              {cartEntries.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">{t('empty')}</p>
              ) : (
                cartEntries.map(({ item, qty, isExternal, components }) => {
                  const cartKey = item._id;
                  const comps = Array.isArray(components) ? components : [];
                  const noteCount = comps.filter((c) => c.kind === "NOTE").length;
                  const priced = comps.filter((c) => c.kind === "PRICED_COMPONENT");
                  const pricedSum = priced.reduce((s, c) => s + (Number(c.quantity) || 0) * (Number(c.unitPrice) || 0), 0);
                  return (
                    <div
                      key={`cart-${cartKey}`}
                      className="rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
                    >
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-[#1E293B] dark:text-white">
                            {localizedName(item, lang)}
                            {isExternal && (
                              <span className="ml-2 inline-flex items-center rounded-full bg-[#E2E8F0] dark:bg-[#2A2B36] px-1.5 py-0.5 text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">LEGACY EXTERNAL {item.type || 'FOOD'}</span>
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-[#64748B] dark:text-[#94A3B8]">{`${item.price} ETB × ${qty} = ${Math.round(item.price * qty * 100) / 100} ETB`}{pricedSum > 0 ? ` + components ${Math.round(pricedSum * 100) / 100} ETB` : ""}{noteCount > 0 ? ` ${noteCount} note${noteCount > 1 ? "s" : ""}` : ""}</p>
                        </div>
                        <div className="flex items-center gap-1.5 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-1.5 py-1">
                          <button type="button" onClick={() => changeQty(cartKey, -1)} aria-label="decrease quantity" className="flex h-7 w-7 items-center justify-center rounded-lg bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0] dark:border-[#2A2B36] shadow-sm">−</button>
                          <span className="min-w-4 text-center text-sm font-bold text-[#1E293B] dark:text-white">{qty}</span>
                          <button type="button" onClick={() => changeQty(cartKey, 1)} aria-label="increase quantity" className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm">+</button>
                        </div>
                        <button type="button" onClick={() => removeFromCart(cartKey)} aria-label="remove item" className="text-xs font-semibold text-[#64748B] dark:text-[#94A3B8] hover:text-[#DC2626] dark:hover:text-[#FF5E00]">✕</button>
                      </div>
                      {/* Components under parent */}
                      {comps.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {comps.map((c, idx) => (
                            <li key={`${cartKey}-comp-${idx}`} className={`flex items-center justify-between gap-2 rounded-xl px-2 py-1 text-xs ${c.kind === "NOTE" ? "bg-[#FEF3C7] dark:bg-[#7C2D12] text-[#92400E] dark:text-[#FDBA74] border border-[#FDE68A] dark:border-[#7C2D12]" : "bg-[#F4F5F9] dark:bg-[#12131A] border border-[#E2E8F0]/60 dark:border-[#2A2B36] text-[#1E293B] dark:text-white"}`}>
                              <span className="min-w-0 flex-1 truncate">
                                {c.kind === "NOTE" ? `• ${c.note}` : `• ${c.name} ×${c.quantity} @ ${c.unitPrice} ETB = ${Math.round(c.quantity * c.unitPrice * 100) / 100} ETB${c.inventoryItemId ? " linked" : ""}`}
                              </span>
                              <button type="button" onClick={() => removeComponentFromCart(cartKey, idx)} className="shrink-0 rounded-lg bg-white dark:bg-[#1C1D24] px-1.5 py-0.5 text-xs font-bold text-[#DC2626] border border-[#FECACA]">✕</button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Add component buttons */}
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingComponent({ cartKey, kind: "NOTE" });
                            setCompNote("");
                            setCompError("");
                          }}
                          className={`flex-1 rounded-xl py-2 text-xs font-bold border ${editingComponent?.cartKey === cartKey && editingComponent?.kind === "NOTE" ? "bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border-[#FFD600] dark:border-[#FF5E00]" : "bg-white dark:bg-[#1C1D24] text-[#64748B] dark:text-[#94A3B8] border-[#E2E8F0] dark:border-[#2A2B36]"}`}
                        >
                          + Note
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingComponent({ cartKey, kind: "PRICED" });
                            setCompName("");
                            setCompQty("1");
                            setCompPrice("");
                            setCompError("");
                          }}
                          className={`flex-1 rounded-xl py-2 text-xs font-bold border ${editingComponent?.cartKey === cartKey && editingComponent?.kind === "PRICED" ? "bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border-[#FFD600] dark:border-[#FF5E00]" : "bg-white dark:bg-[#1C1D24] text-[#64748B] dark:text-[#94A3B8] border-[#E2E8F0] dark:border-[#2A2B36]"}`}
                        >
                          + Priced Add-on
                        </button>
                      </div>
                      {/* Inline editors */}
                      {editingComponent?.cartKey === cartKey && editingComponent?.kind === "NOTE" && (
                        <div className="mt-2 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-2">
                          <input type="text" value={compNote} onChange={(e) => setCompNote(e.target.value)} placeholder="e.g. no onion, extra spicy" maxLength={500} className="w-full rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2 text-sm text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]" />
                          {compError && <p className="mt-1 text-xs text-[#DC2626]">{compError}</p>}
                          <div className="mt-2 flex gap-2">
                            <button type="button" onClick={() => addNoteToCart(cartKey)} className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-2 text-xs font-bold text-[#1E293B] dark:text-white">Add Note</button>
                            <button type="button" onClick={() => setEditingComponent(null)} className="flex-1 rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] py-2 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">Cancel</button>
                          </div>
                        </div>
                      )}
                      {editingComponent?.cartKey === cartKey && editingComponent?.kind === "PRICED" && (
                        <div className="mt-2 space-y-2 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-2">
                          <input type="text" value={compName} onChange={(e) => setCompName(e.target.value)} placeholder="Component name e.g. Extra Cheese" maxLength={100} className="w-full rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2 text-sm text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]" />
                          <div className="grid grid-cols-2 gap-2">
                            <input type="number" min="1" max="99" step="1" value={compQty} onChange={(e) => setCompQty(e.target.value)} placeholder="Qty" className="w-full rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2 text-sm text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]" />
                            <input type="number" min="0" step="0.01" value={compPrice} onChange={(e) => setCompPrice(e.target.value)} placeholder="Unit price ETB" className="w-full rounded-lg border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2 text-sm text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]" />
                          </div>
                          {compError && <p className="text-xs text-[#DC2626]">{compError}</p>}
                          <div className="flex gap-2">
                            <button type="button" onClick={() => addPricedToCart(cartKey)} className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-2 text-xs font-bold text-[#1E293B] dark:text-white">Add Priced</button>
                            <button type="button" onClick={() => setEditingComponent(null)} className="flex-1 rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] py-2 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">Cancel</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {orderDone && (
              <div className="mx-4 mb-2 rounded-2xl border border-[#FFD600]/20 dark:border-[#FF5E00]/20 bg-[#FFD600]/15 dark:bg-[rgba(255,94,0,0.12)] px-4 py-3 text-center text-sm font-bold text-[#8A6D00] dark:text-[#FF8A3D]">
                {`${t('ordered')}${orderDone.total != null ? ` (${orderDone.total} ETB)` : ''}`}
              </div>
            )}
            {orderError && (
              <div className="mx-4 mb-2 rounded-2xl border border-[#FECACA] dark:border-[#FF5E00]/20 bg-[#FEF2F2] dark:bg-[rgba(255,94,0,0.12)] px-4 py-3 text-center text-xs font-semibold text-[#DC2626] dark:text-[#FF8A3D]">
                {orderError}
              </div>
            )}

            <div className="border-t border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-4">
              <div className="mb-3 flex items-center justify-between text-sm">
                <span className="font-semibold text-[#64748B] dark:text-[#94A3B8]">{t('cart')}</span>
                <span className="font-bold text-[#1E293B] dark:text-white">{`${cartTotal} ETB`}</span>
              </div>
              <button
                type="button"
                disabled={submitting || cartEntries.length === 0}
                onClick={submitOrder}
                className="w-full rounded-2xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-sm font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:opacity-50"
              >
                {submitting ? '...' : t('send')}
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
