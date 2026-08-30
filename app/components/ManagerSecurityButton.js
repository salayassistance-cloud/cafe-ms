"use client";

import { useState, useEffect } from "react";
import { useLanguage } from "@/app/components/LanguageProvider";
import { safeFetchJson, withTimeout } from "@/lib/clientFetch";

// Manager Settings — centralized auth management.
// Shows PIN Management (Kitchen/Barista/Manager) + Waiter Accounts (Active only)
// All actions verify Manager session server-side.

export default function ManagerSecurityButton({ className = "", title }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [waiters, setWaiters] = useState([]);
  const [activeWaiters, setActiveWaiters] = useState([]);
  const [kitchenStaff, setKitchenStaff] = useState([]);
  const [baristaStaff, setBaristaStaff] = useState([]);
  const [managerStaff, setManagerStaff] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [pinForm, setPinForm] = useState(null); // { staffId, name, role }
  const [currentManagerPin, setCurrentManagerPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState("");
  const [pinSuccess, setPinSuccess] = useState("");
  const [showAddWaiter, setShowAddWaiter] = useState(false);
  const [addName, setAddName] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [addPin, setAddPin] = useState("");
  const [addConfirmPin, setAddConfirmPin] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [addSuccess, setAddSuccess] = useState("");

  function openModal() {
    setError("");
    setToast("");
    setPinError("");
    setPinSuccess("");
    setOpen(true);
  }

  function closeModal() {
    setOpen(false);
    setPinForm(null);
    setCurrentManagerPin("");
    setNewPin("");
    setConfirmPin("");
    setPinError("");
    setPinSuccess("");
    setShowAddWaiter(false);
    setAddName("");
    setAddUsername("");
    setAddPin("");
    setAddConfirmPin("");
    setAddError("");
    setAddSuccess("");
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [waiterData, staffData] = await Promise.all([
          safeFetchJson("/api/manager/waiters?status=active", { cache: "no-store" }).catch((e) => { throw e; }),
          safeFetchJson("/api/staff", { cache: "no-store" }).catch(() => ({ success: true, data: { staff: [] } })),
        ]);
        if (cancelled) return;
        if (waiterData?.success) {
          const active = waiterData.data?.waiters || [];
          setWaiters(active);
          setActiveWaiters(active);
        } else {
          setError(waiterData?.error || "Failed to load waiter accounts");
        }
        if (staffData?.success) {
          const list = staffData.data?.staff || [];
          setKitchenStaff(list.filter((s) => s.role === "KITCHEN"));
          setBaristaStaff(list.filter((s) => s.role === "BARISTA"));
          setManagerStaff(list.filter((s) => s.role === "MANAGER"));
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || "Failed to load settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [open]);

  async function handleDelete(waiter) {
    setError("");
    setToast("");
    if (!window.confirm(`Delete waiter "${waiter.name}" (${waiter.username})?\n\nThis will disable the waiter account and prevent future waiter login.\n\n[Cancel] [Delete]`)) return;
    setBusyId(waiter.id);
    try {
      const data = await withTimeout(
        safeFetchJson("/api/manager/waiters", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ staffId: waiter.id }),
        }),
        10000,
        "Request timed out"
      );
      if (data?.success) {
        setToast(`Waiter "${waiter.name}" disabled`);
        // Refresh active list from backend — deleted must disappear
        try {
          const refreshed = await safeFetchJson("/api/manager/waiters?status=active", { cache: "no-store" });
          if (refreshed?.success) {
            const active = refreshed.data?.waiters || [];
            setWaiters(active);
            setActiveWaiters(active);
          } else {
            setActiveWaiters((prev) => prev.filter((w) => w.id !== waiter.id));
          }
        } catch {
          setActiveWaiters((prev) => prev.filter((w) => w.id !== waiter.id));
        }
      } else {
        setError(data?.error || data?.message || "Delete failed");
      }
    } catch (err) {
      setError(err?.message || "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleAddWaiter(e) {
    e?.preventDefault();
    setAddError("");
    setAddSuccess("");
    const n = addName.trim();
    const u = addUsername.trim();
    const p = addPin.trim();
    const c = addConfirmPin.trim();
    if (!n) { setAddError("Name is required"); return; }
    if (!u) { setAddError("Username is required"); return; }
    if (!/^[a-zA-Z0-9._-]+$/.test(u)) { setAddError("Username may contain only letters, numbers, dot, underscore, dash"); return; }
    if (!/^\d{4}$/.test(p)) { setAddError("PIN must be exactly 4 digits"); return; }
    if (p !== c) { setAddError("PIN and Confirm PIN do not match"); return; }
    setAddBusy(true);
    try {
      const data = await withTimeout(
        safeFetchJson("/api/manager/waiters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: n, username: u, pin: p, confirmPin: c }),
        }),
        10000,
        "Request timed out"
      );
      if (data?.success) {
        setAddSuccess(`Waiter account created for ${n} (${u})`);
        setAddName("");
        setAddUsername("");
        setAddPin("");
        setAddConfirmPin("");
        // Refresh active list from backend (source of truth)
        try {
          const refreshed = await safeFetchJson("/api/manager/waiters?status=active", { cache: "no-store" });
          if (refreshed?.success) {
            const active = refreshed.data?.waiters || [];
            setWaiters(active);
            setActiveWaiters(active);
          }
        } catch {}
        setTimeout(() => setAddSuccess(""), 2000);
      } else {
        setAddError(data?.error || data?.message || "Unable to create waiter.");
      }
    } catch (err) {
      setAddError(err?.message || "Unable to create waiter.");
    } finally {
      setAddBusy(false);
    }
  }

  function openPinForm(staff) {
    setPinError("");
    setPinSuccess("");
    setCurrentManagerPin("");
    setNewPin("");
    setConfirmPin("");
    setPinForm(staff);
  }

  async function submitPinChange(e) {
    e?.preventDefault();
    if (!pinForm) return;
    setPinError("");
    setPinSuccess("");
    if (!/^\d{4}$/.test(currentManagerPin)) {
      setPinError("Current Manager PIN must be 4 digits");
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      setPinError("New PIN must be 4 digits");
      return;
    }
    if (newPin !== confirmPin) {
      setPinError("New PIN and Confirm PIN do not match");
      return;
    }
    if (currentManagerPin === newPin) {
      setPinError("New PIN must differ from current Manager PIN");
      return;
    }
    setPinBusy(true);
    try {
      const data = await withTimeout(
        safeFetchJson("/api/manager/staff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ staffId: pinForm.staffId || pinForm.id, newPin, currentManagerPin }),
        }),
        10000,
        "Request timed out"
      );
      if (data?.success) {
        setPinSuccess(data.message || `PIN updated for ${pinForm.name}`);
        setTimeout(() => {
          setPinForm(null);
          setCurrentManagerPin("");
          setNewPin("");
          setConfirmPin("");
          setPinSuccess("");
        }, 1200);
        setToast(`PIN updated for ${pinForm.name}`);
      } else {
        setPinError(data?.message || data?.error || "Failed to update PIN");
      }
    } catch (err) {
      setPinError(err?.message || "Failed to update PIN");
    } finally {
      setPinBusy(false);
    }
  }

  const digitsOnly = (v) => String(v).replace(/\D/g, "").slice(0, 4);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        aria-label={title || "Security & PINs"}
        title={title || "Security & PINs"}
        className={
          className ||
          "flex h-10 items-center gap-1.5 rounded-full bg-white dark:bg-[#1C1D24] px-4 text-xs font-bold uppercase tracking-wide text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
        }
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
          <path d="M10.325 4.317a2 2 0 013.35 0l.12.18a2 2 0 001.69.86l.22.02a2 2 0 011.93 1.46l.05.2a2 2 0 00.86 1.2l.17.12a2 2 0 010 3.3l-.17.12a2 2 0 00-.86 1.2l-.05.2a2 2 0 01-1.93 1.46l-.22.02a2 2 0 00-1.69.86l-.12.18a2 2 0 01-3.35 0l-.12-.18a2 2 0 00-1.69-.86l-.22-.02a2 2 0 01-1.93-1.46l-.05-.2a2 2 0 00-.86-1.2l-.17.12a2 2 0 010-3.3l.17.12a2 2 0 00.86-1.2l.05-.2A2 2 0 018.43 4.9l.22-.02a2 2 0 001.69-.86l.12-.18z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        {title ? title : (t("securityPins") || "Security & PINs")}
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg overflow-hidden rounded-3xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-xl max-h-[90vh] flex flex-col">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] shrink-0">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F4F5F9] dark:bg-[#12131A] border border-[#E2E8F0]/60 dark:border-[#2A2B36]">
                ⚙️
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-extrabold text-[#1E293B] dark:text-white">Settings</h2>
                <p className="text-[11px] font-semibold text-[#64748B] dark:text-white/60">Manager — PINs & Waiter Accounts</p>
              </div>
              <button type="button" onClick={closeModal} aria-label="Close" className="ml-auto rounded-lg p-2 text-[#64748B] hover:bg-[#F4F5F9] dark:hover:bg-[#252631]">
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
              {loading ? (
                <p className="py-6 text-center text-sm text-[#64748B]">Loading…</p>
              ) : (
                <>
                  {/* PIN MANAGEMENT */}
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-widest text-[#1E293B] dark:text-white mb-3">PIN Management</h3>
                    <div className="space-y-4">
                      {/* Kitchen — single PIN per role */}
                      <div className="rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8] mb-2">Kitchen PIN</p>
                        <div className="flex items-center justify-between gap-2 rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2">
                          <span className="text-sm font-bold text-[#1E293B] dark:text-white truncate">Kitchen</span>
                          <button type="button" onClick={() => {
                            const target = kitchenStaff[0];
                            if (!target) { setPinError("No Kitchen account found"); return; }
                            openPinForm({ staffId: target.id, id: target.id, name: target.name, role: "KITCHEN" });
                          }} className="shrink-0 rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1 text-xs font-bold text-[#1E293B] dark:text-white">Change PIN</button>
                        </div>
                        {kitchenStaff.length > 1 && <p className="mt-1 text-[10px] text-[#94A3B8]">Applies to all Kitchen accounts</p>}
                      </div>
                      {/* Barista — single PIN */}
                      <div className="rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8] mb-2">Barista PIN</p>
                        <div className="flex items-center justify-between gap-2 rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2">
                          <span className="text-sm font-bold text-[#1E293B] dark:text-white truncate">Barista</span>
                          <button type="button" onClick={() => {
                            const target = baristaStaff[0];
                            if (!target) { setPinError("No Barista account found"); return; }
                            openPinForm({ staffId: target.id, id: target.id, name: target.name, role: "BARISTA" });
                          }} className="shrink-0 rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1 text-xs font-bold text-[#1E293B] dark:text-white">Change PIN</button>
                        </div>
                        {baristaStaff.length > 1 && <p className="mt-1 text-[10px] text-[#94A3B8]">Applies to all Barista accounts</p>}
                      </div>
                      {/* Manager — single PIN */}
                      <div className="rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] p-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8] mb-2">Manager PIN</p>
                        <div className="flex items-center justify-between gap-2 rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2">
                          <span className="text-sm font-bold text-[#1E293B] dark:text-white truncate">Manager</span>
                          <button type="button" onClick={() => {
                            const target = managerStaff[0];
                            if (!target) { setPinError("No Manager account found"); return; }
                            openPinForm({ staffId: target.id, id: target.id, name: target.name, role: "MANAGER" });
                          }} className="shrink-0 rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1 text-xs font-bold text-[#1E293B] dark:text-white">Change PIN</button>
                        </div>
                        {managerStaff.length > 1 && <p className="mt-1 text-[10px] text-[#94A3B8]">Applies to all Manager accounts</p>}
                      </div>
                    </div>
                    {pinForm && (
                      <div className="mt-4 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-4">
                        <p className="text-sm font-bold text-[#1E293B] dark:text-white mb-3">Change PIN for {pinForm.name} ({pinForm.role})</p>
                        <form onSubmit={submitPinChange} className="space-y-3" noValidate>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Current Manager PIN</span>
                            <input type="password" inputMode="numeric" value={currentManagerPin} onChange={(e) => setCurrentManagerPin(digitsOnly(e.target.value))} placeholder="••••" className="h-11 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 text-center text-lg tracking-[0.4em] font-bold text-[#1E293B] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">New PIN</span>
                            <input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(digitsOnly(e.target.value))} placeholder="••••" className="h-11 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 text-center text-lg tracking-[0.4em] font-bold text-[#1E293B] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Confirm New PIN</span>
                            <input type="password" inputMode="numeric" value={confirmPin} onChange={(e) => setConfirmPin(digitsOnly(e.target.value))} placeholder="••••" className="h-11 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 text-center text-lg tracking-[0.4em] font-bold text-[#1E293B] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30" />
                          </label>
                          {pinError && <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#DC2626]">{pinError}</div>}
                          {pinSuccess && <div role="status" className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs font-semibold text-[#15803D]">{pinSuccess}</div>}
                          <div className="flex gap-2">
                            <button type="button" onClick={() => setPinForm(null)} disabled={pinBusy} className="flex-1 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] py-2.5 text-sm font-bold text-[#64748B] dark:text-[#94A3B8] disabled:opacity-40">Cancel</button>
                            <button type="submit" disabled={pinBusy} className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-2.5 text-sm font-black text-[#1E293B] dark:text-white disabled:opacity-40">{pinBusy ? "Saving…" : "Update PIN"}</button>
                          </div>
                        </form>
                      </div>
                    )}
                  </div>

                  {/* WAITER ACCOUNTS */}
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-widest text-[#1E293B] dark:text-white mb-3">Waiter Accounts</h3>
                    {/* Add Waiter */}
                    <div className="mb-4 rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Add Waiter</p>
                        <button type="button" onClick={() => { setShowAddWaiter((v) => !v); setAddError(""); setAddSuccess(""); }} className="rounded-lg bg-[#FFD600] dark:bg-[#FF5E00] px-3 py-1 text-xs font-bold text-[#1E293B] dark:text-white">
                          {showAddWaiter ? "Cancel" : "+ Add Waiter"}
                        </button>
                      </div>
                      {showAddWaiter && (
                        <form onSubmit={handleAddWaiter} className="mt-3 space-y-3" noValidate>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Name</span>
                            <input type="text" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Abebe" className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 text-sm font-semibold text-[#1E293B] dark:text-white placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Username</span>
                            <input type="text" value={addUsername} onChange={(e) => setAddUsername(e.target.value)} placeholder="abebe" className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 text-sm font-semibold text-[#1E293B] dark:text-white placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">PIN</span>
                            <input type="password" inputMode="numeric" value={addPin} onChange={(e) => setAddPin(digitsOnly(e.target.value))} placeholder="••••" className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 text-center text-lg tracking-[0.4em] font-bold text-[#1E293B] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Confirm PIN</span>
                            <input type="password" inputMode="numeric" value={addConfirmPin} onChange={(e) => setAddConfirmPin(digitsOnly(e.target.value))} placeholder="••••" className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3 text-center text-lg tracking-[0.4em] font-bold text-[#1E293B] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30" />
                          </label>
                          {addError && <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#DC2626]">{addError}</div>}
                          {addSuccess && <div role="status" className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs font-semibold text-[#15803D]">{addSuccess}</div>}
                          <button type="submit" disabled={addBusy} className="flex h-11 w-full items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white disabled:opacity-40">
                            {addBusy ? "Creating..." : "Create Waiter"}
                          </button>
                        </form>
                      )}
                    </div>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8] mb-2">Active Waiters</p>
                    {activeWaiters.length === 0 ? (
                      <p className="py-4 text-center text-sm text-[#94A3B8]">No active waiter accounts</p>
                    ) : (
                      <div className="space-y-2">
                        {activeWaiters.map((w) => (
                          <div key={w.id} className="flex items-center justify-between gap-3 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] px-3 py-2.5">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-bold text-[#1E293B] dark:text-white">{w.displayName || w.name} <span className="font-normal text-[#64748B]">({w.username})</span></p>
                              <p className="text-[11px] font-bold uppercase tracking-wide text-[#16A34A]">Active</p>
                            </div>
                            <button type="button" onClick={() => handleDelete(w)} disabled={busyId === w.id} className="shrink-0 rounded-lg bg-white dark:bg-[#1C1D24] border border-[#E2E8F0] px-3 py-1.5 text-xs font-bold text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-40">
                              {busyId === w.id ? "…" : "Delete"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {error && (
                    <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#DC2626]">
                      {error}
                    </div>
                  )}
                  {toast && (
                    <div role="status" className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs font-semibold text-[#15803D]">
                      {toast}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
