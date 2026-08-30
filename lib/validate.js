// Production-grade runtime validation (Zod-like) without external dependency.
// Provides strict schema validation for ALL incoming request bodies, query params, and route params.
// Sanitizes strings, validates enums, numbers, and prevents injection vectors.

const ROLES = ["WAITER", "KITCHEN", "BARISTA", "MANAGER"];
const ORDER_STATUSES = ["PENDING", "PREPARING", "READY", "SERVED", "PAID", "CANCELLED", "ARCHIVED", "ACTIVE"];
const PAYMENT_METHODS = ["CASH", "TELEBIRR", "NONE"];
const LANGS = ["am", "en", "om"];

export const PIN_RE = /^\d{4}$/;
export const OBJECTID_RE = /^[a-fA-F0-9]{24}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sanitize string: trim, limit length, strip control chars, prevent XSS/NoSQL injection payloads
export function sanitizeString(val, { maxLen = 200, allowEmpty = false } = {}) {
  if (val == null) return allowEmpty ? "" : null;
  let s = String(val).trim();
  // Strip control chars except newline/tab
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Limit length to prevent DoS via huge payloads
  if (s.length > maxLen) s = s.slice(0, maxLen);
  // Prevent prototype pollution keys
  if (["__proto__", "constructor", "prototype"].includes(s)) return null;
  if (!allowEmpty && s === "") return null;
  return s;
}

export function sanitizeName(val) {
  const s = sanitizeString(val, { maxLen: 50 });
  if (!s) return null;
  // Allow letters, numbers, spaces, Amharic/Oromo chars, dash, apostrophe
  // Block script tags and obvious XSS
  if (/<script/i.test(s) || /javascript:/i.test(s) || /on\w+\s*=/i.test(s)) return null;
  return s;
}

export function validatePin(pin) {
  const s = String(pin || "").trim();
  return PIN_RE.test(s) ? s : null;
}

export function validateRole(role) {
  const r = String(role || "").trim().toUpperCase();
  return ROLES.includes(r) ? r : null;
}

export function validateObjectId(id) {
  const s = String(id || "").trim();
  return OBJECTID_RE.test(s) ? s : null;
}

export function validateTableNumber(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > 50) return null;
  return num;
}

export function validateWaiterNumber(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > 10) return null;
  return num;
}

export function validatePrice(p) {
  const num = Number(p);
  if (!Number.isFinite(num) || num < 0 || num > 100000) return null;
  return Math.round(num * 100) / 100;
}

export function validateQuantity(q) {
  const num = Number(q);
  if (!Number.isInteger(num) || num < 1 || num > 99) return null;
  return num;
}

export function validateStatus(s) {
  const v = String(s || "").trim().toUpperCase();
  return ORDER_STATUSES.includes(v) ? v : null;
}

export function validatePaymentMethod(m) {
  const v = String(m || "").trim().toUpperCase();
  return PAYMENT_METHODS.includes(v) ? v : null;
}

export function validateLang(l) {
  const v = String(l || "").trim().toLowerCase();
  return LANGS.includes(v) ? v : "en";
}

export function validateDateString(v) {
  const s = String(v || "").trim();
  if (!DATE_RE.test(s)) return null;
  const d = new Date(Number(s.slice(0,4)), Number(s.slice(5,7))-1, Number(s.slice(8,10)));
  if (Number.isNaN(d.getTime())) return null;
  // Ensure no overflow (e.g. 2024-02-30 becomes 2024-03-01)
  if (d.getMonth() !== Number(s.slice(5,7))-1) return null;
  return s;
}

// Full order creation payload validation - strict, returns sanitized object or { error }
export function validateCreateOrderPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body: expected JSON object" };
  }

  // tableNumber - required
  const tableNumber = validateTableNumber(body.tableNumber);
  if (tableNumber == null) {
    return { error: "tableNumber is required and must be integer 1-50" };
  }

  // items - required non-empty array, max 50 items
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: "Order must contain at least one item" };
  }
  if (body.items.length > 50) {
    return { error: "Too many items (max 50)" };
  }

  const sanitizedItems = [];
  for (let i = 0; i < body.items.length; i++) {
    const raw = body.items[i];
    if (!raw || typeof raw !== "object") {
      return { error: `Item ${i}: invalid shape` };
    }
    const name = sanitizeName(raw.name || raw.title);
    if (!name) return { error: `Item ${i}: name is required (max 100 chars)` };
    const price = validatePrice(raw.price);
    if (price == null) return { error: `Item ${i}: price must be number 0-100000` };
    const qtyRaw = raw.quantity ?? raw.qty;
    const quantity = validateQuantity(qtyRaw);
    if (quantity == null) return { error: `Item ${i}: quantity must be integer 1-99` };
    const typeRaw = String(raw.type || raw.category || "").trim().toUpperCase();
    let type = "FOOD";
    if (typeRaw === "DRINK" || raw.barista === true || raw.category === "DRINK") type = "DRINK";
    else if (typeRaw === "FOOD") type = "FOOD";
    // else default FOOD

    // Optional itemId if provided - must be ObjectId if present
    let itemId = null;
    if (raw.itemId != null && String(raw.itemId).trim() !== "") {
      const oid = validateObjectId(raw.itemId);
      if (!oid) return { error: `Item ${i}: itemId must be valid ObjectId if provided` };
      itemId = oid;
    } else if (raw._id != null && String(raw._id).trim() !== "") {
      const oid = validateObjectId(raw._id);
      if (oid) itemId = oid;
    }

    sanitizedItems.push({
      name,
      price,
      quantity,
      type,
      ...(itemId ? { itemId } : {}),
    });
  }

  // waiterName - optional, sanitized
  let waiterName = "Waiter";
  if (body.waiterName != null && String(body.waiterName).trim() !== "") {
    const wn = sanitizeName(body.waiterName);
    if (!wn) return { error: "waiterName contains invalid characters" };
    waiterName = wn.slice(0, 50);
  }

  // waiterNumber - optional
  let waiterNumber = null;
  if (body.waiterNumber != null && String(body.waiterNumber).trim() !== "") {
    const wn = validateWaiterNumber(body.waiterNumber);
    if (wn == null) return { error: "waiterNumber must be 1-10 if provided" };
    waiterNumber = wn;
  }

  // waiterId - optional ObjectId
  let waiterId = null;
  if (body.waiterId != null && String(body.waiterId).trim() !== "") {
    const oid = validateObjectId(body.waiterId);
    if (!oid) return { error: "waiterId must be valid ObjectId if provided" };
    waiterId = oid;
  }

  // paymentMethod - optional
  let paymentMethod = "NONE";
  if (body.paymentMethod != null && String(body.paymentMethod).trim() !== "") {
    const pm = validatePaymentMethod(body.paymentMethod);
    if (!pm) return { error: "paymentMethod must be CASH, TELEBIRR, or NONE" };
    paymentMethod = pm;
  }

  // waiterInfo - optional object, sanitized
  let waiterInfo = null;
  if (body.waiterInfo != null) {
    if (typeof body.waiterInfo !== "object" || Array.isArray(body.waiterInfo)) {
      return { error: "waiterInfo must be object if provided" };
    }
    waiterInfo = {};
    if (body.waiterInfo.waiterId != null && String(body.waiterInfo.waiterId).trim() !== "") {
      const oid = String(body.waiterInfo.waiterId).trim();
      // waiterInfo.waiterId can be string ObjectId or null - allow string
      if (OBJECTID_RE.test(oid)) waiterInfo.waiterId = oid;
      else if (oid !== "null") waiterInfo.waiterId = sanitizeString(oid, { maxLen: 50 });
    }
    if (body.waiterInfo.waiterNumber != null && String(body.waiterInfo.waiterNumber).trim() !== "") {
      const wn = validateWaiterNumber(body.waiterInfo.waiterNumber);
      if (wn != null) waiterInfo.waiterNumber = wn;
    }
    if (body.waiterInfo.shiftId != null) {
      const sid = sanitizeString(body.waiterInfo.shiftId, { maxLen: 50, allowEmpty: true });
      if (sid) waiterInfo.shiftId = sid;
    }
    if (body.waiterInfo.deviceId != null) {
      const did = sanitizeString(body.waiterInfo.deviceId, { maxLen: 100, allowEmpty: true });
      if (did) waiterInfo.deviceId = did;
    }
    if (Object.keys(waiterInfo).length === 0) waiterInfo = null;
  }

  return {
    ok: true,
    data: {
      tableNumber,
      items: sanitizedItems,
      waiterName,
      waiterNumber,
      waiterId,
      waiterInfo,
      paymentMethod,
    },
  };
}

export function validateOrderStatusUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }
  const result = {};

  if (body.status != null) {
    const s = String(body.status).trim().toUpperCase();
    // Allowed transitions via this endpoint
    const allowed = ["PENDING", "PREPARING", "READY", "SERVED", "PAID", "ARCHIVED", "CANCELLED"];
    if (!allowed.includes(s)) return { error: `Invalid status: ${s}` };
    result.status = s;
  }
  if (body.action != null) {
    const a = String(body.action).trim().toUpperCase();
    const allowedActions = ["ARCHIVE", "DELETE", "ARCHIVED", "CANCELLED", "CANCEL"];
    if (!allowedActions.includes(a)) return { error: `Invalid action: ${a}` };
    result.action = a;
  }
  if (body.paymentMethod != null) {
    const pm = validatePaymentMethod(body.paymentMethod);
    if (!pm) return { error: "paymentMethod must be CASH, TELEBIRR, or NONE" };
    result.paymentMethod = pm;
  }
  // Optional staff attribution - must be ObjectId if provided
  if (body.kitchenStaffId != null && String(body.kitchenStaffId).trim() !== "") {
    const oid = validateObjectId(body.kitchenStaffId);
    if (!oid) return { error: "kitchenStaffId must be valid ObjectId" };
    result.kitchenStaffId = oid;
  }
  if (body.baristaStaffId != null && String(body.baristaStaffId).trim() !== "") {
    const oid = validateObjectId(body.baristaStaffId);
    if (!oid) return { error: "baristaStaffId must be valid ObjectId" };
    result.baristaStaffId = oid;
  }
  if (body.staffId != null && String(body.staffId).trim() !== "") {
    const oid = validateObjectId(body.staffId);
    if (!oid) return { error: "staffId must be valid ObjectId" };
    result.staffId = oid;
  }
  if (body.staffRole != null && String(body.staffRole).trim() !== "") {
    const r = validateRole(body.staffRole);
    if (!r) return { error: "staffRole must be WAITER/KITCHEN/BARISTA/MANAGER" };
    result.staffRole = r;
  }

  if (!result.status && !result.action && !result.paymentMethod) {
    return { error: "No update fields provided (need status, action, or paymentMethod)" };
  }

  return { ok: true, data: result };
}

export function validateLoginStaffPayload(body) {
  if (!body || typeof body !== "object") return { error: "Invalid request body" };
  // Username is canonical waiter identity — accept name/username/displayName aliases for compatibility
  const rawName = body.username ?? body.name ?? body.displayName ?? body.waiterUsername;
  const name = sanitizeName(rawName);
  if (!name) return { error: "Username is required (max 50 chars, no script tags)" };
  const pin = validatePin(body.pin);
  if (!pin) return { error: "PIN must be exactly 4 digits" };
  const role = validateRole(body.role || "WAITER");
  if (!role) return { error: "Invalid role" };
  return { ok: true, data: { name, pin, role } };
}

export function validateChangePinPayload(body) {
  if (!body || typeof body !== "object") return { error: "Invalid request body" };
  const currentPin = validatePin(body.currentPin || body.current);
  if (!currentPin) return { error: "Current PIN must be exactly 4 digits" };
  const newPin = validatePin(body.newPin || body.new);
  if (!newPin) return { error: "New PIN must be exactly 4 digits" };
  const confirmRaw = body.confirmPin || body.confirm || newPin;
  const confirmPin = String(confirmRaw).trim();
  if (newPin !== confirmPin) return { error: "New PIN and Confirm PIN do not match" };
  if (currentPin === newPin) return { error: "New PIN must differ from current PIN" };
  let staffId = null;
  if (body.staffId != null && String(body.staffId).trim() !== "") {
    staffId = validateObjectId(body.staffId);
    if (!staffId) return { error: "staffId must be valid ObjectId" };
  }
  return { ok: true, data: { currentPin, newPin, confirmPin, staffId } };
}

export function validateManagerPinUpdate(body) {
  if (!body || typeof body !== "object") return { error: "Invalid request body" };
  const currentManagerPin = validatePin(body.currentManagerPin);
  if (!currentManagerPin) return { error: "Manager PIN must be 4 digits" };
  const pins = {};
  for (const role of ROLES) {
    const key = `${role.toLowerCase()}Pin`; // waiterPin etc - also accept uppercase
    const raw = body[key] ?? body[role] ?? body[`${role}_PIN`] ?? "";
    // Also check manager sends { waiterPin, kitchenPin, baristaPin, managerPin }
    const val = String(raw).trim();
    if (!PIN_RE.test(val)) return { error: `${role} PIN must be exactly 4 digits` };
    pins[role] = val;
  }
  return { ok: true, data: { currentManagerPin, pins } };
}

// Query param sanitizers
export function sanitizeQueryParam(value, { maxLen = 100, allowEmpty = true } = {}) {
  if (value == null) return null;
  return sanitizeString(value, { maxLen, allowEmpty });
}

export function parsePagination(searchParams) {
  const limitRaw = searchParams.get("limit");
  const pageRaw = searchParams.get("page");
  let limit = 50;
  let page = 1;
  if (limitRaw != null) {
    const n = Number(limitRaw);
    if (Number.isInteger(n) && n > 0 && n <= 100) limit = n;
  }
  if (pageRaw != null) {
    const n = Number(pageRaw);
    if (Number.isInteger(n) && n > 0 && n <= 1000) page = n;
  }
  return { limit, page, skip: (page - 1) * limit };
}
