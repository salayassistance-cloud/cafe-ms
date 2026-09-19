'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  IconArchiveFilled,
  IconBoxMultipleFilled,
  IconAlertTriangleFilled,
  IconCoinFilled,
  IconChartBar,
  IconClipboardListFilled,
  IconChefHat,
  IconStackFilled,
} from '@tabler/icons-react';

// Phase A — Visual Shell Only — Mock Data Clearly Identified
// No API, no DB, no calculations. Presentational only.

const TABS = [
  { key: 'stock', label: 'Stock' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'recipes', label: 'Recipes' },
  { key: 'reports', label: 'Reports' },
];

const MOCK_ITEMS = [
  { item: 'Coffee Beans', category: 'Beverages', unit: 'kg', quantity: 12, status: 'In Stock' },
  { item: 'Milk', category: 'Dairy', unit: 'L', quantity: 3, status: 'Low Stock' },
  { item: 'Flour', category: 'Dry Goods', unit: 'kg', quantity: 25, status: 'In Stock' },
  { item: 'Cooking Oil', category: 'Condiments', unit: 'L', quantity: 2, status: 'Low Stock' },
  { item: 'Sugar', category: 'Dry Goods', unit: 'kg', quantity: 8, status: 'In Stock' },
];

function statusCls(status) {
  const s = String(status).toLowerCase();
  if (s === 'low stock') return 'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A] dark:bg-[rgba(255,214,0,0.14)] dark:text-[#FF8A3D] dark:border-[#FFD600]/20';
  if (s === 'out of stock') return 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA] dark:bg-[#2A2B36] dark:text-[#FCA5A5] dark:border-[#2A2B36]';
  return 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7] dark:border-[#10B981]/20';
}

export default function InventoryUI() {
  const [activeTab, setActiveTab] = useState('stock');

  return (
    <div className="min-h-screen bg-[var(--c-bg)] text-[var(--c-text)]">
      {/* Header — matches manager/cashier header tokens */}
      <header className="sticky top-0 z-20 bg-[var(--c-header)] dark:bg-[#1C1D24] border-b border-[var(--c-border-soft)] dark:border-[#2A2B36] shadow-sm">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white dark:bg-[#12131A] border border-[var(--c-border-soft)] shadow-sm text-[var(--c-accent)]">
                <IconArchiveFilled size={20} aria-hidden={true} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg sm:text-xl font-black tracking-tight leading-none text-[var(--c-text)]">Bono Inventory Management</h1>
                <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Stock · Suppliers · Recipes · Reports — Phase A visual shell</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-[var(--c-muted)] shadow-sm">
                <span className="h-2 w-2 rounded-full bg-[var(--c-accent)]" aria-hidden="true" />
                Mock data — shell only
              </span>
              <Link
                href="/"
                className="hidden sm:inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 text-xs font-bold text-[var(--c-muted)] hover:text-[var(--c-text)] shadow-sm tactile"
              >
                Home
              </Link>
              <Link
                href="/manager/reports"
                className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm tactile"
              >
                Reports
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-[1600px] px-4 sm:px-6 py-6 space-y-6">
        {/* Disclaimer — clearly identified mock */}
        <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] dark:bg-[rgba(255,214,0,0.08)] dark:border-[#FFD600]/20 px-3.5 py-2.5 text-xs font-semibold text-[#92400E] dark:text-[#FFD88A] flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white dark:bg-[#1C1D24] border border-[#FDE68A] dark:border-[#FFD600]/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-[#92400E] dark:text-[#FFD88A]">Phase A</span>
          Visual shell only — no inventory APIs, no database, no stock deductions. Values below are placeholder mock data.
        </div>

        {/* Tabs — pill style matching manager reports */}
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
                    active
                      ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white border-transparent shadow-sm'
                      : 'bg-white dark:bg-[#12131A] text-[var(--c-muted)] border-[var(--c-border-soft)] hover:text-[var(--c-text)]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Panels */}
        {activeTab === 'stock' ? (
          <>
            {/* Stock Dashboard Cards — 4 metrics */}
            <section aria-label="Stock dashboard" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Total Items</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]">
                    <IconArchiveFilled size={16} aria-hidden={true} className="h-4 w-4" />
                  </span>
                </div>
                <p className="text-2xl font-black text-[var(--c-text)]">5</p>
                <p className="text-xs font-medium text-[var(--c-muted)]">Mock items in shell</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">Phase A placeholder</p>
              </div>

              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Low Stock</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FEF3C7] dark:bg-[rgba(251,191,36,0.15)] text-[#92400E] dark:text-[#FBBF24]">
                    <IconAlertTriangleFilled size={16} aria-hidden={true} className="h-4 w-4" />
                  </span>
                </div>
                <p className="text-2xl font-black text-[#D97706] dark:text-[#FBBF24]">2</p>
                <p className="text-xs font-medium text-[var(--c-muted)]">Items below threshold (mock)</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">No reorder logic yet</p>
              </div>

              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Inventory Value</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]">
                    <IconCoinFilled size={16} aria-hidden={true} className="h-4 w-4" />
                  </span>
                </div>
                <p className="text-2xl font-black text-[var(--c-text)]">ETB 42,500</p>
                <p className="text-xs font-medium text-[var(--c-muted)]">Mock valuation</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">Not from orders</p>
              </div>

              <div className="card-elevated rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">Today Usage</p>
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#F4F5F9] dark:bg-[#12131A] border border-[var(--c-border-soft)] text-[var(--c-muted)]">
                    <IconChartBar size={16} aria-hidden={true} className="h-4 w-4" />
                  </span>
                </div>
                <p className="text-2xl font-black text-[var(--c-text)]">18</p>
                <p className="text-xs font-medium text-[var(--c-muted)]">Units consumed (mock)</p>
                <p className="text-[11px] font-bold text-[var(--c-faint)]">No deduction yet</p>
              </div>
            </section>

            {/* Inventory Table */}
            <section className="card-elevated rounded-2xl bg-[var(--c-card)] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-4">
                <div>
                  <h2 className="text-sm font-black text-[var(--c-text)]">Inventory Stock — Mock Data</h2>
                  <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">Phase A shell — not connected to orders, suppliers, or recipe calculations.</p>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 py-1 text-[11px] font-bold text-[var(--c-muted)]">
                  {MOCK_ITEMS.length} items
                </span>
              </div>

              {/* Desktop table — hidden on mobile */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                    <tr>
                      <th className="px-4 py-3 font-black">Item</th>
                      <th className="px-4 py-3 font-black">Category</th>
                      <th className="px-4 py-3 font-black">Unit</th>
                      <th className="px-4 py-3 text-right font-black">Quantity</th>
                      <th className="px-4 py-3 text-right font-black">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--c-border-soft)]">
                    {MOCK_ITEMS.map((row) => (
                      <tr key={row.item} className="hover:bg-[var(--c-bg)]/50 transition-colors">
                        <td className="px-4 py-3.5 font-bold text-[var(--c-text)] whitespace-nowrap">
                          <span className="inline-flex items-center gap-2">
                            <span className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)]">
                              <IconStackFilled size={14} aria-hidden={true} className="h-3.5 w-3.5" />
                            </span>
                            {row.item}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 font-medium text-[var(--c-muted)] whitespace-nowrap">
                          <span className="inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2.5 py-1 text-xs font-bold text-[var(--c-muted)]">
                            {row.category}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 font-semibold text-[var(--c-text)]">{row.unit}</td>
                        <td className="px-4 py-3.5 text-right font-black text-[var(--c-text)]">{row.quantity}</td>
                        <td className="px-4 py-3.5 text-right">
                          <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black uppercase ${statusCls(row.status)}`}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — visible only on small screens */}
              <div className="sm:hidden divide-y divide-[var(--c-border-soft)]">
                {MOCK_ITEMS.map((row) => (
                  <div key={`m-${row.item}`} className="px-4 py-3.5 flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-[var(--c-text)]">{row.item}</p>
                        <p className="mt-1 inline-flex rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--c-muted)]">
                          {row.category}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-black uppercase ${statusCls(row.status)}`}>
                        {row.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs font-semibold text-[var(--c-muted)]">
                      <span>Unit: <strong className="text-[var(--c-text)]">{row.unit}</strong></span>
                      <span>Qty: <strong className="text-[var(--c-text)]">{row.quantity}</strong></span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 px-4 sm:px-5 py-3 text-[11px] font-medium text-[var(--c-muted)]">
                Mock data only — values are placeholders for UI review. No stock persistence, adjustments, or cost calculations in Phase A.
              </div>
            </section>
          </>
        ) : (
          // Placeholder for other tabs — visual only
          <section className="card-elevated rounded-2xl bg-[var(--c-card)] p-6 sm:p-8 text-center">
            <div className="mx-auto max-w-md flex flex-col items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] text-[var(--c-muted)] mb-4">
                {activeTab === 'suppliers' ? (
                  <IconClipboardListFilled size={20} aria-hidden={true} className="h-5 w-5" />
                ) : activeTab === 'recipes' ? (
                  <IconChefHat size={20} aria-hidden={true} className="h-5 w-5" />
                ) : (
                  <IconChartBar size={20} aria-hidden={true} className="h-5 w-5" />
                )}
              </div>
              <h3 className="text-base font-black text-[var(--c-text)]">
                {activeTab === 'suppliers' ? 'Suppliers' : activeTab === 'recipes' ? 'Recipes' : 'Reports'} — Coming Soon
              </h3>
              <p className="mt-2 text-sm font-medium text-[var(--c-muted)]">
                Phase A visual shell only. This tab is a placeholder and does not imply backend functionality.
              </p>
              <p className="mt-3 inline-flex rounded-full border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-3 py-1 text-xs font-bold text-[var(--c-muted)]">
                No data fetching · No mutations · Mock UI only
              </p>
            </div>
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-[1600px] px-4 sm:px-6 py-6 text-center text-xs font-medium text-[var(--c-muted)]">
        Inventory · Phase A — Mock shell · No stock persistence · Amounts shown are illustrative only
      </footer>
    </div>
  );
}
