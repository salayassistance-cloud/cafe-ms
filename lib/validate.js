// Production-grade runtime validation (Zod-like) without external dependency.
// Provides strict schema validation for ALL incoming request bodies, query params, and route params.
// Sanitizes strings, validates enums, numbers, and prevents injection vectors.

const ROLES = ["WAITER", "KITCHEN", "BARISTA", "HOT_DRINK", "MANAGER", "CASHIER"];
const ORDER_STATUSES = ["PENDING", "PREPARING", "READY", "SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED", "ACTIVE"];
const PAYMENT_METHODS = ["CASH", "TRANSFER", "TELEBIRR", "NONE"];
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
  // Canonical TRANSFER; legacy TELEBIRR normalized to TRANSFER for new writes
  if (v === "TELEBIRR") return "TRANSFER";
  return PAYMENT_METHODS.includes(v) ? v : null;
}

export function isTransferMethod(m) {
  const v = String(m || "").trim().toUpperCase();
  return v === "TRANSFER" || v === "TELEBIRR";
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
    const qtyRaw = raw.quantity ?? raw.qty;
    const quantity = validateQuantity(qtyRaw);
    if (quantity == null) return { error: `Item ${i}: quantity must be integer 1-99` };

    // Standalone Extra Item lines are no longer accepted. Extras belong only to
    // a selected parent menu item as PRICED_COMPONENT children.
    if (raw.isExtraItem === true) {
      return { error: `Item ${i}: Extra Items must be attached to a parent menu item` };
    }

    const name = sanitizeName(raw.name || raw.title);
    if (!name) return { error: `Item ${i}: name is required (max 100 chars)` };
    const price = validatePrice(raw.price);
    if (price == null) return { error: `Item ${i}: price must be number 0-100000` };
    const typeRaw = String(raw.type || raw.category || "").trim().toUpperCase();
    let type = "FOOD";
    if (typeRaw === "DRINK" || raw.barista === true || raw.category === "DRINK") type = "DRINK";
    else if (typeRaw === "HOT_DRINK" || raw.category === "HOT_DRINK") type = "HOT_DRINK";
    else if (typeRaw === "FOOD") type = "FOOD";
    // else default FOOD

    // C1: itemId is the only accepted line identity. `_id` remains a legacy
    // alias for older clients; both must be a real ObjectId. Existence in the
    // menu catalog is verified server-side in createOrder — client
    // name/price/type are never accepted as an identity substitute.
    let itemId = null;
    if (raw.itemId != null && String(raw.itemId).trim() !== "") {
      const oid = validateObjectId(raw.itemId);
      if (!oid) return { error: `Item ${i}: itemId must be a valid ObjectId` };
      itemId = oid;
    } else if (raw._id != null && String(raw._id).trim() !== "") {
      const oid = validateObjectId(raw._id);
      if (oid) itemId = oid;
    }

    // Components attached to this item — two explicit types
    const rawComps = Array.isArray(raw.components) ? raw.components : [];
    if (rawComps.length > 20) return { error: `Item ${i}: too many components (max 20)` };
    const sanitizedComponents = [];
    for (let ci = 0; ci < rawComps.length; ci++) {
      const cres = rawComps[ci];
      if (!cres || typeof cres !== "object") return { error: `Item ${i} component ${ci}: invalid shape` };
      const kindRaw = String(cres.kind || cres.type || "").trim().toUpperCase();
      let kind = null;
      if (kindRaw === "NOTE" || kindRaw === "INGREDIENT" || kindRaw === "INSTRUCTION" || kindRaw === "INGREDIENT_NOTE") kind = "NOTE";
      else if (kindRaw === "PRICED_COMPONENT" || kindRaw === "PRICED" || kindRaw === "EXTRA" || kindRaw === "COMPONENT") kind = "PRICED_COMPONENT";
      else return { error: `Item ${i} component ${ci}: kind must be NOTE or PRICED_COMPONENT` };
      if (kind === "NOTE") {
        const noteRaw = cres.note ?? cres.text ?? cres.instruction ?? "";
        const note = typeof noteRaw === "string" ? noteRaw.trim() : "";
        if (!note) return { error: `Item ${i} component ${ci}: note is required for NOTE` };
        if (note.length > 500) return { error: `Item ${i} component ${ci}: note max 500 chars` };
        if (/<script/i.test(note) || /javascript:/i.test(note) || /on\w+\s*=/i.test(note)) return { error: `Item ${i} component ${ci}: note contains invalid characters` };
        sanitizedComponents.push({ kind: "NOTE", note: sanitizeString(note, { maxLen: 500 }) });
      } else {
        // PRICED_COMPONENT is now strictly an Extra Item reference. The client
        // sends only the Extra Item identity and quantity; name, selling price,
        // unit and stock link are resolved server-side. Any client-supplied
        // name/price/stock fields are ignored here and never persisted.
        const extraItemId = validateObjectId(cres.extraItemId ?? cres.extraId);
        if (!extraItemId) {
          return { error: `Item ${i} component ${ci}: extraItemId must be valid ObjectId for PRICED_COMPONENT` };
        }
        const qtyC = validateQuantity(cres.quantity ?? cres.qty);
        if (qtyC == null) return { error: `Item ${i} component ${ci}: quantity must be integer 1-99` };
        sanitizedComponents.push({
          kind: "PRICED_COMPONENT",
          extraItemId,
          quantity: qtyC,
        });
      }
    }

    // D1: a PRICED_COMPONENT is an Extra Item child of a real catalog menu
    // item. A free-text parent has no menu identity, so its Extra could be
    // charged while reservation/deduction silently skipped the stock link.
    // Reject that payload instead of selling stock that cannot be accounted for.
    if (!itemId && sanitizedComponents.some((c) => c.kind === "PRICED_COMPONENT")) {
      return { error: `Item ${i}: PRICED_COMPONENT requires a parent menu item (itemId)` };
    }

    // C1: every ordinary order line must carry a catalog identity. A line with
    // only name/price/type has no recipe or stock context and would become a
    // NO_INVENTORY line that is preparable and payable with no deduction, so it
    // is rejected at the payload boundary. Catalog existence is enforced in
    // createOrder (unknown/deleted ids reject the whole order).
    if (!itemId) {
      return { error: `Item ${i}: itemId is required and must reference a menu item` };
    }

    sanitizedItems.push({
      name,
      price,
      quantity,
      type,
      ...(itemId ? { itemId } : {}),
      ...(sanitizedComponents.length ? { components: sanitizedComponents } : {}),
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
    if (!pm) return { error: "paymentMethod must be CASH, TRANSFER, or NONE" };
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
    // Allowed transitions via this endpoint — PAYMENT_PENDING is waiter submit, PAID is cashier verify
    const allowed = ["PENDING", "PREPARING", "READY", "SERVED", "PAYMENT_PENDING", "PAID", "ARCHIVED", "CANCELLED"];
    if (!allowed.includes(s)) return { error: `Invalid status: ${s}` };
    result.status = s;
  }
  if (body.action != null) {
    const a = String(body.action).trim().toUpperCase();
    const allowedActions = ["ARCHIVE", "DELETE", "ARCHIVED", "CANCELLED", "CANCEL", "CANCEL_ITEM", "EDIT_ITEMS", "CANCEL_ORDER", "REJECT_PAYMENT", "REJECT"];
    if (!allowedActions.includes(a)) return { error: `Invalid action: ${a}` };
    result.action = a;
  }
  // Pre-preparation order editing — shape guard only; each op is deep-validated
  // server-side in editOrderItems against the fresh order (never trusted blindly).
  if (body.changes !== undefined) {
    if (!Array.isArray(body.changes) || body.changes.length === 0) return { error: "changes array is required for EDIT_ITEMS" };
    if (body.changes.length > 20) return { error: "Too many changes (max 20)" };
    const ops = ["SETQTY", "REMOVE", "ADD", "NOTE", "EXTRA"];
    for (let i = 0; i < body.changes.length; i += 1) {
      const ch = body.changes[i];
      if (!ch || typeof ch !== "object") return { error: `changes[${i}]: invalid shape` };
      if (!ops.includes(String(ch.op || "").trim().toUpperCase())) return { error: `changes[${i}]: Invalid edit operation` };
    }
    result.changes = body.changes;
  }
  // Item-level cancellation identity + reason
  const rawLineId = body.lineId ?? body.itemLineId ?? body.lineID;
  if (rawLineId != null && String(rawLineId).trim() !== "") {
    const oid = validateObjectId(rawLineId);
    if (!oid) return { error: "lineId must be valid ObjectId" };
    result.lineId = oid;
  }
  const rawReason = body.reason ?? body.cancelReason;
  if (rawReason != null && String(rawReason).trim() !== "") {
    const r = sanitizeString(rawReason, { maxLen: 200, allowEmpty: true });
    if (r == null) return { error: "Invalid cancel reason" };
    if (/<script/i.test(r) || /javascript:/i.test(r) || /on\w+\s*=/i.test(r)) return { error: "Cancel reason contains invalid characters" };
    result.reason = r;
  } else if (rawReason != null) {
    // empty string explicitly provided -> treat as null (no reason)
    result.reason = null;
  }
  if (body.paymentMethod != null) {
    const pm = validatePaymentMethod(body.paymentMethod);
    if (!pm) return { error: "paymentMethod must be CASH, TRANSFER, or NONE" };
    result.paymentMethod = pm;
  }
  // Payment account for Transfer — validated server-side, not trusted client total
  const rawAcc = body.paymentAccountId ?? body.paymentAccount ?? body.transferAccountId ?? body.accountId;
  if (rawAcc != null && String(rawAcc).trim() !== "") {
    const oid = validateObjectId(rawAcc);
    if (!oid) return { error: "paymentAccountId must be valid ObjectId" };
    result.paymentAccountId = oid;
  }
  // Enforce: a status-bearing Transfer submission (new PAYMENT_PENDING or a
  // direct PAID settlement) requires an account. A method-only assertion
  // ({ paymentMethod: "TRANSFER" } with no status/action) targets an existing
  // order and must reach updatePayment so a frozen order can answer the stable
  // 409 PAYMENT_METHOD_IMMUTABLE instead of this unrelated 400. General
  // submission validation is otherwise unchanged.
  const methodOnlyAssertion = !result.status && !result.action;
  if (isTransferMethod(result.paymentMethod) && !result.paymentAccountId && !methodOnlyAssertion) {
    return { error: "paymentAccountId is required for Transfer payments" };
  }
  if (result.paymentMethod === "CASH" && result.paymentAccountId) {
    return { error: "paymentAccountId must not be provided for Cash payments" };
  }
  if (result.paymentAccountId && !isTransferMethod(result.paymentMethod)) {
    // Account provided without Transfer method
    return { error: "paymentAccountId is only allowed for Transfer payments" };
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
  if (body.hotDrinkStaffId != null && String(body.hotDrinkStaffId).trim() !== "") {
    const oid = validateObjectId(body.hotDrinkStaffId);
    if (!oid) return { error: "hotDrinkStaffId must be valid ObjectId" };
    result.hotDrinkStaffId = oid;
  }
  if (body.staffId != null && String(body.staffId).trim() !== "") {
    const oid = validateObjectId(body.staffId);
    if (!oid) return { error: "staffId must be valid ObjectId" };
    result.staffId = oid;
  }
  if (body.staffRole != null && String(body.staffRole).trim() !== "") {
    const r = validateRole(body.staffRole);
    if (!r) return { error: "staffRole must be WAITER/KITCHEN/BARISTA/HOT_DRINK/MANAGER/CASHIER" };
    result.staffRole = r;
  }

  if (result.action === "CANCEL_ITEM" && !result.lineId) {
    return { error: "lineId is required for CANCEL_ITEM" };
  }
  if (result.action === "EDIT_ITEMS" && !result.changes) {
    return { error: "changes array is required for EDIT_ITEMS" };
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
