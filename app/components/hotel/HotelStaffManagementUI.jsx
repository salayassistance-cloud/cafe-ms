"use client";

// Bono Hotel — Manager-controlled Receptionist staff management (Phase 3D).
// Uses the Hotel Phase 3B design language (shared top bar, cards, accent
// colors, banners, status badges, responsive layout) and the Hotel-only API.
// Only Receptionist identities can be managed here; Managers are provisioned
// exclusively by the operator CLI. Sensitive actions require confirmation and
// all mutations go through the session's CSRF token via useHotelRequest.

import { useCallback, useEffect, useState } from "react";
import { IconUserPlus, IconUsers } from "@tabler/icons-react";
import Link from "next/link";

import HotelTopBar from "./HotelTopBar";
import { useHotelI18n } from "./HotelI18n";
import { useHotelRequest } from "./useHotelRequest";
import {
  Banner,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Card,
  INPUT,
  LABEL,
  Spinner,
  StatusBadge,
} from "./ui";

const digitsOnly = (value) => String(value).replace(/\D/g, "").slice(0, 4);
const PIN_CLASS = `${INPUT} text-center text-lg font-bold tracking-[0.5em]`;

export default function HotelStaffManagementUI() {
  const { lang, t } = useHotelI18n();
  const request = useHotelRequest();

  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");

  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newConfirm, setNewConfirm] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [resetId, setResetId] = useState(null);
  const [resetPin, setResetPin] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await request("/api/hotel/staff");
      setStaff(Array.isArray(data?.staff) ? data.staff : []);
    } catch (error) {
      setLoadError(error?.message || t("staff.loadError"));
    } finally {
      setLoading(false);
    }
  }, [request, t]);

  useEffect(() => {
    // Defer the initial fetch outside the effect body so the synchronous
    // setState path in load() cannot cascade renders.
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  function reportError(error, fallback) {
    setNotice({ tone: "error", message: error?.message || fallback });
  }

  async function createStaff(event) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{4}$/.test(newPin) || newPin !== newConfirm) {
      reportError(null, t("staff.mgmt.pinMismatch"));
      return;
    }
    setBusy("create");
    setNotice(null);
    try {
      await request("/api/hotel/staff", {
        method: "POST",
        body: { name: newName, pin: newPin, confirmPin: newConfirm },
      });
      setNewName("");
      setNewPin("");
      setNewConfirm("");
      setNotice({ tone: "success", message: t("staff.mgmt.created") });
      await load();
    } catch (error) {
      reportError(error, t("staff.actionError"));
    } finally {
      setBusy("");
    }
  }

  async function saveName(event) {
    event.preventDefault();
    if (busy || !editingId) return;
    setBusy("rename");
    setNotice(null);
    try {
      await request(`/api/hotel/staff/${editingId}`, {
        method: "PATCH",
        body: { name: editName },
      });
      setEditingId(null);
      setEditName("");
      setNotice({ tone: "success", message: t("staff.mgmt.updated") });
      await load();
    } catch (error) {
      reportError(error, t("staff.actionError"));
    } finally {
      setBusy("");
    }
  }

  async function submitPinReset(event) {
    event.preventDefault();
    if (busy || !resetId) return;
    if (!/^\d{4}$/.test(resetPin) || resetPin !== resetConfirm) {
      reportError(null, t("staff.mgmt.pinMismatch"));
      return;
    }
    setBusy("pin");
    setNotice(null);
    try {
      await request(`/api/hotel/staff/${resetId}/pin`, {
        method: "POST",
        body: { pin: resetPin, confirmPin: resetConfirm },
      });
      setResetId(null);
      setResetPin("");
      setResetConfirm("");
      setNotice({ tone: "success", message: t("staff.mgmt.pinReset") });
      await load();
    } catch (error) {
      reportError(error, t("staff.actionError"));
    } finally {
      setBusy("");
    }
  }

  async function setActive(member, isActive) {
    if (busy) return;
    const key = isActive ? "activate" : "deactivate";
    const confirmKey = isActive ? "staff.mgmt.confirmActivate" : "staff.mgmt.confirmDeactivate";
    if (!window.confirm(t(confirmKey, { name: member.name }))) return;
    setBusy(`${key}:${member.id}`);
    setNotice(null);
    try {
      await request(`/api/hotel/staff/${member.id}/status`, {
        method: "POST",
        body: { isActive },
      });
      setNotice({
        tone: "success",
        message: t(isActive ? "staff.mgmt.activated" : "staff.mgmt.deactivated"),
      });
      await load();
    } catch (error) {
      reportError(error, t("staff.actionError"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div lang={lang} className="min-h-screen bg-[#F4F5F9] text-[#1E293B] dark:bg-[#12131A] dark:text-white">
      <HotelTopBar
        titleKey="staff.title"
        skipHref="#staff-main"
        skipLabelKey="staff.mgmt.skip"
        actions={
          <>
            <Link href="/hotel/rooms" className={BTN_SECONDARY}>
              {t("top.roomManagement")}
            </Link>
            <Link href="/hotel/reports" className={BTN_SECONDARY}>
              {t("reports.title")}
            </Link>
          </>
        }
      />

      <div className="mx-auto w-full max-w-7xl px-4 pb-4 sm:px-6 sm:pb-6">
        <main id="staff-main" tabIndex={-1} className="mt-4 outline-none">
          {notice ? (
            <Banner tone={notice.tone} className="mb-4" onDismiss={() => setNotice(null)}>
              {notice.message}
            </Banner>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-4 lg:col-span-2">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-extrabold">{t("staff.mgmt.listTitle")}</h2>
                  <p className="mt-0.5 text-xs font-medium text-[#64748B] dark:text-[#94A3B8]">
                    {t("staff.mgmt.listHint")}
                  </p>
                </div>
                <button type="button" onClick={load} disabled={loading || !!busy} className={BTN_SECONDARY}>
                  {t("common.refresh")}
                </button>
              </div>

              {loadError ? (
                <Banner tone="error" className="mb-3">{loadError}</Banner>
              ) : null}

              {loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm font-semibold text-[#64748B] dark:text-[#94A3B8]">
                  <Spinner /> {t("common.loading")}
                </div>
              ) : staff.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <IconUsers className="h-10 w-10 text-[#94A3B8]" aria-hidden="true" />
                  <p className="text-sm font-bold">{t("staff.mgmt.empty")}</p>
                  <p className="max-w-sm text-xs text-[#64748B] dark:text-[#94A3B8]">
                    {t("staff.mgmt.emptyHint")}
                  </p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {staff.map((member) => (
                    <li key={member.id} className="rounded-2xl border border-[#E2E8F0]/70 p-4 dark:border-[#2A2B36]">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          {editingId === member.id ? (
                            <form onSubmit={saveName} className="flex flex-wrap items-center gap-2">
                              <input
                                className={INPUT}
                                value={editName}
                                onChange={(event) => setEditName(event.target.value)}
                                aria-label={t("staff.mgmt.nameLabel")}
                                autoFocus
                              />
                              <button type="submit" className={BTN_PRIMARY} disabled={!!busy}>
                                {t("common.saveChanges")}
                              </button>
                              <button
                                type="button"
                                className={BTN_SECONDARY}
                                onClick={() => { setEditingId(null); setEditName(""); }}
                              >
                                {t("common.cancel")}
                              </button>
                            </form>
                          ) : (
                            <p className="truncate text-sm font-extrabold">{member.name}</p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <StatusBadge status={member.isActive ? "ACTIVE" : "INACTIVE"} />
                            <span className="text-[11px] font-semibold text-[#64748B] dark:text-[#94A3B8]">
                              {member.pinSetAt
                                ? t("staff.mgmt.pinConfigured")
                                : t("staff.pinMissing")}
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            disabled={!!busy}
                            onClick={() => { setEditingId(member.id); setEditName(member.name); }}
                          >
                            {t("staff.mgmt.edit")}
                          </button>
                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            disabled={!!busy}
                            onClick={() => {
                              setResetId(member.id);
                              setResetPin("");
                              setResetConfirm("");
                            }}
                          >
                            {t("staff.resetPin")}
                          </button>
                          <button
                            type="button"
                            className={member.isActive ? BTN_DANGER : BTN_PRIMARY}
                            disabled={!!busy}
                            onClick={() => setActive(member, !member.isActive)}
                          >
                            {t(member.isActive ? "staff.deactivate" : "staff.activate")}
                          </button>
                        </div>
                      </div>

                      {resetId === member.id ? (
                        <form onSubmit={submitPinReset} className="mt-4 grid gap-2 border-t border-[#E2E8F0]/70 pt-4 dark:border-[#2A2B36] sm:grid-cols-2">
                          <label className="block">
                            <span className={LABEL}>{t("staff.newPin")}</span>
                            <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} className={PIN_CLASS} value={resetPin} onChange={(event) => setResetPin(digitsOnly(event.target.value))} />
                          </label>
                          <label className="block">
                            <span className={LABEL}>{t("staff.mgmt.confirmPinLabel")}</span>
                            <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} className={PIN_CLASS} value={resetConfirm} onChange={(event) => setResetConfirm(digitsOnly(event.target.value))} />
                          </label>
                          <div className="flex gap-2 sm:col-span-2">
                            <button type="submit" className={BTN_PRIMARY} disabled={!!busy}>
                              {busy === "pin" ? <Spinner /> : null} {t("staff.mgmt.confirmReset")}
                            </button>
                            <button type="button" className={BTN_SECONDARY} onClick={() => { setResetId(null); setResetPin(""); setResetConfirm(""); }}>
                              {t("common.cancel")}
                            </button>
                          </div>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-4">
              <div className="mb-4 flex items-center gap-2">
                <IconUserPlus className="h-5 w-5 text-[var(--c-accent)]" aria-hidden="true" />
                <h2 className="text-base font-extrabold">{t("staff.createTitle")}</h2>
              </div>
              <form onSubmit={createStaff} className="space-y-3">
                <label className="block">
                  <span className={LABEL}>{t("staff.mgmt.nameLabel")}</span>
                  <input className={INPUT} value={newName} onChange={(event) => setNewName(event.target.value)} autoComplete="off" />
                </label>
                <label className="block">
                  <span className={LABEL}>{t("staff.mgmt.pinLabel")}</span>
                  <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} className={PIN_CLASS} value={newPin} onChange={(event) => setNewPin(digitsOnly(event.target.value))} />
                </label>
                <label className="block">
                  <span className={LABEL}>{t("staff.mgmt.confirmPinLabel")}</span>
                  <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} className={PIN_CLASS} value={newConfirm} onChange={(event) => setNewConfirm(digitsOnly(event.target.value))} />
                </label>
                <button type="submit" className={`${BTN_PRIMARY} w-full`} disabled={!!busy}>
                  {busy === "create" ? <Spinner /> : null} {t("staff.mgmt.createButton")}
                </button>
              </form>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
