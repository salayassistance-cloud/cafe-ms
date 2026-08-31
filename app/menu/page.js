'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { safeFetchJson } from '@/lib/clientFetch';
import { getLocalizedSingleString } from '@/lib/displayName';
import { useLanguage } from '@/app/components/LanguageProvider';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';
import { convertPrice, formatPrice } from '@/lib/currency';
import { useOrderEvents } from '@/lib/orderEvents';

const LANGUAGES = [
  { code: 'am', label: 'አማርኛ', short: 'AM' },
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'om', label: 'Oromia', short: 'OM' },
];

const TEXTS = {
  all: { am: 'ሁሉም', en: 'All', om: 'Hunda' },
  special: { am: 'ልዩ እና አዲስ', en: 'Special & New', om: 'Addaa fi Haaraa' },
  categories: { am: 'ምድቦችን ይመልከቱ', en: 'Explore Categories', om: 'Gareewwan Ilaali' },
  popular: { am: 'ታዋቂ ምግቦች', en: 'Popular Items', om: 'Nyaata Baayee Jaalatamaa' },
  search: { am: 'ቡና፣ ምግቦችን ይፈልጉ...', en: 'Search coffee, food...', om: 'Buna, nyaata barbaadi...' },
  add: { am: 'ጨምር', en: 'Add', om: 'Iduu' },
  addToOrder: { am: 'ወደ ትዕዛዝ ጨምር', en: 'Add to Order', om: 'Ajajaattiin Dabalaa' },
  badgeSpecial: { am: 'ልዩ', en: 'Special', om: 'Addaa' },
  cart: { am: 'ጋሪ', en: 'Cart', om: 'Kaartaa' },
  empty: { am: 'ምንም ምግቦች አልተገኙም', en: 'No items found', om: 'Nyaanni hin argamne' },
  filter: { am: 'አጣራ እና ደርድር', en: 'Filter & Sort', om: 'Filtar' },
  priceLowHigh: { am: 'ዋጋ፡ ከዝቅተኛ ወደ ከፍተኛ', en: 'Price: Low → High', om: 'Gatii: Xiqqaa → Guddaa' },
  sortLabel: { am: 'ቅደም ተከተል', en: 'Sort', om: 'Tartiba' },
  dietLabel: { am: 'አሞግ', en: 'Dietary', om: 'Soorata' },
  fasting: { am: 'ጾም', en: 'Fasting', om: 'Soomii' },
  nonFasting: { am: 'ያልጾም', en: 'Non-Fasting', om: 'Hin soomne' },
  outStock: { am: 'ያለቀ', en: 'Out of Stock', om: 'Dhuma' },
  cash: { am: 'ጥሬ ገንዘብ', en: 'Cash', om: 'Maallaqa' },
  transfer: { am: 'በባንክ/ትራንስፈር', en: 'Bank / Transfer', om: 'Baankii' },
  paymentTitle: { am: 'የክፍያ መንገድ ይምረጡ', en: 'Select Payment Method', om: 'Karaa Kaffaltii Filadhu' },
  close: { am: 'ዝጋ', en: 'Close', om: 'Cufi' },
  cancel: { am: 'ሰርዝ', en: 'Cancel', om: 'Haqi' },
  standBack: { am: 'ዝጋ', en: 'Close', om: 'Cufa' },
  payInfoTitle: { am: 'የባንክ ዝርዝር', en: 'Bank Details', om: 'Baanii' },
  copy: { am: 'ቅዳ', en: 'Copy', om: 'Baafadhu' },
  copied: { am: 'ተቀዳ', en: 'Copied', om: 'Baafame' },
  accountNum: { am: 'የካሪያ ቁጥር', en: 'Account Number', om: 'Lakkoofsa Herrega' },
  ownerName: { am: 'የባለው ስም', en: 'Owner Name', om: 'Maqaa Kanatti' },
  bankName: { am: 'የባንክ ስም', en: 'Bank Name', om: 'Maqaa Baankii' },
  noPayment: { am: 'የክፍያ መረጃ የለም', en: 'No payment information available', om: 'Maallaqn maaloo hin jiru' },
};

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

const SKELETON_COUNT = 8;
const MENU_HISTORY_GUARD = '__menuHistoryGuard';

// Reuse the existing localization helper to read the multilingual fields already
// returned by /api/menu (item.name/description are {en,am,om} objects; categories
// expose nameObj). No new data model, no backend changes — only frontend wiring.
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
function localizedCat(cat, lang) {
  return (
    getLocalizedSingleString(cat?.nameObj, lang) ||
    getLocalizedSingleString(cat?.name, lang)
  );
}

export default function MenuPage() {
  const { lang, setLang } = useLanguage();
  const tx = (key) => TEXTS[key]?.[lang] || TEXTS[key]?.en || '';

  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState('default');
  const [dietFilter, setDietFilter] = useState('all'); // 'all' | 'fasting' | 'nonFasting'
  const [filterOpen, setFilterOpen] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [currency, setCurrency] = useState('ETB');
  const [loading, setLoading] = useState(true);

  const [cart, setCart] = useState({});
  const [cartOpen, setCartOpen] = useState(false);
  const [cartBump, setCartBump] = useState(0);
  const [payOpen, setPayOpen] = useState(false);
  const [paymentInfos, setPaymentInfos] = useState([]);
  const [payLoading, setPayLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [branding, setBranding] = useState({ name: '', logoPath: '' });
  const [logoError, setLogoError] = useState(false);

  const filterRef = useRef(null);
  const langBtnRef = useRef(null);

  // Keep direct QR visits inside the customer menu when / is behind this entry.
  // A same-document sentinel also covers hard navigations from the homepage.
  useEffect(() => {
    const menuPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const menuState = {
      ...(window.history.state || {}),
      [MENU_HISTORY_GUARD]: true,
    };
    const keepMenuEntry = () => window.history.pushState(menuState, '', menuPath);

    if (window.history.state?.[MENU_HISTORY_GUARD] !== true) keepMenuEntry();

    function keepMenuOpen(event) {
      event.stopImmediatePropagation();
      keepMenuEntry();
    }
    window.addEventListener('popstate', keepMenuOpen, true);
    return () => window.removeEventListener('popstate', keepMenuOpen, true);
  }, []);

  // Single source of truth — unified MongoDB via /api/menu (Category & MenuItem from /manager/menu-crud).
  // all=true → existing API flag returning the full catalog incl. unavailable
  // items so they can be DISPLAYED with a disabled action (ordering still blocked).
  // Multilingual data is returned as objects (name/description), so the current
  // language selection is preserved automatically on every refetch.
  const loadMenu = useCallback(async (opts) => {
    try {
      setLoading(true);
      // A real-time SSE refresh passes fresh=1 and no-store so the route returns
      // authoritative DB data (no-store) instead of the 60s-cached catalog.
      // Include lang so description/categoryName localization matches the user's selection.
      const langParam = opts?.lang || lang;
      const url = `/api/menu?all=true&lang=${encodeURIComponent(langParam)}${opts?.noStore ? "&fresh=1" : ""}`;
      const raw = await safeFetchJson(url, opts?.noStore ? { cache: 'no-store' } : undefined);
      // Normalize both envelope shapes: {success,data:{categories,items}} and {ok,categories,items} and {data:{categories}}
      const payload = raw?.data && (raw.data.categories || raw.data.items) ? raw.data : raw;
      const cats = payload?.categories || payload?.data?.categories || [];
      const its = payload?.items || payload?.data?.items || [];
      // Ensure each entity has normalized _id/id for React keys and cart lookups
      const normCats = cats.map((c) => ({ ...c, _id: c._id || c.id, id: c.id || c._id }));
      const normItems = its.map((i) => ({
        ...i,
        _id: i._id || i.id,
        id: i.id || i._id,
        // Ensure title remains usable for getLocalizedSingleString
        title: i.title || i.name || "",
        imageUrl: i.imageUrl || i.image || "",
      }));
      setCategories(normCats);
      setItems(normItems);
    } catch (e) {
    } finally {
      setLoading(false);
    }
  }, [lang]);

  useEffect(() => {
    // Defer so the loader's setState is not synchronous within the effect body.
    (async () => {
      await loadMenu();
    })();
  }, [loadMenu]);

  // Real-time menu sync: manager CRUD publishes "menu-changed" over the existing
  // SSE channel; refetch the authoritative catalog (no extra SSE connection).
  const handleMenuEvent = useCallback((event) => {
    if (event && event.type === 'menu-changed') {
      loadMenu({ noStore: true });
    }
  }, [loadMenu]);

  useOrderEvents(handleMenuEvent);

  // Load store branding (cafe name + logo) for the header.
  useEffect(() => {
    let ignore = false;
    async function fetchBranding() {
      try {
        const raw = await safeFetchJson('/api/brand');
        if (!ignore && raw?.success && raw?.data?.brand) {
          setBranding(raw.data.brand);
          setLogoError(false);
        }
      } catch (e) {
      }
    }
    fetchBranding();
    return () => {
      ignore = true;
    };
  }, []);

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

  useEffect(() => {
    if (!payOpen) return;
    let ignore = false;
    async function fetchPaymentInfos() {
      setPayLoading(true);
      try {
        const raw = await safeFetchJson('/api/payment-info');
        if (ignore) return;
        const list = raw?.data?.paymentInfos || raw?.paymentInfos || [];
        setPaymentInfos(list.filter((p) => p.isActive !== false));
      } catch (e) {
        if (!ignore) setPaymentInfos([]);
      } finally {
        if (!ignore) setPayLoading(false);
      }
    }
    fetchPaymentInfos();
    return () => {
      ignore = true;
    };
  }, [payOpen]);

  const copyToClipboard = async (text, id) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const categoryFiltered =
    selectedCategory === 'ALL'
      ? items
      : items.filter((item) => item.categoryId === selectedCategory);

  const dietFiltered =
    dietFilter === 'all'
      ? categoryFiltered
      : categoryFiltered.filter((item) =>
          dietFilter === 'fasting' ? !!item.isFasting : !!item.isNonFasting
        );

  const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searchedItems = terms.length
    ? dietFiltered.filter((item) => {
        const haystack = buildSearchHaystack(item);
        return terms.every((term) => haystack.includes(term));
      })
    : dietFiltered;

  const visibleItems = [...searchedItems];
  if (sortMode === 'price') {
    visibleItems.sort((a, b) => (a.price || 0) - (b.price || 0));
  }

  const specialItems = items.filter((i) => i.isAvailable !== false).slice(0, 10);

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
        [item._id]: { item, qty: (existing?.qty || 0) + 1 },
      };
    });
    setCartBump((n) => n + 1);
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

  const priceOf = (p) => formatPrice(convertPrice(p || 0, currency), currency);

  return (
    <div className="w-full md:max-w-[420px] lg:max-w-[440px] mx-auto h-[100dvh] max-h-[100dvh] md:h-[100vh] md:max-h-[100vh] min-h-[100dvh] overflow-hidden bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col md:shadow-[0_4px_24px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.05)] md:rounded-[10px] relative font-[family-name:var(--font-geist-sans)] font-light">
      {/* Local style: banner auto-scroll marquee + light menu typography helpers */}
      <style>{`
        @keyframes menu-banner-scroll { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .menu-banner-track { animation: menu-banner-scroll 30s linear infinite; }
        .menu-banner-viewport:hover .menu-banner-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) { .menu-banner-track { animation: none; } }
      `}</style>
      <div className="flex flex-1 flex-col bg-[#F4F5F9] dark:bg-[#12131A] text-[#1E293B] dark:text-white pb-8 h-full max-h-full min-h-0 overflow-hidden">
      {/* HEADER — Sunshine Yellow in light, transparent in dark */}
      <header className="sticky top-0 z-40 bg-[#FFDC00] dark:bg-transparent border-b border-[#E2E8F0]/60 dark:border-transparent dark:border-none pt-[env(safe-area-inset-top)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-none backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pb-3 pt-3">
          {/* LEFT — Hotel Logo + Brand Name */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden bg-transparent">
              {branding.logoPath && !logoError ? (
                <img
                  src={branding.logoPath}
                  alt={branding.name || 'logo'}
                  onError={() => setLogoError(true)}
                  className="h-full w-full object-contain"
                />
              ) : null}
            </div>
              <div className="min-w-0 leading-tight">
                <h1 className="truncate text-[13px] font-semibold tracking-wide text-[#1E293B] dark:text-white">{branding.name}</h1>
              </div>
          </div>

          {/* RIGHT — Language · Currency · Light/Dark Mode */}
          <div className="flex items-center gap-2">
            {/* LANGUAGE SELECTOR DROPDOWN */}
            <div ref={langBtnRef} className="relative">
              <button
                type="button"
                onClick={() => setLangMenuOpen((o) => !o)}
                aria-label="Language"
                aria-haspopup="menu"
                aria-expanded={langMenuOpen}
                className="flex h-8 items-center gap-1 rounded-full border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-2.5 text-[11px] font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
              >
                <span>{LANGUAGES.find((l) => l.code === lang)?.short || lang}</span>
                <span className="text-[10px] leading-none" aria-hidden="true">▼</span>
              </button>
              {langMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-2 w-36 origin-top-right overflow-hidden rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
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
                </div>
              )}
            </div>

            {/* CURRENCY SELECTOR PILL */}
            <button
              type="button"
              onClick={() => setCurrency((c) => (c === 'ETB' ? 'USD' : 'ETB'))}
              aria-label="Currency"
              className="flex h-8 items-center rounded-full bg-[#FFD600] dark:bg-[#FF5E00] px-2.5 text-[11px] font-extrabold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
            >
              {currency}
            </button>

            {/* DARK / LIGHT MODE TOGGLE — identical to the Home page (visually scaled down for /menu only) */}
            <span className="inline-flex scale-90 origin-center"><ThemeToggleHome /></span>

          </div>
        </div>
      </header>

      <main className="relative z-0 mx-auto w-full max-w-3xl bg-[#F4F5F9] dark:bg-[#12131A] px-4 py-4 pb-8 space-y-5 flex-1 overflow-y-auto custom-scrollbar">
        {/* SEARCH + FILTER — part of the scrolling content layer (scrolls behind navbar) */}
        <div className="mb-3">
          <div className="flex w-full items-center justify-between rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-1.5 pl-4 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
          <div className="flex min-w-0 flex-1 items-center mr-2">
            <svg viewBox="0 0 24 24" fill="none" className="mr-2.5 h-5 w-5 shrink-0 text-[#64748B] dark:text-[#94A3B8]" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={tx('search')}
              aria-label="Search menu"
              className="w-full bg-transparent border-none pl-1 pr-1 text-[11px] sm:text-xs text-[#1E293B] dark:text-white placeholder-[#64748B] dark:placeholder-[#94A3B8] focus:outline-none"
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

          <div ref={filterRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setFilterOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              aria-label={tx('filter')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            {filterOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-56 origin-top-right overflow-y-auto rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
              >
                <p className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#64748B] dark:text-[#94A3B8]">
                  {tx('sortLabel')}
                </p>
                {[
                  { key: 'all', label: tx('all') },
                  { key: 'price', label: tx('priceLowHigh') },
                ].map((opt) => {
                  const active =
                    opt.key === 'all'
                      ? sortMode === 'default' && dietFilter === 'all'
                      : sortMode === 'price' && dietFilter === 'all';
                  return (
                    <button
                      key={`sort-${opt.key}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (opt.key === 'all') { setSortMode('default'); setDietFilter('all'); }
                        else { setSortMode('price'); setDietFilter('all'); }
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
                            <path d="M2.5 6l2.5 2.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      {opt.label}
                    </button>
                  );
                })}
                <div className="my-1 border-t border-[#E2E8F0]/60 dark:border-[#2A2B36]" />
                <p className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#64748B] dark:text-[#94A3B8]">
                  {tx('dietLabel')}
                </p>
                {[
                  { key: 'fasting', label: tx('fasting') },
                  { key: 'nonFasting', label: tx('nonFasting') },
                ].map((opt) => {
                  const active = dietFilter === opt.key;
                  return (
                    <button
                      key={`diet-${opt.key}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSortMode('default');
                        setDietFilter(opt.key);
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
                            <path d="M2.5 6l2.5 2.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        </div>

        {/* SPECIAL & NEW — horizontal scrollable banner */}
        <section>
          <h2 className="mb-3 text-[15px] font-medium text-[#1E293B] dark:text-white">{tx('special')}</h2>
          {loading ? (
            <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div key={`sp-skel-${idx}`} className="h-28 w-80 max-w-[calc(100vw-2rem)] shrink-0 animate-pulse rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24]" />
              ))}
            </div>
          ) : specialItems.length === 0 ? (
            <div className="flex min-h-[12rem] items-center justify-center text-center text-sm text-[#64748B] dark:text-[#94A3B8]">{tx('empty')}</div>
          ) : (
            <div className="menu-banner-viewport overflow-hidden">
              <div className="menu-banner-track flex w-max gap-3 pb-1">
                {[...specialItems, ...specialItems].map((item, bIdx) => {
                  const available = item.isAvailable !== false;
                  const inCart = cart[item._id];
                  const description = localizedDesc(item, lang);
                  return (
                    <article
                      key={`special-${bIdx}-${item._id}`}
                      className="flex w-80 max-w-[calc(100vw-2rem)] shrink-0 snap-start gap-4 rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_8px_22px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_26px_-12px_rgba(0,0,0,0.55)]"
                    >
                      {/* LEFT — badge · title · subtitle · price + action */}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="self-start rounded-full border border-[#FFD600]/20 bg-[#FFD600]/15 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-[#8A6D00] dark:border-[#FF5E00]/20 dark:bg-[rgba(255,94,0,0.12)] dark:text-[#FF8A3D]">
                          {tx('badgeSpecial')}
                        </span>
                        <h3 className="mt-2 truncate text-[15px] font-medium text-[#1E293B] dark:text-white">
                          {localizedName(item, lang)}
                        </h3>
                        {description && (
                          <p className="mt-1 line-clamp-2 text-xs opacity-80 text-[#64748B] dark:text-[#94A3B8]">
                            {description}
                          </p>
                        )}
                        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                          <span className="whitespace-nowrap text-base font-bold text-[#1E293B] dark:text-white">
                            {priceOf(item.price)}
                          </span>
                          {!available ? (
                            <span className="rounded-full border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-2.5 py-1.5 text-[10px] font-bold text-[#94A3B8]">
                              {tx('outStock')}
                            </span>
                          ) : inCart ? (
                            <div className="flex items-center justify-center gap-1.5 rounded-full border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-1.5 py-1">
                              <button type="button" onClick={() => changeQty(item._id, -1)} aria-label="decrease quantity" className="flex h-7 w-7 items-center justify-center rounded-full bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0] dark:border-[#2A2B36] shadow-sm transition-all duration-150 ease-out    ">−</button>
                              <span className="min-w-4 text-center text-xs font-bold text-[#1E293B] dark:text-white">{inCart.qty}</span>
                              <button type="button" onClick={() => changeQty(item._id, 1)} aria-label="increase quantity" className="flex h-7 w-7 items-center justify-center rounded-full bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out    ">+</button>
                            </div>
                          ) : (
                            <button type="button" onClick={() => addToCart(item)} disabled={!available} aria-label="+ Add" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFD600] dark:bg-[#FF5E00] text-lg font-black leading-none text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:cursor-not-allowed disabled:opacity-50">
                              +
                            </button>
                          )}
                        </div>
                      </div>

                      {/* RIGHT — large food image (transparent, frameless) */}
                       <div className="h-28 w-28 shrink-0 overflow-hidden bg-transparent">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt={localizedName(item, lang)} className="h-full w-full object-contain object-center" loading="lazy" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-[#94A3B8]">{tx('empty')}</div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* EXPLORE CATEGORIES — filter pills */}
        <section>
          <h2 className="mb-3 text-[15px] font-medium text-[#1E293B] dark:text-white">{tx('categories')}</h2>
          <nav className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-[11px] font-medium transition-all duration-150 ease-out     active:shadow-inner ${
                selectedCategory === 'ALL'
                  ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm'
                  : 'border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white shadow-[0_8px_22px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_26px_-12px_rgba(0,0,0,0.55)]'
              }`}
            >
              {tx('all')}
            </button>
            {categories.map((cat) => {
              const active = selectedCategory === (cat.id || cat._id);
              return (
                <button
                  type="button"
                  key={`cat-${cat._id || cat.id || cat.slug}`}
                  onClick={() => setSelectedCategory(cat.id || cat._id)}
                  className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-[11px] font-medium transition-all duration-150 ease-out     active:shadow-inner ${
                    active
                      ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-sm'
                      : 'border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white shadow-[0_8px_22px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_26px_-12px_rgba(0,0,0,0.55)]'
                  }`}
                >
                  {localizedCat(cat, lang)}
                </button>
              );
            })}
          </nav>
        </section>

        {/* POPULAR ITEMS — card grid */}
        <section>
          <h2 className="mb-3 text-[15px] font-medium text-[#1E293B] dark:text-white">{tx('popular')}</h2>
          {loading ? (
            <div className="grid w-full grid-cols-1 gap-5">
              {Array.from({ length: SKELETON_COUNT }).map((_, idx) => (
                <div key={`pop-skel-${idx}`} className="h-[15rem] animate-pulse rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24]" />
              ))}
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="flex min-h-[40vh] items-center justify-center text-center text-sm text-[#64748B] dark:text-[#94A3B8]">{tx('empty')}</div>
          ) : (
            <div className="grid w-full grid-cols-1 gap-5">
              {visibleItems.map((item, idx) => {
                const available = item.isAvailable !== false;
                const inCart = cart[item._id];
                const description = localizedDesc(item, lang);
                return (
                  <article
                    key={`item-${item._id || item.id}`}
                    style={{ '--stagger-index': Math.min(idx, 14) }}
                    className="flex h-[19rem] w-full flex-col overflow-hidden rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:shadow-[0_14px_30px_-5px_rgba(0,0,0,0.08),0_10px_12px_-6px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_16px_36px_rgba(0,0,0,0.55)]   active:shadow-inner"
                  >
                    {/* IMAGE — fixed area inside the fixed-height card; contained, no overflow */}
                    <div className="relative flex min-h-[6rem] flex-1 items-center justify-center overflow-hidden bg-transparent">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={localizedName(item, lang)} className="h-full w-full object-contain object-[50%_60%] drop-shadow-md" loading="lazy" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[10px] text-[#94A3B8]">{tx('empty')}</div>
                      )}
                    </div>

                    {/* BOTTOM — name/description (left) · price + Add (right) */}
                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="min-w-0 truncate text-[14px] font-medium leading-snug text-[#1E293B] dark:text-white">
                          {localizedName(item, lang)}
                        </h3>
                        {description && (
                          <p className="line-clamp-2 mt-1 text-[11px] leading-snug opacity-70 text-[#64748B] dark:text-[#94A3B8]">
                            {description}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <span className="whitespace-nowrap text-[15px] font-bold text-[#1E293B] dark:text-white">
                          {priceOf(item.price)}
                        </span>
                        {!available ? (
                          <span className="flex items-center justify-center rounded-2xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-4 py-2.5 text-center text-[11px] font-semibold text-[#94A3B8]">
                            {tx('outStock')}
                          </span>
                        ) : inCart ? (
                          <div className="flex items-center justify-center gap-2 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-2 py-1">
                            <button type="button" onClick={() => changeQty(item._id, -1)} aria-label="decrease quantity" className="flex h-8 w-8 items-center justify-center rounded-xl bg-white dark:bg-[#1C1D24] text-base font-semibold text-[#1E293B] dark:text-white border border-[#E2E8F0] dark:border-[#2A2B36] shadow-sm transition-all duration-150 ease-out    ">−</button>
                            <span className="min-w-5 text-center text-sm font-bold text-[#1E293B] dark:text-white">{inCart.qty}</span>
                            <button type="button" onClick={() => changeQty(item._id, 1)} aria-label="increase quantity" className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-base font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out    ">+</button>
                          </div>
                        ) : (
                          <button type="button" onClick={() => addToCart(item)} disabled={!available} className="flex w-[5rem] items-center justify-center rounded-2xl bg-[#FFD600] dark:bg-[#FF5E00] px-2 py-2 text-[13px] font-semibold text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:cursor-not-allowed disabled:opacity-50">
                            {tx('add')}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* FLOATING ACTION BUTTONS — inside frame on desktop */}
      <div className="fixed md:absolute bottom-6 right-6 md:bottom-4 md:right-4 z-50 flex flex-col items-end gap-3 sm:right-6 md:sm:right-4">
        {/* CART — top of stack */}
        <button
          key={cartBump}
          type="button"
          onClick={() => setCartOpen(true)}
          aria-label={tx('cart')}
          className={`flex h-14 w-14 items-center justify-center rounded-full bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none ${cartBump > 0 ? 'cart-bump' : ''}`}
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
            <path d="M3 3h2l2.4 12.2a2 2 0 002 1.8h8.4a2 2 0 002-1.6L21 7H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="10" cy="20" r="1.4" fill="currentColor" />
            <circle cx="17.5" cy="20" r="1.4" fill="currentColor" />
          </svg>
          {cartCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-white dark:bg-white px-1 text-[11px] font-extrabold text-[#1E293B] shadow-sm border border-[#E2E8F0] dark:border-white">
              {cartCount}
            </span>
          )}
        </button>

        {/* PAYMENT METHOD — middle of stack (2D card icon) */}
        <button
          type="button"
          onClick={() => setPayOpen(true)}
          aria-label={tx('paymentTitle')}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white shadow-[0_8px_22px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_26px_-12px_rgba(0,0,0,0.55)] transition-all duration-150 ease-out     active:shadow-inner focus:outline-none"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
            <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M3 10h18" stroke="currentColor" strokeWidth="2" />
            <path d="M7 14h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* CART DRAWER — inside frame on desktop */}
      {cartOpen && (
        <div
          className="fixed md:absolute inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCartOpen(false);
          }}
        >
          <div
            className="absolute inset-0 bg-[#1E293B]/30 dark:bg-[#12131A]/70 backdrop-blur-sm"
            onClick={() => setCartOpen(false)}
          />
          <aside className="relative z-10 flex max-h-[85vh] w-full max-w-md   flex-col overflow-hidden rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-4">
              <h2 className="text-base font-bold text-[#1E293B] dark:text-white">{tx('cart')}</h2>
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
                <p className="py-10 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">{tx('empty')}</p>
              ) : (
                cartEntries.map(({ item, qty }) => (
                  <div
                    key={`cart-${item._id}`}
                    className="flex items-center gap-3 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#1E293B] dark:text-white">
                        {localizedName(item, lang)}
                      </p>
                      <p className="mt-0.5 text-xs text-[#64748B] dark:text-[#94A3B8]">{priceOf(item.price)}</p>
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

            <div className="border-t border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-4 py-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-[#64748B] dark:text-[#94A3B8]">{tx('cart')}</span>
                <span className="text-2xl font-extrabold text-[#1E293B] dark:text-white">{priceOf(cartTotal)}</span>
              </div>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="rounded-xl border border-[#E2E8F0] dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-3 py-1.5 text-xs font-bold text-[#64748B] dark:text-[#94A3B8] transition-all duration-150 ease-out     active:shadow-inner"
              >
                {tx('standBack')}
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* PAYMENT INFORMATION MODAL — inside frame on desktop */}
      {payOpen && (
        <div
          className="fixed md:absolute inset-0 z-[70] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 p-4 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPayOpen(false);
          }}
        >
          <div className="w-full max-w-sm   overflow-hidden rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
            <div className="flex items-center gap-3 border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] px-5 py-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] text-lg">
                💳
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-base font-extrabold text-[#1E293B] dark:text-white">
                  {tx('payInfoTitle')}
                </h2>
                <p className="truncate text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
                  {priceOf(cartTotal)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPayOpen(false)}
                aria-label={tx('close')}
                className="ml-auto rounded-lg p-2 text-[#64748B] dark:text-[#94A3B8] transition-colors hover:bg-[#F4F5F9] dark:hover:bg-[#252631] hover:text-[#1E293B] dark:hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 px-5 py-5">
              {payLoading ? (
                <div className="space-y-3">
                  {[0, 1].map((i) => (
                    <div key={i} className="h-24 animate-pulse rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A]" />
                  ))}
                </div>
              ) : paymentInfos.length === 0 ? (
                <p className="py-8 text-center text-sm text-[#64748B] dark:text-[#94A3B8]">{tx('noPayment')}</p>
              ) : (
                paymentInfos.map((p) => {
                  const copyAll = `${p.bankName} — ${p.ownerName} — ${p.accountNumber}`;
                  return (
                    <div
                      key={p._id}
                      className="rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-4"
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 rounded-full bg-[#FFD600]/15 dark:bg-[#FF5E00]/15 border border-[#FFD600]/20 dark:border-[#FF5E00]/20 px-2.5 py-1 text-xs font-extrabold text-[#8A6D00] dark:text-[#FF8A3D]">
                          {p.bankName}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(copyAll, `all-${p._id}`)}
                          className="flex items-center gap-1 rounded-full bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1.5 text-xs font-bold text-[#1E293B] dark:text-white transition-all duration-150 ease-out     active:shadow-inner"
                        >
                          {copiedId === `all-${p._id}` ? tx('copied') : tx('copy')}
                        </button>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">{tx('ownerName')}</span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(p.ownerName, `owner-${p._id}`)}
                            className="text-xs font-semibold text-[#1E293B] dark:text-white transition-colors hover:text-[#FF5E00]"
                          >
                            {copiedId === `owner-${p._id}` ? `✓ ${tx('copied')}` : p.ownerName}
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">{tx('accountNum')}</span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(p.accountNumber, `acc-${p._id}`)}
                            className="text-xs font-semibold text-[#1E293B] dark:text-white transition-colors hover:text-[#FF5E00]"
                          >
                            {copiedId === `acc-${p._id}` ? `✓ ${tx('copied')}` : p.accountNumber}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}

              <button
                type="button"
                onClick={() => setPayOpen(false)}
                className="w-full rounded-xl py-2.5 text-xs font-bold text-[#64748B] dark:text-[#94A3B8] transition-colors hover:bg-[#F4F5F9] dark:hover:bg-[#252631]"
              >
                {tx('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
