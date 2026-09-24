'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { safeFetchJson } from '@/lib/clientFetch';
import { useLanguage } from '@/app/components/LanguageProvider';
import LanguageToggle from '@/app/components/LanguageToggle';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';
import {
  IconUsers,
  IconUserPlus,
  IconUserCheck,
  IconUserX,
  IconShieldCheck,
  IconEdit,
  IconTrash,
  IconKey,
  IconSearch,
  IconRefresh,
  IconCalendar,
  IconClock,
  IconChartBar,
  IconReceipt,
  IconEye,
} from '@tabler/icons-react';
import {
  formatEthiopianDateTime,
} from '@/lib/ethiopianCalendar';

// Canonical Phase F business display: Ethiopian Calendar + Africa/Addis_Ababa.
// `new Date(value)` only wraps an existing UTC instant; formatting is
// Addis-aware, never browser-local. 24h Addis wall time.
function fmtStaffDateTime(value, lang) {
  try {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return formatEthiopianDateTime(d, lang === 'en' ? 'en' : 'am');
  } catch {
    return '—';
  }
}



const ROLES = ['WAITER', 'CASHIER', 'KITCHEN', 'BARISTA', 'MANAGER'];

function roleBadgeCls(role) {
  const r = String(role).toUpperCase();
  if (r === 'MANAGER') return 'bg-[#1E293B] text-white dark:bg-white dark:text-[#12131A]';
  if (r === 'CASHIER') return 'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A] dark:bg-[#7C2D12] dark:text-[#FDBA74] dark:border-[#7C2D12]';
  if (r === 'WAITER') return 'bg-[#FFD600]/20 text-[#8A6D00] border-[#FFD600]/30 dark:bg-[rgba(255,94,0,0.12)] dark:text-[#FF8A3D] dark:border-[#FF5E00]/20';
  if (r === 'KITCHEN') return 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7] dark:border-[#10B981]/20';
  if (r === 'BARISTA') return 'bg-[#EEF2FF] text-[#4338CA] border-[#C7D2FE] dark:bg-[#1E1B4B] dark:text-[#A5B4FC] dark:border-[#3730A3]';
  return 'bg-[#F4F5F9] text-[#64748B] border-[var(--c-border-soft)]';
}

function statusBadge(isActive) {
  return isActive
    ? 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0] dark:bg-[rgba(16,185,129,0.12)] dark:text-[#6EE7B7]'
    : 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA] dark:bg-[#2A2B36] dark:text-[#FCA5A5]';
}

export default function StaffManagement() {
  const { t, lang } = useLanguage();
  const roleLabel = (r) => ({
    WAITER: t('staffRoleWaiter'),
    CASHIER: t('staffRoleCashier'),
    KITCHEN: t('staffRoleKitchen'),
    BARISTA: t('staffRoleBarista'),
    MANAGER: t('staffRoleManager'),
  }[r] || r);
  const [staff, setStaff] = useState([]);
  const [counts, setCounts] = useState({ total: 0, active: 0, disabled: 0, byRole: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', username: '', pin: '', confirmPin: '', role: 'WAITER' });
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');

  const [editStaff, setEditStaff] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', username: '' });
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  const [toggleTarget, setToggleTarget] = useState(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const [pinTarget, setPinTarget] = useState(null);
  const [pinForm, setPinForm] = useState({ currentManagerPin: '', newPin: '', confirmPin: '' });
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState('');

  // Waiter performance — date presets use Africa/Addis_Ababa half-open [from, to)
  const [preset, setPreset] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [waiterSummaries, setWaiterSummaries] = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState('');
  const [analyticsMeta, setAnalyticsMeta] = useState(null);
  const [selectedWaiter, setSelectedWaiter] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await safeFetchJson('/api/manager/staff?status=all', { cache: 'no-store' });
      const list = data?.data?.staff || data?.staff || [];
      const c = data?.data?.counts || data?.counts || null;
      setStaff(Array.isArray(list) ? list : []);
      if (c) setCounts(c);
      else {
        const total = Array.isArray(list) ? list.length : 0;
        const active = Array.isArray(list) ? list.filter((s) => s.isActive !== false).length : 0;
        const disabled = total - active;
        const byRole = {};
        for (const r of ROLES) byRole[r] = Array.isArray(list) ? list.filter((s) => s.role === r).length : 0;
        setCounts({ total, active, disabled, byRole, filteredTotal: total });
      }
    } catch (err) {
      const m = err?.message || 'Failed to load staff';
      if (err?.status === 401) setError(t('staffErrUnauthorized'));
      else if (err?.status === 403) setError(t('staffErrForbidden'));
      else setError(m);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const t = setTimeout(() => fetchStaff(), 0);
    return () => clearTimeout(t);
  }, [fetchStaff]);

  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(''), 3000);
      return () => clearTimeout(t);
    }
  }, [success]);

  // Date presets are half-open [from, to) in Africa/Addis_Ababa — same helpers as lib/analytics
  const buildAnalyticsQuery = useCallback(() => {
    const p = String(preset).toLowerCase();
    if (p === 'custom') {
      if (!customFrom || !customTo) return null;
      return `preset=custom&from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
    }
    if (p === 'yesterday') return 'preset=yesterday';
    if (p === 'last7' || p === 'last_7') return 'preset=last7';
    if (p === 'thismonth' || p === 'this_month') return 'preset=thisMonth';
    return 'preset=today';
  }, [preset, customFrom, customTo]);

  const fetchWaiterSummaries = useCallback(async () => {
    // Only WAITER summaries are meaningful; fetch only when staff list has waiters or on preset change
    const hasWaiters = staff.some((s) => s.role === 'WAITER');
    if (!hasWaiters && !loading) {
      // still fetch to get empty summaries (server will return empty)
    }
    const q = buildAnalyticsQuery();
    if (!q) {
      setAnalyticsError(t('staffErrCustomDates'));
      return;
    }
    setAnalyticsLoading(true);
    setAnalyticsError('');
    try {
      const data = await safeFetchJson(`/api/manager/waiter-analytics?${q}`, { cache: 'no-store' });
      const payload = data?.data || data;
      setWaiterSummaries(Array.isArray(payload?.summaries) ? payload.summaries : []);
      setAnalyticsMeta(payload?.range || payload?.meta || null);
    } catch (err) {
      if (err?.status === 401) setAnalyticsError(t('staffErrUnauthorized'));
      else if (err?.status === 403) setAnalyticsError(t('staffErrForbidden'));
      else setAnalyticsError(err?.message || t('staffErrLoadAnalytics'));
      setWaiterSummaries([]);
    } finally {
      setAnalyticsLoading(false);
    }
  }, [staff, loading, buildAnalyticsQuery, t]);

  const fetchWaiterDetail = useCallback(async (waiterId) => {
    if (!waiterId) return;
    const q = buildAnalyticsQuery();
    if (!q) {
      setDetailError(t('staffErrCustomDates'));
      return;
    }
    setDetailLoading(true);
    setDetailError('');
    try {
      const data = await safeFetchJson(`/api/manager/waiter-analytics?waiterId=${encodeURIComponent(waiterId)}&${q}&limit=200`, { cache: 'no-store' });
      const payload = data?.data || data;
      setDetailData(payload);
    } catch (err) {
      setDetailError(err?.message || t('staffErrLoadDetail'));
      setDetailData(null);
    } finally {
      setDetailLoading(false);
    }
  }, [buildAnalyticsQuery, t]);

  // Summary fetch on preset/custom change and after staff load (deferred to avoid setState-in-effect)
  useEffect(() => {
    const t = setTimeout(() => fetchWaiterSummaries(), 0);
    return () => clearTimeout(t);
  }, [fetchWaiterSummaries]);

  // Detail fetch when selectedWaiter changes (deferred to avoid setState-in-effect)
  useEffect(() => {
    if (!selectedWaiter) {
      queueMicrotask(() => {
        setDetailData(null);
        setDetailError('');
      });
      return;
    }
    const t = setTimeout(() => fetchWaiterDetail(String(selectedWaiter.id || selectedWaiter.waiterId)), 0);
    return () => clearTimeout(t);
  }, [selectedWaiter, fetchWaiterDetail]);

  const filtered = useMemo(() => {
    let list = staff;
    if (roleFilter !== 'all') list = list.filter((s) => s.role === roleFilter);
    if (statusFilter === 'active') list = list.filter((s) => s.isActive !== false);
    else if (statusFilter === 'disabled') list = list.filter((s) => s.isActive === false);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((s) => String(s.name).toLowerCase().includes(q) || String(s.username).toLowerCase().includes(q));
    return list;
  }, [staff, roleFilter, statusFilter, search]);

  const summaryMap = useMemo(() => new Map(waiterSummaries.map((s) => [String(s.waiterId), s])), [waiterSummaries]);

  const totalStaff = counts.total ?? staff.length;
  const activeStaff = counts.active ?? staff.filter((s) => s.isActive !== false).length;
  const disabledStaff = counts.disabled ?? staff.filter((s) => s.isActive === false).length;

  const handleAdd = async (e) => {
    e.preventDefault();
    setAddError('');
    const name = String(addForm.name).trim();
    const username = String(addForm.username).trim();
    const pin = String(addForm.pin).trim();
    const confirmPin = String(addForm.confirmPin).trim();
    const role = String(addForm.role).trim().toUpperCase();
    if (!name || name.length < 1 || name.length > 50) {
      setAddError(t('staffErrName'));
      return;
    }
    if (!username || username.length < 2 || username.length > 30) {
      setAddError(t('staffErrUsername'));
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      setAddError(t('staffErrUsernameChars'));
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      setAddError(t('staffErrPin'));
      return;
    }
    if (pin !== confirmPin) {
      setAddError(t('staffErrPinMatch'));
      return;
    }
    if (!['WAITER', 'CASHIER'].includes(role)) {
      setAddError(t('staffErrRole'));
      return;
    }
    setAddBusy(true);
    try {
      const res = await safeFetchJson('/api/manager/waiters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, pin, confirmPin: confirmPin, role }),
      });
      if (!res?.success) throw new Error(res?.error || res?.message || t('staffErrCreate'));
      setSuccess(res?.data?.cashier ? `${t('staffRoleCashier')} ${res.data.cashier.username} ${t('staffCreatedOk')}` : `${t('staffRoleWaiter')} ${res.data.waiter.username} ${t('staffCreatedOk')}`);
      setShowAdd(false);
      setAddForm({ name: '', username: '', pin: '', confirmPin: '', role: 'WAITER' });
      fetchStaff();
    } catch (err) {
      setAddError(err?.message || t('staffErrCreate'));
    } finally {
      setAddBusy(false);
    }
  };

  const openEdit = (s) => {
    setEditStaff(s);
    setEditForm({ name: s.name || '', username: s.username || '' });
    setEditError('');
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    if (!editStaff) return;
    setEditError('');
    const name = String(editForm.name).trim();
    const username = String(editForm.username).trim();
    if (!name) {
      setEditError(t('staffErrNameRequired'));
      return;
    }
    if (!username || username.length < 2 || username.length > 30) {
      setEditError(t('staffErrUsername'));
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      setEditError(t('staffErrUsernameChars'));
      return;
    }
    if (name === editStaff.name && username.toLowerCase() === String(editStaff.username).toLowerCase()) {
      setEditError(t('staffErrNoChanges'));
      return;
    }
    setEditBusy(true);
    try {
      const data = await safeFetchJson('/api/manager/staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId: editStaff.id, name, username }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || t('staffErrUpdate'));
      setSuccess(`${t('staffUpdatedOk')} ${data.data?.staff?.username || name}`);
      setEditStaff(null);
      fetchStaff();
    } catch (err) {
      setEditError(err?.message || t('staffErrUpdate'));
    } finally {
      setEditBusy(false);
    }
  };

  const handleToggle = async () => {
    if (!toggleTarget) return;
    const wantActive = !toggleTarget.isActive;
    // For shared roles, backend will reject — we already filter UI but keep guard
    if (!['WAITER', 'CASHIER'].includes(toggleTarget.role)) {
      setError(t('staffErrToggleRole'));
      setToggleTarget(null);
      return;
    }
    setToggleBusy(true);
    try {
      const data = await safeFetchJson('/api/manager/staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId: toggleTarget.id, isActive: wantActive }),
      });
      if (!data?.success) throw new Error(data?.error || data?.message || t('staffErrUpdateStatus'));
      setSuccess(wantActive ? `${t('staffReenabledOk')} ${toggleTarget.username}` : `${t('staffDisabledOk')} ${toggleTarget.username}`);
      setToggleTarget(null);
      fetchStaff();
    } catch (err) {
      setError(err?.message || t('staffErrUpdateStatus'));
      setToggleTarget(null);
    } finally {
      setToggleBusy(false);
    }
  };

  const handlePinReset = async (e) => {
    e.preventDefault();
    if (!pinTarget) return;
    setPinError('');
    const cur = String(pinForm.currentManagerPin).trim();
    const np = String(pinForm.newPin).trim();
    const cp = String(pinForm.confirmPin).trim();
    if (cur && !/^\d{4}$/.test(cur)) {
      setPinError(t('staffErrCurPin'));
      return;
    }
    if (!/^\d{4}$/.test(np)) {
      setPinError(t('staffErrNewPin'));
      return;
    }
    if (np !== cp) {
      setPinError(t('staffErrPinMatch'));
      return;
    }
    setPinBusy(true);
    try {
      const body = { staffId: pinTarget.id, newPin: np };
      if (cur) body.currentManagerPin = cur;
      const data = await safeFetchJson('/api/manager/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!data?.success) throw new Error(data?.message || data?.error || t('staffErrResetPin'));
      setSuccess(data?.message || `${t('staffPinUpdatedOk')} ${pinTarget.name}`);
      setPinTarget(null);
      setPinForm({ currentManagerPin: '', newPin: '', confirmPin: '' });
    } catch (err) {
      setPinError(err?.message || t('staffErrResetPin'));
    } finally {
      setPinBusy(false);
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
                <h1 className="text-lg sm:text-xl font-black tracking-tight leading-none text-[var(--c-text)]">{t('staffTitle')}</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={fetchStaff} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm">
                <IconRefresh size={16} className="mr-1.5 h-4 w-4" /> {t('staffRefresh')}
              </button>
              <LanguageToggle includeOromia={false} />
              <Link
                href="/"
                aria-label={t('home')}
                title={t('home')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] text-[var(--c-muted)] shadow-sm hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
                </svg>
              </Link>
              <ThemeToggleHome />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 sm:px-6 py-6 space-y-6">
        {success && <div role="status" className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3.5 py-2.5 text-xs font-bold text-[#15803D]">{success}</div>}
        {error && (
          <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] flex items-center justify-between gap-3">
            <span>{error}</span>
              <button type="button" onClick={fetchStaff} className="shrink-0 rounded-lg bg-white border border-[#FECACA] px-2.5 py-1 text-xs font-bold text-[#DC2626] hover:bg-[#FFF7ED]">{t('staffRetry')}</button>
          </div>
        )}

        {/* Overview */}
        <section aria-label="Staff overview" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffTotalStaff')}</p>
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]"><IconUsers size={16} className="h-4 w-4" /></span>
            </div>
            {loading ? <div className="h-7 w-12 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[var(--c-text)]">{totalStaff}</p>}
            <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffAllRoles')}</p>
          </div>
          <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffActive')}</p>
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#F0FDF4] dark:bg-[rgba(16,185,129,0.12)] text-[#15803D]"><IconUserCheck size={16} className="h-4 w-4" /></span>
            </div>
            {loading ? <div className="h-7 w-12 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[#15803D] dark:text-[#6EE7B7]">{activeStaff}</p>}
            <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffCanLogin')}</p>
          </div>
          <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffDisabled')}</p>
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FEF2F2] dark:bg-[#2A2B36] text-[#DC2626]"><IconUserX size={16} className="h-4 w-4" /></span>
            </div>
            {loading ? <div className="h-7 w-12 animate-pulse rounded bg-[var(--c-bg)]" /> : <p className="text-2xl font-black text-[#DC2626]">{disabledStaff}</p>}
            <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffCannotLogin')}</p>
          </div>
          <div className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl p-4 bg-[var(--c-card)] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffByRole')}</p>
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FFD600]/15 dark:bg-[rgba(255,94,0,0.12)] text-[#8A6D00] dark:text-[#FF8A3D]"><IconShieldCheck size={16} className="h-4 w-4" /></span>
            </div>
            {loading ? (
              <div className="h-7 w-24 animate-pulse rounded bg-[var(--c-bg)]" />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {ROLES.map((r) => (
                  <span key={r} className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-black ${roleBadgeCls(r)}`}>
                    {roleLabel(r)}: {counts.byRole?.[r] ?? 0}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Waiter Performance — Date Range (Africa/Addis_Ababa, half-open [from, to)) — shared for list & Details */}
        <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-4 sm:p-5 flex flex-col gap-3" aria-label="Waiter performance date range">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--c-accent)]/15 dark:bg-[rgba(255,94,0,0.12)] text-[var(--c-accent)]"><IconCalendar size={16} className="h-4 w-4" /></span>
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('waiterPerf')}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => fetchWaiterSummaries()} disabled={analyticsLoading} className="inline-flex h-8 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)] shadow-sm disabled:opacity-50">
                <IconRefresh size={14} className="mr-1 h-3.5 w-3.5" />{analyticsLoading ? t('staffLoading') : t('staffRefresh')}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { key: 'today', label: t('today') },
              { key: 'yesterday', label: t('yesterday') },
              { key: 'last7', label: t('last7') },
              { key: 'thisMonth', label: t('thisMonth') },
              { key: 'custom', label: t('custom') },
            ].map((p) => {
              const active = preset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPreset(p.key)}
                  aria-pressed={active}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-black border transition-all duration-150 ease-out active:shadow-inner ${active ? 'bg-[var(--c-accent)] text-[#1E293B] dark:text-white border-transparent shadow-sm' : 'bg-white dark:bg-[#12131A] text-[var(--c-muted)] border-[var(--c-border-soft)]'}`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('from')} (Addis) *</span>
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('to')} (Addis) *</span>
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
              </label>
              <p className="col-span-2 text-[11px] font-medium text-[var(--c-muted)]">{t('staffRangeNote')}</p>
            </div>
          )}
          {analyticsError && <p className="text-xs font-semibold text-[#DC2626]">{analyticsError}</p>}
          {analyticsLoading && <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffLoadingAnalytics')}</p>}
        </section>

        {/* Controls */}
        <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] p-4 sm:p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-black text-[var(--c-text)]">{t('staffAccounts')}</h2>
            <button
              type="button"
              onClick={() => { setShowAdd((v) => !v); setAddError(''); }}
              className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm"
            >
              <IconUserPlus size={16} className="mr-1.5 h-4 w-4" /> {showAdd ? t('close') : t('staffAddStaff')}
            </button>
          </div>

          {showAdd && (
            <form onSubmit={handleAdd} className="rounded-2xl border border-[var(--c-border-soft)] bg-[var(--c-bg)]/50 p-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffName')} *</span>
                <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Abel" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('username')} *</span>
                <input value={addForm.username} onChange={(e) => setAddForm({ ...addForm, username: e.target.value })} placeholder="abel.t" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffRole')} *</span>
                <select value={addForm.role} onChange={(e) => setAddForm({ ...addForm, role: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
                  <option value="WAITER">{roleLabel('WAITER')}</option>
                  <option value="CASHIER">{roleLabel('CASHIER')}</option>
                </select>
                <p className="mt-1 text-[11px] font-medium text-[var(--c-muted)]">{t('staffIndividualRolesNote')}</p>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffPin')} (4 digits) *</span>
                  <input type="password" inputMode="numeric" maxLength={4} value={addForm.pin} onChange={(e) => setAddForm({ ...addForm, pin: e.target.value })} placeholder="••••" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffConfirmPin')} *</span>
                  <input type="password" inputMode="numeric" maxLength={4} value={addForm.confirmPin} onChange={(e) => setAddForm({ ...addForm, confirmPin: e.target.value })} placeholder="••••" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                </label>
              </div>
              <div className="sm:col-span-2 flex items-center gap-2">
                <button type="submit" disabled={addBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{addBusy ? t('staffLoading') : t('staffCreateAccount')}</button>
                <button type="button" onClick={() => { setShowAdd(false); setAddError(''); }} className="inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('staffCancel')}</button>
                {addError && <span className="text-xs font-semibold text-[#DC2626]">{addError}</span>}
              </div>
            </form>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex flex-1 items-center gap-2 rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] px-3 py-2 focus-within:ring-2 focus-within:ring-[var(--c-accent)]/30">
              <IconSearch size={16} className="h-4 w-4 text-[var(--c-muted)] shrink-0" aria-hidden={true} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('staffSearchPh')} aria-label={t('staffSearchAria')} className="w-full bg-transparent text-sm font-medium text-[var(--c-text)] placeholder:text-[var(--c-muted)] focus:outline-none" />
              {search && <button type="button" onClick={() => setSearch('')} className="shrink-0 rounded-full bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] h-6 w-6 flex items-center justify-center text-[var(--c-muted)] hover:bg-[#F8FAFC] dark:hover:bg-[#252631]" aria-label={t('staffClearSearch')}>✕</button>}
            </label>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="h-10 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-bold text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
              <option value="all">{t('staffAllRoles')}</option>
              {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-bold text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30">
              <option value="all">{t('staffAllStatus')}</option><option value="active">{t('staffActive')}</option><option value="disabled">{t('staffDisabled')}</option>
            </select>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-[var(--c-muted)]">{loading ? t('staffLoading') : `${filtered.length} / ${staff.length} ${t('staffAccountsWord')}`}</p>
            <span className="hidden sm:inline text-[11px] font-bold text-[var(--c-faint)]">{t('staffPinsNeverShown')}</span>
          </div>
        </section>

        {/* List */}
        <section className="border border-[var(--c-border-soft)] shadow-[var(--shadow-card)] rounded-2xl bg-[var(--c-card)] overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)]" />)}
            </div>
          ) : error ? (
            <div className="px-4 sm:px-5 py-8 text-center">
              <p className="text-sm font-bold text-[#DC2626]">{error}</p>
                <button type="button" onClick={fetchStaff} className="mt-3 rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 py-1.5 text-xs font-bold text-[var(--c-muted)]">{t('staffRetry')}</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 sm:px-5 py-12 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] mb-3"><IconUsers size={20} className="h-5 w-5" /></div>
              <p className="text-sm font-black text-[var(--c-text)]">{t('staffNoStaff')}</p>
              <p className="mt-1 text-xs font-medium text-[var(--c-muted)] max-w-[36ch] mx-auto">{t('staffAdjustHint')}</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                    <tr>
                      <th className="px-4 py-3 font-black">{t('staffTitle')}</th>
                      <th className="px-4 py-3 font-black">{t('staffRole')}</th>
                      <th className="px-4 py-3 font-black">{t('staffStatus')}</th>
                      <th className="px-4 py-3 font-black">{t('username')}</th>
                      <th className="px-4 py-3 text-right font-black">{t('staffActions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--c-border-soft)]">
                    {filtered.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] font-black text-xs">{String(s.name).slice(0, 2).toUpperCase()}</span>
                            <div className="min-w-0">
                              <p className="truncate font-bold text-[var(--c-text)]">{s.name}</p>
                              {s.role === 'WAITER' && (
                                (() => {
                                  const sum = summaryMap.get(String(s.id));
                                  if (analyticsLoading) return <p className="text-[11px] font-medium text-[var(--c-muted)]">{t('staffLoadingPerf')}</p>;
                                  if (analyticsError) return <p className="text-[11px] font-medium text-[#DC2626]">{t('staffPerfUnavailable')}</p>;
                                  if (!sum) return <p className="text-[11px] font-medium text-[var(--c-muted)]">{t('staffNoPerfData')}</p>;
                                  return (
                                    <p className="text-[11px] font-medium text-[var(--c-muted)]">
                                      {t('staffPaid')} <span className="font-bold text-[var(--c-text)]">{sum.paidOrdersByPayment}</span> <span className="font-bold text-[var(--c-text)]">{sum.paidRevenueByPayment} ETB</span> <span className="font-bold text-[var(--c-text)]">{t('staffLevel')}: {t('staffNotConfigured')}</span>
                                    </p>
                                  );
                                })()
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${roleBadgeCls(s.role)}`}>{roleLabel(s.role)}</span></td>
                        <td className="px-4 py-3.5"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${statusBadge(s.isActive)}`}>{s.isActive ? t('staffActive') : t('staffDisabled')}</span></td>
                        <td className="px-4 py-3.5 font-mono text-xs font-semibold text-[var(--c-text)]">{s.username}</td>
                        <td className="px-4 py-3.5">
                          <div className="flex justify-end gap-1.5">
                            {s.role === 'WAITER' && (
                              <button type="button" onClick={() => setSelectedWaiter(s)} className="inline-flex h-7 items-center justify-center rounded-lg bg-[var(--c-accent)] px-2.5 text-xs font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner"><IconEye size={14} className="mr-1 h-3.5 w-3.5" />{t('staffDetails')}</button>
                            )}
                            <button type="button" onClick={() => openEdit(s)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]"><IconEdit size={14} className="mr-1 h-3.5 w-3.5" />{t('edit')}</button>
                            <button type="button" onClick={() => setPinTarget(s)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-2.5 text-xs font-bold text-[var(--c-muted)]"><IconKey size={14} className="mr-1 h-3.5 w-3.5" />{t('staffPin')}</button>
                            {['WAITER','CASHIER'].includes(s.role) ? (
                              s.isActive ? (
                                <button type="button" onClick={() => setToggleTarget(s)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[#FECACA] bg-white px-2.5 text-xs font-bold text-[#DC2626] hover:bg-[#FEF2F2]"><IconTrash size={14} className="mr-1 h-3.5 w-3.5" />{t('staffDisable')}</button>
                              ) : (
                                <button type="button" onClick={() => setToggleTarget(s)} className="inline-flex h-7 items-center justify-center rounded-lg border border-[#BBF7D0] bg-[#F0FDF4] px-2.5 text-xs font-bold text-[#15803D] hover:bg-[#DCFCE7]">{t('staffEnable')}</button>
                              )
                            ) : (
                              <span className="inline-flex h-7 items-center rounded-lg border border-[var(--c-border-soft)] bg-[var(--c-bg)] px-2.5 text-xs font-bold text-[var(--c-faint)]">{t('staffSharedPin')}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile cards */}
              <div className="sm:hidden divide-y divide-[var(--c-border-soft)]">
                {filtered.map((s) => (
                  <div key={`m-${s.id}`} className="px-4 py-4 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--c-bg)] border border-[var(--c-border-soft)] text-[var(--c-muted)] font-black text-xs">{String(s.name).slice(0, 2).toUpperCase()}</span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-[var(--c-text)]">{s.name}</p>
                          <p className="truncate text-xs font-mono font-medium text-[var(--c-muted)]">{s.username}</p>
                              {s.role === 'WAITER' && (
                                (() => {
                                  const sum = summaryMap.get(String(s.id));
                                  if (analyticsLoading) return <p className="text-[11px] font-medium text-[var(--c-muted)]">{t('staffLoadingPerf')}</p>;
                                  if (analyticsError) return <p className="text-[11px] font-medium text-[#DC2626]">{t('staffPerfUnavailable')}</p>;
                                  if (!sum) return null;
                                  return <p className="text-[11px] font-medium text-[var(--c-muted)]">{t('staffPaid')} {sum.paidOrdersByPayment} {sum.paidRevenueByPayment} ETB <span className="font-bold text-[var(--c-text)]">{t('staffLevel')}: {t('staffNotConfigured')}</span></p>;
                                })()
                              )}
                        </div>
                      </div>
                      <span className={`shrink-0 inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${statusBadge(s.isActive)}`}>{s.isActive ? t('staffActive') : t('staffDisabled')}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${roleBadgeCls(s.role)}`}>{roleLabel(s.role)}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {s.role === 'WAITER' && (
                        <button type="button" onClick={() => setSelectedWaiter(s)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-3 text-xs font-black text-[#1E293B] dark:text-white shadow-sm"><IconEye size={16} className="mr-1.5 h-4 w-4" />{t('staffDetails')}</button>
                      )}
                      <button type="button" onClick={() => openEdit(s)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)]"><IconEdit size={16} className="mr-1.5 h-4 w-4" />{t('edit')}</button>
                      <button type="button" onClick={() => setPinTarget(s)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-xs font-bold text-[var(--c-muted)]"><IconKey size={16} className="mr-1.5 h-4 w-4" />{t('staffPin')}</button>
                      {['WAITER','CASHIER'].includes(s.role) && (
                        s.isActive ? (
                          <button type="button" onClick={() => setToggleTarget(s)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl border border-[#FECACA] bg-white px-3 text-xs font-bold text-[#DC2626]">{t('staffDisable')}</button>
                        ) : (
                          <button type="button" onClick={() => setToggleTarget(s)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3 text-xs font-bold text-[#15803D]">{t('staffEnable')}</button>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {/* Waiter Details — KPIs, payment breakdown, item table, order history */}
        {selectedWaiter && (
          <div className="fixed inset-0 z-50 flex" onClick={(e) => { if (e.target === e.currentTarget) setSelectedWaiter(null); }}>
            <div className="flex-1 bg-[#1E293B]/20 dark:bg-[#12131A]/60 backdrop-blur-sm" onClick={() => setSelectedWaiter(null)} />
            <div className="flex h-full w-[96%] max-w-3xl flex-col border-l border-[var(--c-border-soft)] bg-[#F4F5F9] dark:bg-[#12131A] shadow-[0_12px_30px_rgba(0,0,0,0.45)] overflow-hidden">
              <div className="flex items-center justify-between border-b border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-4 py-4">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-black text-[var(--c-text)]">{selectedWaiter.name} {t('staffDetails')}</h2>
                  <p className="truncate text-xs font-medium text-[var(--c-muted)]">{selectedWaiter.username} {roleLabel(selectedWaiter.role)} {selectedWaiter.isActive ? t('staffActive') : t('staffDisabled')} {t('staffLevel')}: <span className="font-bold text-[var(--c-text)]">{t('staffNotConfigured')}</span></p>
                </div>
                <button type="button" onClick={() => setSelectedWaiter(null)} className="shrink-0 rounded-full border border-[var(--c-border-soft)] bg-[#F4F5F9] dark:bg-[#12131A] px-3 py-1 text-sm font-bold text-[var(--c-muted)]">✕ {t('staffClose')}</button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                {detailLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)]" />)}
                  </div>
                ) : detailError ? (
                  <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-6 text-center">
                    <p className="text-sm font-bold text-[#DC2626]">{detailError}</p>
                    <button type="button" onClick={() => selectedWaiter && fetchWaiterDetail(String(selectedWaiter.id))} className="mt-3 rounded-xl border border-[#FECACA] bg-white px-3 py-1.5 text-xs font-bold text-[#DC2626]">{t('staffRetry')}</button>
                  </div>
                ) : !detailData ? (
                  <p className="py-10 text-center text-sm text-[var(--c-muted)]">{t('staffNoData')}</p>
                ) : (
                  <>
                    <div className="rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] px-3 py-2 text-xs font-medium text-[var(--c-muted)]">
                      <span className="font-bold text-[var(--c-text)]">{detailData.presetLabel}</span> {fmtStaffDateTime(detailData.range.from, lang)} → {fmtStaffDateTime(detailData.range.to, lang)}
                    </div>
                    {/* Summary KPIs */}
                    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                      <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-3">
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffOrdersCreated')}</p>
                        <p className="mt-1 text-xl font-black text-[var(--c-text)]">{detailData.kpis.totalOrdersCreated}</p>
                        <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffInPeriod')}</p>
                      </div>
                      <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-3">
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffPaidOrders')}</p>
                        <p className="mt-1 text-xl font-black text-[#15803D] dark:text-[#6EE7B7]">{detailData.kpis.paidOrdersByPayment}</p>
                        <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffByPaymentDate')} {detailData.kpis.paidRevenueByPayment} ETB</p>
                      </div>
                      <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-3">
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffSoldQty')}</p>
                        <p className="mt-1 text-xl font-black text-[var(--c-text)]">{detailData.kpis.soldQtyPaid}</p>
                        <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffExclCancelled')}</p>
                      </div>
                      <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-3">
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffAvgPaidValue')}</p>
                        <p className="mt-1 text-xl font-black text-[var(--c-text)]">{detailData.kpis.avgPaidValue} ETB</p>
                        <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffPaidOnly')}</p>
                      </div>
                      <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-3">
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffPendingServed')}</p>
                        <p className="mt-1 text-sm font-black text-[var(--c-text)]">{t('staffPendingWord')} {detailData.kpis.pendingInProgress} {t('staffServedWord')} {detailData.kpis.servedUnpaid} {t('staffVerifyWord')} {detailData.kpis.pendingVerificationCount}</p>
                        <p className="text-xs font-medium text-[var(--c-muted)]">PAYMENT_PENDING {detailData.kpis.pendingVerificationAmount} ETB</p>
                      </div>
                      <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-3">
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffCancelledRejected')}</p>
                        <p className="mt-1 text-sm font-black text-[#DC2626]">{t('staffCancelledWord')} {detailData.kpis.cancelled} {t('staffRejectedWord')} {detailData.kpis.rejectedCount}</p>
                        <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffExcludedNote')}</p>
                      </div>
                    </div>
                    {/* Payment breakdown */}
                    <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-4">
                      <h3 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('paymentBreakdown')}</h3>
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                        <div className="rounded-xl bg-[#F0FDF4] dark:bg-[rgba(16,185,129,0.12)] border border-[#BBF7D0] dark:border-[#10B981]/20 p-3">
                          <p className="text-xs font-bold text-[#15803D] dark:text-[#6EE7B7]">{t('cash')}</p>
                          <p className="mt-1 font-black text-[#15803D] dark:text-[#6EE7B7]">{detailData.paymentBreakdown.cash.count} {detailData.paymentBreakdown.cash.total} ETB</p>
                        </div>
                        <div className="rounded-xl bg-[#FEF3C7]/50 dark:bg-[#7C2D12]/20 border border-[#FDE68A] dark:border-[#7C2D12] p-3">
                          <p className="text-xs font-bold text-[#92400E] dark:text-[#FDBA74]">{t('bankTransfer')}</p>
                          <p className="mt-1 font-black text-[#92400E] dark:text-[#FDBA74]">{detailData.paymentBreakdown.transfer.count} {detailData.paymentBreakdown.transfer.total} ETB</p>
                        </div>
                        <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#12131A] border border-[var(--c-border-soft)] p-3">
                          <p className="text-xs font-bold text-[var(--c-muted)]">{t('staffPendingRejected')}</p>
                          <p className="mt-1 font-black text-[var(--c-text)]">Pending {detailData.paymentBreakdown.pending.count} {detailData.paymentBreakdown.pending.total} ETB</p>
                          <p className="text-xs font-medium text-[var(--c-muted)]">Rejected {detailData.paymentBreakdown.rejected.count}</p>
                        </div>
                      </div>
                    </div>
                    {/* Item performance */}
                    <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-4">
                      <h3 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffItemsSold')}</h3>
                      {detailData.items.length === 0 ? (
                        <p className="py-6 text-center text-sm text-[var(--c-muted)]">{t('staffNoItemsSold')}</p>
                      ) : (
                        <div className="mt-3 overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-[var(--c-bg)] text-left text-xs uppercase tracking-wide text-[var(--c-muted)]">
                              <tr>
                                <th className="px-3 py-2 font-black">{t('item')}</th>
                                <th className="px-3 py-2 font-black">{t('type')}</th>
                                <th className="px-3 py-2 text-right font-black">{t('qty')}</th>
                                <th className="px-3 py-2 text-right font-black">{t('invUnit')}</th>
                                <th className="px-3 py-2 text-right font-black">{t('staffRevenue')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--c-border-soft)]">
                              {detailData.items.map((it, idx) => (
                                <tr key={`${it.name}-${idx}`}>
                                  <td className="px-3 py-2 font-bold text-[var(--c-text)]">{it.name}{it.isComponent ? ` ${t('staffComponent')}` : ''}</td>
                                  <td className="px-3 py-2"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black ${it.type==='COMPONENT' ? 'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]' : 'bg-[var(--c-bg)] text-[var(--c-muted)] border-[var(--c-border-soft)]'}`}>{it.type}</span></td>
                                  <td className="px-3 py-2 text-right font-bold text-[var(--c-text)]">{it.quantity}</td>
                                  <td className="px-3 py-2 text-right font-medium text-[var(--c-muted)]">{it.unitPrice ? `${it.unitPrice} ETB` : '—'}</td>
                                  <td className="px-3 py-2 text-right font-black text-[var(--c-text)]">{it.revenue} ETB</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                    {/* Order history */}
                    <div className="rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-4">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-black uppercase tracking-widest text-[var(--c-muted)]">{t('staffOrderHistory')} {detailData.historyCount} {t('staffCreatedWord')} {detailData.historyLimited ? `(${t('staffLimited200')})` : ''}</h3>
                        <span className="text-[11px] font-medium text-[var(--c-muted)]">{t('staffShownMax')}: {detailData.history.length}</span>
                      </div>
                      {detailData.history.length === 0 ? (
                        <p className="py-6 text-center text-sm text-[var(--c-muted)]">{t('staffNoOrdersPeriod')}</p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {detailData.history.map((o) => (
                            <details key={o._id} className="rounded-xl border border-[var(--c-border-soft)] bg-[var(--c-bg)] dark:bg-[#12131A] p-3">
                              <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate font-bold text-[var(--c-text)]">{o.orderNumber} {t('table')} {o.tableNumber} {o.status} {o.paymentMethod}{o.paymentMethod==='TRANSFER' && o.paymentAccountSnapshot ? ` ${o.paymentAccountSnapshot.bankName}` : ''}</p>
                                  <p className="text-xs font-medium text-[var(--c-muted)]">{t('staffTsCreated')} {fmtStaffDateTime(o.createdAt, lang)} {o.effectiveAmount} ETB {o.items.filter((it)=>!it.cancelled).length} {t('staffItemsWord')}</p>
                                  {o.paidAt && <p className="text-[11px] font-medium text-[#15803D] dark:text-[#6EE7B7]">{t('staffTsPaid')} {fmtStaffDateTime(o.paidAt, lang)}</p>}
                                  {o.paymentRejectedAt && <p className="text-[11px] font-medium text-[#DC2626]">{t('staffRejectedWord')} {fmtStaffDateTime(o.paymentRejectedAt, lang)}{o.paymentRejectionReason ? `: ${o.paymentRejectionReason}` : ''}</p>}
                                </div>
                                <span className="shrink-0 rounded-full bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] px-2 py-1 text-xs font-bold text-[var(--c-muted)]">{t('staffDetails')}</span>
                              </summary>
                              <div className="mt-3 space-y-2 rounded-xl bg-white dark:bg-[#1C1D24] p-3 border border-[var(--c-border-soft)]">
                                <p className="text-xs font-bold text-[var(--c-muted)]">{t('staffTimestamps')}</p>
                                <p className="text-xs font-medium text-[var(--c-text)]">{t('staffTsCreated')} {fmtStaffDateTime(o.createdAt, lang)} {t('staffTsServed')} {fmtStaffDateTime(o.servedAt, lang)} {t('staffTsReady')} {fmtStaffDateTime(o.readyAt, lang)} {t('staffTsPaid')} {fmtStaffDateTime(o.paidAt, lang)} {t('staffTsSubmitted')} {fmtStaffDateTime(o.paymentSubmittedAt, lang)} {t('staffTsVerified')} {fmtStaffDateTime(o.paymentVerifiedAt, lang)}</p>
                                <p className="text-xs font-bold text-[var(--c-muted)]">{t('staffPayment')}</p>
                                <p className="text-xs font-medium text-[var(--c-text)]">{o.paymentMethod}{o.paymentAccountSnapshot ? ` ${o.paymentAccountSnapshot.bankName} ${o.paymentAccountSnapshot.ownerName} ${o.paymentAccountSnapshot.accountNumber}` : ''}</p>
                                <ul className="space-y-1">
                                  {o.items.map((it, idx) => (
                                    <li key={`${o._id}-${it.lineId || idx}`} className={`rounded-lg px-2 py-1.5 text-xs ${it.cancelled ? 'bg-[#FEF2F2] dark:bg-[#2A2B36] text-[#DC2626] line-through' : 'bg-[var(--c-bg)] dark:bg-[#12131A] text-[var(--c-text)]'}`}>
                                      <div className="flex justify-between gap-2"><span className="font-bold">{it.quantity}× {it.name} ({it.type})</span><span className="font-bold">{it.subTotal} ETB</span></div>
                                      {it.cancelled && <span className="text-[11px]">{t('staffCancelledWord')}{it.cancelReason ? `: ${it.cancelReason}` : ''}</span>}
                                      {it.components && it.components.length > 0 && (
                                        <ul className="ml-3 mt-1 space-y-0.5">
                                          {it.components.map((c, ci) => (
                                            <li key={ci} className="text-[11px] text-[var(--c-muted)]">{c.kind==='NOTE' ? `📝 ${c.note}` : `➕ ${c.name} ×${c.quantity} @ ${c.unitPrice} = ${c.lineSum} ETB`}</li>
                                          ))}
                                        </ul>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                                <p className="text-xs font-bold text-[var(--c-text)]">{t('staffTotal')} {o.totalAmount} ETB {t('staffEffective')} {o.effectiveAmount} ETB {o.totalAmount !== o.effectiveAmount ? t('staffPartialCancel') : ''}</p>
                              </div>
                            </details>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Edit modal */}
        {editStaff && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E293B]/20 dark:bg-[#12131A]/60 backdrop-blur-sm p-4" onClick={(e) => { if (e.target === e.currentTarget) setEditStaff(null); }}>
            <form onSubmit={handleEdit} className="w-full max-w-md rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-5 shadow-[0_12px_30px_rgba(0,0,0,0.15)]">
              <h3 className="text-base font-black text-[var(--c-text)]">{t('staffEditStaff')}</h3>
              <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">{editStaff.role} {editStaff.isActive ? t('staffActive') : t('staffDisabled')}</p>
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffName')} *</span>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
              </label>
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('username')} *</span>
                <input value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-mono font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
              </label>
              {editError && <p className="mt-3 text-xs font-semibold text-[#DC2626]">{editError}</p>}
              <div className="mt-4 flex gap-2">
                <button type="submit" disabled={editBusy} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{editBusy ? t('staffLoading') : t('staffSave')}</button>
                <button type="button" onClick={() => setEditStaff(null)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('staffCancel')}</button>
              </div>
            </form>
          </div>
        )}

        {/* Disable/Enable confirm */}
        {toggleTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E293B]/20 dark:bg-[#12131A]/60 backdrop-blur-sm p-4" onClick={(e) => { if (e.target === e.currentTarget) setToggleTarget(null); }}>
            <div className="w-full max-w-md rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-5 shadow-[0_12px_30px_rgba(0,0,0,0.15)]">
              <h3 className="text-base font-black text-[var(--c-text)]">{toggleTarget.isActive ? t('staffDisable') : t('staffEnable')}</h3>
              <p className="mt-2 text-sm font-medium text-[var(--c-muted)]">
                {toggleTarget.isActive
                  ? `${t('staffDisable')}: ${toggleTarget.name} (${toggleTarget.username}, ${roleLabel(toggleTarget.role)})? ${t('staffDisableSuffix')}`
                  : `${t('staffEnable')}: ${toggleTarget.name} (${toggleTarget.username})? ${t('staffEnableSuffix')}`}
              </p>
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={handleToggle} disabled={toggleBusy} className={`flex-1 inline-flex h-9 items-center justify-center rounded-xl px-4 text-xs font-black uppercase tracking-wide shadow-sm disabled:opacity-50 ${toggleTarget.isActive ? 'bg-[#DC2626] text-white' : 'bg-[#16A34A] text-white'}`}>
                  {toggleBusy ? t('staffLoading') : toggleTarget.isActive ? t('staffDisable') : t('staffEnable')}
                </button>
                <button type="button" onClick={() => setToggleTarget(null)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('staffCancel')}</button>
              </div>
            </div>
          </div>
        )}

        {/* PIN reset */}
        {pinTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E293B]/20 dark:bg-[#12131A]/60 backdrop-blur-sm p-4" onClick={(e) => { if (e.target === e.currentTarget) setPinTarget(null); }}>
            <form onSubmit={handlePinReset} className="w-full max-w-md rounded-2xl border border-[var(--c-border-soft)] bg-white dark:bg-[#1C1D24] p-5 shadow-[0_12px_30px_rgba(0,0,0,0.15)]">
              <h3 className="text-base font-black text-[var(--c-text)]">{t('staffResetPin')} {pinTarget.name}</h3>
              <p className="mt-1 text-xs font-medium text-[var(--c-muted)]">
                {['KITCHEN','BARISTA','MANAGER'].includes(pinTarget.role)
                  ? `${t('staffRolePinNoteA')} ${roleLabel(pinTarget.role)} ${t('staffRolePinNoteB')}`
                  : `${t('staffIndividualPinNoteA')} ${pinTarget.username}. ${t('staffIndividualPinNoteB')}`}
              </p>
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffCurrentMgrPin')}</span>
                <input type="password" inputMode="numeric" maxLength={4} value={pinForm.currentManagerPin} onChange={(e) => setPinForm({ ...pinForm, currentManagerPin: e.target.value })} placeholder="••••" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
              </label>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffNewPin')} *</span>
                  <input type="password" inputMode="numeric" maxLength={4} value={pinForm.newPin} onChange={(e) => setPinForm({ ...pinForm, newPin: e.target.value })} placeholder="••••" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--c-muted)]">{t('staffConfirmPin')} *</span>
                  <input type="password" inputMode="numeric" maxLength={4} value={pinForm.confirmPin} onChange={(e) => setPinForm({ ...pinForm, confirmPin: e.target.value })} placeholder="••••" className="h-9 w-full rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-3 text-sm font-medium text-[var(--c-text)] focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30" />
                </label>
              </div>
              {pinError && <p className="mt-3 text-xs font-semibold text-[#DC2626]">{pinError}</p>}
              <div className="mt-4 flex gap-2">
                <button type="submit" disabled={pinBusy} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl bg-[var(--c-accent)] px-4 text-xs font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm disabled:opacity-50">{pinBusy ? t('staffLoading') : t('staffResetPin')}</button>
                <button type="button" onClick={() => setPinTarget(null)} className="flex-1 inline-flex h-9 items-center justify-center rounded-xl border border-[var(--c-border-soft)] bg-white dark:bg-[#12131A] px-4 text-xs font-bold text-[var(--c-muted)]">{t('staffCancel')}</button>
              </div>
            </form>
          </div>
        )}

        <p className="text-center text-[11px] font-medium text-[var(--c-faint)]">{t('staffPinFooterNote')}</p>
      </main>
    </div>
  );
}
