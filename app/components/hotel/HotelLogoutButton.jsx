"use client";

// Hotel logout control.
//
// The Hotel module previously had no logout action: the logout Route Handler
// existed but nothing invoked it, so the Hotel-only HttpOnly session cookie
// survived a "logout" elsewhere and the page guards bounced the still-valid
// Receptionist session to Reception on every Manager route.
//
// This button performs the complete lifecycle:
//   1. POST /api/hotel/auth/logout with the session-bound CSRF header (added by
//      useHotelRequest) so the server revokes the session row and expires the
//      cookie. It never clears client state on its own.
//   2. Only after a successful response, ask the server layout to re-validate
//      via router.refresh(). The layout then renders the correct sign-in gate
//      for the current route with no stale authenticated state.
//   3. On failure, report it and do NOT claim the session ended.
//
// No localStorage/sessionStorage is used and no authorization decision is made
// in the browser.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconLogout } from "@tabler/icons-react";

import { useHotelI18n } from "./HotelI18n";
import { useHotelRequest } from "./useHotelRequest";
import { BTN_SECONDARY } from "./ui";

export default function HotelLogoutButton() {
  const router = useRouter();
  const { t } = useHotelI18n();
  const request = useHotelRequest();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request("/api/hotel/auth/logout", { method: "POST" });
      // The cookie is now gone: force the server layout to re-read it. This
      // replaces the provider with the gate for the requested portal/page.
      router.refresh();
    } catch {
      // Revocation or verification failed. Never suggest success and never
      // clear client state here — the server remains the authority.
      setError(t("session.logoutError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={logout}
        disabled={busy}
        aria-busy={busy}
        className={BTN_SECONDARY}
      >
        <IconLogout className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? t("session.loggingOut") : t("session.logout")}
      </button>
      {error ? (
        <span role="alert" className="text-[11px] font-bold text-[#DC2626]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
