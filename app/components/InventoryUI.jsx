'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { safeFetchJson } from '@/lib/clientFetch';
import {
  IconArchiveFilled,
  IconAlertTriangleFilled,
  IconCoinFilled,
  IconChartBar,
  IconClipboardListFilled,
  IconChefHat,
  IconStackFilled,
} from '@tabler/icons-react';

// Phase F — Recipe System: Menu ↔ Inventory relationship layer
// No stock deduction, no order hooks, presentation + CRUD only.

const TABS = [
  { key: 'stock', label: 'Stock' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'recipes', label: 'Recipes' },
  { key: 'reports', label: 'Reports' },
];

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

function getMenuDisplayName(m) {
  if (!m) return '—';
  if (typeof m.name === 'string') return m.name;
  if (m.title) return m.title;
  if (m.name?.en) return m.name.en;
  if (m.displayName) return m.displayName;
  return m.name || '—';
}

export default function InventoryUI() {
  const [activeTab, setActiveTab] = useState('stock');

  // Data
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [loadingRecipes, setLoadingRecipes] = useState(true);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [itemsError, setItemsError] = useState('');
  const [suppliersError, setSuppliersError] = useState('');
  const [recipesError, setRecipesError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Add Item form
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', category: '', unit: '', currentStock: '', minimumStock: '', cost: '' });
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');

  // Edit Item
  const [editItem, setEditItem] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', category: '', unit: '', minimumStock: '', cost: '', status: '' });
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
      if (err?.status === 401) setItemsError('Unauthorized — please sign in as Manager.');
      else if (err?.status === 403) setItemsError('Forbidden — Manager access required.');
      else setItemsError(m);
    } finally {
      setLoadingItems(false);
    }
  }, []);

  const fetchSuppliers = useCallback(async () => {
    setLoadingSuppliers(true);
    setSuppliersError('');
    try {
      const data = await safeFetchJson('/api/inventory/suppliers', { cache: 'no-store' });
      const list = data?.data?.suppliers || data?.suppliers || [];
      setSuppliers(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load suppliers';
      if (err?.status === 401) setSuppliersError('Unauthorized — please sign in as Manager.');
      else if (err?.status === 403) setSuppliersError('Forbidden — Manager access required.');
      else setSuppliersError(m);
    } finally {
      setLoadingSuppliers(false);
    }
  }, []);

  const fetchRecipes = useCallback(async () => {
    setLoadingRecipes(true);
    setRecipesError('');
    try {
      const data = await safeFetchJson('/api/recipes', { cache: 'no-store' });
      const list = data?.data?.recipes || data?.recipes || [];
      setRecipes(Array.isArray(list) ? list : []);
    } catch (err) {
      const m = err?.message || 'Failed to load recipes';
      if (err?.status === 401) setRecipesError('Unauthorized — please sign in as Manager.');
      else if (err?.status === 403) setRecipesError('Forbidden — Manager access required.');
      else setRecipesError(m);
    } finally {
      setLoadingRecipes(false);
    }
  }, []);

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

  const fetchDashboard = useCallback(async () => {
    setLoadingDashboard(true);
    setDashboardError('');
    try {
      const data = await safeFetchJson('/api/manager/inventory-dashboard', { cache: 'no-store' });
      const payload = data?.data || data || {};
      setDashboard(payload);
    } catch (err) {
      const m = err?.message || 'Failed to load dashboard';
      if (err?.status === 401) setDashboardError('Unauthorized — please sign in as Manager.');
      else if (err?.status === 403) setDashboardError('Forbidden — Manager access required.');
      else setDashboardError(m);
    } finally {
      setLoadingDashboard(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
    fetchSuppliers();
    fetchRecipes();
    fetchMenu();
    fetchDashboard();
  }, [fetchItems, fetchSuppliers, fetchRecipes, fetchMenu, fetchDashboard]);

  useEffect(() => {
    if (successMsg) {
      const t = setTimeout(() => setSuccessMsg(''), 4000);
      return () => clearTimeout(t);
    }
  }, [successMsg]);

  // Dashboard derived from real data
  const totalItems = items.length;
  const lowStockCount = items.filter((it) => String(it.status).toLowerCase() === 'low stock' || (Number(it.currentStock) <= Number(it.minimumStock) && Number(it.currentStock) > 0)).length;
  const outOfStockCount = items.filter((it) => String(it.status).toLowerCase() === 'out of stock' || Number(it.currentStock) <= 0).length;
  const inventoryValue = items.reduce((sum, it) => sum + (Number(it.currentStock) || 0) * (Number(it.cost) || 0), 0);

  const handleAddItem = async (e) => {
    e.preventDefault();
    setAddError('');
    if (!addForm.name.trim() || !addForm.category.trim() || !addForm.unit.trim()) {
      setAddError('name, category and unit are required');
      return;
    }
    setAddBusy(true);
    try {
      const payload = {
        name: addForm.name.trim(),
        category: addForm.category.trim(),
        unit: addForm.unit.trim(),
        currentStock: addForm.currentStock === '' ? undefined : Number(addForm.currentStock),
        minimumStock: addForm.minimumStock === '' ? undefined : Number(addForm.minimumStock),
        cost: addForm.cost === '' ? undefined : Number(addForm.cost),
      };
      await safeFetchJson('/api/inventory/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccessMsg('Item added');
      setShowAdd(false);
      setAddForm({ name: '', category: '', unit: '', currentStock: '', minimumStock: '', cost: '' });
      fetchItems();
    } catch (err) {
      setAddError(err?.message || 'Failed to add item');
    } finally {
      setAddBusy(false);
    }
  };

  const openEdit = (it) => {
    setEditItem(it);
    setEditForm({
      name: it.name || '',
      category: it.category || '',
      unit: it.unit || '',
      minimumStock: String(it.minimumStock ?? ''),
      cost: String(it.cost ?? ''),
      status: it.status || 'In Stock',
    });
    setEditError('');
  };

  const handleEditItem = async (e) => {
    e.preventDefault();
    if (!editItem) return;
    setEditError('');
    setEditBusy(true);
    try {
      const payload = {
        name: editForm.name.trim(),
        category: editForm.category.trim(),
        unit: editForm.unit.trim(),
        minimumStock: editForm.minimumStock === '' ? undefined : Number(editForm.minimumStock),
        cost: editForm.cost === '' ? undefined : Number(editForm.cost),
        status: editForm.status,
      };
      await safeFetchJson(`/api/inventory/items/${editItem._id || editItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccessMsg('Item updated');
      setEditItem(null);
      fetchItems();
    } catch (err) {
      setEditError(err?.message || 'Failed to update item');
    } finally {
      setEditBusy(false);
    }
  };

  const handleAddSupplier = async (e) => {
    e.preventDefault();
    setSupError('');
    if (!supForm.name.trim()) {
      setSupError('name is required');
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
      setSuccessMsg('Supplier added');
      setShowSupAdd(false);
      setSupForm({ name: '', contact: '', address: '', status: 'Active' });
      fetchSuppliers();
    } catch (err) {
      setSupError(err?.message || 'Failed to add supplier');
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
      setSuccessMsg('Supplier updated');
      setEditSup(null);
      fetchSuppliers();
    } catch (err) {
      setEditSupError(err?.message || 'Failed to update supplier');
    } finally {
      setEditSupBusy(false);
    }
  };

  // Recipe handlers
  const handleAddRecipe = async (e) => {
    e.preventDefault();
    setRecipeError('');
    if (!recipeForm.menuItemId) {
      setRecipeError('menuItemId is required');
      return;
    }
    const cleanIngredients = recipeForm.ingredients
      .filter((r) => r.inventoryItemId && r.quantity && r.unit)
      .map((r) => ({ inventoryItemId: r.inventoryItemId, quantity: Number(r.quantity), unit: String(r.unit).trim() }));
    if (cleanIngredients.length === 0) {
      setRecipeError('At least one ingredient with quantity and unit is required');
      return;
    }
    for (const ing of cleanIngredients) {
      if (!Number.isFinite(ing.quantity) || ing.quantity <= 0) {
        setRecipeError('Each ingredient quantity must be > 0');
        return;
      }
      if (!ing.unit) {
        setRecipeError('Each ingredient unit is required');
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
      setSuccessMsg('Recipe created');
      setShowRecipeAdd(false);
      setRecipeForm({ menuItemId: '', ingredients: [{ inventoryItemId: '', quantity: '', unit: '' }] });
      fetchRecipes();
    } catch (err) {
      setRecipeError(err?.message || 'Failed to create recipe');
    } finally {
      setRecipeBusy(false);
    }
  };

  const openEditRecipe = (r) => {
    setEditRecipe(r);
    setEditRecipeForm({
      menuItemId: r.menuItemId || (r.menuItem?._id || ''),
      ingredients: (r.ingredients || []).map((ing) => ({
        inventoryItemId: String(ing.inventoryItemId || ing.itemId || (ing.inventoryItem?._id || '')),
        quantity: String(ing.quantity ?? ''),
        unit: String(ing.unit || ''),
      })),
      isActive: r.isActive !== false,
    });
    setEditRecipeError('');
  };

  const handleEditRecipe = async (e) => {
    e.preventDefault();
    if (!editRecipe) return;
    setEditRecipeError('');
    const cleanIngredients = editRecipeForm.ingredients
      .filter((r) => r.inventoryItemId && r.quantity && r.unit)
      .map((r) => ({ inventoryItemId: r.inventoryItemId, quantity: Number(r.quantity), unit: String(r.unit).trim() }));
    if (cleanIngredients.length === 0) {
      setEditRecipeError('At least one ingredient required');
      return;
    }
    setEditRecipeBusy(true);
    try {
      await safeFetchJson(`/api/recipes/${editRecipe._id || editRecipe.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menuItemId: editRecipeForm.menuItemId, ingredients: cleanIngredients, isActive: editRecipeForm.isActive }),
      });
      setSuccessMsg('Recipe updated');
      setEditRecipe(null);
      fetchRecipes();
    } catch (err) {
      setEditRecipeError(err?.message || 'Failed to update recipe');
    } finally {
      setEditRecipeBusy(false);
    }
  };

  const handleDeactivateRecipe = async (r) => {
    if (!confirm(`Deactivate recipe for ${r.menuItem?.name || r.menuItemId}?`)) return;
    try {
      await safeFetchJson(`/api/recipes/${r._id || r.id}`, { method: 'DELETE' });
      setSuccessMsg('Recipe deactivated');
      fetchRecipes();
    } catch (err) {
      setRecipesError(err?.message || 'Failed to deactivate');
    }
  };

  const updateRecipeIngredient = (idx, field, value, isEdit) => {
    if (isEdit) {
      const next = [...editRecipeForm.ingredients];
      next[idx] = { ...next[idx], [field]: value };
      setEditRecipeForm({ ...editRecipeForm, ingredients: next });
    } else {
      const next = [...recipeForm.ingredients];
      next[idx] = { ...next[idx], [field]: value };
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
      {/* Header */}
      <header className="sticky top-0 z-20 bg-[var(--c-header)] dark:bg-[#1C1D24] border-b border-[var(--c-border-soft)] dark:border-[#2A2B36] shadow-sm">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)] shadow-sm text-[var(--c-accent)]">
                <IconArchiveFilled size={20} aria-hidden={true} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg sm:text-xl font-black tracking-tight leading-none text-[var(--c-text)]">Bono Inventory Management</h1>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Stock · Suppliers · Recipes · Reports — Live data</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-[var(--c-muted)] shadow-sm">
                <span className="h-2 w-2 rounded-full bg-[#16A34A]" aria-hidden="true" />
                API connected
              </span>
              <Link href="/" className="hidden sm:inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] shadow-sm tactile">Home</Link>
              <Link href="/manager/reports" className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm tactile">Reports</Link>
            </div>
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
            <button type="button" onClick={fetchItems} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626] hover:bg-[#FFF7ED]">Retry</button>
          </div>
        )}

        {/* Tabs */}
        <div className="card-elevated rounded-2xl p-2 bg-[var(--c-card)]">
          <nav className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1" aria-label="Inventory tabs">
            {TABS.map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  aria-selected={active}
                  className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-xs font-black uppercase tracking-wide border transition-all tactile ${
                    active ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white border-transparent shadow-sm' : 'bg-white dark:bg-[#12131A] text-[var(--c-muted)] border-[var(--c-border-soft)] hover:text-[var(--c-text)]'
                  }`}
                >
                  {tab.label}
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
              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Total Items</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]"><IconArchiveFilled size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-12 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[var(--c-text)]">{totalItems}</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">{loadingItems ? 'Loading…' : `${totalItems} items in inventory`}</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">Live from API</p>
              </div>
              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Low Stock</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FEF3C7] dark:bg-[rgba(251,191,36,0.15)] text-[#92400E] dark:text-[#FBBF24]"><IconAlertTriangleFilled size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-12 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[#D97706] dark:text-[#FBBF24]">{lowStockCount}</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">{outOfStockCount} out of stock</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">Status derived in UI</p>
              </div>
              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Inventory Value</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]"><IconCoinFilled size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-24 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[var(--c-text)]">{fmtCost(inventoryValue)}</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">sum(stock × cost)</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">UI calculation only</p>
              </div>
              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Stock Status</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#F4F5F9] dark:bg-[#12131A] border border-[var(--c-border-soft)] text-[var(--c-muted)]"><IconChartBar size={16} className="h-4 w-4" /></span>
                </div>
                {loadingItems ? <div className="h-7 w-24 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-sm font-black text-[var(--c-text)]">{outOfStockCount} out · {lowStockCount} low · {totalItems - lowStockCount - outOfStockCount} ok</p>}
                <p className="text-xs font-medium text-[var(--c-muted)]">Distribution</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">No backend analytics</p>
              </div>
            </section>

            {/* Stock Table + Add/Edit */}
            <section className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
                <div>
                  <h2 className="text-sm font-black text-[var(--c-text)]">Inventory Stock</h2>
                  <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Live data from <code className="rounded bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-1">/api/inventory/items</code> — UI-calculated value.</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">{loadingItems ? '…' : `${items.length} items`}</span>
                  <button type="button" onClick={() => setShowAdd((v) => !v)} className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm tactile">{showAdd ? 'Close' : '+ Add Item'}</button>
                  <button type="button" onClick={fetchItems} className="hidden sm:inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] shadow-sm tactile">Refresh</button>
                </div>
              </div>

              {/* Add Item form */}
              {showAdd && (
                <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                  <form onSubmit={handleAddItem} className="grid gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Name *</span>
                      <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Coffee Beans" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Category *</span>
                      <input value={addForm.category} onChange={(e) => setAddForm({ ...addForm, category: e.target.value })} placeholder="Beverages" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Unit *</span>
                      <input value={addForm.unit} onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })} placeholder="kg" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Current Stock</span>
                      <input type="number" min="0" step="1" value={addForm.currentStock} onChange={(e) => setAddForm({ ...addForm, currentStock: e.target.value })} placeholder="12" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Minimum Stock</span>
                      <input type="number" min="0" step="1" value={addForm.minimumStock} onChange={(e) => setAddForm({ ...addForm, minimumStock: e.target.value })} placeholder="5" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Cost (ETB)</span>
                      <input type="number" min="0" step="0.01" value={addForm.cost} onChange={(e) => setAddForm({ ...addForm, cost: e.target.value })} placeholder="850" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <div className="sm:col-span-3 flex items-center gap-2">
                      <button type="submit" disabled={addBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50 tactile">{addBusy ? 'Saving…' : 'Create Item'}</button>
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
                  <button type="button" onClick={fetchItems} className="mt-3 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)]">Retry</button>
                </div>
              ) : items.length === 0 ? (
                <div className="px-4 sm:px-5 py-12 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] mb-3"><IconStackFilled size={20} className="h-5 w-5" /></div>
                  <p className="text-sm font-black text-[var(--c-text)]">No inventory items yet</p>
                  <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[36ch] mx-auto">Add your first item with <strong className="text-[var(--c-text)]">+ Add Item</strong>. Data is persisted via <code className="rounded bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-1">POST /api/inventory/items</code>.</p>
                </div>
              ) : (
                <>
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                        <tr>
                          <th className="px-4 py-3 font-black">Item</th>
                          <th className="px-4 py-3 font-black">Category</th>
                          <th className="px-4 py-3 font-black">Unit</th>
                          <th className="px-4 py-3 text-right font-black">Current</th>
                          <th className="px-4 py-3 text-right font-black">Minimum</th>
                          <th className="px-4 py-3 text-right font-black">Cost</th>
                          <th className="px-4 py-3 text-right font-black">Status</th>
                          <th className="px-4 py-3 text-right font-black">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--c-border-soft)]">
                        {items.map((row) => (
                          <tr key={row._id || row.id} className="hover:bg-[var(--c-bg)]/50 transition-colors">
                            <td className="px-4 py-3.5 font-bold text-[var(--c-text)] whitespace-nowrap">
                              <span className="inline-flex items-center gap-2">
                                <span className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)]"><IconStackFilled size={14} className="h-3.5 w-3.5" /></span>
                                {row.name}
                              </span>
                            </td>
                            <td className="px-4 py-3.5"><span className="inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)]">{row.category}</span></td>
                            <td className="px-4 py-3.5 font-semibold text-[var(--c-text)]">{row.unit}</td>
                            <td className="px-4 py-3.5 text-right font-black text-[var(--c-text)]">{Number(row.currentStock) ?? 0}</td>
                            <td className="px-4 py-3.5 text-right font-medium text-[var(--c-muted)]">{Number(row.minimumStock) ?? 0}</td>
                            <td className="px-4 py-3.5 text-right font-bold text-[var(--c-text)]">{fmtCost(row.cost)}</td>
                            <td className="px-4 py-3.5 text-right"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${statusCls(row.status)}`}>{row.status}</span></td>
                            <td className="px-4 py-3.5 text-right"><button type="button" onClick={() => openEdit(row)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)]">Edit</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="sm:hidden divide-y divide-[var(--c-border-soft)]">
                    {items.map((row) => (
                      <div key={`m-${row._id || row.id}`} className="px-4 py-3.5 flex flex-col gap-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0"><p className="truncate text-sm font-black text-[var(--c-text)]">{row.name}</p><p className="mt-1 inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--c-muted)]">{row.category} · {row.unit}</p></div>
                          <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-black uppercase ${statusCls(row.status)}`}>{row.status}</span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-semibold text-[var(--c-muted)]">
                          <span>Current: <strong className="text-[var(--c-text)]">{Number(row.currentStock) ?? 0}</strong></span>
                          <span>Min: <strong className="text-[var(--c-text)]">{Number(row.minimumStock) ?? 0}</strong></span>
                          <span>Cost: <strong className="text-[var(--c-text)]">{fmtCost(row.cost)}</strong></span>
                          <button type="button" onClick={() => openEdit(row)} className="ml-auto inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">Edit</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="border-t border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-3 text-[11px] font-medium text-[var(--c-muted)]">
                Live from <code className="rounded bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-1">/api/inventory/items</code> — <code>PATCH /api/inventory/items/[id]</code> cannot change <code>currentStock</code> directly.
              </div>
            </section>

            {/* Edit Item Modal */}
            {editItem && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md">
                <div className="w-full max-w-lg rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1)]">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h3 className="text-sm font-black text-[var(--c-text)]">Edit Item — {editItem.name}</h3>
                    <button type="button" onClick={() => setEditItem(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--c-muted)] hover:bg-[var(--c-bg)]">✕</button>
                  </div>
                  <form onSubmit={handleEditItem} className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Name</span>
                      <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Category</span>
                      <input value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Unit</span>
                      <input value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Minimum Stock</span>
                      <input type="number" min="0" value={editForm.minimumStock} onChange={(e) => setEditForm({ ...editForm, minimumStock: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Cost</span>
                      <input type="number" min="0" step="0.01" value={editForm.cost} onChange={(e) => setEditForm({ ...editForm, cost: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Status</span>
                      <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                        <option>In Stock</option>
                        <option>Low Stock</option>
                        <option>Out Of Stock</option>
                      </select>
                    </label>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <button type="submit" disabled={editBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50 tactile">{editBusy ? 'Saving…' : 'Save'}</button>
                      <button type="button" onClick={() => setEditItem(null)} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">Cancel</button>
                      {editError && <span className="text-xs font-semibold text-[#DC2626]">{editError}</span>}
                    </div>
                    <p className="sm:col-span-2 text-[11px] font-medium text-[var(--c-muted)]">Note: <code>currentStock</code> cannot be edited directly (use movements in a later phase).</p>
                  </form>
                </div>
              </div>
            )}
          </>
        ) : activeTab === 'suppliers' ? (
          <section className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
              <div>
                <h2 className="text-sm font-black text-[var(--c-text)]">Suppliers</h2>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Live from <code className="rounded bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-1">/api/inventory/suppliers</code></p>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">{loadingSuppliers ? '…' : `${suppliers.length} suppliers`}</span>
                <button type="button" onClick={() => setShowSupAdd((v) => !v)} className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm tactile">{showSupAdd ? 'Close' : '+ Add Supplier'}</button>
                <button type="button" onClick={fetchSuppliers} className="hidden sm:inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)]">Refresh</button>
              </div>
            </div>
            {suppliersError && (
              <div className="mx-4 sm:mx-5 mt-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
                <span>{suppliersError}</span>
                <button type="button" onClick={fetchSuppliers} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">Retry</button>
              </div>
            )}
            {successMsg && !itemsError && <div className="mx-4 sm:mx-5 mt-4 rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3.5 py-2.5 text-xs font-bold text-[#15803D]">{successMsg}</div>}
            {showSupAdd && (
              <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                <form onSubmit={handleAddSupplier} className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Name *</span>
                    <input value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} placeholder="Fresh Farms" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Contact</span>
                    <input value={supForm.contact} onChange={(e) => setSupForm({ ...supForm, contact: e.target.value })} placeholder="+251 9..." className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Address</span>
                    <input value={supForm.address} onChange={(e) => setSupForm({ ...supForm, address: e.target.value })} placeholder="Addis Ababa" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Status</span>
                    <select value={supForm.status} onChange={(e) => setSupForm({ ...supForm, status: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                      <option>Active</option>
                      <option>Inactive</option>
                    </select>
                  </label>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <button type="submit" disabled={supBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50 tactile">{supBusy ? 'Saving…' : 'Create Supplier'}</button>
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
                <p className="text-sm font-black text-[var(--c-text)]">No suppliers yet</p>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Add a supplier with <strong className="text-[var(--c-text)]">+ Add Supplier</strong></p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--c-border-soft)]">
                {suppliers.map((s) => (
                  <div key={s._id || s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-black text-[var(--c-text)]">{s.name}</p>
                      <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">{s.contact || '—'} · {s.address || '—'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${s.status === 'Active' ? 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7]' : 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]'}`}>{s.status}</span>
                      <button type="button" onClick={() => openEditSup(s)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">Edit</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {editSup && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md">
                <div className="w-full max-w-lg rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1)]">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h3 className="text-sm font-black text-[var(--c-text)]">Edit Supplier — {editSup.name}</h3>
                    <button type="button" onClick={() => setEditSup(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--c-muted)] hover:bg-[var(--c-bg)]">✕</button>
                  </div>
                  <form onSubmit={handleEditSupplier} className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Name</span>
                      <input value={editSupForm.name} onChange={(e) => setEditSupForm({ ...editSupForm, name: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Contact</span>
                      <input value={editSupForm.contact} onChange={(e) => setEditSupForm({ ...editSupForm, contact: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Address</span>
                      <input value={editSupForm.address} onChange={(e) => setEditSupForm({ ...editSupForm, address: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Status</span>
                      <select value={editSupForm.status} onChange={(e) => setEditSupForm({ ...editSupForm, status: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                        <option>Active</option>
                        <option>Inactive</option>
                      </select>
                    </label>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <button type="submit" disabled={editSupBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50 tactile">{editSupBusy ? 'Saving…' : 'Save'}</button>
                      <button type="button" onClick={() => setEditSup(null)} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">Cancel</button>
                      {editSupError && <span className="text-xs font-semibold text-[#DC2626]">{editSupError}</span>}
                    </div>
                  </form>
                </div>
              </div>
            )}
            <div className="border-t border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-3 text-[11px] font-medium text-[var(--c-muted)]">
              Live from <code className="rounded bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-1">/api/inventory/suppliers</code>
            </div>
          </section>
        ) : activeTab === 'recipes' ? (
          <section className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
              <div>
                <h2 className="text-sm font-black text-[var(--c-text)]">Recipes — Menu ↔ Inventory</h2>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Live from <code className="rounded bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-1">/api/recipes</code> — no deduction, relationship only.</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">{loadingRecipes ? '…' : `${recipes.length} recipes`}</span>
                <button type="button" onClick={() => setShowRecipeAdd((v) => !v)} className="inline-flex h-8 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm tactile">{showRecipeAdd ? 'Close' : '+ Add Recipe'}</button>
                <button type="button" onClick={fetchRecipes} className="hidden sm:inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)]">Refresh</button>
              </div>
            </div>

            {recipesError && (
              <div className="mx-4 sm:mx-5 mt-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
                <span>{recipesError}</span>
                <button type="button" onClick={fetchRecipes} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">Retry</button>
              </div>
            )}

            {showRecipeAdd && (
              <div className="border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/30 px-4 sm:px-5 py-4">
                <form onSubmit={handleAddRecipe} className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Menu Item *</span>
                    {loadingMenu ? (
                      <div className="h-9 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                    ) : (
                      <select value={recipeForm.menuItemId} onChange={(e) => setRecipeForm({ ...recipeForm, menuItemId: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                        <option value="">Select menu item</option>
                        {menuItems.map((m) => (
                          <option key={m._id || m.id} value={m._id || m.id}>{getMenuDisplayName(m)} — {m.price != null ? fmtCost(m.price) : ''}</option>
                        ))}
                      </select>
                    )}
                  </label>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black uppercase tracking-wide text-[var(--c-muted)]">Ingredients</span>
                      <button type="button" onClick={() => addRecipeRow(false)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">+ Add row</button>
                    </div>
                    {recipeForm.ingredients.map((row, idx) => (
                      <div key={idx} className="grid gap-2 sm:grid-cols-[1fr_110px_90px_40px] items-end">
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">Inventory Item</span>
                          <select value={row.inventoryItemId} onChange={(e) => updateRecipeIngredient(idx, 'inventoryItemId', e.target.value, false)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2 text-sm font-medium text-[var(--c-text)]">
                            <option value="">Select item</option>
                            {items.map((it) => (
                              <option key={it._id || it.id} value={it._id || it.id}>{it.name} ({it.unit})</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">Quantity</span>
                          <input type="number" min="0" step="0.01" value={row.quantity} onChange={(e) => updateRecipeIngredient(idx, 'quantity', e.target.value, false)} placeholder="0.5" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">Unit</span>
                          <input value={row.unit} onChange={(e) => updateRecipeIngredient(idx, 'unit', e.target.value, false)} placeholder="kg" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                        </label>
                        <button type="button" onClick={() => removeRecipeRow(idx, false)} className="h-9 w-full sm:w-10 inline-flex items-center justify-center rounded-xl border border-[#FECACA] bg-white text-[#DC2626] text-xs font-bold">✕</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="submit" disabled={recipeBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50 tactile">{recipeBusy ? 'Saving…' : 'Create Recipe'}</button>
                    {recipeError && <span className="text-xs font-semibold text-[#DC2626]">{recipeError}</span>}
                  </div>
                </form>
              </div>
            )}

            {loadingRecipes ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-20 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />
                ))}
              </div>
            ) : recipes.length === 0 ? (
              <div className="px-4 sm:px-5 py-12 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] mb-3"><IconChefHat size={20} className="h-5 w-5" /></div>
                <p className="text-sm font-black text-[var(--c-text)]">No recipes yet</p>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[40ch] mx-auto">Connect a menu item with inventory ingredients. Example: <em>Cappuccino</em> → Coffee Beans, Milk, Sugar. No stock will be deducted.</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--c-border-soft)]">
                {recipes.map((r) => (
                  <div key={r._id || r.id} className="px-4 sm:px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-[var(--c-text)]">{r.menuItem?.name || r.menuItemId}</p>
                        <p className="mt-1 flex flex-wrap gap-1.5">
                          {(r.ingredients || []).map((ing, idx) => (
                            <span key={idx} className="inline-flex items-center gap-1 rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2 py-0.5 text-xs font-bold text-[var(--c-muted)]">
                              {ing.inventoryItem?.name || String(ing.inventoryItemId).slice(-4)} · {ing.quantity} {ing.unit}
                            </span>
                          ))}
                          {(!r.ingredients || r.ingredients.length === 0) && <span className="text-xs text-[var(--c-muted)]">No ingredients</span>}
                        </p>
                        <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">{r.ingredients?.length || 0} ingredients · {r.isActive === false ? 'Inactive' : 'Active'}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${r.isActive === false ? 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]' : 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0]'}`}>{r.isActive === false ? 'Inactive' : 'Active'}</span>
                        <button type="button" onClick={() => openEditRecipe(r)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">Edit</button>
                        {r.isActive !== false && (
                          <button type="button" onClick={() => handleDeactivateRecipe(r)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[#FECACA] bg-white px-2.5 text-xs font-bold text-[#DC2626]">Deactivate</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Edit Recipe Modal */}
            {editRecipe && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md overflow-y-auto">
                <div className="w-full max-w-xl rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1)] my-auto">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <h3 className="text-sm font-black text-[var(--c-text)]">Edit Recipe — {editRecipe.menuItem?.name || editRecipe.menuItemId}</h3>
                    <button type="button" onClick={() => setEditRecipe(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--c-muted)] hover:bg-[var(--c-bg)]">✕</button>
                  </div>
                  <form onSubmit={handleEditRecipe} className="space-y-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">Menu Item</span>
                      <select value={editRecipeForm.menuItemId} onChange={(e) => setEditRecipeForm({ ...editRecipeForm, menuItemId: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]">
                        <option value="">Select menu item</option>
                        {menuItems.map((m) => (
                          <option key={m._id || m.id} value={m._id || m.id}>{getMenuDisplayName(m)}</option>
                        ))}
                      </select>
                    </label>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black uppercase tracking-wide text-[var(--c-muted)]">Ingredients</span>
                        <button type="button" onClick={() => addRecipeRow(true)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]">+ Add row</button>
                      </div>
                      {editRecipeForm.ingredients.map((row, idx) => (
                        <div key={idx} className="grid gap-2 sm:grid-cols-[1fr_110px_90px_40px] items-end">
                          <label className="block">
                            <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">Inventory Item</span>
                            <select value={row.inventoryItemId} onChange={(e) => updateRecipeIngredient(idx, 'inventoryItemId', e.target.value, true)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2 text-sm font-medium text-[var(--c-text)]">
                              <option value="">Select item</option>
                              {items.map((it) => (
                                <option key={it._id || it.id} value={it._id || it.id}>{it.name} ({it.unit})</option>
                              ))}
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">Quantity</span>
                            <input type="number" min="0" step="0.01" value={row.quantity} onChange={(e) => updateRecipeIngredient(idx, 'quantity', e.target.value, true)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] font-bold text-[var(--c-muted)]">Unit</span>
                            <input value={row.unit} onChange={(e) => updateRecipeIngredient(idx, 'unit', e.target.value, true)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)]" />
                          </label>
                          <button type="button" onClick={() => removeRecipeRow(idx, true)} className="h-9 w-full sm:w-10 inline-flex items-center justify-center rounded-xl border border-[#FECACA] bg-white text-[#DC2626] text-xs font-bold">✕</button>
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={editRecipeForm.isActive} onChange={(e) => setEditRecipeForm({ ...editRecipeForm, isActive: e.target.checked })} className="h-4 w-4 rounded border-[var(--c-border-soft)]" />
                      <span className="text-xs font-bold text-[var(--c-muted)]">Active</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={editRecipeBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50 tactile">{editRecipeBusy ? 'Saving…' : 'Save'}</button>
                      <button type="button" onClick={() => setEditRecipe(null)} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">Cancel</button>
                      {editRecipeError && <span className="text-xs font-semibold text-[#DC2626]">{editRecipeError}</span>}
                    </div>
                  </form>
                </div>
              </div>
            )}

            <div className="border-t border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-3 text-[11px] font-medium text-[var(--c-muted)]">
              Relationship only — no stock is deducted. Use <code className="rounded bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-1">POST /api/recipes</code> / <code>PATCH /api/recipes/[id]</code>.
            </div>
          </section>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-black text-[var(--c-text)]">Inventory Intelligence</h2>
              <button type="button" onClick={fetchDashboard} className="inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] shadow-sm tactile">Refresh</button>
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
                <button type="button" onClick={fetchDashboard} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626]">Retry</button>
              </div>
            ) : !dashboard ? (
              <div className="card-elevated rounded-2xl bg-[var(--c-card)] p-8 text-center">
                <p className="text-sm font-bold text-[var(--c-muted)]">No dashboard data</p>
              </div>
            ) : (
              <>
                <section aria-label="Inventory overview" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Total Items</p>
                    <p className="text-2xl font-black text-[var(--c-text)]">{dashboard.overview?.totalItems ?? 0}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">Distinct SKUs</p>
                  </div>
                  <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Inventory Value</p>
                    <p className="text-2xl font-black text-[var(--c-text)]">{fmtCost(dashboard.overview?.inventoryValue)}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">stock × cost</p>
                  </div>
                  <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Low Stock</p>
                    <p className="text-2xl font-black text-[#D97706] dark:text-[#FBBF24]">{dashboard.overview?.lowStockCount ?? 0}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">0 &lt; stock ≤ min</p>
                  </div>
                  <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Out of Stock</p>
                    <p className="text-2xl font-black text-[#DC2626]">{dashboard.overview?.outOfStockCount ?? 0}</p>
                    <p className="text-xs font-medium text-[var(--c-muted)]">stock ≤ 0</p>
                  </div>
                </section>
                <section className="card-elevated rounded-2xl bg-[var(--c-card)] p-4">
                  <h3 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">Food Cost (historical)</h3>
                  <p className="mt-2 text-2xl font-black text-[var(--c-text)]">{fmtCost(dashboard.foodCost?.foodCost)}</p>
                  <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Sum <code className="rounded bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-1">StockMovement.totalCost</code> where <code>reason:SaleDeduction</code></p>
                </section>
                <section className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
                  <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                    <h3 className="text-sm font-black text-[var(--c-text)]">Consumption</h3>
                    <p className="text-xs font-medium text-[var(--c-muted)]">type:OUT reason:SaleDeduction grouped before lookup</p>
                  </div>
                  {(!dashboard.consumption || dashboard.consumption.length === 0) ? (
                    <div className="px-4 sm:px-5 py-8 text-center">
                      <p className="text-sm font-bold text-[var(--c-muted)]">No consumption recorded</p>
                      <p className="text-xs font-medium text-[var(--c-muted)]">SaleDeduction movements will appear after paid orders.</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                          <tr><th className="px-4 py-3 font-black">Ingredient</th><th className="px-4 py-3 text-right font-black">Quantity Used</th><th className="px-4 py-3 font-black">Unit</th></tr>
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
                <section className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
                  <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                    <h3 className="text-sm font-black text-[var(--c-text)]">Waste</h3>
                    <p className="text-xs font-medium text-[var(--c-muted)]">totalCost snapshot, null-safe</p>
                  </div>
                  <div className="px-4 sm:px-5 py-3 flex flex-wrap gap-4 text-xs font-bold text-[var(--c-muted)]">
                    <span>Total quantity: <strong className="text-[var(--c-text)]">{dashboard.waste?.totalWasteQuantity ?? 0}</strong></span>
                    <span>Total cost: <strong className="text-[var(--c-text)]">{fmtCost(dashboard.waste?.totalWasteCost)}</strong></span>
                  </div>
                  {(!dashboard.waste?.items || dashboard.waste.items.length === 0) ? (
                    <div className="px-4 sm:px-5 py-6 text-center">
                      <p className="text-sm font-bold text-[var(--c-muted)]">No waste recorded</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                          <tr><th className="px-4 py-3 font-black">Ingredient</th><th className="px-4 py-3 text-right font-black">Qty</th><th className="px-4 py-3 text-right font-black">Cost</th></tr>
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
                <section className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
                  <div className="px-4 sm:px-5 py-4 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50">
                    <h3 className="text-sm font-black text-[var(--c-text)]">Top Ingredients (Top 10)</h3>
                    <p className="text-xs font-medium text-[var(--c-muted)]">Aggregation early $match, lookup after group</p>
                  </div>
                  {(!dashboard.topIngredients || dashboard.topIngredients.length === 0) ? (
                    <div className="px-4 sm:px-5 py-8 text-center">
                      <p className="text-sm font-bold text-[var(--c-muted)]">No consumption yet</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                          <tr><th className="px-4 py-3 font-black">#</th><th className="px-4 py-3 font-black">Ingredient</th><th className="px-4 py-3 text-right font-black">Quantity Used</th></tr>
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
              </>
            )}
          </div>
        )}
      </main>

      <footer className="mx-auto max-w-[1600px] px-4 sm:px-6 py-6 text-center text-xs font-medium text-[var(--c-muted)]">Inventory · Live API · Manager-protected · Recipes are relationship only</footer>
    </div>
  );
}
