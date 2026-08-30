// Client-side session helpers — convenience only, NOT authority.
// The authoritative session lives in the HttpOnly `bono_sess` cookie (server-side).
// localStorage values are for UI display only and must never be trusted for auth.

export const ROLE_KEY = "bono_role";
export const STAFF_ID_KEY = "bono_staff_id";
export const STAFF_NAME_KEY = "bono_staff_name";

// Generic staff persistence for new username+PIN flow (used by /api/auth/login-staff)
export function setLocalStaff(staff) {
  try {
    if (!staff || typeof staff !== "object") return;
    if (staff.id) window.localStorage.setItem(STAFF_ID_KEY, String(staff.id));
    if (staff.name) window.localStorage.setItem(STAFF_NAME_KEY, String(staff.name));
    if (staff.role) window.localStorage.setItem(ROLE_KEY, String(staff.role));
  } catch {}
}

export function getLocalStaff() {
  if (typeof window === "undefined") return null;
  try {
    const id = window.localStorage.getItem(STAFF_ID_KEY);
    const name = window.localStorage.getItem(STAFF_NAME_KEY);
    const role = window.localStorage.getItem(ROLE_KEY);
    if (!id && !name) return null;
    return { staffId: id, name, role };
  } catch {
    return null;
  }
}

export function clearLocalSession() {
  try {
    window.localStorage.removeItem(STAFF_ID_KEY);
    window.localStorage.removeItem(STAFF_NAME_KEY);
    window.localStorage.removeItem(ROLE_KEY);
  } catch {
    /* ignore */
  }
}

// Calls the logout API and clears local convenience values. HttpOnly cookie cleared by server.
export async function logout() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({}),
    });
  } catch {
    /* best effort */
  }
  clearLocalSession();
}
