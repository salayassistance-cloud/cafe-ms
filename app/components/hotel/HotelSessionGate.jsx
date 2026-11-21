"use client";

// Gate rendered by the /hotel server layout when no valid Hotel session exists.
//
// This component is the static fallback used only when the Hotel session
// cannot be verified at all (configuration/database unavailable). It provides
// NO login form, credential input, identity selector, or authentication
// request. The approved identity + PIN sign-in gate is HotelLoginGate, rendered
// by the /hotel server layout when no valid session exists.
//
// The layout still validates any pre-existing session server-side, so the
// operational pages remain protected by the retained request/page guards.

import { useHotelI18n } from "./HotelI18n";

export default function HotelSessionGate({ reason }) {
  const { t } = useHotelI18n();
  const message =
    reason === "unavailable" ? t("session.unavailable") : t("session.required");

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F4F5F9] px-4 text-[#1E293B] dark:bg-[#12131A] dark:text-white">
      <div className="w-full max-w-[460px] rounded-2xl border border-[#E2E8F0] bg-white p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] dark:border-[#2A2B36] dark:bg-[#1C1D24]">
        <h1 className="text-lg font-extrabold tracking-tight">
          {t("session.gateTitle")}
        </h1>
        <p role="status" className="mt-2 text-sm text-[#64748B] dark:text-[#94A3B8]">
          {message}
        </p>
      </div>
    </main>
  );
}
