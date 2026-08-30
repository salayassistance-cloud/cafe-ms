"use client";

import { useState } from "react";
import { safeFetchJson } from "@/lib/clientFetch";

/**
 * Lightweight Change PIN Modal — used across waiter/kitchen/barista/manager navbars.
 * Inputs: Current PIN, New PIN, Confirm New PIN
 * Calls POST /api/auth/change-pin with { staffId, currentPin, newPin, confirmPin }
 * If staffId not provided, server resolves via HTTP-only session cookie.
 * Does NOT alter Auth Modal/Numpad UI — standalone settings modal.
 */
export default function ChangePinModal({ open, onClose, staffId = null, title = "Change PIN" }) {
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const digitsOnly = (v) => String(v).replace(/\D/g, "").slice(0, 4);

  async function submit(e) {
    e?.preventDefault();
    setError("");
    setSuccess("");
    if (!/^\d{4}$/.test(currentPin)) {
      setError("Current PIN must be 4 digits");
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      setError("New PIN must be 4 digits");
      return;
    }
    if (newPin !== confirmPin) {
      setError("New PIN and Confirm PIN do not match");
      return;
    }
    if (currentPin === newPin) {
      setError("New PIN must differ from current PIN");
      return;
    }
    setBusy(true);
    try {
      const payload = { currentPin, newPin, confirmPin };
      if (staffId) payload.staffId = staffId;
      const data = await safeFetchJson("/api/auth/change-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (data?.success) {
        setSuccess(data.message || "PIN updated successfully");
        setCurrentPin("");
        setNewPin("");
        setConfirmPin("");
        setTimeout(() => {
          setSuccess("");
          onClose?.();
        }, 1200);
      } else {
        setError(data?.message || data?.error || "Failed to update PIN");
      }
    } catch (err) {
      setError(err?.message || "Failed to update PIN");
    } finally {
      setBusy(false);
    }
  }

  function closeIfIdle() {
    if (!busy) {
      setError("");
      setSuccess("");
      onClose?.();
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) closeIfIdle(); }}>
      <div className="w-full max-w-sm   overflow-hidden rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-3 border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] text-[#64748B] dark:text-[#94A3B8]">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
              <path d="M10.325 4.317a2 2 0 013.35 0l.12.18a2 2 0 001.69.86l.22.02a2 2 0 011.93 1.46l.05.2a2 2 0 00.86 1.2l.17.12a2 2 0 010 3.3l-.17.12a2 2 0 00-.86 1.2l-.05.2a2 2 0 01-1.93 1.46l-.22.02a2 2 0 00-1.69.86l-.12.18a2 2 0 01-3.35 0l-.12-.18a2 2 0 00-1.69-.86l-.22-.02a2 2 0 01-1.93-1.46l-.05-.2a2 2 0 00-.86-1.2l-.17-.12a2 2 0 010-3.3l.17-.12a2 2 0 00.86-1.2l.05-.2A2 2 0 018.43 4.9l.22-.02a2 2 0 001.69-.86l.12-.18z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-extrabold text-[#1E293B] dark:text-white">{title}</h2>
            <p className="truncate text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">Secure PIN update</p>
          </div>
          <button type="button" onClick={closeIfIdle} disabled={busy} aria-label="Close" className="ml-auto rounded-lg p-2 text-[#64748B] dark:text-[#94A3B8] hover:bg-[#F4F5F9] dark:hover:bg-[#252631] hover:text-[#1E293B] dark:hover:text-white disabled:opacity-40 transition-colors">
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Current PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={currentPin}
              onChange={(e) => setCurrentPin(digitsOnly(e.target.value))}
              placeholder="••••"
              className="h-12 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3.5 text-center text-2xl tracking-[0.5em] font-bold text-[#1E293B] dark:text-white placeholder:tracking-[0.5em] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 dark:focus:ring-[#FF5E00]/30 shadow-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">New PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={newPin}
              onChange={(e) => setNewPin(digitsOnly(e.target.value))}
              placeholder="••••"
              className="h-12 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3.5 text-center text-2xl tracking-[0.5em] font-bold text-[#1E293B] dark:text-white placeholder:tracking-[0.5em] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 dark:focus:ring-[#FF5E00]/30 shadow-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Confirm New PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={confirmPin}
              onChange={(e) => setConfirmPin(digitsOnly(e.target.value))}
              placeholder="••••"
              className="h-12 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3.5 text-center text-2xl tracking-[0.5em] font-bold text-[#1E293B] dark:text-white placeholder:tracking-[0.5em] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 dark:focus:ring-[#FF5E00]/30 shadow-sm"
            />
          </label>

          {error && (
            <div role="alert" className="rounded-xl border border-[#FECACA] dark:border-[#FF5E00]/20 bg-[#FEF2F2] dark:bg-[rgba(255,94,0,0.12)] px-3.5 py-2.5 text-xs font-semibold text-[#DC2626] dark:text-[#FF8A3D]">
              {error}
            </div>
          )}
          {success && (
            <div role="status" className="rounded-xl border border-[#BBF7D0] dark:border-[#FF5E00]/20 bg-[#F0FDF4] dark:bg-[rgba(255,94,0,0.12)] px-3.5 py-2.5 text-xs font-semibold text-[#15803D] dark:text-[#FF8A3D]">
              {success}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={closeIfIdle} disabled={busy} className="flex-1 rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] py-3 text-sm font-bold text-[#64748B] dark:text-[#94A3B8] hover:bg-[#F4F5F9] dark:hover:bg-[#252631] transition-all duration-150 ease-out     active:shadow-inner disabled:opacity-40">
              Cancel
            </button>
            <button type="submit" disabled={busy || !currentPin || !newPin || !confirmPin} className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] py-3 text-sm font-black text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out     active:shadow-inner disabled:opacity-50">
              {busy ? "Saving…" : "Update PIN"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
