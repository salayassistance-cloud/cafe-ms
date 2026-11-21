"use client";

// Hotel-specific self-service PIN change modal. Structure and inputs follow
// the POS ChangePinModal reference (C:\bonosm\app\components\ChangePinModal.jsx).
// It sends the memory-only Hotel CSRF token on the mutation and never selects
// a target identity: the server uses the authenticated session's HotelUser.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HOTEL_CSRF_HEADER } from "@/lib/hotel/constants";
import { useHotelI18n } from "./HotelI18n";
import { useHotelSession } from "./HotelSessionProvider";

const digitsOnly = (value) => String(value).replace(/\D/g, "").slice(0, 4);

export default function HotelChangePinModal({ open, onClose }) {
  const { t } = useHotelI18n();
  const router = useRouter();
  const session = useHotelSession();
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  function closeIfIdle() {
    if (busy) return;
    setError("");
    setSuccess("");
    // Never leave entered PIN values behind in component state after close.
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
    onClose?.();
  }

  async function submit(event) {
    event?.preventDefault();
    if (busy) return;
    setError("");
    setSuccess("");
    if (!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin) || !/^\d{4}$/.test(confirmPin)) {
      setError(t("session.pin4digits"));
      return;
    }
    if (newPin !== confirmPin) {
      setError(t("session.newPinMismatch"));
      return;
    }
    if (newPin === currentPin) {
      setError(t("session.newPinMustDiffer"));
      return;
    }

    setBusy(true);
    try {
      const headers = { "Content-Type": "application/json" };
      if (session?.csrfToken) headers[HOTEL_CSRF_HEADER] = session.csrfToken;
      const response = await fetch("/api/hotel/auth/change-pin", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ currentPin, newPin, confirmPin }),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (response.ok && data?.success) {
        setSuccess(t("session.pinUpdated"));
        setCurrentPin("");
        setNewPin("");
        setConfirmPin("");
        setTimeout(() => {
          setSuccess("");
          onClose?.();
          // A successful change revokes every Hotel session for this identity,
          // including the one that made this request. The server-layout session
          // snapshot held by this page is now stale; ask the server to re-read
          // the cookie so the sign-in gate replaces the authenticated UI instead
          // of leaving a dead session visible until the next 401.
          router.refresh();
        }, 1200);
      } else {
        setError(
          data?.error?.message ||
            data?.message ||
            t("session.currentPinIncorrect")
        );
      }
    } catch {
      setError(t("session.networkError"));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "h-12 w-full rounded-xl border border-[#E2E8F0]/60 bg-white px-3.5 text-center text-2xl font-bold tracking-[0.5em] text-[#1E293B] placeholder:tracking-[0.5em] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:focus:ring-[#FF5E00]/30";

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[#1E293B]/30 p-4 backdrop-blur-sm dark:bg-[#12131A]/70"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeIfIdle();
      }}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-[#E2E8F0]/60 bg-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] dark:border-[#2A2B36] dark:bg-[#1C1D24] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-3 border-b border-[#E2E8F0]/60 px-5 py-4 dark:border-[#2A2B36]">
          <h2 className="truncate text-base font-extrabold text-[#1E293B] dark:text-white">
            {t("session.changePin")}
          </h2>
          <button
            type="button"
            onClick={closeIfIdle}
            disabled={busy}
            aria-label={t("common.close")}
            className="ml-auto rounded-lg p-2 text-[#64748B] transition-colors hover:bg-[#F4F5F9] disabled:opacity-40 dark:text-[#94A3B8] dark:hover:bg-[#252631]"
          >
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t("session.currentPin")}
            </span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={currentPin}
              onChange={(event) => setCurrentPin(digitsOnly(event.target.value))}
              placeholder="••••"
              disabled={busy}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t("session.newPin")}
            </span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={newPin}
              onChange={(event) => setNewPin(digitsOnly(event.target.value))}
              placeholder="••••"
              disabled={busy}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
              {t("session.confirmNewPin")}
            </span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={confirmPin}
              onChange={(event) => setConfirmPin(digitsOnly(event.target.value))}
              placeholder="••••"
              disabled={busy}
              className={inputClass}
            />
          </label>

          {error && (
            <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-center text-xs font-semibold text-[#DC2626]">
              {error}
            </div>
          )}
          {success && (
            <div role="status" className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3.5 py-2.5 text-center text-xs font-semibold text-[#15803D]">
              {success}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={closeIfIdle}
              disabled={busy}
              className="flex-1 rounded-xl border border-[#E2E8F0]/60 bg-white py-3 text-sm font-bold text-[#64748B] transition-all duration-150 ease-out active:shadow-inner disabled:opacity-40 dark:border-[#2A2B36] dark:bg-[#1C1D24] dark:text-[#94A3B8]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={busy || !/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin) || !/^\d{4}$/.test(confirmPin)}
              className="flex-1 rounded-xl bg-[#FFD600] py-3 text-sm font-black text-[#1E293B] shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:opacity-50 dark:bg-[#FF5E00] dark:text-white"
            >
              {busy ? t("common.saving") : t("session.updatePin")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
