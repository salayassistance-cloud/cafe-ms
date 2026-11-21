"use client";

// Hotel sign-in gate, presented as a POS-style modal.
//
// Visual/interaction reference: the BONO POS portal login modal (fixed overlay,
// dimmed + blurred portal context behind a compact rounded card, four dots and
// the 1-9 / Clear / 0 / backspace keypad). The Hotel implementation is its own
// component and imports no POS authentication, session or API code.
//
// The underlying page cannot be the real operational screen while signed out:
// the Hotel page guards intentionally redirect unauthenticated visitors. The
// backdrop therefore renders a non-sensitive, blurred Hotel portal shell (the
// same top-bar and card silhouette) so entry feels like a modal over the portal
// rather than a disconnected standalone page.
//
// Portal-aware: /hotel/reception offers only RECEPTIONIST identities and
// /hotel/rooms only MANAGER identities. Authentication is unchanged: the
// server verifies the selected individual HotelUser identity and its own PIN.

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  IconChartBar,
  IconDashboardFilled,
  IconDoor,
  IconRefresh,
  IconUsers,
} from "@tabler/icons-react";

import { useHotelI18n } from "./HotelI18n";
import HotelPinKeypad from "./HotelPinKeypad";
import {
  canSubmitPin,
  filterIdentitiesForRole,
  isCompletePin,
  sanitizePinDigits,
} from "@/lib/hotel/ui/pinEntry";
import {
  hotelHomeForRole,
  isAuthorizedDestinationForRole,
  resolveHotelPortal,
} from "@/lib/hotel/ui/portals";

const TIMEOUT_MS = 15_000;

// Portal copy is resolved from the requested route by a pure, testable module.
// Manager portals (Rooms, Management, Reports) stay Manager portals; Reception
// stays Reception. The icon mapping is the only view-specific detail here.
const ICON_BY_KEY = Object.freeze({
  door: IconDoor,
  dashboard: IconDashboardFilled,
  users: IconUsers,
  chart: IconChartBar,
});

const EMPTY_DIRECTORY = Object.freeze({
  portalKey: null,
  loading: true,
  failed: false,
  identities: [],
});

// Blurred, non-interactive Hotel portal silhouette behind the modal. It shows
// the same top-bar/card composition as the operational pages without rendering
// any protected data or interactive control.
function HotelPortalBackdrop({ portal, title }) {
  const PortalIcon = ICON_BY_KEY[portal.icon] || IconDashboardFilled;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 select-none overflow-hidden"
    >
      <div className="mx-auto w-full max-w-7xl px-4 pt-4 opacity-80 blur-[2px] sm:px-6 sm:pt-6">
        <div className="rounded-2xl border border-[#E2E8F0]/70 bg-white px-4 py-3 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] dark:border-[#2A2B36] dark:bg-[#1C1D24] sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#E2E8F0]/60 bg-[#F4F5F9] text-[var(--c-accent)] dark:border-[#2A2B36] dark:bg-[#12131A]">
                <PortalIcon size={20} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-xl font-black tracking-tight text-[#1E293B] dark:text-white">
                  {title}
                </p>
                <div className="mt-1 h-2.5 w-24 rounded bg-[#E2E8F0] dark:bg-[#2A2B36]" />
              </div>
            </div>
            <div className="flex gap-2">
              <span className="h-9 w-20 rounded-full bg-[#E2E8F0]/80 dark:bg-[#2A2B36]/80" />
              <span className="h-9 w-9 rounded-full bg-[#E2E8F0]/80 dark:bg-[#2A2B36]/80" />
              <span className="h-9 w-9 rounded-full bg-[#E2E8F0]/80 dark:bg-[#2A2B36]/80" />
            </div>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <div
              key={key}
              className="h-28 rounded-2xl border border-[#E2E8F0]/70 bg-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] dark:border-[#2A2B36] dark:bg-[#1C1D24]"
            />
          ))}
        </div>
      </div>
      <div className="absolute inset-0 bg-[#1E293B]/30 dark:bg-[#12131A]/70" />
    </div>
  );
}

export default function HotelLoginGate() {
  const router = useRouter();
  const pathname = usePathname();
  const portal = resolveHotelPortal(pathname);
  const { t } = useHotelI18n();

  const [directory, setDirectory] = useState(EMPTY_DIRECTORY);
  const [directoryAttempt, setDirectoryAttempt] = useState(0);
  const [identityId, setIdentityId] = useState("");
  // Entry state is tagged with the portal key that produced it. When the
  // visitor moves between portals the stale PIN/error/busy values are ignored
  // by derivation, so no state-resetting effect is needed.
  const [entry, setEntry] = useState({
    portalKey: portal.key,
    pin: "",
    error: "",
    busy: false,
  });

  const pin = entry.portalKey === portal.key ? entry.pin : "";
  const error = entry.portalKey === portal.key ? entry.error : "";
  const busy = entry.portalKey === portal.key ? entry.busy : false;

  function updateEntry(patch) {
    setEntry((previous) => {
      const base =
        previous.portalKey === portal.key
          ? previous
          : { portalKey: portal.key, pin: "", error: "", busy: false };
      return { ...base, ...patch };
    });
  }

  // The directory is a small public list of safe display identities. It is
  // fetched in the background while the card and keypad are already rendered,
  // so entry never waits behind a loading screen. A failure is retryable and
  // is never allowed to leave a silent, permanently disabled keypad.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    (async () => {
      try {
        const response = await fetch("/api/hotel/auth/identities", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) throw new Error("directory");
        if (cancelled) return;
        const list = filterIdentitiesForRole(
          data?.data?.identities,
          portal.role
        );
        setDirectory({
          portalKey: portal.key,
          loading: false,
          failed: false,
          identities: list,
        });
      } catch {
        if (cancelled) return;
        setDirectory({
          portalKey: portal.key,
          loading: false,
          failed: true,
          identities: [],
        });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [portal.key, portal.role, directoryAttempt]);

  const currentDirectory =
    directory.portalKey === portal.key
      ? directory
      : { portalKey: portal.key, loading: true, failed: false, identities: [] };
  const identities = currentDirectory.identities;
  const directoryLoading = currentDirectory.loading;
  const directoryFailed = currentDirectory.failed;

  const selectedIdentity =
    identities.find((item) => item.id === identityId) || identities[0] || null;
  const effectiveIdentityId = selectedIdentity?.id || "";
  const hasIdentity = Boolean(effectiveIdentityId);
  const ready = canSubmitPin({
    pin,
    identityId: effectiveIdentityId,
    busy,
  });
  const noIdentities =
    !directoryLoading && !directoryFailed && identities.length === 0;
  // Typing is allowed while the directory is still loading; it is disabled only
  // when a request is in flight or when there is genuinely no identity to use.
  const keypadDisabled = busy || (!directoryLoading && !hasIdentity);

  function retryDirectory() {
    setDirectory({
      portalKey: portal.key,
      loading: true,
      failed: false,
      identities: [],
    });
    setDirectoryAttempt((attempt) => attempt + 1);
  }

  function selectIdentity(nextId) {
    if (busy || nextId === effectiveIdentityId) return;
    setIdentityId(nextId);
    updateEntry({ pin: "", error: "" });
  }

  async function submitPin(entered) {
    if (busy) return;
    if (!hasIdentity) {
      updateEntry({ error: t("login.identityRequired") });
      return;
    }
    const value = sanitizePinDigits(entered);
    if (!isCompletePin(value)) {
      updateEntry({ error: t("session.pin4digits") });
      return;
    }

    updateEntry({ busy: true, error: "" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch("/api/hotel/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ identityId: effectiveIdentityId, pin: value }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.success) {
        // The server returns the authoritative role. Preserve the route the
        // visitor originally requested — this gate was resolved from that
        // route — so a direct open of Management/Reports returns there after
        // sign-in instead of silently landing on Rooms. Fall back to the role's
        // canonical home only when the requested route is not permitted for
        // the authenticated role. Server page guards remain the final authority.
        const role = data?.data?.role;
        const destination = isAuthorizedDestinationForRole(
          role,
          portal.destination
        )
          ? portal.destination
          : hotelHomeForRole(role);
        if (
          typeof window !== "undefined" &&
          window.location.pathname === destination
        ) {
          router.refresh();
        } else {
          router.push(destination);
        }
        return;
      }
      updateEntry({
        error:
          data?.error?.message ||
          data?.message ||
          t("session.invalidCredentials"),
        pin: "",
      });
    } catch {
      updateEntry({ error: t("session.networkError"), pin: "" });
    } finally {
      clearTimeout(timeout);
      updateEntry({ busy: false });
    }
  }

  const PortalIcon = ICON_BY_KEY[portal.icon] || IconDashboardFilled;
  const title = t(portal.titleKey);

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto">
      <HotelPortalBackdrop portal={portal} title={title} />

      <div className="relative z-10 flex min-h-full items-center justify-center px-4 py-6">
        <div className="animate-fade-up w-full max-w-[360px] overflow-hidden rounded-2xl border border-[#E2E8F0]/60 bg-white p-6 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] dark:border-[#2A2B36] dark:bg-[#1C1D24]">
          <div className="mb-5 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E2E8F0]/60 bg-[#F4F5F9] text-[var(--c-accent)] shadow-sm dark:border-[#2A2B36] dark:bg-[#12131A]">
              <PortalIcon size={28} className="h-7 w-7" aria-hidden="true" />
            </div>
            <h1 className="text-xl font-extrabold tracking-tight text-[#1E293B] dark:text-white">
              {title}
            </h1>
            <p className="mt-1 text-sm font-semibold text-[#64748B] dark:text-[#94A3B8]">
              {t("login.enterPinFour")}
            </p>
            {directoryLoading ? (
              <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8] dark:text-[#64748B]">
                {t("staff.mgmt.identityLoading")}
              </p>
            ) : selectedIdentity ? (
              <p className="mt-1 text-xs font-bold text-[#1E293B] dark:text-white">
                {selectedIdentity.name}
              </p>
            ) : null}
          </div>

          {identities.length > 1 ? (
            <div
              className="mb-5 flex flex-wrap justify-center gap-2"
              role="group"
              aria-label={t("login.identityListLabel")}
            >
              {identities.map((identity) => (
                <button
                  key={identity.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={identity.id === effectiveIdentityId}
                  onClick={() => selectIdentity(identity.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold transition-all duration-150 ease-out disabled:opacity-40 ${
                    identity.id === effectiveIdentityId
                      ? "border-[#FFD600] bg-[#FFD600] text-[#1E293B] dark:border-[#FF5E00] dark:bg-[#FF5E00] dark:text-white"
                      : "border-[#E2E8F0]/60 bg-white text-[#64748B] hover:bg-[#F4F5F9] dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-[#94A3B8]"
                  }`}
                >
                  {identity.name}
                </button>
              ))}
            </div>
          ) : null}

          {noIdentities ? (
            <div
              role="status"
              className="mb-4 rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-3.5 py-2.5 text-center text-xs font-semibold text-[#92400E] dark:border-[#78350F] dark:bg-[#2A1E0A] dark:text-[#FCD34D]"
            >
              {portal.role === "RECEPTIONIST"
                ? t("login.noReceptionist")
                : t("login.noManager")}
            </div>
          ) : null}

          {directoryFailed ? (
            <div className="mb-4 space-y-2">
              <div
                role="alert"
                className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-center text-xs font-semibold text-[#DC2626]"
              >
                {t("login.errDirectory")}
              </div>
              <button
                type="button"
                onClick={retryDirectory}
                disabled={directoryLoading}
                className="mx-auto flex h-9 items-center justify-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-4 text-xs font-bold text-[#1E293B] hover:bg-[#F8FAFC] disabled:opacity-50 dark:border-[#2A2B36] dark:bg-[#12131A] dark:text-white dark:hover:bg-[#252631]"
              >
                <IconRefresh size={14} aria-hidden="true" />
                {t("login.retryDirectory")}
              </button>
            </div>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitPin(pin);
            }}
            noValidate
          >
            <HotelPinKeypad
              value={pin}
              onChange={(value) => updateEntry({ pin: value })}
              onSubmit={submitPin}
              disabled={keypadDisabled}
              hideSubmit
            />
            {error ? (
              <div
                role="alert"
                className="mt-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-center text-xs font-semibold text-[#DC2626]"
              >
                {error}
              </div>
            ) : null}
            <button
              type="submit"
              disabled={!ready}
              className="mx-auto mt-4 flex h-12 w-full max-w-[260px] items-center justify-center rounded-xl bg-[#FFD600] text-sm font-black uppercase tracking-wide text-[#1E293B] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] transition-all duration-150 ease-out active:shadow-inner disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FF5E00] dark:text-white dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
            >
              {busy ? t("session.verifying") : t("session.verify")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
