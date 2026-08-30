"use client";

import { useState } from "react";
import { useLanguage } from "@/app/components/LanguageProvider";
import { fetchWithTimeout } from "@/lib/clientFetch";
import { setLocalStaff } from "@/lib/sessionClient";
import PinKeypad from "@/app/components/PinKeypad";

const ROLE_LABEL = {
  WAITER: "Waiter Portal",
  KITCHEN: "Kitchen Display",
  BARISTA: "Barista Display",
  MANAGER: "Manager Dashboard",
};

export default function PinGuard({ role, next }) {
  const { t } = useLanguage();

  const target =
    next ||
    (typeof window !== "undefined"
      ? window.location.pathname
      : role === "MANAGER"
      ? "/manager/reports"
      : `/${role.toLowerCase()}`);

  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitWaiterLogin(e) {
    if (e) e.preventDefault();
    if (busy) return;
    const u = username.trim();
    const p = String(pin).trim();
    if (!u) {
      setError("Username is required");
      return;
    }
    if (!/^\d{4}$/.test(p)) {
      setError("PIN must be exactly 4 digits");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await fetchWithTimeout(
        "/api/auth/login-staff",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: u, name: u, pin: p, role: "WAITER" }),
        },
        10000,
        "Request timed out"
      );
      if (data.success) {
        if (data.staff) {
          try {
            setLocalStaff(data.staff);
            window.localStorage.setItem("bono_staff_id", data.staff.id);
            window.localStorage.setItem("bono_staff_name", data.staff.name);
            window.localStorage.setItem("bono_role", "WAITER");
          } catch {}
        }
        // PERFORMANCE FIX: Removed redundant GET /api/auth/me before redirect.
        // The /api/auth/login-staff already sets the HttpOnly bono_sess cookie with
        // Set-Cookie; the destination layout (getPortalSession) verifies it server-side.
        // The extra me check added a sequential 200-500ms (+ up to 5s timeout) before
        // navigation and duplicated the layout's Staff.isActive check, contributing
        // to the 8s perceived login delay. Direct navigation is now immediate.
        window.location.assign(target);
      } else {
        const msg = data?.message || data?.error || "";
        if (/disabled|inactive/i.test(msg)) {
          setError("Your waiter account is inactive. Please contact the manager.");
        } else if (/Invalid|incorrect|not found/i.test(msg)) {
          setError("Invalid username or PIN.");
        } else {
          setError(msg || "Invalid username or PIN.");
        }
        setPin("");
      }
    } catch (err) {
      const m = err?.message || "";
      if (/timed out|timeout/i.test(m)) setError("Network error. Please try again.");
      else if (/Failed to fetch|NetworkError/i.test(m)) setError("Network error. Please try again.");
      else if (/disabled|inactive/i.test(m)) setError("Your waiter account is inactive. Please contact the manager.");
      else setError("Invalid username or PIN.");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  async function submitPin(entered) {
    setBusy(true);
    setError("");
    try {
      const data = await fetchWithTimeout(
        "/api/auth/verify-pin",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, pin: entered }),
        },
        10000,
        "Request timed out"
      );
      if (data.success) {
        if (data.staff) {
          try {
            setLocalStaff(data.staff);
            window.localStorage.setItem("bono_staff_id", data.staff.id);
            window.localStorage.setItem("bono_staff_name", data.staff.name);
            window.localStorage.setItem("bono_role", data.staff.role);
          } catch {}
        }
        window.location.assign(target);
      } else {
        setError(data?.message || data?.error || "Authentication failed");
        setPin("");
      }
    } catch (err) {
      setError(err?.message || "Authentication failed");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  // WAITER: Username + PIN — clean compact form, no on-screen keypad
  if (role === "WAITER") {
    const canSubmit = username.trim().length > 0 && /^\d{4}$/.test(pin) && !busy;
    return (
      <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#F4F5F9] dark:bg-[#12131A] px-4 py-6 text-[#1E293B] dark:text-white overflow-y-auto">
        <div className="w-full max-w-sm my-auto">
          <div className="mb-5 text-center">
            <h1 className="text-xl font-extrabold tracking-tight text-[#1E293B] dark:text-white sm:text-2xl">
              {ROLE_LABEL[role] || "Portal"}
            </h1>
          </div>
          <div className="rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-5 sm:p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)]">
            <form onSubmit={submitWaiterLogin} className="space-y-3.5" noValidate>
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">Username</span>
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. abebe"
                  disabled={busy}
                  className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3.5 text-sm font-semibold text-[#1E293B] dark:text-white placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">4-Digit PIN</span>
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
                  className="h-10 w-full rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A] px-3.5 text-sm font-semibold tracking-[0.35em] text-[#1E293B] dark:text-white placeholder:text-[#94A3B8] placeholder:tracking-[0.35em] focus:outline-none focus:ring-2 focus:ring-[#FFD600]/30 focus:border-[#FFD600]/40 dark:focus:ring-[#FF5E00]/30 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] disabled:opacity-60"
                />
              </label>
              {error && (
                <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-center text-xs font-semibold text-[#DC2626]">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex h-12 w-full items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-sm transition-all duration-150 ease-out active:shadow-inner disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Signing in..." : "Sign In"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // KITCHEN / BARISTA / MANAGER: PIN only (legacy shared PIN, Staff-based)
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#F4F5F9] dark:bg-[#12131A] px-4 py-6 text-[#1E293B] dark:text-white">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-extrabold tracking-tight text-[#1E293B] dark:text-white sm:text-2xl">
            {ROLE_LABEL[role] || "Portal"}
          </h1>
        </div>
        <div className="rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)]">
          <p className="mb-4 text-center text-sm font-semibold text-[#64748B] dark:text-[#94A3B8]">
            {t("enterPin") || "Enter your 4-digit PIN"}
          </p>
          <PinKeypad value={pin} onChange={setPin} onSubmit={submitPin} disabled={busy} submitLabel={busy ? t("verifying") : t("signInBtn")} />
          {error && (
            <div role="alert" className="mt-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-center text-xs font-semibold text-[#DC2626]">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
