'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { safeFetchJson } from '@/lib/clientFetch';
import { useLanguage } from '@/app/components/LanguageProvider';
import ManagerTopControls from '@/app/components/ManagerTopControls';
import {
  IconArchiveFilled,
  IconAlertTriangleFilled,
  IconCoinFilled,
  IconChartBar,
  IconClipboardListFilled,
  IconChefHat,
  IconStackFilled,
} from '@tabler/icons-react';
import {
  addisYMDToUTCStart,
  formatEthiopianDate,
  formatEthiopianDateTime,
} from '@/lib/ethiopianCalendar';
import {
  deriveInventoryStatus,
  availableStockOf,
} from '@/lib/inventoryStatus';
import {
  STOCK_GROUP,
  STOCK_GROUP_LABELS,
  STOCK_GROUP_VALUES,
  EXTRA_ITEM_CATEGORY,
  stockGroupLabel,
} from '@/lib/inventoryCategories';
import {
  INVENTORY_UNIT_OPTIONS,
  isValidInventoryUnit,
} from '@/lib/inventoryUnitGuard';
import {
  buildRecipeEditPatch,
  INGREDIENT_ID_REQUIRED,
  INGREDIENT_QTY_INVALID,
  INGREDIENT_QTY_PRECISION,
  INGREDIENT_UNIT_REQUIRED,
  INGREDIENT_UNIT_INVALID,
} from '@/lib/recipeEditDraft';
import {
  isTrackedRecipeUsable,
  resolveSavedMenuItemPolicy,
} from '@/lib/inventoryPolicy';

// The only units a Manager can submit. The blank option is a "not chosen yet"
// placeholder and is rejected by the handlers below; legacy values are shown
// read-only so an unsupported stored unit is visible instead of silently
// replaced with a valid one.
const INVALID_UNIT_UI_MESSAGE = 'Invalid unit — choose g, kg, ml, L, or pcs';

// M-2: an incomplete legacy row blocks the save instead of being filtered out
// of the PATCH body. The row number makes the offending ingredient obvious and
// the form keeps every entered value.
function recipeEditErrorMessage(result, t) {
  const row = result.index >= 0 ? ` (#${result.index + 1})` : '';
  switch (result.code) {
    case INGREDIENT_ID_REQUIRED:
      return `${t('invErrSelectItem')}${row}`;
    case INGREDIENT_QTY_INVALID:
      return `${t('invErrIngQty')}${row}`;
    case INGREDIENT_QTY_PRECISION:
      return `${t('invErrPrecision3')}${row}`;
    case INGREDIENT_UNIT_REQUIRED:
      return `${t('invErrIngUnit')}${row}`;
    case INGREDIENT_UNIT_INVALID:
      return `${INVALID_UNIT_UI_MESSAGE}${row}`;
    default:
      return t('invErrIngredients');
  }
}

function UnitSelect({ value, onChange, className = '' }) {
  const current = value == null ? '' : String(value);
  const isOption = INVENTORY_UNIT_OPTIONS.some((u) => u.value === current);
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      className={`h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30 ${className}`}
    >
      <option value="">—</option>
      {INVENTORY_UNIT_OPTIONS.map((u) => (
        <option key={u.value} value={u.value}>{u.label}</option>
      ))}
      {current && !isOption && (
        <option value={current}>
          {isValidInventoryUnit(current) ? `${current} — approved alias` : `${current} — legacy / invalid`}
        </option>
      )}
    </select>
  );
}

// Phase F — Recipe System: Menu ↔ Inventory relationship layer
// No stock deduction, no order hooks, presentation + CRUD only.

const TABS = [
  { key: 'stock', label: 'Stock' },
  { key: 'extras', label: 'Extra Items' },
  { key: 'movements', label: 'Movements' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'recipes', label: 'Recipes' },
  { key: 'reports', label: 'Reports' },
];

// Four physically separate stock areas shown as filter chips on the Stock tab.
// `ALL` is a view filter only; it never changes an item's persisted group.
const STOCK_GROUP_FILTERS = [
  { key: 'ALL', label: 'All Stock', labelKey: 'invStockGroupAll' },
  ...STOCK_GROUP_VALUES.map((key) => ({
    key,
    label: STOCK_GROUP_LABELS[key],
    labelKey: `invStockGroup${key.charAt(0)}${key.slice(1).toLowerCase()}`,
  })),
];

const EMPTY_EXTRA_FORM = {
  name: '',
  category: EXTRA_ITEM_CATEGORY,
  sellingPrice: '',
  inventoryItemId: '',
  isAvailable: true,
};

function statusCls(status) {
  const s = String(status).toLowerCase();
  if (s === 'low stock') return 'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A] dark:bg-[rgba(255,214,0,0.14)] dark:text-[#FF8A3D] dark:border-[#FFD600]/20';
  if (s === 'out of stock') return 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA] dark:bg-[#2A2B36] dark:text-[#FCA5A5] dark:border-[#2A2B36]';
  return 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7] dark:border-[#10B981]/20';
}

function fmtCost(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `ETB ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// `Number(missing)` is NaN and `NaN ?? 0` stays NaN — never render "NaN".
function numOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Business timestamps are Addis wall-clock, never browser-local formatting.
function fmtDateTime(iso, lang) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return formatEthiopianDateTime(d, lang === 'en' ? 'en' : 'am');
  } catch {
    return '—';
  }
}

const MOVEMENT_TYPE_KEYS = {
  IN: 'invMovementIn',
  OUT: 'invMovementOut',
  ADJUSTMENT: 'invMovementAdjustment',
};

// Canonical Phase F: transport YYYY-MM-DD (Addis wall) → Ethiopian business
// date for display. Never browser-local formatting for business dates.
function fmtTrendDate(ymd, lang) {
  try {
    const start = addisYMDToUTCStart(ymd);
    if (!start) return String(ymd || '—');
    return formatEthiopianDate(start, lang === 'en' ? 'en' : 'am');
  } catch {
    return String(ymd || '—');
  }
}

function getMenuDisplayName(m) {
  if (!m) return '—';
  if (typeof m.name === 'string') return m.name;
  if (m.title) return m.title;
  if (m.name?.en) return m.name.en;
  if (m.displayName) return m.displayName;
  return m.name || '—';
}

export default function InventoryUI({ menuPolicies = {} }) {
  const { t, lang } = useLanguage();
  const [activeTab, setActiveTab] = useState('stock');

  // Data
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [extras, setExtras] = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [loadingRecipes, setLoadingRecipes] = useState(true);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [loadingExtras, setLoadingExtras] = useState(true);
  const [itemsError, setItemsError] = useState('');
  const [suppliersError, setSuppliersError] = useState('');
  const [recipesError, setRecipesError] = useState('');
  const [extrasError, setExtrasError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Stock tab is partitioned into the four physical stock areas. The filter is
  // presentational only; items keep their persisted `stockGroup`.
  const [stockGroupFilter, setStockGroupFilter] = useState('ALL');

  // Extra Items — sellable wrappers around an existing InventoryItem. No recipe.
  const [showExtraAdd, setShowExtraAdd] = useState(false);
  const [extraForm, setExtraForm] = useState(EMPTY_EXTRA_FORM);
  const [extraBusy, setExtraBusy] = useState(false);
  const [extraFormError, setExtraFormError] = useState('');
  const [editExtra, setEditExtra] = useState(null);
  const [editExtraForm, setEditExtraForm] = useState(EMPTY_EXTRA_FORM);
  const [editExtraBusy, setEditExtraBusy] = useState(false);
  const [editExtraError, setEditExtraError] = useState('');

  // Stock movements + audit trail + server-authoritative low-stock alerts.
  // These endpoints existed with no UI consumer; wiring them (read-only for
  // movements/audits, waste POST) keeps the Manager view consistent with the
  // reservation/deduction trail instead of a separate presentation-only cache.
  const [movements, setMovements] = useState([]);
  const [loadingMovements, setLoadingMovements] = useState(true);
  const [movementsError, setMovementsError] = useState('');
  const [movementItemId, setMovementItemId] = useState('');
  const [movementTypeFilter, setMovementTypeFilter] = useState('ALL');
  const [movementSubTab, setMovementSubTab] = useState('movements');
  const [recipeClassificationFilter, setRecipeClassificationFilter] = useState('ALL');
  const [audits, setAudits] = useState([]);
  const [loadingAudits, setLoadingAudits] = useState(true);
  const [auditsError, setAuditsError] = useState('');
  const [alerts, setAlerts] = useState(null);
  const [loadingAlerts, setLoadingAlerts] = useState(true);
  const [alertsError, setAlertsError] = useState('');

  // Record Waste — writes StockMovement(OUT, reason Waste) + InventoryAudit in
  // one server transaction; the server refuses to consume reserved stock.
  const [wasteForm, setWasteForm] = useState({ itemId: '', quantity: '', notes: '' });
  const [wasteBusy, setWasteBusy] = useState(false);
  const [wasteError, setWasteError] = useState('');

  // Add Item form
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', category: '', stockGroup: '', unit: '', currentStock: '', minimumStock: '', cost: '', supplier: '' });
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');

  // Receive Stock
  const [showReceive, setShowReceive] = useState(false);
  const [receiveForm, setReceiveForm] = useState({ itemId: '', quantity: '', unitCost: '', unit: '', supplier: '', notes: '' });
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [receiveError, setReceiveError] = useState('');

  // Idempotency draft persistence — scoped to active receiving draft, survives reload for transient/ambiguous retry
  // Cleared only on confirmed success or explicit Cancel/Close. Fingerprint prevents silently reusing a key for a changed payload.
  const RECEIVE_DRAFT_STORAGE_KEY = 'bono:receive:draft';
  const receiveFingerprint = useCallback((form) => {
    const itemId = String(form.itemId || '').trim();
    const qty = Number(form.quantity);
    const uc = Number(form.unitCost);
    const rounded = Number.isFinite(uc) ? Math.round(uc * 100) / 100 : uc;
    const unit = String(form.unit || '').trim().toLowerCase();
    const supplier = String(form.supplier || '').trim();
    return `${itemId}|${Number.isFinite(qty) ? qty : form.quantity}|${unit}|${Number.isFinite(rounded) ? rounded : form.unitCost}|${supplier}`;
  }, []);
  const loadReceiveDraft = useCallback(() => {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return null;
      const raw = window.sessionStorage.getItem(RECEIVE_DRAFT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, []);
  const saveReceiveDraft = useCallback((key, fp) => {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      if (!key) window.sessionStorage.removeItem(RECEIVE_DRAFT_STORAGE_KEY);
      else window.sessionStorage.setItem(RECEIVE_DRAFT_STORAGE_KEY, JSON.stringify({ key, fp }));
    } catch {}
  }, []);
  const clearReceiveDraft = useCallback(() => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) window.sessionStorage.removeItem(RECEIVE_DRAFT_STORAGE_KEY);
    } catch {}
  }, []);
  // Hydrate draft key via lazy initializer (no cascading effect; survives reload for transient/503 retry)
  const [receiveIdempotencyKey, setReceiveIdempotencyKey] = useState(() => {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return '';
      const raw = window.sessionStorage.getItem(RECEIVE_DRAFT_STORAGE_KEY);
      const draft = raw ? JSON.parse(raw) : null;
      return draft?.key && typeof draft.key === 'string' ? draft.key : '';
    } catch {
      return '';
    }
  });

  // Edit Item
  const [editItem, setEditItem] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', category: '', stockGroup: '', unit: '', minimumStock: '', cost: '', supplier: '' });
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  // Add Supplier
  const [showSupAdd, setShowSupAdd] = useState(false);
  const [supForm, setSupForm] = useState({ name: '', contact: '', address: '', status: 'Active' });
  const [supBusy, setSupBusy] = useState(false);
  const [supError, setSupError] = useState('');

  // Edit Supplier
  const [editSup, setEditSup] = useState(null);
  const [editSupForm, setEditSupForm] = useState({ name: '', contact: '', address: '', status: '' });
  const [editSupBusy, setEditSupBusy] = useState(false);
  const [editSupError, setEditSupError] = useState('');

  // Dashboard
  const [dashboard, setDashboard] = useState(null);
  const [loadingDashboard, setLoadingDashboard] = useState(true);
  const [dashboardError, setDashboardError] = useState('');

  // Food Cost Analytics (H6.1)
  const [foodCostData, setFoodCostData] = useState(null);
  const [loadingFoodCost, setLoadingFoodCost] = useState(true);
  const [foodCostError, setFoodCostError] = useState('');

  // Recipe — Add
  const [showRecipeAdd, setShowRecipeAdd] = useState(false);
  const [recipeForm, setRecipeForm] = useState({ menuItemId: '', ingredients: [{ inventoryItemId: '', quantity: '', unit: '' }] });
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [recipeError, setRecipeError] = useState('');

  // Recipe — Edit
  const [editRecipe, setEditRecipe] = useState(null);
  const [editRecipeForm, setEditRecipeForm] = useState({ menuItemId: '', ingredients: [], isActive: true });
  const [editRecipeBusy, setEditRecipeBusy] = useState(false);
  const [editRecipeError, setEditRecipeError] = useState('');

  const fetchItems = useCallback(async () => {
    setLoadingItems(true);
    setItemsError('');
    try {
      const data = await safeFetchJson('/api/inventory/items', { cache: 'no-store' });
      const list = data?.data?.items || data?.items || [];
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load inventory';
      if (err?.status === 401) setItemsError(t('invErrUnauthorized'));
      else if (err?.status === 403) setItemsError(t('invErrForbidden'));
      else setItemsError(m);
    } finally {
      setLoadingItems(false);
    }
  }, [t]);

  const fetchSuppliers = useCallback(async () => {
    setLoadingSuppliers(true);
    setSuppliersError('');
    try {
      const data = await safeFetchJson('/api/inventory/suppliers', { cache: 'no-store' });
      const list = data?.data?.suppliers || data?.suppliers || [];
      setSuppliers(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load suppliers';
      if (err?.status === 401) setSuppliersError(t('invErrUnauthorized'));
      else if (err?.status === 403) setSuppliersError(t('invErrForbidden'));
      else setSuppliersError(m);
    } finally {
      setLoadingSuppliers(false);
    }
  }, [t]);

  const fetchRecipes = useCallback(async () => {
    setLoadingRecipes(true);
    setRecipesError('');
    try {
      const data = await safeFetchJson('/api/recipes', { cache: 'no-store' });
      const list = data?.data?.recipes || data?.recipes || [];
      setRecipes(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load recipes';
      if (err?.status === 401) setRecipesError(t('invErrUnauthorized'));
      else if (err?.status === 403) setRecipesError(t('invErrForbidden'));
      else setRecipesError(m);
    } finally {
      setLoadingRecipes(false);
    }
  }, [t]);

  const fetchMenu = useCallback(async () => {
    setLoadingMenu(true);
    try {
      const data = await safeFetchJson('/api/menu?all=true', { cache: 'no-store' });
      const list = data?.data?.items || data?.items || [];
      setMenuItems(Array.isArray(list) ? list : []);
    } catch {
      // fallback try without all
      try {
        const data2 = await safeFetchJson('/api/menu', { cache: 'no-store' });
        const list2 = data2?.data?.items || data2?.items || [];
        setMenuItems(Array.isArray(list2) ? list2 : []);
      } catch {
        setMenuItems([]);
      }
    } finally {
      setLoadingMenu(false);
    }
  }, []);

  const fetchExtras = useCallback(async () => {
    setLoadingExtras(true);
    setExtrasError('');
    try {
      const data = await safeFetchJson('/api/extra-items', { cache: 'no-store' });
      const list = data?.data?.items || data?.items || [];
      setExtras(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load Extra Items';
      if (err?.status === 401) setExtrasError(t('invErrUnauthorized'));
      else if (err?.status === 403) setExtrasError(t('invErrForbidden'));
      else setExtrasError(m);
    } finally {
      setLoadingExtras(false);
    }
  }, [t]);

  const fetchDashboard = useCallback(async () => {
    setLoadingDashboard(true);
    setDashboardError('');
    try {
      const data = await safeFetchJson('/api/manager/inventory-dashboard', { cache: 'no-store' });
      const payload = data?.data || data || {};
      setDashboard(payload);
    } catch (err) {
      const m = err?.message || 'Failed to load dashboard';
      if (err?.status === 401) setDashboardError(t('invErrUnauthorized'));
      else if (err?.status === 403) setDashboardError(t('invErrForbidden'));
      else setDashboardError(m);
    } finally {
      setLoadingDashboard(false);
    }
  }, [t]);

  const fetchFoodCost = useCallback(async () => {
    setLoadingFoodCost(true);
    setFoodCostError('');
    try {
      const data = await safeFetchJson('/api/manager/food-cost-analytics', { cache: 'no-store' });
      const payload = data?.data || data || {};
      setFoodCostData(payload);
    } catch (err) {
      const m = err?.message || 'Failed to load food cost';
      if (err?.status === 401) setFoodCostError(t('invErrUnauthorized'));
      else if (err?.status === 403) setFoodCostError(t('invErrForbidden'));
      else setFoodCostError(m);
    } finally {
      setLoadingFoodCost(false);
    }
  }, [t]);

  // Movements/audits/alerts are read-only Manager views over the same
  // collections the reservation lifecycle writes. No polling/SSE: explicit
  // refresh only, so the displayed snapshot is always deliberate.
  const fetchMovements = useCallback(async (itemId) => {
    setLoadingMovements(true);
    setMovementsError('');
    try {
      const qs = itemId ? `?item=${encodeURIComponent(itemId)}` : '';
      const data = await safeFetchJson(`/api/inventory/movements${qs}`, { cache: 'no-store' });
      const list = data?.data?.movements || data?.movements || [];
      setMovements(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load stock movements';
      if (err?.status === 401) setMovementsError(t('invErrUnauthorized'));
      else if (err?.status === 403) setMovementsError(t('invErrForbidden'));
      else setMovementsError(m);
    } finally {
      setLoadingMovements(false);
    }
  }, [t]);

  const fetchAudits = useCallback(async () => {
    setLoadingAudits(true);
    setAuditsError('');
    try {
      const data = await safeFetchJson('/api/inventory/audits?limit=100', { cache: 'no-store' });
      const list = data?.data?.audits || data?.audits || [];
      setAudits(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load audit trail';
      if (err?.status === 401) setAuditsError(t('invErrUnauthorized'));
      else if (err?.status === 403) setAuditsError(t('invErrForbidden'));
      else setAuditsError(m);
    } finally {
      setLoadingAudits(false);
    }
  }, [t]);

  const fetchAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    setAlertsError('');
    try {
      const data = await safeFetchJson('/api/manager/inventory-alerts', { cache: 'no-store' });
      const payload = data?.data || data || {};
      setAlerts({
        lowStock: Array.isArray(payload.lowStock) ? payload.lowStock : [],
        outOfStock: Array.isArray(payload.outOfStock) ? payload.outOfStock : [],
      });
    } catch (err) {
      const m = err?.message || 'Failed to load stock alerts';
      if (err?.status === 401) setAlertsError(t('invErrUnauthorized'));
      else if (err?.status === 403) setAlertsError(t('invErrForbidden'));
      else setAlertsError(m);
    } finally {
      setLoadingAlerts(false);
    }
  }, [t]);

  const handleRecordWaste = async (e) => {
    e.preventDefault();
    setWasteError('');
    if (!wasteForm.itemId) {
      setWasteError(t('invErrSelectItem'));
      return;
    }
    const qty = Number(wasteForm.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setWasteError(t('invErrWasteQty'));
      return;
    }
    setWasteBusy(true);
    try {
      await safeFetchJson('/api/inventory/waste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: wasteForm.itemId,
          quantity: qty,
          notes: wasteForm.notes.trim() || undefined,
        }),
      });
      setSuccessMsg(t('invWasteRecorded'));
      setWasteForm({ itemId: '', quantity: '', notes: '' });
      // Server decremented currentStock atomically; refresh every derivation
      // (items, movements, audit trail, alerts) instead of patching local state.
      await Promise.all([
        fetchItems(),
        fetchMovements(movementItemId),
        fetchAudits(),
        fetchAlerts(),
      ]);
    } catch (err) {
      setWasteError(err?.message || t('invErrWaste'));
    } finally {
      setWasteBusy(false);
    }
  };

  useEffect(() => {
    // Defer initial data load to avoid cascading render; callbacks set state outside direct effect body (subscription pattern)
    const timeoutId = setTimeout(() => {
      fetchItems();
      fetchSuppliers();
      fetchRecipes();
      fetchMenu();
      fetchExtras();
      fetchDashboard();
      fetchFoodCost();
      fetchMovements('');
      fetchAudits();
      fetchAlerts();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [fetchItems, fetchSuppliers, fetchRecipes, fetchMenu, fetchExtras, fetchDashboard, fetchFoodCost, fetchMovements, fetchAudits, fetchAlerts]);

  useEffect(() => {
    if (successMsg) {
      const t = setTimeout(() => setSuccessMsg(''), 4000);
      return () => clearTimeout(t);
    }
  }, [successMsg]);

  // Dashboard derived from real data.
  // Status/counts use the SAME rule as the API (availableStock) so the table,
  // the KPI cards, and the server alert/dashboard services cannot disagree.
  const availableOf = (it) => availableStockOf(it.currentStock, it.reservedStock);
  const statusOf = (it) =>
    deriveInventoryStatus(it.currentStock, it.minimumStock, it.reservedStock);
  const lowStockCount = items.filter((it) => statusOf(it) === 'Low Stock').length;
  const outOfStockCount = items.filter((it) => statusOf(it) === 'Out Of Stock').length;
  const inventoryValue = items.reduce((sum, it) => sum + (Number(it.currentStock) || 0) * (Number(it.cost) || 0), 0);
  // GET /api/inventory/items is capped at 200 rows, so counts/valuation for the
  // KPI cards come from the server aggregation when it is available.
  const overview = dashboard?.overview || null;
  const totalItems = overview ? numOrZero(overview.totalItems) : items.length;
  const kpiLowStockCount = overview ? numOrZero(overview.lowStockCount) : lowStockCount;
  const kpiOutOfStockCount = overview ? numOrZero(overview.outOfStockCount) : outOfStockCount;
  const kpiInventoryValue = overview ? numOrZero(overview.inventoryValue) : inventoryValue;

  // Inventory Classification comes from the canonical saved inventoryPolicy
  // supplied by the Manager-only server page. Recipe presence is a separate
  // health signal: it never changes a saved classification.
  const menuItemByMenuId = new Map(
    menuItems.map((m) => [String(m._id || m.id), m])
  );
  const policyOfMenuItem = (m) =>
    resolveSavedMenuItemPolicy(menuPolicies, String(m?._id || m?.id || ''));
  const policyOfMenuId = (id) =>
    resolveSavedMenuItemPolicy(menuPolicies, String(id || ''));
  const recipeByMenuId = new Map();
  for (const r of (Array.isArray(recipes) ? recipes : [])) {
    const key = String(r?.menuItemId || r?.menuItem?._id || '');
    if (key && !recipeByMenuId.has(key)) recipeByMenuId.set(key, r);
  }
  // A saved TRACKED item with a missing/inactive/invalid Recipe is still
  // TRACKED; its issue is reported separately rather than reclassifying it.
  const hasRecipeIssue = (id) =>
    policyOfMenuId(id) === 'TRACKED' &&
    !isTrackedRecipeUsable(recipeByMenuId.get(String(id || '')));
  const trackedItems = menuItems.filter((m) => policyOfMenuItem(m) === 'TRACKED');
  const untrackedItems = menuItems.filter((m) => policyOfMenuItem(m) === 'UNTRACKED');
  const unknownItems = menuItems.filter((m) => policyOfMenuItem(m) === 'UNKNOWN');
  const trackedCount = trackedItems.length;
  const untrackedCount = untrackedItems.length;
  const unknownCount = unknownItems.length;

  const itemNameOf = (itemId) => {
    if (!itemId) return '—';
    const found = items.find((it) => String(it._id || it.id) === String(itemId));
    return found?.name || String(itemId).slice(-6);
  };
  const supplierNameOf = (supplierId) => {
    if (!supplierId) return '';
    const found = suppliers.find((s) => String(s._id || s.id) === String(supplierId));
    return found?.name || '';
  };

  const stockGroupOf = (it) => it?.stockGroup || null;
  const visibleItems =
    stockGroupFilter === 'ALL'
      ? items
      : items.filter((it) => stockGroupOf(it) === stockGroupFilter);
  const unassignedItemCount = items.filter((it) => !stockGroupOf(it)).length;

  // Linked stock picker: items already in the Extra Items stock area come
  // first, but any canonical InventoryItem with a supported unit may be linked.
  const extraStockCandidates = [...items].sort((a, b) => {
    const aExtra = stockGroupOf(a) === STOCK_GROUP.EXTRA ? 0 : 1;
    const bExtra = stockGroupOf(b) === STOCK_GROUP.EXTRA ? 0 : 1;
    if (aExtra !== bExtra) return aExtra - bExtra;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const handleAddItem = async (e) => {
    e.preventDefault();
    setAddError('');
    if (!addForm.name.trim() || !addForm.category.trim() || !isValidInventoryUnit(addForm.unit)) {
      setAddError(addForm.unit.trim() ? INVALID_UNIT_UI_MESSAGE : t('invErrItemFields'));
      return;
    }
    setAddBusy(true);
    try {
      const payload = {
        name: addForm.name.trim(),
        category: addForm.category.trim(),
        stockGroup: addForm.stockGroup || undefined,
        unit: addForm.unit.trim(),
        currentStock: addForm.currentStock === '' ? undefined : Number(addForm.currentStock),
        minimumStock: addForm.minimumStock === '' ? undefined : Number(addForm.minimumStock),
        cost: addForm.cost === '' ? undefined : Number(addForm.cost),
        supplier: addForm.supplier || undefined,
      };
      await safeFetchJson('/api/inventory/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccessMsg(t('invItemAdded'));
      setShowAdd(false);
      setAddForm({ name: '', category: '', stockGroup: '', unit: '', currentStock: '', minimumStock: '', cost: '', supplier: '' });
      fetchItems();
    } catch (err) {
      setAddError(err?.message || t('invErrAddItem'));
    } finally {
      setAddBusy(false);
    }
  };

  const handleReceive = async (e) => {
    e.preventDefault();
    setReceiveError('');
    if (!receiveForm.itemId) {
      setReceiveError(t('invErrSelectItem'));
      return;
    }
    const qty = Number(receiveForm.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setReceiveError(t('invErrQty'));
      return;
    }
    if (receiveForm.unit && !isValidInventoryUnit(receiveForm.unit)) {
      setReceiveError(INVALID_UNIT_UI_MESSAGE);
      return;
    }
    const uc = Number(receiveForm.unitCost);
    if (!Number.isFinite(uc) || uc < 0) {
      setReceiveError(t('invErrUnitCost'));
      return;
    }
    // Idempotency key lifecycle: reuse for transient/ambiguous retry, but never silently reuse for a changed payload
    // Fingerprint guards: if item/qty/unit/cost/supplier changed, old key is invalid and a new one is generated
    const currentFp = receiveFingerprint({ itemId: receiveForm.itemId, quantity: receiveForm.quantity, unit: receiveForm.unit, unitCost: receiveForm.unitCost, supplier: receiveForm.supplier });
    let key = receiveIdempotencyKey;
    let storedFp = null;
    try {
      const draft = loadReceiveDraft();
      if (draft?.key && draft?.fp) storedFp = draft.fp;
      // If we have a stored key but fingerprint changed, discard old key (prevents 409 on changed payload retry)
      if (key && storedFp && storedFp !== currentFp) {
        key = '';
      } else if (!key && draft?.key && draft.fp === currentFp) {
        // Hydrate from sessionStorage after reload — same logical receipt
        key = draft.key;
        setReceiveIdempotencyKey(key);
      }
    } catch {}
    if (!key) {
      try {
        key = crypto.randomUUID();
      } catch {
        key = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
      setReceiveIdempotencyKey(key);
      saveReceiveDraft(key, currentFp);
    } else {
      // Keep fingerprint in sync for current draft
      saveReceiveDraft(key, currentFp);
    }
    setReceiveBusy(true);
    try {
      const payload = {
        itemId: receiveForm.itemId,
        quantity: qty,
        unitCost: uc,
        unit: receiveForm.unit.trim() || undefined,
        supplier: receiveForm.supplier || undefined,
        notes: receiveForm.notes.trim() || undefined,
      };
      const data = await safeFetchJson('/api/inventory/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(payload),
      });
      // Handle replay vs new: both are success, refresh only after confirmed
      if (data?.data?.replayed) {
        setSuccessMsg(`${t('invAlreadyReceived')} ${data.data.movement.quantity} ${data.data.movement.unit || ''}`);
      } else {
        setSuccessMsg(`${t('invReceivedOk')} ${qty}. ${t('invNewStock')} ${data?.data?.newStock ?? ''}`);
      }
      setShowReceive(false);
      setReceiveForm({ itemId: '', quantity: '', unitCost: '', unit: '', supplier: '', notes: '' });
      setReceiveIdempotencyKey('');
      clearReceiveDraft();
      fetchItems();
    } catch (err) {
      const status = err?.status;
      const msg = err?.message || '';
      if (status === 409) {
        // Same key + different payload: instruct new key for new receipt, clear draft fingerprint so next submit generates fresh key
        if (/different payload/i.test(msg)) {
          setReceiveError(`${msg}. ${t('invErrPayloadChanged')}`);
          clearReceiveDraft();
          setReceiveIdempotencyKey('');
        } else {
          setReceiveError(msg || t('invErrKeyReuse'));
          // Keep key for user to decide, but draft remains for explicit retry of same payload
        }
      } else if (status === 503 || status >= 500) {
        // Includes new 503 "Receipt status unknown — retry with the same Idempotency-Key to confirm."
        // Keep same key (and draft) for retry — survives reload via sessionStorage
        setReceiveError(`${msg || t('invErrServer')}. ${t('invErrRetrySameKey')}`);
        saveReceiveDraft(key, currentFp);
      } else if (status === 400) {
        // Validation never wrote to DB — safe to keep key if payload will be retried with same fingerprint (after fixing other fields)
        // But if fingerprint changed on next attempt, handleReceive will auto-generate new key
        setReceiveError(msg || t('invErrReceive'));
        saveReceiveDraft(key, currentFp);
      } else {
        setReceiveError(msg || t('invErrReceive'));
        saveReceiveDraft(key, currentFp);
      }
    } finally {
      setReceiveBusy(false);
    }
  };

  const openEdit = (it) => {
    setEditItem(it);
    setEditForm({
      name: it.name || '',
      category: it.category || '',
      stockGroup: it.stockGroup || '',
      unit: it.unit || '',
      minimumStock: String(it.minimumStock ?? ''),
      cost: String(it.cost ?? ''),
      supplier: it.supplier ? String(it.supplier) : '',
    });
    setEditError('');
  };

  const handleEditItem = async (e) => {
    e.preventDefault();
    if (!editItem) return;
    setEditError('');
    if (!isValidInventoryUnit(editForm.unit)) {
      setEditError(INVALID_UNIT_UI_MESSAGE);
      return;
    }
    setEditBusy(true);
    try {
      const payload = {
        name: editForm.name.trim(),
        category: editForm.category.trim(),
        // Empty selects clear the grouping (never auto-assigned/backfilled).
        stockGroup: editForm.stockGroup || null,
        unit: editForm.unit.trim(),
        minimumStock: editForm.minimumStock === '' ? undefined : Number(editForm.minimumStock),
        cost: editForm.cost === '' ? undefined : Number(editForm.cost),
      };
      // Status is derived from available stock (never a manual field), but the
      // supplier link is a real persisted field accepted by PATCH. Only send it
      // when it actually changed so the audit trail stays meaningful.
      const beforeSupplier = editItem.supplier ? String(editItem.supplier) : '';
      const nextSupplier = editForm.supplier ? String(editForm.supplier) : '';
      if (nextSupplier !== beforeSupplier) payload.supplier = nextSupplier;
      await safeFetchJson(`/api/inventory/items/${editItem._id || editItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccessMsg(t('invItemUpdated'));
      setEditItem(null);
      fetchItems();
    } catch (err) {
      setEditError(err?.message || t('invErrUpdateItem'));
    } finally {
      setEditBusy(false);
    }
  };

  const handleAddSupplier = async (e) => {
    e.preventDefault();
    setSupError('');
    if (!supForm.name.trim()) {
      setSupError(t('invErrNameRequired'));
      return;
    }
    setSupBusy(true);
    try {
      const payload = {
        name: supForm.name.trim(),
        contact: supForm.contact.trim(),
        address: supForm.address.trim(),
        status: supForm.status,
      };
      await safeFetchJson('/api/inventory/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccessMsg(t('invSupplierAdded'));
      setShowSupAdd(false);
      setSupForm({ name: '', contact: '', address: '', status: 'Active' });
      fetchSuppliers();
    } catch (err) {
      setSupError(err?.message || t('invErrAddSupplier'));
    } finally {
      setSupBusy(false);
    }
  };

  const openEditSup = (s) => {
    setEditSup(s);
    setEditSupForm({ name: s.name || '', contact: s.contact || '', address: s.address || '', status: s.status || 'Active' });
    setEditSupError('');
  };

  const handleEditSupplier = async (e) => {
    e.preventDefault();
    if (!editSup) return;
    setEditSupError('');
    setEditSupBusy(true);
    try {
      const payload = {
        name: editSupForm.name.trim(),
        contact: editSupForm.contact.trim(),
        address: editSupForm.address.trim(),
        status: editSupForm.status,
      };
      await safeFetchJson(`/api/inventory/suppliers/${editSup._id || editSup.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccessMsg(t('invSupplierUpdated'));
      setEditSup(null);
      fetchSuppliers();
    } catch (err) {
      setEditSupError(err?.message || t('invErrUpdateSupplier'));
    } finally {
      setEditSupBusy(false);
    }
  };

  // Recipe handlers
  const handleAddRecipe = async (e) => {
    e.preventDefault();
    setRecipeError('');
    if (!recipeForm.menuItemId) {
      setRecipeError(t('invErrMenuItem'));
      return;
    }
    const cleanIngredients = recipeForm.ingredients
      .filter((r) => r.inventoryItemId && r.quantity && r.unit)
      .map((r) => ({ inventoryItemId: r.inventoryItemId, quantity: Number(r.quantity), unit: String(r.unit).trim() }));
    if (cleanIngredients.length === 0) {
      setRecipeError(t('invErrIngredients'));
      return;
    }
    for (const ing of cleanIngredients) {
      if (!Number.isFinite(ing.quantity) || ing.quantity <= 0) {
        setRecipeError(t('invErrIngQty'));
        return;
      }
      const parts = String(ing.quantity).split('.');
      if (parts[1] && parts[1].length > 3) {
        setRecipeError(t('invErrPrecision3'));
        return;
      }
      if (!ing.unit) {
        setRecipeError(t('invErrIngUnit'));
        return;
      }
      if (!isValidInventoryUnit(ing.unit)) {
        setRecipeError(INVALID_UNIT_UI_MESSAGE);
        return;
      }
    }
    setRecipeBusy(true);
    try {
      await safeFetchJson('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menuItemId: recipeForm.menuItemId, ingredients: cleanIngredients }),
      });
      setSuccessMsg(t('invRecipeCreated'));
      setShowRecipeAdd(false);
      setRecipeForm({ menuItemId: '', ingredients: [{ inventoryItemId: '', quantity: '', unit: '' }] });
      fetchRecipes();
    } catch (err) {
      setRecipeError(err?.message || t('invErrCreateRecipe'));
    } finally {
      setRecipeBusy(false);
    }
  };

  const openEditRecipe = (r) => {
    setEditRecipe(r);
    setEditRecipeForm({
      menuItemId: r.menuItemId || (r.menuItem?._id || ''),
      ingredients: (r.ingredients || []).map((ing) => {
        const inventoryItemId = String(ing.inventoryItemId || ing.itemId || (ing.inventoryItem?._id || ''));
        return {
          inventoryItemId,
          quantity: String(ing.quantity ?? ''),
          // Keep the stored recipe unit visible. A legacy unsupported or missing
          // unit must be shown (and repaired by the Manager) instead of being
          // silently replaced by the inventory item's unit.
          unit: String(ing.unit || ''),
        };
      }),
      isActive: r.isActive !== false,
    });
    setEditRecipeError('');
  };

  const handleEditRecipe = async (e) => {
    e.preventDefault();
    if (!editRecipe) return;
    setEditRecipeError('');
    // M-2: never filter rows. The builder either returns a complete, validated
    // ingredient list or refuses the save with the offending row number; an
    // unchanged tuple sends no ingredient array at all.
    const built = buildRecipeEditPatch({
      current: editRecipe,
      form: {
        menuItemId: editRecipeForm.menuItemId,
        ingredients: editRecipeForm.ingredients,
        isActive: editRecipeForm.isActive,
      },
    });
    if (!built.ok) {
      setEditRecipeError(recipeEditErrorMessage(built, t));
      return;
    }
    const payload = built.payload;
    setEditRecipeBusy(true);
    try {
      await safeFetchJson(`/api/recipes/${editRecipe._id || editRecipe.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccessMsg(t('invRecipeUpdated'));
      setEditRecipe(null);
      fetchRecipes();
    } catch (err) {
      setEditRecipeError(err?.message || t('invErrUpdateRecipe'));
    } finally {
      setEditRecipeBusy(false);
    }
  };

  const handleDeactivateRecipe = async (r) => {
    if (!confirm(`Deactivate recipe for ${r.menuItem?.name || r.menuItemId}?`)) return;
    try {
      await safeFetchJson(`/api/recipes/${r._id || r.id}`, { method: 'DELETE' });
      setSuccessMsg(t('invRecipeDeactivated'));
      fetchRecipes();
    } catch (err) {
      setRecipesError(err?.message || t('invErrDeactivate'));
    }
  };

  // Extra Items — Manager CRUD. Selling price is separate from inventory unit
  // cost and is the only money value the server persists for the sellable item.
  const validateExtraForm = (form) => {
    if (!form.name.trim()) return t('invErrNameRequired');
    const price = Number(form.sellingPrice);
    if (!Number.isFinite(price) || price < 0 || price > 100000) return t('invErrExtraPrice');
    if (!form.inventoryItemId) return t('invErrExtraStock');
    return '';
  };

  const extraPayloadOf = (form) => ({
    name: form.name.trim(),
    category: form.category.trim() || EXTRA_ITEM_CATEGORY,
    sellingPrice: Number(form.sellingPrice),
    inventoryItemId: form.inventoryItemId,
    isAvailable: form.isAvailable !== false,
  });

  const handleAddExtra = async (e) => {
    e.preventDefault();
    setExtraFormError('');
    const invalid = validateExtraForm(extraForm);
    if (invalid) {
      setExtraFormError(invalid);
      return;
    }
    setExtraBusy(true);
    try {
      await safeFetchJson('/api/extra-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extraPayloadOf(extraForm)),
      });
      setSuccessMsg(t('invExtraCreated'));
      setShowExtraAdd(false);
      setExtraForm(EMPTY_EXTRA_FORM);
      fetchExtras();
    } catch (err) {
      setExtraFormError(err?.message || t('invErrCreateExtra'));
    } finally {
      setExtraBusy(false);
    }
  };

  const openEditExtra = (ex) => {
    setEditExtra(ex);
    setEditExtraForm({
      name: ex.name || '',
      category: ex.category || EXTRA_ITEM_CATEGORY,
      sellingPrice: String(ex.sellingPrice ?? ''),
      inventoryItemId: ex.inventoryItemId ? String(ex.inventoryItemId) : '',
      isAvailable: ex.isAvailable !== false,
    });
    setEditExtraError('');
  };

  const handleEditExtra = async (e) => {
    e.preventDefault();
    if (!editExtra) return;
    setEditExtraError('');
    const invalid = validateExtraForm(editExtraForm);
    if (invalid) {
      setEditExtraError(invalid);
      return;
    }
    setEditExtraBusy(true);
    try {
      await safeFetchJson(`/api/extra-items/${editExtra._id || editExtra.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extraPayloadOf(editExtraForm)),
      });
      setSuccessMsg(t('invExtraUpdated'));
      setEditExtra(null);
      fetchExtras();
    } catch (err) {
      setEditExtraError(err?.message || t('invErrUpdateExtra'));
    } finally {
      setEditExtraBusy(false);
    }
  };

  const handleToggleExtraAvailability = async (ex) => {
    try {
      await safeFetchJson(`/api/extra-items/${ex._id || ex.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAvailable: ex.isAvailable === false }),
      });
      setSuccessMsg(t('invExtraUpdated'));
      fetchExtras();
    } catch (err) {
      setExtrasError(err?.message || t('invErrUpdateExtra'));
    }
  };

  const handleDeleteExtra = async (ex) => {
    if (!confirm(`${t('invDeleteExtraConfirm')} ${ex.name}?`)) return;
    try {
      await safeFetchJson(`/api/extra-items/${ex._id || ex.id}`, { method: 'DELETE' });
      setSuccessMsg(t('invExtraDeleted'));
      fetchExtras();
    } catch (err) {
      setExtrasError(err?.message || t('invErrDeleteExtra'));
    }
  };

  const updateRecipeIngredient = (idx, field, value, isEdit) => {
    const patch = { [field]: value };
    if (field === 'inventoryItemId') {
      // POST/PATCH /api/recipes rejects a recipe unit that does not exactly
      // match the inventory item unit. Pre-fill it so a valid selection can
      // never produce a guaranteed 400.
      const picked = items.find((it) => String(it._id || it.id) === String(value));
      if (picked?.unit) patch.unit = picked.unit;
    }
    if (isEdit) {
      const next = [...editRecipeForm.ingredients];
      next[idx] = { ...next[idx], ...patch };
      setEditRecipeForm({ ...editRecipeForm, ingredients: next });
    } else {
      const next = [...recipeForm.ingredients];
      next[idx] = { ...next[idx], ...patch };
      setRecipeForm({ ...recipeForm, ingredients: next });
    }
  };
  const addRecipeRow = (isEdit) => {
    if (isEdit) setEditRecipeForm({ ...editRecipeForm, ingredients: [...editRecipeForm.ingredients, { inventoryItemId: '', quantity: '', unit: '' }] });
    else setRecipeForm({ ...recipeForm, ingredients: [...recipeForm.ingredients, { inventoryItemId: '', quantity: '', unit: '' }] });
  };
  const removeRecipeRow = (idx, isEdit) => {
    if (isEdit) {
      const next = editRecipeForm.ingredients.filter((_, i) => i !== idx);
      setEditRecipeForm({ ...editRecipeForm, ingredients: next.length ? next : [{ inventoryItemId: '', quantity: '', unit: '' }] });
    } else {
      const next = recipeForm.ingredients.filter((_, i) => i !== idx);
      setRecipeForm({ ...recipeForm, ingredients: next.length ? next : [{ inventoryItemId: '', quantity: '', unit: '' }] });
    }
  };

  return (
    <div className="min-h-screen bg-[var(--c-bg)] text-[var(--c-text)]">
      {/* Header — contained curved container matching Menu CRUD / Manager Reports */}
      <header className="sticky top-4 z-20 mx-4 sm:mx-6 mt-4 rounded-2xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] dark:border-[#2A2B36] shadow-sm">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="min-w-0">
                <h1 className="text-lg sm:text-xl font-black tracking-tight leading-none text-[var(--c-text)]">{t('invTitle')}</h1>
              </div>
            </div>
            <ManagerTopControls />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 sm:px-6 py-6 space-y-6">
        {/* Success / error banner */}
        {successMsg && (
          <div role="status" className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3.5 py-2.5 text-xs font-bold text-[#15803D]">{successMsg}</div>
        )}
        {itemsError && activeTab === 'stock' && (
          <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
            <span>{itemsError}</span>
            <button type="button" onClick={fetchItems} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626] hover:bg-[#FFF7ED]">{t('uiRetry')}</button>
          </div>
        )}

        {/* Tabs */}
        <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-2 bg-[var(--c-card)]">
          <nav role="tablist" className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1" aria-label="Inventory tabs">
            {TABS.map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  onClick={() => setActiveTab(tab.key)}
                  aria-selected={active}
                  className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-xs font-black uppercase tracking-wide border transition-all duration-150 ease-out active:shadow-inner inline-flex items-center gap-1.5 ${
                    active ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white border-transparent shadow-sm' : 'bg-white dark:bg-[#12131A] text-[var(--c-muted)] border-[var(--c-border-soft)]'
                  }`}
                >
                  <span>{{ stock: t('invStock'), extras: t('invExtras'), movements: t('invMovements'), suppliers: t('invSuppliers'), recipes: t('invRecipes'), reports: t('invReports') }[tab.key] || tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* STOCK TAB */}
        {activeTab === 'stock' ? (
          <>
            {/* Dashboard — real data */}
            <section aria-label="Stock dashboard" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invTotalItems')}</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]"><IconArchiveFilled size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-12 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[var(--c-text)]">{totalItems}</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">{loadingItems ? t('invLoading') : `${totalItems} ${t('invItemsInInventory')}`}</p>
              </div>
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invLowStock')}</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FEF3C7] dark:bg-[rgba(251,191,36,0.15)] text-[#92400E] dark:text-[#FBBF24]"><IconAlertTriangleFilled size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-12 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[#D97706] dark:text-[#FBBF24]">{kpiLowStockCount}</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">{kpiOutOfStockCount} {t('invOutOfStock')}</p>
              </div>
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invInventoryValue')}</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]"><IconCoinFilled size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-24 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[var(--c-text)]">{fmtCost(kpiInventoryValue)}</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">{t('invValueFormula')}</p>
              </div>
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invStockStatus')}</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#F4F5F9] dark:bg-[#12131A] border border-[var(--c-border-soft)] text-[var(--c-muted)]"><IconChartBar size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-24 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-sm font-black text-[var(--c-text)]">{kpiOutOfStockCount} {t('invOutShort')} {kpiLowStockCount} {t('invLowShort')} {Math.max(0, totalItems - kpiLowStockCount - kpiOutOfStockCount)} {t('invOkWord')}</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">{t('invDistribution')}</p>
              </div>
            </section>

            {/* Server-authoritative low/out-of-stock alerts. Uses availableStock
                (currentStock - reservedStock) from /api/manager/inventory-alerts,
                so an order holding the last units surfaces as a shortage. */}
            <section aria-label="Stock alerts" className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
                <div>
                  <h2 className="text-sm font-black text-[var(--c-text)]">{t('invStockAlerts')}</h2>
                  <p className="text-xs font-medium text-[var(--c-muted)]">{t('invAlertsHint')}</p>
                </div>
                <button type="button" onClick={fetchAlerts} className="inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm">{t('invRefresh')}</button>
              </div>
              {alertsError ? (
                <div role="alert" className="px-4 sm:px-5 py-4 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
                  <span>{alertsError}</span>
                  <button type="button" onClick={fetchAlerts} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">{t('uiRetry')}</button>
                </div>
              ) : loadingAlerts ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className="h-10 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                  ))}
                </div>
              ) : !alerts || (alerts.lowStock.length === 0 && alerts.outOfStock.length === 0) ? (
                <div className="px-4 sm:px-5 py-6 text-center">
                  <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoAlerts')}</p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--c-border-soft)]">
                  {[...(alerts.outOfStock || []), ...(alerts.lowStock || [])].map((alert) => {
                    const status = deriveInventoryStatus(alert.currentStock, alert.minimumStock, alert.reservedStock);
                    return (
                      <div key={alert.itemId} className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-[var(--c-text)]">{alert.name}</p>
                          <p className="mt-0.5 text-[11px] font-medium text-[var(--c-muted)]">
                            {alert.category || '—'} · {t('invAvailable')}: {numOrZero(alert.availableStock)} {alert.unit}
                            {' · '}{t('invReserved')}: {numOrZero(alert.reservedStock)} {alert.unit}
                            {' · '}{t('invMinimum')}: {numOrZero(alert.minimumStock)} {alert.unit}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-[#DC2626] dark:text-[#FCA5A5]">{t('invShortageQty')}: {numOrZero(alert.shortage)} {alert.unit}</span>
                          <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${statusCls(status)}`}>{status}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Four physically separate stock areas. The chips only partition
                the view; `stockGroup` is edited per item below. */}
            <section aria-label={t('invStockArea')} className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invStockArea')}</span>
                {STOCK_GROUP_FILTERS.map((group) => {
                  const active = stockGroupFilter === group.key;
                  const count = group.key === 'ALL'
                    ? items.length
                    : items.filter((it) => stockGroupOf(it) === group.key).length;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      onClick={() => setStockGroupFilter(group.key)}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-wide transition-colors ${
                        active
                          ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white border-transparent shadow-sm'
                          : 'bg-white dark:bg-[#12131A] text-[var(--c-muted)] border-[var(--c-border-soft)]'
                      }`}
                    >
                      {t(group.labelKey) || group.label}
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${active ? 'bg-black/10 dark:bg-white/20' : 'bg-[var(--c-bg)]'}`}>{count}</span>
                    </button>
                  );
                })}
                {unassignedItemCount > 0 && (
                  <span className="ml-auto text-[11px] font-semibold text-[var(--c-muted)]">
                    {t('invUnassigned')}: {unassignedItemCount}
                  </span>
                )}
              </div>
            </section>

            {/* Stock Table + Add/Edit */}
            <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
                <div>
                  <h2 className="text-sm font-black text-[var(--c-text)]">{t('invStockTitle')}</h2>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">{loadingItems ? '…' : `${visibleItems.length} ${t('invItems')}`}</span>
                  <button type="button" onClick={() => { const willOpen = !showReceive; setShowReceive((v) => !v); if (willOpen) { setReceiveIdempotencyKey(''); setReceiveError(''); clearReceiveDraft(); } else { setReceiveError(''); } }} className="inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm">{showReceive ? t('close') : t('invReceive')}</button>
                  <button type="button" onClick={() => setShowAdd((v) => !v)} className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm">{showAdd ? t('close') : `+ ${t('invAddItem')}`}</button>
                  <button type="button" onClick={fetchItems} className="hidden sm:inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm">{t('invRefresh')}</button>
                </div>
              </div>

              {/* Receive Stock form */}
              {showReceive && (
                <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                  <form onSubmit={handleReceive} className="grid gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invItemField')} *</span>
                      <select value={receiveForm.itemId} onChange={(e) => { const v = e.target.value; const it = items.find((x) => String(x._id||x.id)===String(v)); setReceiveForm({ ...receiveForm, itemId: v, unit: it ? it.unit : receiveForm.unit }); }} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option value="">{t('invSelectItem')}</option>
                        {items.map((it) => (
                          <option key={it._id||it.id} value={it._id||it.id}>{it.name} {it.unit} (stock {it.currentStock})</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invQuantity')} *</span>
                      <input type="number" min="0.01" step="0.01" value={receiveForm.quantity} onChange={(e) => setReceiveForm({ ...receiveForm, quantity: e.target.value })} placeholder="5" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invUnitCost')} (ETB) *</span>
                      <input type="number" min="0" step="0.01" value={receiveForm.unitCost} onChange={(e) => setReceiveForm({ ...receiveForm, unitCost: e.target.value })} placeholder="10.50" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invUnit')}</span>
                      <UnitSelect value={receiveForm.unit} onChange={(v) => setReceiveForm({ ...receiveForm, unit: v })} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invSupplier')}</span>
                      <select value={receiveForm.supplier} onChange={(e) => setReceiveForm({ ...receiveForm, supplier: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option value="">{t('invNoSupplier')}</option>
                        {suppliers.map((s) => (
                          <option key={s._id||s.id} value={s._id||s.id}>{s.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block sm:col-span-3">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invNotes')}</span>
                      <input value={receiveForm.notes} onChange={(e) => setReceiveForm({ ...receiveForm, notes: e.target.value })} placeholder="Invoice #123, delivery notes" maxLength={500} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <div className="sm:col-span-3 flex items-center gap-2">
                      <button type="submit" disabled={receiveBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-emerald-600 px-4 text-xs font-black uppercase tracking-wide text-white shadow-sm disabled:opacity-50">{receiveBusy ? t('invReceiving') : t('invSubmitReceipt')}</button>
                      <button type="button" onClick={() => { setShowReceive(false); setReceiveError(''); setReceiveIdempotencyKey(''); clearReceiveDraft(); }} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('invCancel')}</button>
                      {receiveError && <span className="text-xs font-semibold text-[#DC2626]">{receiveError}</span>}
                    </div>
                    <p className="sm:col-span-3 text-[11px] font-medium text-[var(--c-muted)]">{t('invIdempotencyNote')}</p>
                  </form>
                </div>
              )}

              {/* Add Item form */}
              {showAdd && (
                <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                  <form onSubmit={handleAddItem} className="grid gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('uiName')} *</span>
                      <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Coffee Beans" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invCategoryField')} *</span>
                      <input value={addForm.category} onChange={(e) => setAddForm({ ...addForm, category: e.target.value })} placeholder="Beverages" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invStockArea')}</span>
                      <select value={addForm.stockGroup} onChange={(e) => setAddForm({ ...addForm, stockGroup: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option value="">{t('invUnassigned')}</option>
                        {STOCK_GROUP_VALUES.map((group) => (
                          <option key={group} value={group}>{t(`invStockGroup${group.charAt(0)}${group.slice(1).toLowerCase()}`) || STOCK_GROUP_LABELS[group]}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invUnit')} *</span>
                      <UnitSelect value={addForm.unit} onChange={(v) => setAddForm({ ...addForm, unit: v })} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invCurrentStock')}</span>
                      <input type="number" min="0" step="1" value={addForm.currentStock} onChange={(e) => setAddForm({ ...addForm, currentStock: e.target.value })} placeholder="12" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invMinStock')}</span>
                      <input type="number" min="0" step="1" value={addForm.minimumStock} onChange={(e) => setAddForm({ ...addForm, minimumStock: e.target.value })} placeholder="5" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invCost')} (ETB)</span>
                      <input type="number" min="0" step="0.01" value={addForm.cost} onChange={(e) => setAddForm({ ...addForm, cost: e.target.value })} placeholder="850" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <div className="sm:col-span-3 flex items-center gap-2">
                      <button type="submit" disabled={addBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{addBusy ? t('invSaving') : t('invCreateItem')}</button>
                      {addError && <span className="text-xs font-semibold text-[#DC2626]">{addError}</span>}
                    </div>
                  </form>
                </div>
              )}

              {/* Table states */}
              {loadingItems ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                  ))}
                </div>
              ) : itemsError ? (
                <div className="px-4 sm:px-5 py-8 text-center">
                  <p className="text-sm font-bold text-[#DC2626]">{itemsError}</p>
                  <button type="button" onClick={fetchItems} className="mt-3 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)]">{t('uiRetry')}</button>
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="px-4 sm:px-5 py-12 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] mb-3"><IconStackFilled size={20} className="h-5 w-5" /></div>
                  <p className="text-sm font-black text-[var(--c-text)]">{t('invNoItems')}</p>
                  <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[36ch] mx-auto">{t('invEmptyStockA')} <strong className="text-[var(--c-text)]">+ {t('invAddItem')}</strong>.</p>
                </div>
              ) : (
                <>
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                        <tr>
                          <th className="px-4 py-3 font-black">{t('invItems')}</th>
                          <th className="px-4 py-3 font-black">{t('invCategoryField')}</th>
                          <th className="px-4 py-3 font-black">{t('invStockArea')}</th>
                          <th className="px-4 py-3 font-black">{t('invUnit')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('invCurrentStock')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('invMinimum')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('invCost')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('status')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('invActions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--c-border-soft)]">
                        {visibleItems.map((row) => (
                          <tr key={row._id || row.id}>
                            <td className="px-4 py-3.5 font-bold text-[var(--c-text)] whitespace-nowrap">
                              <span className="inline-flex items-center gap-2">
                                <span className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)]"><IconStackFilled size={14} className="h-3.5 w-3.5" /></span>
                                <span>
                                  {row.name}
                                  {supplierNameOf(row.supplier) && <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--c-muted)]">{supplierNameOf(row.supplier)}</span>}
                                </span>
                              </span>
                            </td>
                            <td className="px-4 py-3.5"><span className="inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)]">{row.category}</span></td>
                            <td className="px-4 py-3.5"><span className="inline-flex rounded-full bg-[#F4F5F9] dark:bg-[#12131A] border border-[var(--c-border-soft)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)]">{stockGroupLabel(row.stockGroup) || t('invUnassigned')}</span></td>
                            <td className="px-4 py-3.5 font-semibold text-[var(--c-text)]">{row.unit}</td>
                            <td className="px-4 py-3.5 text-right font-black text-[var(--c-text)]">
                              {numOrZero(row.currentStock)}
                              {numOrZero(row.reservedStock) > 0 && <span className="block text-[10px] font-bold uppercase tracking-wide text-[var(--c-muted)]">{t('invReservedShort')} {numOrZero(row.reservedStock)}</span>}
                            </td>
                            <td className="px-4 py-3.5 text-right font-medium text-[var(--c-muted)]">{numOrZero(row.minimumStock)}</td>
                            <td className="px-4 py-3.5 text-right font-bold text-[var(--c-text)]">{fmtCost(row.cost)}</td>
                            <td className="px-4 py-3.5 text-right"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${statusCls(statusOf(row))}`}>{statusOf(row)}</span></td>
                            <td className="px-4 py-3.5 text-right"><button type="button" onClick={() => openEdit(row)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">{t('edit')}</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="sm:hidden divide-y divide-[var(--c-border-soft)]">
                    {visibleItems.map((row) => (
                      <div key={`m-${row._id || row.id}`} className="px-4 py-3.5 flex flex-col gap-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0"><p className="truncate text-sm font-black text-[var(--c-text)]">{row.name}</p><p className="mt-1 inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--c-muted)]">{stockGroupLabel(row.stockGroup) || t('invUnassigned')} · {row.category} {row.unit}</p></div>
                          <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-black uppercase ${statusCls(row.status)}`}>{row.status}</span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-semibold text-[var(--c-muted)]">
                          <span>{t('invCurrentShort')}: <strong className="text-[var(--c-text)]">{Number(row.currentStock) ?? 0}</strong></span>
                          <span>{t('invMinShort')}: <strong className="text-[var(--c-text)]">{Number(row.minimumStock) ?? 0}</strong></span>
                          <span>{t('invCost')}: <strong className="text-[var(--c-text)]">{fmtCost(row.cost)}</strong></span>
                          <button type="button" onClick={() => openEdit(row)} className="ml-auto inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">{t('edit')}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>

            {/* Edit Item Modal */}
            {editItem && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md">
                <div className="w-full max-w-lg rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1)]">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h3 className="text-sm font-black text-[var(--c-text)]">{t('invEditItem')} {editItem.name}</h3>
                    <button type="button" onClick={() => setEditItem(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--c-muted)] hover:text-[var(--c-text)] hover:bg-[var(--c-bg)] dark:hover:bg-[#252631]">✕</button>
                  </div>
                  <form onSubmit={handleEditItem} className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('uiName')}</span>
                      <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invCategoryField')}</span>
                      <input value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invStockArea')}</span>
                      <select value={editForm.stockGroup} onChange={(e) => setEditForm({ ...editForm, stockGroup: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option value="">{t('invUnassigned')}</option>
                        {STOCK_GROUP_VALUES.map((group) => (
                          <option key={group} value={group}>{t(`invStockGroup${group.charAt(0)}${group.slice(1).toLowerCase()}`) || STOCK_GROUP_LABELS[group]}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invUnit')}</span>
                      <UnitSelect value={editForm.unit} onChange={(v) => setEditForm({ ...editForm, unit: v })} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invMinStock')}</span>
                      <input type="number" min="0" value={editForm.minimumStock} onChange={(e) => setEditForm({ ...editForm, minimumStock: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invCost')}</span>
                      <input type="number" min="0" step="0.01" value={editForm.cost} onChange={(e) => setEditForm({ ...editForm, cost: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('status')}</span>
                      <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option value="In Stock">{t('invInStock')}</option>
                        <option value="Low Stock">{t('invLowStock')}</option>
                        <option value="Out Of Stock">{t('invOutOfStock')}</option>
                      </select>
                    </label>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <button type="submit" disabled={editBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{editBusy ? t('invSaving') : t('invSave')}</button>
                      <button type="button" onClick={() => setEditItem(null)} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('invCancel')}</button>
                      {editError && <span className="text-xs font-semibold text-[#DC2626]">{editError}</span>}
                    </div>
                    <p className="sm:col-span-2 text-[11px] font-medium text-[var(--c-muted)]">{t('invStockNoteLocked')}</p>
                  </form>
                </div>
              </div>
            )}
          </>
        ) : activeTab === 'extras' ? (
          <>
            <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
                <div>
                  <h2 className="text-sm font-black text-[var(--c-text)]">{t('invExtras')}</h2>
                  <p className="text-xs font-medium text-[var(--c-muted)]">{t('invExtrasHint')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">{loadingExtras ? '…' : `${extras.length} ${t('invItems')}`}</span>
                  <button type="button" onClick={() => setShowExtraAdd((v) => !v)} className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm">{showExtraAdd ? t('close') : `+ ${t('invAddExtra')}`}</button>
                  <button type="button" onClick={fetchExtras} className="inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm">{t('invRefresh')}</button>
                </div>
              </div>

              {/* Add Extra Item form */}
              {showExtraAdd && (
                <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                  <form onSubmit={handleAddExtra} className="grid gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('uiName')} *</span>
                      <input value={extraForm.name} onChange={(e) => setExtraForm({ ...extraForm, name: e.target.value })} placeholder="Extra Injera" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invCategoryField')}</span>
                      <input value={extraForm.category} onChange={(e) => setExtraForm({ ...extraForm, category: e.target.value })} placeholder={EXTRA_ITEM_CATEGORY} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invSellingPrice')} *</span>
                      <input type="number" min="0" step="0.01" value={extraForm.sellingPrice} onChange={(e) => setExtraForm({ ...extraForm, sellingPrice: e.target.value })} placeholder="20" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invLinkedStock')} *</span>
                      <select value={extraForm.inventoryItemId} onChange={(e) => setExtraForm({ ...extraForm, inventoryItemId: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option value="">{t('invSelectItem')}</option>
                        {extraStockCandidates.map((it) => (
                          <option key={it._id || it.id} value={it._id || it.id}>
                            {it.name} · {it.unit} · {stockGroupLabel(it.stockGroup) || t('invUnassigned')} · {t('invCurrentShort')} {numOrZero(it.currentStock)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-end gap-2 pb-2">
                      <input type="checkbox" checked={extraForm.isAvailable} onChange={(e) => setExtraForm({ ...extraForm, isAvailable: e.target.checked })} className="h-4 w-4 rounded border-[var(--c-border-soft)] text-[var(--c-accent)] focus:ring-[var(--c-accent)]/30" />
                      <span className="text-xs font-bold text-[var(--c-muted)]">{t('invAvailable')}</span>
                    </label>
                    <div className="sm:col-span-3 flex items-center gap-2">
                      <button type="submit" disabled={extraBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{extraBusy ? t('invSaving') : t('invCreateExtra')}</button>
                      <button type="button" onClick={() => { setShowExtraAdd(false); setExtraFormError(''); setExtraForm(EMPTY_EXTRA_FORM); }} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('invCancel')}</button>
                      {extraFormError && <span className="text-xs font-semibold text-[#DC2626]">{extraFormError}</span>}
                    </div>
                  </form>
                </div>
              )}

              {loadingExtras ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                  ))}
                </div>
              ) : extrasError ? (
                <div className="px-4 sm:px-5 py-8 text-center">
                  <p className="text-sm font-bold text-[#DC2626]">{extrasError}</p>
                  <button type="button" onClick={fetchExtras} className="mt-3 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)]">{t('uiRetry')}</button>
                </div>
              ) : extras.length === 0 ? (
                <div className="px-4 sm:px-5 py-12 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] mb-3"><IconStackFilled size={20} className="h-5 w-5" /></div>
                  <p className="text-sm font-black text-[var(--c-text)]">{t('invNoExtras')}</p>
                  <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[44ch] mx-auto">{t('invExtrasEmptyHint')}</p>
                </div>
              ) : (
                <>
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                        <tr>
                          <th className="px-4 py-3 font-black">{t('uiName')}</th>
                          <th className="px-4 py-3 font-black">{t('invCategoryField')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('invSellingPrice')}</th>
                          <th className="px-4 py-3 font-black">{t('invLinkedStock')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('invAvailable')}</th>
                          <th className="px-4 py-3 text-right font-black">{t('invActions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--c-border-soft)]">
                        {extras.map((ex) => {
                          const inv = ex.inventory || items.find((it) => String(it._id || it.id) === String(ex.inventoryItemId));
                          return (
                            <tr key={ex._id || ex.id}>
                              <td className="px-4 py-3.5 font-bold text-[var(--c-text)]">{ex.name}</td>
                              <td className="px-4 py-3.5"><span className="inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)]">{ex.category || EXTRA_ITEM_CATEGORY}</span></td>
                              <td className="px-4 py-3.5 text-right font-black text-[var(--c-text)]">{fmtCost(ex.sellingPrice)}</td>
                              <td className="px-4 py-3.5">
                                {inv ? (
                                  <span className="text-xs font-semibold text-[var(--c-text)]">
                                    {inv.name}
                                    <span className="block text-[10px] font-medium uppercase tracking-wide text-[var(--c-muted)]">{inv.unit} · {t('invCurrentShort')} {numOrZero(inv.currentStock)}</span>
                                  </span>
                                ) : (
                                  <span className="text-xs font-semibold text-[#DC2626]">{t('invExtraStockMissing')}</span>
                                )}
                              </td>
                              <td className="px-4 py-3.5 text-right">
                                <button type="button" onClick={() => handleToggleExtraAvailability(ex)} className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${ex.isAvailable === false ? 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]' : 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0]'}`}>
                                  {ex.isAvailable === false ? t('invUnavailable') : t('invAvailable')}
                                </button>
                              </td>
                              <td className="px-4 py-3.5 text-right whitespace-nowrap">
                                <button type="button" onClick={() => openEditExtra(ex)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">{t('edit')}</button>
                                <button type="button" onClick={() => handleDeleteExtra(ex)} className="ml-1.5 inline-flex h-7 items-center justify-center rounded-lg border border-[#FECACA] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[#DC2626]">{t('delete')}</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="sm:hidden divide-y divide-[var(--c-border-soft)]">
                    {extras.map((ex) => {
                      const inv = ex.inventory || items.find((it) => String(it._id || it.id) === String(ex.inventoryItemId));
                      return (
                        <div key={`m-${ex._id || ex.id}`} className="px-4 py-3.5 flex flex-col gap-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-black text-[var(--c-text)]">{ex.name}</p>
                              <p className="mt-1 inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--c-muted)]">{ex.category || EXTRA_ITEM_CATEGORY}</p>
                            </div>
                            <span className="shrink-0 text-sm font-black text-[var(--c-text)]">{fmtCost(ex.sellingPrice)}</span>
                          </div>
                          <p className="text-xs font-semibold text-[var(--c-muted)]">
                            {t('invLinkedStock')}: <strong className="text-[var(--c-text)]">{inv ? `${inv.name} · ${inv.unit}` : t('invExtraStockMissing')}</strong>
                          </p>
                          <div className="flex items-center gap-1.5">
                            <button type="button" onClick={() => handleToggleExtraAvailability(ex)} className={`inline-flex h-7 items-center justify-center rounded-lg border px-2.5 text-[11px] font-black uppercase ${ex.isAvailable === false ? 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]' : 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0]'}`}>
                              {ex.isAvailable === false ? t('invUnavailable') : t('invAvailable')}
                            </button>
                            <button type="button" onClick={() => openEditExtra(ex)} className="ml-auto inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">{t('edit')}</button>
                            <button type="button" onClick={() => handleDeleteExtra(ex)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[#FECACA] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[#DC2626]">{t('delete')}</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>

            {/* Edit Extra Item modal */}
            {editExtra && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md">
                <div className="w-full max-w-lg rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1)]">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h3 className="text-sm font-black text-[var(--c-text)]">{t('invEditExtra')} {editExtra.name}</h3>
                    <button type="button" onClick={() => setEditExtra(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--c-muted)] hover:text-[var(--c-text)] hover:bg-[var(--c-bg)] dark:hover:bg-[#252631]">✕</button>
                  </div>
                  <form onSubmit={handleEditExtra} className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('uiName')} *</span>
                      <input value={editExtraForm.name} onChange={(e) => setEditExtraForm({ ...editExtraForm, name: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invCategoryField')}</span>
                      <input value={editExtraForm.category} onChange={(e) => setEditExtraForm({ ...editExtraForm, category: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invSellingPrice')} *</span>
                      <input type="number" min="0" step="0.01" value={editExtraForm.sellingPrice} onChange={(e) => setEditExtraForm({ ...editExtraForm, sellingPrice: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invLinkedStock')} *</span>
                      <select value={editExtraForm.inventoryItemId} onChange={(e) => setEditExtraForm({ ...editExtraForm, inventoryItemId: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option value="">{t('invSelectItem')}</option>
                        {extraStockCandidates.map((it) => (
                          <option key={it._id || it.id} value={it._id || it.id}>
                            {it.name} · {it.unit} · {stockGroupLabel(it.stockGroup) || t('invUnassigned')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="sm:col-span-2 flex items-center gap-2">
                      <input type="checkbox" checked={editExtraForm.isAvailable} onChange={(e) => setEditExtraForm({ ...editExtraForm, isAvailable: e.target.checked })} className="h-4 w-4 rounded border-[var(--c-border-soft)] text-[var(--c-accent)] focus:ring-[var(--c-accent)]/30" />
                      <span className="text-xs font-bold text-[var(--c-muted)]">{t('invAvailable')}</span>
                    </label>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <button type="submit" disabled={editExtraBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{editExtraBusy ? t('invSaving') : t('invSave')}</button>
                      <button type="button" onClick={() => setEditExtra(null)} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('invCancel')}</button>
                      {editExtraError && <span className="text-xs font-semibold text-[#DC2626]">{editExtraError}</span>}
                    </div>
                    <p className="sm:col-span-2 text-[11px] font-medium text-[var(--c-muted)]">{t('invExtraNoRecipeNote')}</p>
                  </form>
                </div>
              </div>
            )}
          </>
        ) : activeTab === 'movements' ? (
          <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-black text-[var(--c-text)]">
                  {movementSubTab === 'movements' ? (t('invMovements') || 'Stock Movements') : (t('invAudits') || 'Audit Trail')}
                </h2>
                <div className="inline-flex rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] p-0.5 text-xs font-bold shadow-sm">
                  <button
                    type="button"
                    onClick={() => setMovementSubTab('movements')}
                    className={`rounded-lg px-2.5 py-1 transition-all ${
                      movementSubTab === 'movements'
                        ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white shadow-sm'
                        : 'text-[var(--c-muted)] hover:text-[var(--c-text)]'
                    }`}
                  >
                    {t('invMovements') || 'Movements'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMovementSubTab('audits')}
                    className={`rounded-lg px-2.5 py-1 transition-all ${
                      movementSubTab === 'audits'
                        ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white shadow-sm'
                        : 'text-[var(--c-muted)] hover:text-[var(--c-text)]'
                    }`}
                  >
                    {t('invAudits') || 'Audits'}
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">
                  {movementSubTab === 'movements'
                    ? (loadingMovements ? '…' : `${movements.length} ${t('invMovementsCount') || 'movements'}`)
                    : (loadingAudits ? '…' : `${audits.length} ${t('invAuditsCount') || 'audits'}`)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    fetchMovements(movementItemId);
                    fetchAudits();
                  }}
                  className="inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm"
                >
                  {t('invRefresh') || 'Refresh'}
                </button>
              </div>
            </div>

            {/* Filter controls */}
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/20 px-4 sm:px-5 py-3 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-[var(--c-muted)]">{t('invFilterByItem') || 'Item'}:</span>
                <select
                  value={movementItemId}
                  onChange={(e) => {
                    setMovementItemId(e.target.value);
                    fetchMovements(e.target.value);
                  }}
                  className="h-8 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2 text-xs font-semibold text-[var(--c-text)]"
                >
                  <option value="">{t('invAllItems') || 'All Items'}</option>
                  {items.map((it) => (
                    <option key={it._id || it.id} value={it._id || it.id}>
                      {it.name} ({it.unit})
                    </option>
                  ))}
                </select>
              </div>

              {movementSubTab === 'movements' && (
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-[var(--c-muted)]">{t('invFilterByType') || 'Type'}:</span>
                  <select
                    value={movementTypeFilter}
                    onChange={(e) => setMovementTypeFilter(e.target.value)}
                    className="h-8 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2 text-xs font-semibold text-[var(--c-text)]"
                  >
                    <option value="ALL">{t('invAllTypes') || 'All Types'}</option>
                    <option value="IN">{t('invMovementIn') || 'IN (Receive)'}</option>
                    <option value="OUT">{t('invMovementOut') || 'OUT (Sale/Waste)'}</option>
                    <option value="ADJUSTMENT">{t('invMovementAdjustment') || 'ADJUSTMENT'}</option>
                  </select>
                </div>
              )}
            </div>

            {movementSubTab === 'movements' ? (
              loadingMovements ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                  ))}
                </div>
              ) : movementsError ? (
                <div className="m-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-4 text-xs font-semibold text-[#DC2626] flex items-center justify-between">
                  <span>{movementsError}</span>
                  <button type="button" onClick={() => fetchMovements(movementItemId)} className="rounded-lg bg-white border border-[#FECACA] px-2.5 py-1">{t('uiRetry') || 'Retry'}</button>
                </div>
              ) : (movements.filter((m) => movementTypeFilter === 'ALL' || m.type === movementTypeFilter)).length === 0 ? (
                <div className="p-12 text-center text-sm font-bold text-[var(--c-muted)]">
                  {t('invNoMovements') || 'No stock movements recorded'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)] text-[11px] font-black uppercase tracking-wider text-[var(--c-muted)]">
                      <tr>
                        <th className="px-4 sm:px-5 py-3">{t('invDate') || 'Date'}</th>
                        <th className="px-4 sm:px-5 py-3">{t('invItemField') || 'Item'}</th>
                        <th className="px-4 sm:px-5 py-3">{t('invMovementType') || 'Type'}</th>
                        <th className="px-4 sm:px-5 py-3 text-right">{t('qty') || 'Quantity'}</th>
                        <th className="px-4 sm:px-5 py-3">{t('invMovementReason') || 'Reason'}</th>
                        <th className="px-4 sm:px-5 py-3">{t('invNotes') || 'Notes'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--c-border-soft)] text-xs">
                      {movements
                        .filter((m) => movementTypeFilter === 'ALL' || m.type === movementTypeFilter)
                        .map((m) => {
                          const matchedItem = items.find((it) => String(it._id || it.id) === String(m.item));
                          const itemName = matchedItem?.name || (typeof m.item === 'object' ? m.item?.name : null) || m.item || '—';
                          const unit = m.unit || matchedItem?.unit || '';
                          const isOut = m.type === 'OUT';
                          const isIn = m.type === 'IN';
                          return (
                            <tr key={m._id || m.id} className="hover:bg-[var(--c-bg)]/30">
                              <td className="px-4 sm:px-5 py-3 font-semibold text-[var(--c-muted)] whitespace-nowrap">
                                {fmtDateTime(m.createdAt, lang)}
                              </td>
                              <td className="px-4 sm:px-5 py-3 font-bold text-[var(--c-text)]">
                                {itemName}
                              </td>
                              <td className="px-4 sm:px-5 py-3">
                                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${
                                  isIn
                                    ? 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7]'
                                    : isOut
                                    ? 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA] dark:bg-[#2A2B36] dark:text-[#FCA5A5]'
                                    : 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]'
                                }`}>
                                  {m.type}
                                </span>
                              </td>
                              <td className={`px-4 sm:px-5 py-3 text-right font-black ${
                                isIn ? 'text-[#15803D] dark:text-[#6EE7B7]' : 'text-[var(--c-text)]'
                              }`}>
                                {isIn ? '+' : isOut ? '-' : ''}{m.quantity} {unit}
                              </td>
                              <td className="px-4 sm:px-5 py-3 text-[var(--c-muted)] font-semibold">
                                <span>{m.reason || '—'}</span>
                                {m.refOrderId && (
                                  <span className="ml-1 text-[10px] font-bold text-[var(--c-accent)]">
                                    (Order #{String(m.refOrderId).slice(-6)})
                                  </span>
                                )}
                              </td>
                              <td className="px-4 sm:px-5 py-3 text-[var(--c-muted)] max-w-xs truncate">
                                {m.notes || '—'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              loadingAudits ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                  ))}
                </div>
              ) : auditsError ? (
                <div className="m-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-4 text-xs font-semibold text-[#DC2626] flex items-center justify-between">
                  <span>{auditsError}</span>
                  <button type="button" onClick={fetchAudits} className="rounded-lg bg-white border border-[#FECACA] px-2.5 py-1">{t('uiRetry') || 'Retry'}</button>
                </div>
              ) : audits.length === 0 ? (
                <div className="p-12 text-center text-sm font-bold text-[var(--c-muted)]">
                  {t('invNoAudits') || 'No audit records found'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)] text-[11px] font-black uppercase tracking-wider text-[var(--c-muted)]">
                      <tr>
                        <th className="px-4 sm:px-5 py-3">{t('invDate') || 'Date'}</th>
                        <th className="px-4 sm:px-5 py-3">{t('invItemField') || 'Item'}</th>
                        <th className="px-4 sm:px-5 py-3">Action</th>
                        <th className="px-4 sm:px-5 py-3">Actor</th>
                        <th className="px-4 sm:px-5 py-3 text-right">Delta / Detail</th>
                        <th className="px-4 sm:px-5 py-3">{t('invNotes') || 'Notes'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--c-border-soft)] text-xs">
                      {audits.map((a) => {
                        const matchedItem = items.find((it) => String(it._id || it.id) === String(a.item));
                        const itemName = matchedItem?.name || a.itemName || a.item || '—';
                        const isPolicyChange =
                          a.entity === 'MenuItem' ||
                          String(a.reason || '').startsWith('MENU_ITEM_INVENTORY_POLICY_CHANGE');
                        const beforePolicy =
                          a.beforeSnapshot?.resolvedPolicy ?? a.beforeSnapshot?.inventoryPolicy;
                        const afterPolicy =
                          a.afterSnapshot?.resolvedPolicy ?? a.afterSnapshot?.inventoryPolicy;
                        const policyDetail =
                          beforePolicy != null || afterPolicy != null
                            ? `${beforePolicy ?? '—'} → ${afterPolicy ?? '—'}`
                            : '';
                        return (
                          <tr key={a._id || a.id} className="hover:bg-[var(--c-bg)]/30">
                            <td className="px-4 sm:px-5 py-3 font-semibold text-[var(--c-muted)] whitespace-nowrap">
                              {fmtDateTime(a.createdAt, lang)}
                            </td>
                            <td className="px-4 sm:px-5 py-3 font-bold text-[var(--c-text)]">
                              {isPolicyChange && (
                                <span className="mr-1 inline-flex rounded-full border border-[#BBF7D0] bg-[#F0FDF4] px-2 py-0.5 text-[10px] font-black uppercase text-[#15803D] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7]">
                                  {t('invPolicyChange') || 'Menu classification'}
                                </span>
                              )}
                              {itemName}
                            </td>
                            <td className="px-4 sm:px-5 py-3">
                              <span className="inline-flex rounded-full border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-2 py-0.5 text-[10px] font-black uppercase text-[var(--c-text)]">
                                {isPolicyChange ? (t('invPolicyChange') || 'Menu classification') : a.action}
                              </span>
                            </td>
                            <td className="px-4 sm:px-5 py-3 text-[var(--c-muted)] font-medium">
                              {a.actorName || a.actor || 'System'}
                            </td>
                            <td className="px-4 sm:px-5 py-3 text-right font-black text-[var(--c-text)]">
                              {isPolicyChange ? '—' : (a.delta?.currentStock != null ? `${a.delta.currentStock > 0 ? '+' : ''}${a.delta.currentStock} ${a.unit || ''}` : '—')}
                            </td>
                            <td className="px-4 sm:px-5 py-3 text-[var(--c-muted)] max-w-xs truncate">
                              {isPolicyChange
                                ? `${policyDetail || a.notes || a.reason || '—'}${a.reason ? ` · ${a.reason}` : ''}`
                                : (a.notes || a.reason || '—')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </section>
        ) : activeTab === 'suppliers' ? (
          <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
              <div>
                <h2 className="text-sm font-black text-[var(--c-text)]">{t('invSuppliers')}</h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">{loadingSuppliers ? '…' : `${suppliers.length} ${t('invSuppliersCount')}`}</span>
                <button type="button" onClick={() => setShowSupAdd((v) => !v)} className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm">{showSupAdd ? t('close') : `+ ${t('invAddSupplier')}`}</button>
                <button type="button" onClick={fetchSuppliers} className="hidden sm:inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)]">{t('invRefresh')}</button>
              </div>
            </div>
            {suppliersError && (
              <div className="mx-4 sm:mx-5 mt-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
                <span>{suppliersError}</span>
                <button type="button" onClick={fetchSuppliers} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">{t('uiRetry')}</button>
              </div>
            )}
            {successMsg && !itemsError && <div className="mx-4 sm:mx-5 mt-4 rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3.5 py-2.5 text-xs font-bold text-[#15803D]">{successMsg}</div>}
            {showSupAdd && (
              <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                <form onSubmit={handleAddSupplier} className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('uiName')} *</span>
                      <input value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} placeholder="Fresh Farms" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invContact')}</span>
                      <input value={supForm.contact} onChange={(e) => setSupForm({ ...supForm, contact: e.target.value })} placeholder="+251 9..." className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invAddress')}</span>
                      <input value={supForm.address} onChange={(e) => setSupForm({ ...supForm, address: e.target.value })} placeholder="Addis Ababa" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('status')}</span>
                      <select value={supForm.status} onChange={(e) => setSupForm({ ...supForm, status: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                        <option value="Active">{t('uiActive')}</option>
                        <option value="Inactive">{t('uiDisabled')}</option>
                      </select>
                    </label>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <button type="submit" disabled={supBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{supBusy ? t('invSaving') : t('invCreateSupplier')}</button>
                    {supError && <span className="text-xs font-semibold text-[#DC2626]">{supError}</span>}
                  </div>
                </form>
              </div>
            )}
            {loadingSuppliers ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                ))}
              </div>
            ) : suppliers.length === 0 ? (
              <div className="px-4 sm:px-5 py-12 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] mb-3"><IconClipboardListFilled size={20} className="h-5 w-5" /></div>
                <p className="text-sm font-black text-[var(--c-text)]">{t('invNoSuppliers')}</p>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">{t('invAddSupplierFirst')} <strong className="text-[var(--c-text)]">+ {t('invAddSupplier')}</strong></p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--c-border-soft)]">
                {suppliers.map((s) => (
                  <div key={s._id || s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-black text-[var(--c-text)]">{s.name}</p>
                      <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">{s.contact || '—'} {s.address || '—'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${s.status === 'Active' ? 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7]' : 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]'}`}>{s.status}</span>
                      <button type="button" onClick={() => openEditSup(s)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">{t('edit')}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {editSup && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md">
                <div className="w-full max-w-lg rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1)]">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h3 className="text-sm font-black text-[var(--c-text)]">{t('invEditSupplier')} {editSup.name}</h3>
                    <button type="button" onClick={() => setEditSup(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--c-muted)] hover:text-[var(--c-text)] hover:bg-[var(--c-bg)] dark:hover:bg-[#252631]">✕</button>
                  </div>
                  <form onSubmit={handleEditSupplier} className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('uiName')}</span>
                      <input value={editSupForm.name} onChange={(e) => setEditSupForm({ ...editSupForm, name: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invContact')}</span>
                      <input value={editSupForm.contact} onChange={(e) => setEditSupForm({ ...editSupForm, contact: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invAddress')}</span>
                      <input value={editSupForm.address} onChange={(e) => setEditSupForm({ ...editSupForm, address: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('status')}</span>
                      <select value={editSupForm.status} onChange={(e) => setEditSupForm({ ...editSupForm, status: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                        <option value="Active">{t('uiActive')}</option>
                        <option value="Inactive">{t('uiDisabled')}</option>
                      </select>
                    </label>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <button type="submit" disabled={editSupBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{editSupBusy ? t('invSaving') : t('invSave')}</button>
                      <button type="button" onClick={() => setEditSup(null)} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('invCancel')}</button>
                      {editSupError && <span className="text-xs font-semibold text-[#DC2626]">{editSupError}</span>}
                    </div>
                  </form>
                </div>
              </div>
            )}
          </section>
        ) : activeTab === 'recipes' ? (
          <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
              <div>
                <h2 className="text-sm font-black text-[var(--c-text)]">{t('invRecipesMenuTitle')}</h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">{loadingRecipes ? '…' : `${recipes.length} ${t('invRecipesCount')}`}</span>
                <button type="button" onClick={() => setShowRecipeAdd((v) => !v)} className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm">{showRecipeAdd ? t('close') : `+ ${t('invAddRecipe')}`}</button>
                <button type="button" onClick={() => { fetchRecipes(); fetchMenu(); }} className="hidden sm:inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)]">{t('invRefresh')}</button>
              </div>
            </div>

            {/* Classification Summary & Filter Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-bold text-[var(--c-muted)] mr-1">{t('invClassification') || 'Classification'}:</span>
                <button
                  type="button"
                  onClick={() => setRecipeClassificationFilter('ALL')}
                  className={`rounded-xl px-3 py-1 font-bold transition-all ${
                    recipeClassificationFilter === 'ALL'
                      ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white shadow-sm'
                      : 'text-[var(--c-muted)] hover:text-[var(--c-text)] bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)]'
                  }`}
                >
                  {t('invAllCatalog') || 'All Catalog'} ({menuItems.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRecipeClassificationFilter('TRACKED')}
                  className={`rounded-xl px-3 py-1 font-bold transition-all ${
                    recipeClassificationFilter === 'TRACKED'
                      ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white shadow-sm'
                      : 'text-[var(--c-muted)] hover:text-[var(--c-text)] bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)]'
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    {t('invTracked') || 'Tracked'} ({trackedCount})
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setRecipeClassificationFilter('UNTRACKED')}
                  className={`rounded-xl px-3 py-1 font-bold transition-all ${
                    recipeClassificationFilter === 'UNTRACKED'
                      ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white shadow-sm'
                      : 'text-[var(--c-muted)] hover:text-[var(--c-text)] bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)]'
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    {t('invUntracked') || 'Untracked'} ({untrackedCount})
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setRecipeClassificationFilter('UNKNOWN')}
                  className={`rounded-xl px-3 py-1 font-bold transition-all ${
                    recipeClassificationFilter === 'UNKNOWN'
                      ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white shadow-sm'
                      : 'text-[var(--c-muted)] hover:text-[var(--c-text)] bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)]'
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-slate-400" />
                    {t('invUnknown') || 'Needs review'} ({unknownCount})
                  </span>
                </button>
              </div>
            </div>

            {recipesError && (
              <div className="mx-4 sm:mx-5 mt-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
                <span>{recipesError}</span>
                <button type="button" onClick={() => { fetchRecipes(); fetchMenu(); }} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">{t('uiRetry')}</button>
              </div>
            )}

            {showRecipeAdd && (
              <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                <form onSubmit={handleAddRecipe} className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invMenuItem')} *</span>
                    {loadingMenu ? (
                      <div className="h-9 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                    ) : (
                      <select value={recipeForm.menuItemId} onChange={(e) => setRecipeForm({ ...recipeForm, menuItemId: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                        <option value="">{t('invSelectMenuItem')}</option>
                        {menuItems.map((m) => (
                          <option key={m._id || m.id} value={m._id || m.id}>{getMenuDisplayName(m)} {m.price != null ? fmtCost(m.price) : ''}</option>
                        ))}
                      </select>
                    )}
                  </label>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black uppercase tracking-wide text-[var(--c-muted)]">{t('invIngredients')}</span>
                      <button type="button" onClick={() => addRecipeRow(false)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">+ {t('invAddRow')}</button>
                    </div>
                    {recipeForm.ingredients.map((row, idx) => (
                      <div key={idx} className="grid gap-2 sm:grid-cols-[1fr_110px_90px_40px] items-end">
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">{t('invInventoryItem')}</span>
                          <select value={row.inventoryItemId} onChange={(e) => updateRecipeIngredient(idx, 'inventoryItemId', e.target.value, false)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2 text-sm font-medium text-[var(--c-text)]">
                            <option value="">{t('invSelectItem')}</option>
                            {items.map((it) => (
                              <option key={it._id || it.id} value={it._id || it.id}>{it.name} ({it.unit})</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">{t('invQuantity')}</span>
                          <input type="number" min="0" step="0.001" value={row.quantity} onChange={(e) => updateRecipeIngredient(idx, 'quantity', e.target.value, false)} placeholder="0.5" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">{t('invUnit')}</span>
                          <UnitSelect value={row.unit} onChange={(v) => updateRecipeIngredient(idx, 'unit', v, false)} />
                        </label>
                        <button type="button" onClick={() => removeRecipeRow(idx, false)} className="h-9 w-full sm:w-10 inline-flex items-center justify-center rounded-xl border border-[#FECACA] bg-white text-[#DC2626] text-xs font-bold">✕</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="submit" disabled={recipeBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{recipeBusy ? t('invSaving') : t('invCreateRecipe')}</button>
                    {recipeError && <span className="text-xs font-semibold text-[#DC2626]">{recipeError}</span>}
                  </div>
                </form>
              </div>
            )}

            {recipeClassificationFilter === 'UNKNOWN' ? (
              unknownItems.length === 0 ? (
                <div className="px-4 sm:px-5 py-12 text-center">
                  <p className="text-sm font-black text-[var(--c-text)]">{t('invNoUnknownCatalog')}</p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--c-border-soft)]">
                  <div className="px-4 sm:px-5 py-2.5 bg-[var(--c-bg)]/40 text-xs font-semibold text-[var(--c-muted)] flex items-center justify-between">
                    <span>{t('invUnknownHint')}</span>
                    <span>{unknownCount} {t('invAllCatalog')}</span>
                  </div>
                  {unknownItems.map((item) => (
                    <div key={item._id || item.id} className="px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 hover:bg-[var(--c-bg)]/20">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-black text-[var(--c-text)]">{getMenuDisplayName(item)}</p>
                        <span className="inline-flex rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 px-2 py-0.5 text-[10px] font-black uppercase text-slate-600 dark:text-slate-300">
                          {t('invUnknown') || 'Needs review'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : recipeClassificationFilter === 'UNTRACKED' ? (
              untrackedItems.length === 0 ? (
                <div className="px-4 sm:px-5 py-12 text-center">
                  <p className="text-sm font-black text-[var(--c-text)]">{t('invNoUntrackedCatalog')}</p>
                  <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">{t('inventoryPolicyReviewHint')}</p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--c-border-soft)]">
                  <div className="px-4 sm:px-5 py-2.5 bg-[var(--c-bg)]/40 text-xs font-semibold text-[var(--c-muted)] flex items-center justify-between">
                    <span>{t('invUntrackedCatalogHint')}</span>
                    <span>{untrackedItems.length} {t('invAllCatalog')}</span>
                  </div>
                  {untrackedItems.map((item) => (
                    <div key={item._id || item.id} className="px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 hover:bg-[var(--c-bg)]/20">
                      <div>
                        <p className="text-sm font-black text-[var(--c-text)]">{getMenuDisplayName(item)}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--c-muted)]">
                            {item.category?.name || item.category || 'General'}
                          </span>
                          {item.price != null && (
                            <span className="text-xs font-bold text-[var(--c-text)]">{fmtCost(item.price)}</span>
                          )}
                          <span className="inline-flex rounded-full bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 px-2 py-0.5 text-[10px] font-black uppercase text-amber-700 dark:text-amber-400">
                            {t('invUntracked') || 'Untracked'}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setRecipeForm({
                            menuItemId: String(item._id || item.id),
                            ingredients: [{ inventoryItemId: '', quantity: '', unit: '' }],
                          });
                          setShowRecipeAdd(true);
                        }}
                        className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm"
                      >
                        + {t('invCreateRecipeFor') || 'Create Recipe'}
                      </button>
                    </div>
                  ))}
                </div>
              )
            ) : loadingRecipes ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-20 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                ))}
              </div>
            ) : recipes.length === 0 ? (
              <div className="px-4 sm:px-5 py-12 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] mb-3"><IconChefHat size={20} className="h-5 w-5" /></div>
                <p className="text-sm font-black text-[var(--c-text)]">{t('invNoRecipes')}</p>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[40ch] mx-auto">{t('invRecipesGuide')} <em>Cappuccino</em> → Coffee Beans, Milk, Sugar. {t('invRecipesNoDeduct')}</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--c-border-soft)]">
                {recipes
                  .filter((r) => {
                    if (recipeClassificationFilter === 'ALL') return true;
                    const id = String(r?.menuItemId || r?.menuItem?._id || '');
                    return policyOfMenuId(id) === recipeClassificationFilter;
                  })
                  .map((r) => {
                    const menuId = String(r?.menuItemId || r?.menuItem?._id || '');
                    const savedPolicy = policyOfMenuId(menuId);
                    const isTracked = savedPolicy === 'TRACKED';
                    const issue = hasRecipeIssue(menuId);
                    return (
                      <div key={r._id || r.id} className="px-4 sm:px-5 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-black text-[var(--c-text)]">{r.menuItem?.name || r.menuItemId}</p>
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${
                                isTracked
                                  ? 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7]'
                                  : savedPolicy === 'UNTRACKED'
                                  ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400'
                                  : 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-300'
                              }`}>
                                {isTracked ? (t('invTracked') || 'Tracked') : savedPolicy === 'UNTRACKED' ? (t('invUntracked') || 'Untracked') : (t('invUnknown') || 'Needs review')}
                              </span>
                              {issue && (
                                <span className="inline-flex rounded-full border border-[#FECACA] bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-black uppercase text-[#DC2626]">
                                  {t('invRecipeIssue') || 'Recipe issue'}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 flex flex-wrap gap-1.5">
                              {(r.ingredients || []).map((ing, idx) => (
                                <span key={idx} className="inline-flex items-center gap-1 rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2 py-0.5 text-xs font-bold text-[var(--c-muted)]">
                                  {ing.inventoryItem?.name || String(ing.inventoryItemId).slice(-4)}: <strong>{ing.quantity} {ing.unit}</strong>
                                </span>
                              ))}
                              {(!r.ingredients || r.ingredients.length === 0) && <span className="text-xs text-[var(--c-muted)]">{t('invNoIngredients')}</span>}
                            </p>
                            <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">{r.ingredients?.length || 0} {t('invIngredientsCount')} {r.isActive === false ? t('uiDisabled') : t('uiActive')}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${r.isActive === false ? 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]' : 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0]'}`}>{r.isActive === false ? t('uiDisabled') : t('uiActive')}</span>
                            <button type="button" onClick={() => openEditRecipe(r)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">{t('edit')}</button>
                            {r.isActive !== false && (
                              <button type="button" onClick={() => handleDeactivateRecipe(r)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[#FECACA] bg-white px-2.5 text-xs font-bold text-[#DC2626]">{t('invDeactivate')}</button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* Edit Recipe Modal */}
            {editRecipe && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md overflow-y-auto">
                <div className="w-full max-w-xl rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1)] my-auto">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h3 className="text-sm font-black text-[var(--c-text)]">{t('invEditRecipe')} {editRecipe.menuItem?.name || editRecipe.menuItemId}</h3>
                    <button type="button" onClick={() => setEditRecipe(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--c-muted)] hover:text-[var(--c-text)] hover:bg-[var(--c-bg)] dark:hover:bg-[#252631]">✕</button>
                  </div>
                  <form onSubmit={handleEditRecipe} className="space-y-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('invMenuItem')}</span>
                      <select value={editRecipeForm.menuItemId} onChange={(e) => setEditRecipeForm({ ...editRecipeForm, menuItemId: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                        <option value="">{t('invSelectMenuItem')}</option>
                        {menuItems.map((m) => (
                          <option key={m._id || m.id} value={m._id || m.id}>{getMenuDisplayName(m)}</option>
                        ))}
                      </select>
                    </label>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black uppercase tracking-wide text-[var(--c-muted)]">{t('invIngredients')}</span>
                        <button type="button" onClick={() => addRecipeRow(true)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">+ {t('invAddRow')}</button>
                      </div>
                      {editRecipeForm.ingredients.map((row, idx) => (
                        <div key={idx} className="grid gap-2 sm:grid-cols-[1fr_110px_90px_40px] items-end">
                          <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">{t('invInventoryItem')}</span>
                            <select value={row.inventoryItemId} onChange={(e) => updateRecipeIngredient(idx, 'inventoryItemId', e.target.value, true)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2 text-sm font-medium text-[var(--c-text)]">
                        <option value="">{t('invSelectItem')}</option>
                              {items.map((it) => (
                                <option key={it._id || it.id} value={it._id || it.id}>{it.name} ({it.unit})</option>
                              ))}
                            </select>
                          </label>
                          <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">{t('invQuantity')}</span>
                            <input type="number" min="0" step="0.01" value={row.quantity} onChange={(e) => updateRecipeIngredient(idx, 'quantity', e.target.value, true)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                          </label>
                          <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">{t('invUnit')}</span>
                            <UnitSelect value={row.unit} onChange={(v) => updateRecipeIngredient(idx, 'unit', v, true)} />
                          </label>
                          <button type="button" onClick={() => removeRecipeRow(idx, true)} className="h-9 w-full sm:w-10 inline-flex items-center justify-center rounded-xl border border-[#FECACA] bg-white text-[#DC2626] text-xs font-bold">✕</button>
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={editRecipeForm.isActive} onChange={(e) => setEditRecipeForm({ ...editRecipeForm, isActive: e.target.checked })} className="h-4 w-4 rounded border-[var(--c-border-soft)]" />
                      <span className="text-xs font-bold text-[var(--c-muted)]">{t('uiActive')}</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={editRecipeBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{editRecipeBusy ? t('invSaving') : t('invSave')}</button>
                      <button type="button" onClick={() => setEditRecipe(null)} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('invCancel')}</button>
                      {editRecipeError && <span className="text-xs font-semibold text-[#DC2626]">{editRecipeError}</span>}
                    </div>
                  </form>
                </div>
              </div>
            )}

          </section>
        ) : activeTab === 'reports' ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-black text-[var(--c-text)]">{t('invIntelligence')}</h2>
              <button type="button" onClick={fetchDashboard} className="inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm">{t('invRefresh')}</button>
            </div>
            {loadingDashboard ? (
              <div className="grid gap-4">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-24 animate-pulse rounded-2xl bg-[var(--c-card)] border border-[var(--c-border-soft)]" />
                  ))}
                </div>
                <div className="h-48 animate-pulse rounded-2xl bg-[var(--c-card)] border border-[var(--c-border-soft)]" />
              </div>
            ) : dashboardError ? (
              <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
                <span>{dashboardError}</span>
                <button type="button" onClick={fetchDashboard} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">{t('uiRetry')}</button>
              </div>
            ) : !dashboard ? (
              <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-8 text-center">
                <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoDashboard')}</p>
              </div>
            ) : (
              <>
                <section aria-label="Inventory overview" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invTotalItems')}</p>
                    <p className="text-2xl font-black text-[var(--c-text)]">{dashboard.overview?.totalItems ?? 0}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">{t('invDistinctSkus')}</p>
                  </div>
                  <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invInventoryValue')}</p>
                    <p className="text-2xl font-black text-[var(--c-text)]">{fmtCost(dashboard.overview?.inventoryValue)}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">{t('invValueFormula')}</p>
                  </div>
                  <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invLowStock')}</p>
                    <p className="text-2xl font-black text-[#D97706] dark:text-[#FBBF24]">{dashboard.overview?.lowStockCount ?? 0}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">{t('invLowFormula')}</p>
                  </div>
                  <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invOutOfStock')}</p>
                    <p className="text-2xl font-black text-[#DC2626]">{dashboard.overview?.outOfStockCount ?? 0}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">{t('invOutFormula')}</p>
                  </div>
                </section>
                <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-4">
                    <h3 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invFoodCostHist')}</h3>
                  <p className="mt-2 text-2xl font-black text-[var(--c-text)]">{fmtCost(dashboard.foodCost?.foodCost)}</p>
                </section>
                <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
                  <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                      <h3 className="text-sm font-black text-[var(--c-text)]">{t('invConsumption')}</h3>
                  </div>
                  {(!dashboard.consumption || dashboard.consumption.length === 0) ? (
                    <div className="px-4 sm:px-5 py-8 text-center">
                        <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoConsumption')}</p>
                        <p className="text-xs font-medium text-[var(--c-muted)]">{t('invSaleDeductionNote')}</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                            <tr><th className="px-4 py-3 font-black">{t('invIngredient')}</th><th className="px-4 py-3 text-right font-black">{t('invQuantityUsed')}</th><th className="px-4 py-3 font-black">{t('invUnit')}</th></tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--c-border-soft)]">
                          {dashboard.consumption.map((row) => (
                            <tr key={row.itemId}><td className="px-4 py-2.5 font-bold text-[var(--c-text)]">{row.name}</td><td className="px-4 py-2.5 text-right font-black text-[var(--c-text)]">{row.quantityUsed}</td><td className="px-4 py-2.5 font-medium text-[var(--c-muted)]">{row.unit}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
                <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
                  <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                      <h3 className="text-sm font-black text-[var(--c-text)]">{t('invWaste')}</h3>
                  </div>
                  <div className="px-4 sm:px-5 py-3 flex flex-wrap gap-4 text-xs font-bold text-[var(--c-muted)]">
                      <span>{t('invTotalQty')}: <strong className="text-[var(--c-text)]">{dashboard.waste?.totalWasteQuantity ?? 0}</strong></span>
                      <span>{t('invTotalCost')}: <strong className="text-[var(--c-text)]">{fmtCost(dashboard.waste?.totalWasteCost)}</strong></span>
                  </div>
                  {(!dashboard.waste?.items || dashboard.waste.items.length === 0) ? (
                    <div className="px-4 sm:px-5 py-6 text-center">
                        <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoWaste')}</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                            <tr><th className="px-4 py-3 font-black">{t('invIngredient')}</th><th className="px-4 py-3 text-right font-black">{t('qty')}</th><th className="px-4 py-3 text-right font-black">{t('invCost')}</th></tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--c-border-soft)]">
                          {dashboard.waste.items.map((row) => (
                            <tr key={row.itemId}><td className="px-4 py-2.5 font-bold text-[var(--c-text)]">{row.name}</td><td className="px-4 py-2.5 text-right font-black text-[var(--c-text)]">{row.quantity}</td><td className="px-4 py-2.5 text-right font-medium text-[var(--c-text)]">{fmtCost(row.cost)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
                <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
                  <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                      <h3 className="text-sm font-black text-[var(--c-text)]">{t('invTopIngredients')}</h3>
                  </div>
                  {(!dashboard.topIngredients || dashboard.topIngredients.length === 0) ? (
                    <div className="px-4 sm:px-5 py-8 text-center">
                        <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoConsumptionYet')}</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                            <tr><th className="px-4 py-3 font-black">#</th><th className="px-4 py-3 font-black">{t('invIngredient')}</th><th className="px-4 py-3 text-right font-black">{t('invQuantityUsed')}</th></tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--c-border-soft)]">
                          {dashboard.topIngredients.map((row, idx) => (
                            <tr key={row.itemId}><td className="px-4 py-2.5 font-bold text-[var(--c-muted)]">{idx + 1}</td><td className="px-4 py-2.5 font-bold text-[var(--c-text)]">{row.name} <span className="text-xs font-medium text-[var(--c-muted)]">({row.unit})</span></td><td className="px-4 py-2.5 text-right font-black text-[var(--c-text)]">{row.quantityUsed}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* Food Cost Analytics (H6.1) */}
                <div className="pt-2">
                  <h3 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invFoodCostIntel')}</h3>
                </div>
                {loadingFoodCost ? (
                  <div className="grid gap-4">
                    <div className="h-24 animate-pulse rounded-2xl bg-[var(--c-card)] border border-[var(--c-border-soft)]" />
                    <div className="h-48 animate-pulse rounded-2xl bg-[var(--c-card)] border border-[var(--c-border-soft)]" />
                  </div>
                ) : foodCostError ? (
                  <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
                    <span>{foodCostError}</span>
                    <button type="button" onClick={fetchFoodCost} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">{t('uiRetry')}</button>
                  </div>
                ) : !foodCostData ? (
                  <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-8 text-center">
                    <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoFoodCostData')}</p>
                  </div>
                ) : (
                  <>
                    <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-4">
                      <h3 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('invFoodCostSummary')}</h3>
                      <p className="mt-2 text-2xl font-black text-[var(--c-text)]">{fmtCost(foodCostData.summary?.foodCost)}</p>
                    </section>
                    <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
                      <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                        <h3 className="text-sm font-black text-[var(--c-text)]">{t('invDailyTrend')}</h3>
                      </div>
                      {(!foodCostData.trend || foodCostData.trend.length === 0) ? (
                        <div className="px-4 sm:px-5 py-8 text-center">
                          <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoTrendData')}</p>
                          <p className="text-xs font-medium text-[var(--c-muted)]">{t('invSaleDeductionHere')}</p>
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                              <tr><th className="px-4 py-3 font-black">{t('invDate')}</th><th className="px-4 py-3 text-right font-black">{t('invFoodCost')}</th></tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--c-border-soft)]">
                              {foodCostData.trend.map((row) => (
                                <tr key={row.date}><td className="px-4 py-2.5 font-bold text-[var(--c-text)]">{fmtTrendDate(row.date, lang)}</td><td className="px-4 py-2.5 text-right font-black text-[var(--c-text)]">{fmtCost(row.foodCost)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                    <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
                      <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                        <h3 className="text-sm font-black text-[var(--c-text)]">{t('invTopCostIngredients')}</h3>
                      </div>
                      {(!foodCostData.topIngredients || foodCostData.topIngredients.length === 0) ? (
                        <div className="px-4 sm:px-5 py-8 text-center">
                          <p className="text-sm font-bold text-[var(--c-muted)]">{t('invNoCostData')}</p>
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                              <tr><th className="px-4 py-3 font-black">#</th><th className="px-4 py-3 font-black">{t('invIngredient')}</th><th className="px-4 py-3 text-right font-black">{t('invQuantity')}</th><th className="px-4 py-3 text-right font-black">{t('invCost')}</th></tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--c-border-soft)]">
                              {foodCostData.topIngredients.map((row, idx) => (
                                <tr key={row.itemId}><td className="px-4 py-2.5 font-bold text-[var(--c-muted)]">{idx + 1}</td><td className="px-4 py-2.5 font-bold text-[var(--c-text)]">{row.name} <span className="text-xs font-medium text-[var(--c-muted)]">({row.unit})</span></td><td className="px-4 py-2.5 text-right font-medium text-[var(--c-text)]">{row.quantity}</td><td className="px-4 py-2.5 text-right font-black text-[var(--c-text)]">{fmtCost(row.cost)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  </>
                )}
              </>
            )}
          </div>
        ) : null}
      </main>

    </div>
  );
}
