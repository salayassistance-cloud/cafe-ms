"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "@/lib/clientFetch";
import { setLocalStaff } from "@/lib/sessionClient";
import PinKeypad from "@/app/components/PinKeypad";
import { useLanguage } from "./LanguageProvider";
import {
  IconReceiptFilled,
  IconChefHatFilled,
  IconMugFilled,
  IconDashboardFilled,
  IconBookFilled,
} from "@tabler/icons-react";

export default function PinLoginModal({ open, portal, onClose }) {
  const router = useRouter();
  const { t } = useLanguage();

  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open || !portal) return null;

  async function submitPin(e) {
    if (e) e.preventDefault();
    if (busy) return;
    const p = String(pin).trim();
    setError("");
    let endpoint, payload;
    if (portal.role === "WAITER") {
      const u = username.trim();
        if (!u) {
          setError(t('usernameRequired'));
          return;
        }
        if (!/^\d{4}$/.test(p)) {
          setError(t('pin4digits'));
          return;
        }
        endpoint = "/api/auth/login-staff";
        payload = { username: u, name: u, pin: p, role: "WAITER" };
      } else {
        if (!/^\d{4}$/.test(p)) {
          setError(t('pin4digits'));
          return;
        }
      endpoint = "/api/auth/verify-pin";
      payload = { role: portal.role, pin: p };
    }
    setBusy(true);
    try {
      const data = await fetchWithTimeout(
        endpoint,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        10000, "Request timed out"
      );

      if (data.success) {
        if (data.staff) {
          try {
            setLocalStaff(data.staff);
            window.localStorage.setItem("bono_staff_id", data.staff.id);
            window.localStorage.setItem("bono_staff_name", data.staff.name);
            window.localStorage.setItem("bono_role", data.staff.role || portal.role);
          } catch {}
        }
        // PERFORMANCE FIX: Removed redundant GET /api/auth/me before router.push.
        // The auth endpoint already set the HttpOnly bono_sess cookie with Set-Cookie;
        // the destination layout (getPortalSession) verifies it server-side. The extra
        // me check added sequential latency (up to 5s) and duplicated the layout's
        // Staff.isActive DB lookup, contributing to the 8s delay.
        router.push(portal.route);
      } else {
        const msg = data?.message || data?.error || "";
        if (/disabled|inactive/i.test(msg)) setError(t('waiterInactive'));
        else if (/Invalid|incorrect|not found/i.test(msg)) setError(t('invalidPin'));
        else setError(msg || t('invalidPin'));
        setPin("");
      }
    } catch (err) {
      const m = err?.message || "";
      if (/timed out|timeout/i.test(m)) setError(t('networkError'));
      else if (/disabled|inactive/i.test(m)) setError(t('waiterInactive'));
      else setError(t('invalidPin'));
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  const title = portal?.titleKey ? t(portal.titleKey) : portal?.title;

  // Portal icon — Tabler filled, single family, consistent with homepage
  const portalIconNode = (() => {
    const props = { size: 28, "aria-hidden": true };
    const map = {
      WAITER: <IconReceiptFilled {...props} className="h-7 w-7" />,
      KITCHEN: <IconChefHatFilled {...props} className="h-7 w-7" />,
      BARISTA: <IconMugFilled {...props} className="h-7 w-7" />,
      MANAGER: <IconDashboardFilled {...props} className="h-7 w-7" />,
      MENU: <IconBookFilled {...props} className="h-7 w-7" />,
    };
    if (portal.icon) {
      if (typeof portal.icon === "string") return map[portal.role] || portal.icon;
      return portal.icon;
    }
    return map[portal.role] || null;
  })();

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1E293B]/30 dark:bg-[#12131A]/70 px-4 py-6 backdrop-blur-md">
      <div className="relative w-full max-w-[360px] rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)]">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-lg font-bold text-[#64748B] dark:text-[#94A3B8] hover:bg-[#F4F5F9] dark:hover:bg-[#252631]"
        >
          ✕
        </button>

        <div className="mb-5 pr-8 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] text-[var(--c-accent)] shadow-sm">
            {portalIconNode}
          </div>
          <h2 className="text-lg font-extrabold tracking-tight text-[#1E293B] dark:text-white">
            {title}
          </h2>
          {portal.role !== "WAITER" && (
            <p className="mt-1 text-sm text-[#64748B] dark:text-[#94A3B8]">{t('enterPin')}</p>
          )}
        </div>

        {portal.role === "WAITER" ? (
          <form onSubmit={submitPin} className="space-y-3.5" noValidate>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">{t('username')}</span>
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. abebe"
                disabled={busy}
                className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3.5 text-sm font-semibold text-[#1E293B] dark:text-white placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">{t('pin')}</span>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="current-password"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="••••"
                disabled={busy}
                className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3.5 text-sm font-semibold tracking-[0.35em] text-[#1E293B] dark:text-white placeholder:text-[#94A3B8] placeholder:tracking-[0.35em] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 focus:border-[#FFD600]/40 dark:focus:ring-[#FF5E00]/30 disabled:opacity-60"
              />
            </label>
            {error && (
              <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-center text-xs font-semibold text-[#DC2626]">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={busy || !username.trim() || !/^\d{4}$/.test(pin)}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? t('verifying') : t('signInBtn')}
            </button>
          </form>
        ) : (
          <form onSubmit={submitPin} className="space-y-4" noValidate>
            <PinKeypad value={pin} onChange={setPin} onSubmit={() => { if (!busy && /^\d{4}$/.test(pin)) submitPin(); }} disabled={busy} hideSubmit />
            {error && (
              <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-center text-xs font-semibold text-[#DC2626]">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={busy || !/^\d{4}$/.test(pin)}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? t('verifying') : t('verify')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
