'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useRef } from 'react';
import {
  IconDashboardFilled,
  IconBookFilled,
  IconCashRegister,
  IconArchiveFilled,
  IconUsers,
  IconShieldCheck,
  IconFileTypeCsv,
  IconFileTypePdf,
  IconChevronLeft,
  IconChevronRight,
  IconGripVertical,
} from '@tabler/icons-react';

// Sidebar entries — reusing actual existing routes and homepage icon set
// Kitchen/Barista intentionally omitted here (still available via homepage portals /kds + /barista)
const RAW_ENTRIES = [
  { id: 'reports', label: 'Manager Reports', href: '/manager/reports', icon: IconDashboardFilled, type: 'link' },
  { id: 'menu', label: 'Menu Management', href: '/manager/menu-crud', icon: IconBookFilled, type: 'link' },
  { id: 'cashier', label: 'Cashier', href: '/cashier', icon: IconCashRegister, type: 'link' },
  { id: 'inventory', label: 'Inventory', href: '/manager/inventory', icon: IconArchiveFilled, type: 'link' },
  { id: 'staff', label: 'Staff Management', href: '/manager/staff', icon: IconUsers, type: 'link' },
  { id: 'security', label: 'PIN & Security', href: '/manager/security', icon: IconShieldCheck, type: 'link' },
  { id: 'exportCsv', label: 'Export CSV', icon: IconFileTypeCsv, type: 'action', action: 'exportCsv' },
  { id: 'exportPdf', label: 'Export PDF', icon: IconFileTypePdf, type: 'action', action: 'exportPdf' },
];

export default function ManagerSidebar({ onExportCsv, onExportPdf }) {
  const pathname = usePathname();
  const router = useRouter();
  const [order, setOrder] = useState(() => RAW_ENTRIES.map((e) => e.id));
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dragIdRef = useRef(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

  const entries = order.map((id) => RAW_ENTRIES.find((e) => e.id === id)).filter(Boolean);

  const handleDragStart = (e, id) => {
    dragIdRef.current = id;
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    // Show icon+label together in drag image (browser default uses the dragged element)
  };
  const handleDragOver = (e, id) => {
    e.preventDefault();
    if (dragIdRef.current === null || dragIdRef.current === id) return;
    setDragOverId(id);
  };
  const handleDrop = (e, targetId) => {
    e.preventDefault();
    const dragged = dragIdRef.current;
    if (!dragged || dragged === targetId) {
      setDragOverId(null);
      return;
    }
    setOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(dragged);
      const to = next.indexOf(targetId);
      if (from === -1 || to === -1) return prev;
      next.splice(from, 1);
      next.splice(to, 0, dragged);
      return next;
    });
    setDragOverId(null);
  };
  const handleDragEnd = () => {
    dragIdRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  };
  const handleKeyReorder = (id, dir) => {
    setOrder((prev) => {
      const idx = prev.indexOf(id);
      const swap = dir === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  const isActive = (href) => {
    if (!href || !pathname) return false;
    return pathname === href || pathname.startsWith(href + '/');
  };

  const handleAction = (entry) => {
    if (entry.action === 'exportCsv') {
      if (onExportCsv) {
        onExportCsv();
      } else {
        router.push('/manager/reports');
      }
      setMobileOpen(false);
      return;
    }
    if (entry.action === 'exportPdf') {
      if (onExportPdf) {
        onExportPdf();
      } else {
        router.push('/manager/reports');
      }
      setMobileOpen(false);
      return;
    }
  };

  const renderItem = (entry) => {
    const Icon = entry.icon;
    const active = entry.href ? isActive(entry.href) : false;
    const isDragging = draggingId === entry.id;
    const isOver = dragOverId === entry.id;
    const baseCls = `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-all tactile flex-1 min-w-0 text-left ${
      active
        ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white shadow-sm'
        : 'text-[var(--c-muted)] hover:text-[var(--c-text)] hover:bg-white dark:hover:bg-[#252631] border border-transparent hover:border-[var(--c-border-soft)]'
    }`;
    const iconEl = (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-transparent text-[var(--c-accent)]">
        <Icon size={20} className="h-5 w-5" aria-hidden="true" />
      </span>
    );
    const labelEl = !collapsed ? <span className="truncate flex-1">{entry.label}</span> : null;

    const dragProps = {
      draggable: true,
      onDragStart: (e) => handleDragStart(e, entry.id),
      onDragOver: (e) => handleDragOver(e, entry.id),
      onDrop: (e) => handleDrop(e, entry.id),
      onDragEnd: handleDragEnd,
      onDragLeave: () => setDragOverId((cur) => (cur === entry.id ? null : cur)),
    };

    const reorderControls = !collapsed ? (
      <span className="hidden group-hover:flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconGripVertical size={14} className="h-3.5 w-3.5 text-[var(--c-muted)]" aria-hidden="true" />
        <span className="hidden lg:flex flex-col -space-y-1">
          <button type="button" aria-label={`Move ${entry.label} up`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleKeyReorder(entry.id, 'up'); }} className="h-3 w-3 flex items-center justify-center hover:text-[var(--c-text)]" tabIndex={0}>▲</button>
          <button type="button" aria-label={`Move ${entry.label} down`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleKeyReorder(entry.id, 'down'); }} className="h-3 w-3 flex items-center justify-center hover:text-[var(--c-text)]" tabIndex={0}>▼</button>
        </span>
      </span>
    ) : null;

    if (entry.type === 'link' && entry.href) {
      return (
        <div
          key={entry.id}
          className={`flex items-center gap-2 rounded-xl ${isDragging ? 'opacity-50 ring-2 ring-[var(--c-accent)]' : ''} ${isOver ? 'ring-2 ring-[var(--c-accent)]/50' : ''}`}
          {...dragProps}
          title={collapsed ? entry.label : undefined}
          aria-label={entry.label}
        >
          <Link
            href={entry.href}
            prefetch
            onClick={(e) => {
              if (draggingId) {
                e.preventDefault();
                return;
              }
              setMobileOpen(false);
            }}
            aria-label={entry.label}
            title={collapsed ? entry.label : undefined}
            className={baseCls}
          >
            {iconEl}
            {labelEl}
          </Link>
          {reorderControls}
        </div>
      );
    }
    return (
      <div
        key={entry.id}
        className={`flex items-center gap-2 rounded-xl ${isDragging ? 'opacity-50 ring-2 ring-[var(--c-accent)]' : ''} ${isOver ? 'ring-2 ring-[var(--c-accent)]/50' : ''}`}
        {...dragProps}
        title={collapsed ? entry.label : undefined}
        aria-label={entry.label}
      >
        <button
          type="button"
          onClick={() => handleAction(entry)}
          aria-label={entry.label}
          title={collapsed ? entry.label : undefined}
          className={baseCls}
        >
          {iconEl}
          {labelEl}
        </button>
        {reorderControls}
      </div>
    );
  };

  const sidebarInner = (
    <div className={`flex h-full flex-col bg-white dark:bg-[#1C1D24] border-r border-[var(--c-border-soft)] dark:border-[#2A2B36] ${collapsed ? 'w-[72px] p-2' : 'w-[260px] p-3'}`}>
      {/* Brand — single line BONO MANAGER with collapse icon on right */}
      <div className={`flex items-center gap-2 px-2 py-3 ${collapsed ? 'justify-center' : 'justify-between'}`}>
        {!collapsed && <p className="text-sm font-black tracking-widest text-[var(--c-text)] truncate">BONO MANAGER</p>}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--c-muted)] hover:text-[var(--c-text)] hover:bg-[var(--c-bg)] dark:hover:bg-[#252631]"
        >
          {collapsed ? <IconChevronRight size={16} className="h-4 w-4" /> : <IconChevronLeft size={16} className="h-4 w-4" />}
        </button>
      </div>

      {/* Nav */}
      <nav className="mt-4 flex-1 space-y-1 overflow-y-auto no-scrollbar" aria-label="Manager navigation">
        {entries.map(renderItem)}
      </nav>

      {/* Footer hint */}
      {!collapsed && <p className="mt-3 px-2 text-[10px] font-bold uppercase tracking-widest text-[var(--c-faint)]">Drag to reorder · Click to open</p>}
    </div>
  );

  return (
    <>
      {/* Desktop persistent */}
      <aside className="hidden lg:flex lg:shrink-0 lg:sticky lg:top-0 lg:h-screen lg:overflow-hidden">
        {sidebarInner}
      </aside>
      {/* Mobile top bar + drawer */}
      <div className="flex lg:hidden w-full items-center justify-between gap-2 bg-white dark:bg-[#1C1D24] border-b border-[var(--c-border-soft)] dark:border-[#2A2B36] px-3 py-2">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? 'Close manager menu' : 'Open manager menu'}
          aria-expanded={mobileOpen}
          className="flex h-9 items-center gap-2 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] px-3 text-xs font-black uppercase tracking-wide text-[var(--c-text)]"
        >
          <IconGripVertical size={16} className="h-4 w-4" />
          Menu
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] text-[var(--c-muted)]"
        >
          {collapsed ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="flex-1 bg-[#1E293B]/30 dark:bg-[#12131A]/60 backdrop-blur-sm" />
          <div className="h-full w-[280px] max-w-[85vw] shrink-0 overflow-hidden bg-white dark:bg-[#1C1D24] border-l border-[var(--c-border-soft)]" onClick={(e) => e.stopPropagation()}>
            <div className="h-full overflow-y-auto p-3">
              <div className="flex justify-end mb-2">
                <button type="button" onClick={() => setMobileOpen(false)} className="rounded-full border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-3 py-1 text-xs font-bold">Close</button>
              </div>
              <div className="space-y-1">{entries.map(renderItem)}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
