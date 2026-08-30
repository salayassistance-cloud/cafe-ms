'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { safeFetchJson, sendOrder, updateOrderStatusClient } from '@/lib/clientFetch';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useOrderEvents } from '@/lib/orderEvents';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';

const TABLE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

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
};

const STATUS_BADGE = {
  PENDING: 'bg-[rgba(255,214,0,0.12)] text-[#8A6D00] dark:bg-[rgba(255,94,0,0.12)] dark:text-[#FF8A3D] border border-[#FFD600]/20 dark:border-[#FF5E00]/20',
  PREPARING: 'bg-white text-[#64748B] dark:bg-[#1C1D24] dark:text-[#94A3B8] border border-[#E2E8F0] dark:border-[#2A2B36]',
  READY: 'bg-[#FFD600] text-[#1E293B] dark:bg-[#FF5E00] dark:text-white shadow-sm',
  SERVED: 'bg-[#F4F5F9] text-[#475569] dark:bg-[#12131A] dark:text-[#94A3B8] border border-[#E2E8F0]/60 dark:border-[#2A2B36]',
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
  const t = (key) => LABELS[key]?.[lang] || LABELS[key]?.en || '';

  const [lang, setLang] = useState('am');
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const langBtnRef = useRef(null);
  const [selectedTable, setSelectedTable] = useState(1);
  const [waiterName, setWaiterName] = useState('Waiter');
  const [waiterId, setWaiterId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    safeFetchJson('/api/auth/me', { cache: 'no-store' }).then((data) => {
      if (cancelled) return;
      if (data?.success && data?.data?.name) {
        setWaiterName(data.data.name);
        setWaiterId(data.data.staffId);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

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

  const [externalOpen, setExternalOpen] = useState(false);
  const [extName, setExtName] = useState('');
  const [extQty, setExtQty] = useState('1');
  const [extType, setExtType] = useState('FOOD');
  const [extPrice, setExtPrice] = useState('');
  const [extError, setExtError] = useState('');

  const [readyToasts, setReadyToasts] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const [ordersDrawerOpen, setOrdersDrawerOpen] = useState(false);
  const ordersDrawerOpenRef = useRef(false);

  const [payTarget, setPayTarget] = useState(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState('');
  const [paymentToast, setPaymentToast] = useState('');

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

  // Lazily fetch SERVED orders only when the SERVED drawer is opened, then merge
  // them into the single display list so the drawer shows SERVED exactly as before.
  const loadServedOrders = useCallback(async () => {
    try {
      const served = await safeFetchJson('/api/orders?status=SERVED', { cache: 'no-store' });
      if (!served?.success) return;
      setActiveOrders((prev) => {
        const byId = new Map(prev.map((o) => [o._id, o]));
        for (const o of (served.data?.orders || [])) byId.set(o._id, o);
        return Array.from(byId.values());
      });
    } catch {
      // Keep current ACTIVE list on failure; drawer remains usable for active orders
    }
  }, []);

  // Background refresh: when the SERVED drawer is closed we fetch ONLY the ACTIVE
  // board (1 GET). When it is open we also fetch SERVED so its data stays correct.
  const pollActiveOrders = useCallback(async (opts) => {
    const includeServed = (opts && opts.includeServed) || ordersDrawerOpenRef.current;
    try {
      const requests = [safeFetchJson('/api/orders', { cache: 'no-store' })];
      if (includeServed) {
        requests.push(safeFetchJson('/api/orders?status=SERVED', { cache: 'no-store' }));
      }
      const [prep, served] = await Promise.all(requests);
      if (!prep?.success) return;
      const byId = new Map();
      for (const o of (prep.data?.orders || [])) byId.set(o._id, o);
      if (includeServed && served?.success) {
        for (const o of (served.data?.orders || [])) byId.set(o._id, o);
      }
      const list = Array.from(byId.values());
      const prev = prevActiveRef.current;
      if (prev.size > 0) {
        for (const o of list) {
          const was = prev.get(o._id);
          if (was && was.status !== 'READY' && o.status === 'READY') {
            // Server already filters to own orders (waiterId == session.staffId), so any READY here is own
            pushReadyToast(o.orderNumber, o.tableNumber);
          }
        }
      }
      prevActiveRef.current = new Map(list.map((o) => [o._id, o]));
      setActiveOrders(list);
    } catch (err) {
      // Session expiration: 401 must not be hidden as 503 — redirect to login
      if (err && (err.status === 401 || /session expired|authentication required|invalid or expired/i.test(err.message || ""))) {
        // Avoid spamming redirects during polling — only redirect if no activeOrders yet or after delay
        // Show toast and redirect to /waiter login
        setOrderError("Your session has expired. Please sign in again.");
        setTimeout(() => { try { window.location.assign("/waiter"); } catch {} }, 1200);
      }
    }
  }, [pushReadyToast]);

  const refreshTimer = useRef(null);
  const scheduleOrdersRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(pollActiveOrders, 150);
  }, [pollActiveOrders]);

  const handleOrderEvent = useCallback(
    (event) => {
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
        }
      }
    },
    [scheduleOrdersRefresh, pushReadyToast, pollMenu]
  );

  useOrderEvents(handleOrderEvent);

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

  const cartEntries = Object.values(cart);
  const cartCount = cartEntries.reduce((sum, entry) => sum + entry.qty, 0);
  const cartTotal = cartEntries.reduce(
    (sum, entry) => sum + entry.qty * (entry.item.price || 0),
    0
  );

  function addToCart(item) {
    if (!item.isAvailable) return;
    setCart((prev) => {
      const existing = prev[item._id];
      return {
        ...prev,
        [item._id]: {
          item,
          qty: (existing?.qty || 0) + 1,
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

  // Append a manually-entered external item (EXTERNAL ITEM REQUEST).
  // Required fields: Item Name, Quantity, Type (FOOD/DRINK), Price.
  // Routing is automatic via type; will be stored with EXTERNAL ITEM tag and shown in Manager Reports.
  function addExternalItem() {
    const name = extName.trim();
    const price = Number(extPrice);
    const qty = Number(extQty);
    const type = String(extType).toUpperCase() === "DRINK" ? "DRINK" : "FOOD";
    if (!name) {
      setExtError(t('extName') + ' ' + t('required'));
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      setExtError("Quantity must be 1-99");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setExtError(t('extPrice') + ' ' + t('required'));
      return;
    }
    const extId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setCart((prev) => ({
      ...prev,
      [extId]: {
        item: {
          _id: extId,
          title: name,
          price: Math.round(price * 100) / 100,
          type,
          isExternal: true,
        },
        qty,
        isExternal: true,
      },
    }));
    setExtName('');
    setExtQty('1');
    setExtType('FOOD');
    setExtPrice('');
    setExtError('');
    setExternalOpen(false);
    setOrderDone(null);
  }

  async function submitOrder() {
    if (cartEntries.length === 0 || submitting) return;
    setSubmitting(true);
    setOrderError('');
    try {
      const normalEntries = cartEntries.filter((e) => !e.isExternal);
      const externalEntries = cartEntries.filter((e) => e.isExternal);
      let total = 0;

      // Normal catalog items — server derives waiter identity from authenticated session (staffId)
      // and resolves canonical FOOD/DRINK routing from MenuItem doc via itemId (server-authoritative).
      if (normalEntries.length > 0) {
        const payload = {
          tableNumber: selectedTable,
          items: normalEntries.map(({ item, qty }) => ({
            itemId: item._id,
            name: item.title,
            price: item.price,
            quantity: qty,
            type: item.categoryType || (item.targetStation === "BARISTA" || item.barista ? "DRINK" : "FOOD"),
          })),
        };
        const data = await sendOrder(payload);
        total += data.data?.order?.totalAmount ?? 0;
      }

      // External item REQUESTS — push to /api/external-items (server derives waiter
      // identity from session, stamps PENDING). These surface under the EXTERNAL ITEM
      // tag in Manager Reports and never enter the kitchen/barista workflow.
      if (externalEntries.length > 0) {
        const extRes = await safeFetchJson('/api/external-items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tableNumber: selectedTable,
            items: externalEntries.map(({ item, qty }) => ({
              name: item.title,
              price: item.price,
              quantity: qty,
              type: item.type || "FOOD",
            })),
          }),
        });
        if (!extRes.success) throw new Error(extRes.error || 'External item request failed');
      }

      setOrderDone({ total });
      setCart({});
      setCartOpen(false);
    } catch (err) {
      const s = err && err.status;
      if (s === 401) setOrderError("Your session has expired. Please sign in again.");
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

  async function confirmPayment(method) {
    if (!payTarget || payBusy) return;
    const paymentMethod = method === 'TRANSFER' ? 'TELEBIRR' : 'CASH';
    setPayBusy(true);
    setPayError('');
    try {
      const data = await safeFetchJson(`/api/orders/${payTarget._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PAID', paymentMethod }),
      });
      if (data.success) {
        setActiveOrders((prev) => prev.filter((o) => o._id !== payTarget._id));
        setPaymentToast(t('paidToast'));
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
                        try {
                          await safeFetchJson('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
                        } catch {}
                        window.location.assign('/waiter');
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
              aria-label={`${t('activeOrders')} (${activeOrders.length})`}
              aria-haspopup="dialog"
              aria-expanded={ordersDrawerOpen}
              className="relative flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-xs sm:text-sm font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
            >
              <span>{t('activeOrders')}</span>
              {activeOrders.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white dark:bg-white px-1 text-[11px] font-extrabold text-[#1E293B] shadow-sm border border-[#E2E8F0] dark:border-white">
                  {activeOrders.length}
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
          <div className="flex flex-col gap-3">
            {visibleItems.map((item, idx) => {
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
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={localizedName(item, lang) || t('empty')}
                          className="h-full w-full object-cover object-center"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[10px] text-[#94A3B8]">
                          {t('empty')}
                        </div>
                      )}
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

                  {/* RIGHT SIDE: PRICE + ADD */}
                  <div className="flex shrink-0 items-center gap-2 pl-3">
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
              <button
                type="button"
                onClick={() => setOrdersDrawerOpen(false)}
                aria-label={t('close')}
                className="rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-3 py-1 text-sm font-bold text-[#64748B] dark:text-[#94A3B8] transition-all duration-150 ease-out     active:shadow-inner"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              {activeOrders.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">
                  {t('noOrders')}
                </p>
              ) : (
                activeOrders.map((o) => (
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
                          const fk = o.kitchenStatus || o.status;
                          const bk = o.baristaStatus || o.status;
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
                        {(o.status === 'READY' || o.status === 'SERVED') && (
                          <button
                            type="button"
                            onClick={() => setPayTarget(o)}
                            className="rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1 text-xs font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner"
                          >
                            PAY
                          </button>
                        )}
                      </div>
                    </div>
                    <ul className="mt-2 space-y-0.5 text-xs text-[#64748B] dark:text-[#94A3B8]">
                      {(o.items || []).map((it, i) => (
                        <li key={`${o._id}-${i}`}>
                          {`${it.quantity || 1}x ${
                            getLocalizedSingleString(it.name) ||
                            getLocalizedSingleString(it.title) ||
                            'Item'
                          }`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
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
                  {`${t('table')} ${payTarget.tableNumber} · ${payTarget.totalAmount} ETB`}
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
                  <span className="block text-sm font-black text-[#1E293B] dark:text-white">CASH</span>
                  <span className="block text-[11px] font-semibold text-[#1E293B]/70 dark:text-white/80">
                    {t('cash')}
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => confirmPayment('TRANSFER')}
                disabled={payBusy}
                className="flex h-14 w-full items-center gap-3 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-4 text-left shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:opacity-50"
              >
                <span className="text-xl" aria-hidden="true">
                  📱
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-black text-[#1E293B] dark:text-white">
                    TRANSFER
                  </span>
                  <span className="block text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
                    {t('transfer')}
                  </span>
                </span>
              </button>

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
          <span className="text-sm">{`${t('cart')} · ${cartCount}`}</span>
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
                cartEntries.map(({ item, qty, isExternal }) => (
                  <div
                    key={`cart-${item._id}`}
                    className="flex items-center gap-3 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#1E293B] dark:text-white">
                        {localizedName(item, lang)}
                        {isExternal && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-[#E2E8F0] dark:bg-[#2A2B36] px-1.5 py-0.5 text-[10px] font-bold text-[#64748B] dark:text-[#94A3B8]">EXTERNAL ITEM · {item.type || 'FOOD'}</span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-[#64748B] dark:text-[#94A3B8]">{`${item.price} ETB`}{isExternal ? ` · Qty ${qty} · ${item.type}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-1.5 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-1.5 py-1">
                      <button
                        type="button"
                        onClick={() => changeQty(item._id, -1)}
                        aria-label="decrease quantity"
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0] dark:border-[#2A2B36] shadow-sm transition-all duration-150 ease-out    "
                      >
                        −
                      </button>
                      <span className="min-w-4 text-center text-sm font-bold text-[#1E293B] dark:text-white">{qty}</span>
                      <button
                        type="button"
                        onClick={() => changeQty(item._id, 1)}
                        aria-label="increase quantity"
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out    "
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFromCart(item._id)}
                      aria-label="remove item"
                      className="text-xs font-semibold text-[#64748B] dark:text-[#94A3B8] hover:text-[#DC2626] dark:hover:text-[#FF5E00]"
                    >
                      ✕
                    </button>
                  </div>
                ))
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
                onClick={() => setExternalOpen(true)}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] py-2.5 text-sm font-bold text-[#1E293B] dark:text-white transition-all duration-150 ease-out    "
              >
                <span aria-hidden="true">＋</span>
                {t('addExternal')}
              </button>
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

      {externalOpen && (
        <div
          className="fixed md:absolute inset-0 z-[60] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
          onClick={() => setExternalOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-3xl bg-[#F4F5F9] dark:bg-[#12131A] p-5 sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-[#1E293B] dark:text-white">EXTERNAL ITEM REQUEST</h2>
              <button
                type="button"
                onClick={() => setExternalOpen(false)}
                aria-label="close"
                className="text-lg text-[#64748B] dark:text-[#94A3B8]"
              >
                ✕
              </button>
            </div>

            <label className="mb-1 block text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">Item Name *</label>
            <input
              type="text"
              value={extName}
              onChange={(e) => setExtName(e.target.value)}
              placeholder="Special Juice"
              className="mb-3 w-full rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2 text-sm text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]"
            />

            <label className="mb-1 block text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">Quantity *</label>
            <input
              type="number"
              min="1"
              max="99"
              step="1"
              value={extQty}
              onChange={(e) => setExtQty(e.target.value)}
              placeholder="1"
              className="mb-3 w-full rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2 text-sm text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]"
            />

            <label className="mb-1 block text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">Type *</label>
            <div className="mb-3 flex gap-2">
              {['FOOD','DRINK'].map((tp)=> (
                <button key={tp} type="button" onClick={()=> setExtType(tp)} className={`flex-1 rounded-xl py-2.5 text-xs font-bold border ${extType===tp ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border-[#FFD600] dark:border-[#FF5E00]' : 'bg-white dark:bg-[#1C1D24] text-[#64748B] dark:text-[#94A3B8] border-[#E2E8F0] dark:border-[#2A2B36]'}`}>{tp}</button>
              ))}
            </div>

            <label className="mb-1 block text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">Price (ETB) *</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={extPrice}
              onChange={(e) => setExtPrice(e.target.value)}
              placeholder="120"
              className="mb-3 w-full rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2 text-sm text-[#1E293B] dark:text-white outline-none focus:border-[#FFD600] dark:focus:border-[#FF5E00]"
            />

            {extError && (
              <p className="mb-3 text-xs font-semibold text-[#DC2626] dark:text-[#FF8A3D]">{extError}</p>
            )}

            <button
              type="button"
              onClick={addExternalItem}
              className="w-full rounded-2xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-sm font-bold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner"
            >
              SEND REQUEST
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
