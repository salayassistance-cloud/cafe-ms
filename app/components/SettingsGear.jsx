"use client";

import { useState, useMemo } from "react";
import ChangePinModal from "./ChangePinModal";

/**
 * Subtle Settings Gear — appears in top navbar of /waiter, /kitchen, /barista, /manager
 * Opens lightweight Change PIN modal. Does not affect Auth Modal/Numpad UI.
 * Phase 6.6: canChangeOwnPin controls whether PIN-change action is exposed.
 * /kitchen and /barista must NOT expose Change PIN (managed from /manager/reports).
 */
export default function SettingsGear({ staffId = null, title = "Change PIN", className = "", canChangeOwnPin = true }) {
  const [open, setOpen] = useState(false);
  const resolvedId = useMemo(() => {
    if (staffId) return staffId;
    try {
      const wid = typeof window !== "undefined" ? window.localStorage.getItem("bono_waiter_id") : null;
      if (wid) return wid;
      const sid = typeof window !== "undefined" ? window.localStorage.getItem("bono_staff_id") : null;
      if (sid) return sid;
    } catch {}
    return null;
  }, [staffId]);

  // Phase 6.6: Kitchen/Barista have no PIN-change UI (centralized in manager)
  if (!canChangeOwnPin) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Settings"
        title="Settings"
        className={
          className ||
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#64748B] dark:text-[#94A3B8] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:text-[#1E293B] dark:hover:text-white   active:shadow-inner"
        }
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path d="M10.325 4.317a2 2 0 013.35 0l.12.18a2 2 0 001.69.86l.22.02a2 2 0 011.93 1.46l.05.2a2 2 0 00.86 1.2l.17.12a2 2 0 010 3.3l-.17.12a2 2 0 00-.86 1.2l-.05.2a2 2 0 01-1.93 1.46l-.22.02a2 2 0 00-1.69.86l-.12.18a2 2 0 01-3.35 0l-.12-.18a2 2 0 00-1.69-.86l-.22-.02a2 2 0 01-1.93-1.46l-.05-.2a2 2 0 00-.86-1.2l-.17-.12a2 2 0 010-3.3l.17-.12a2 2 0 00.86-1.2l.05-.2A2 2 0 018.43 4.9l.22-.02a2 2 0 001.69-.86l.12-.18z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      <ChangePinModal open={open} onClose={() => setOpen(false)} staffId={resolvedId} title={title} />
    </>
  );
}
