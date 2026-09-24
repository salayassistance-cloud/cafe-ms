// Client-side safe fetch helpers for the Hotel Management System POS terminals.
//
// Every helper checks `response.ok` BEFORE attempting to parse JSON so an
// empty error body (405/404/500) can never produce an
// "Unexpected end of JSON input" crash. API routes that return 204/empty
// bodies degrade to `null` instead of throwing.

// AUTH-ARCH-11: tab-scoped operational authentication transport.
//
// Each browser tab runs its own JS context, so module-level memory is
// naturally tab-scoped: Tab A's credential is unreachable from Tab B.
// The raw tab credential lives ONLY in this module variable — never in
// localStorage, sessionStorage, IndexedDB, URLs, DOM attributes, or logs.
// Every protected helper below attaches it as X-Bono-Tab-Session; the
// server resolves it to Session -> live Staff -> authorization. When absent
// (fresh reload, legacy flow), requests fall back to cookie auth unchanged.
//
// Single source of truth: components must NEVER store, copy, or forward
// the credential themselves — use setTabCredential/tabLogout/appendTabCredential.
export const TAB_SESSION_HEADER = "X-Bono-Tab-Session";

let tabCredential = null;
let heartbeatTimer = null;

export function setTabCredential(raw) {
  tabCredential = typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function getTabCredential() {
  return tabCredential;
}

export function clearTabCredential() {
  tabCredential = null;
}

function withTabHeaders(headers) {
  const merged = { ...(headers || {}) };
  if (tabCredential) {
    let present = false;
    for (const key of Object.keys(merged)) {
      if (String(key).toLowerCase() === TAB_SESSION_HEADER.toLowerCase()) { present = true; break; }
    }
    if (!present) merged[TAB_SESSION_HEADER] = tabCredential;
  }
  return merged;
}

// Attach the tab credential to a FormData payload for Server Actions
// (which receive no Request headers). Extra field is ignored by actions
// that do not read it. No-op when the tab holds no credential.
export function appendTabCredential(formData) {
  try {
    if (tabCredential && formData && typeof formData.set === "function") {
      formData.set("tabSession", tabCredential);
    }
  } catch {}
  return formData;
}

// Tab heartbeat: keeps an ACTIVE open tab alive without user-facing timeouts
// (server slides expiry per heartbeat; abandoned tabs expire and TTL cleans
// them). One timer per tab (module singleton per JS context). On 401 the
// heartbeat stops silently — the portal's own polling/me surfaces the
// session-ended UX. Never logs the credential.
export function startTabHeartbeat({ intervalMs = 5 * 60 * 1000 } = {}) {
  stopTabHeartbeat();
  if (!tabCredential) return false;
  const beat = async () => {
    if (!tabCredential) { stopTabHeartbeat(); return; }
    try {
      await safeFetchJson("/api/auth/tab/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    } catch (err) {
      if (err && (err.status === 401 || getSessionErrorKind(err))) stopTabHeartbeat();
    }
  };
  heartbeatTimer = setInterval(beat, intervalMs);
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") {
    try { heartbeatTimer.unref(); } catch {}
  }
  return true;
}

export function stopTabHeartbeat() {
  if (heartbeatTimer) {
    try { clearInterval(heartbeatTimer); } catch {}
    heartbeatTimer = null;
  }
}

// Post-login navigation: complete the portal switch without a manual refresh.
//
// When the destination equals the current pathname (PinGuard rendered by the
// destination layout itself, e.g. opening /cashier directly), router.push()
// to the identical URL does not reliably re-run the server layout, so the
// freshly-set session cookie is never evaluated and the login screen stays
// mounted until a manual refresh. router.refresh() re-requests the current
// route's server tree — layouts re-authenticate against the new cookie —
// while preserving client state. Cross-route navigation keeps router.push().
// Single implementation for PinGuard + PinLoginModal; returns the branch
// taken ("refresh" | "push" | "assign") for DB-free tests. No credentials,
// storage, or timers involved.
export function navigateAfterAuth(router, target) {
  try {
    const current = typeof window !== "undefined" ? window.location.pathname : null;
    if (current && target && current === target && router && typeof router.refresh === "function") {
      router.refresh();
      return "refresh";
    }
    if (router && typeof router.push === "function") {
      router.push(target);
      return "push";
    }
  } catch {}
  try {
    window.location.assign(target);
  } catch {}
  return "assign";
}

// Tab-scoped logout: stops the heartbeat, revokes THIS tab's Session on the
// server (other tabs/sessions untouched), and clears tab memory. Callers
// then navigate to their portal login as before.
export async function tabLogout() {
  stopTabHeartbeat();
  try {
    await safeFetchJson("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  } catch {
    /* best effort — memory is cleared regardless */
  }
  clearTabCredential();
}

// Fetch + parse JSON defensively. Throws an Error with the HTTP status (and
// server-provided error message when available) on any non-2xx response.
// The thrown error is annotated with `status` and `retryAfter` (from
// Retry-After header) so callers can branch on 401/429 without parsing strings.
export async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, { credentials: "include", ...options, headers: withTabHeaders(options.headers) });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const message =
      data?.message || data?.error || `Server returned status ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    const ra = res.headers.get("retry-after") || res.headers.get("Retry-After");
    if (ra) err.retryAfter = ra;
    throw err;
  }

  return data;
}

// Hard deadline guard for critical UI flows (e.g. terminal sign-in). If the
// server never responds — hung handler, cut connection, dropped request — the
// promise rejects after `ms` instead of hanging forever, so spinners/busy
// states always resolve and the user always gets an actionable error.
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(message || `Request timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Abortable fetch with a hard deadline for critical auth flows. Unlike a bare
// Promise.race, this actually calls `controller.abort()` so the underlying
// network request is cancelled (not just ignored) — the connection can never
// linger and wedge a PIN submit behind a "rendering…" spinner.
export async function fetchWithTimeout(
  url,
  options = {},
  ms = 10000,
  message
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await safeFetchJson(url, { credentials: "include", ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || err?.name === "AbortError") {
      throw new Error(message || `Request timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Canonical order submission used by the Waiter UI: POST /api/orders with a
// strict ok-check before any JSON parsing. Handles loading/error/empty/success
// states explicitly — throws with `status` so WaiterUI can show actionable UI.
export async function sendOrder(orderData) {
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: withTabHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify(orderData),
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }

    if (!res.ok) {
      const msg = data?.error || data?.message || text || `Server returned status ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      const ra = res.headers.get("retry-after") || res.headers.get("Retry-After");
      if (ra) err.retryAfter = ra;
      throw err;
    }

    // Handle 201 Created as well as 200
    if (!data) data = await res.json().catch(() => null);
    return data;
  } catch (err) {
    console.error("Order submission failed:", err);
    throw err;
  }
}

// Canonical order lifecycle update: PATCH /api/orders/[id] with { status }.
export async function updateOrderStatusClient(orderId, status, extra = {}) {
  return safeFetchJson(`/api/orders/${orderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status, ...extra }),
  });
}

// Session error kinds — AUTH-ARCH-5 shared client helper.
//
// Prefers the stable machine-readable `code` from the API envelope
// (SESSION_REVOKED / SESSION_EXPIRED / SESSION_INVALID / ACCOUNT_DISABLED,
// see lib/apiResponse + lib/serverAuth). Falls back to legacy 401 handling
// for older responses without codes. Returns:
//   'revoked' | 'expired' | 'invalid' | 'disabled' | null (not session-related).
// 503 / network errors NEVER map to a session kind (transient infra, keep polling).
export function getSessionErrorKind(err) {
  if (!err || typeof err !== "object") return null;
  const code = err?.data?.code || err?.code || null;
  if (code === "SESSION_REVOKED") return "revoked";
  if (code === "SESSION_EXPIRED") return "expired";
  if (code === "SESSION_INVALID") return "invalid";
  if (code === "ACCOUNT_DISABLED") return "disabled";
  if (err.status === 401) {
    const msg = String(err.message || "");
    if (/no longer valid|revoked|signed in (elsewhere|as another)/i.test(msg)) return "revoked";
    if (/disabled|inactive|contact manager/i.test(msg)) return "disabled";
    return "expired";
  }
  return null;
}

// True when the error ends the client session (re-login required).
export function isSessionEndedError(err) {
  return getSessionErrorKind(err) !== null;
}
