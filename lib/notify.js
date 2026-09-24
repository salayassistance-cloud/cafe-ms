"use client";

// Shared foreground notification primitives (single implementation for
// Waiter/KDS/Barista). Sound uses WebAudio oscillation — no audio asset to
// fetch/decode, works offline. Browser notifications use the Web Notifications
// API only when permission was granted via an explicit user gesture elsewhere;
// this module never requests permission by itself and never retries failures
// (no console noise on polls).
//
// Platform limits (reported, not hidden):
// - Tab open: in-app sound works (after one user gesture unlocks audio).
// - Tab hidden: system notification works only if permission exists.
// - App fully closed: NOT supported — public/sw.js intentionally unregisters
//   service workers (no stale offline POS state), so there is no push infra.

let ctx = null;

export function playChime() {
  const Ctx =
    typeof window !== "undefined"
      ? window.AudioContext || window.webkitAudioContext
      : null;
  if (!Ctx) return false;
  try {
    if (!ctx) ctx = new Ctx();
  } catch {
    return false;
  }
  try {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    [880, 1320, 1760].forEach((freq, i) => {
      const start = t0 + i * 0.14;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.45);
    });
    return true;
  } catch {
    return false;
  }
}

// Fire-and-forget system notification for background/hidden tabs only.
// Foreground tabs already surface the event in-app; permission-gated.
export function notifyBrowser({ title, body, tag } = {}) {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    if (Notification.permission !== "granted") return false;
    if (typeof document !== "undefined" && !document.hidden) return false;
    void new Notification(title || "BONO", { body: body || "", tag });
    return true;
  } catch {
    return false;
  }
}

// Must only be called from a user gesture (button click). Never auto-requests.
export async function ensureBrowserNotifyPermission() {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    if (Notification.permission === "granted" || Notification.permission === "denied") {
      return Notification.permission;
    }
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}
