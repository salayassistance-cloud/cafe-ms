// Client-side safe fetch helpers for the Hotel Management System POS terminals.
//
// Every helper checks `response.ok` BEFORE attempting to parse JSON so an
// empty error body (405/404/500) can never produce an
// "Unexpected end of JSON input" crash. API routes that return 204/empty
// bodies degrade to `null` instead of throwing.

// Fetch + parse JSON defensively. Throws an Error with the HTTP status (and
// server-provided error message when available) on any non-2xx response.
// The thrown error is annotated with `status` and `retryAfter` (from
// Retry-After header) so callers can branch on 401/429 without parsing strings.
export async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, { credentials: "include", ...options, headers: { ...(options.headers || {}) } });

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
      headers: { "Content-Type": "application/json" },
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
