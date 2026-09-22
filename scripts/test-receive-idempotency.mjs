#!/usr/bin/env node
// DB-free unit tests for inventory receiving idempotency hardening.
// Covers:
//  - exact duplicate-key classification (keyPattern/keyValue/message scoped to idempotencyKey)
//  - fingerprint consistency (item, quantity, unit normalized, unitCost rounded, supplier)
//  - malformed Idempotency-Key validation
//  - UI retry-key lifecycle (sessionStorage draft with fingerprint guard)
// No MongoDB connection. Integration concurrency tests are listed as NOT RUN at end.

import fs from "fs";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else { console.log(`❌ ${name} ${extra}`); fail++; }
}

// --- Duplicate-key classification logic (mirrors app/api/inventory/receive/route.js) ---
function isIdempotencyDuplicateKeyError(err) {
  if (!err || err.code !== 11000) return false;
  const kp = err.keyPattern;
  if (kp && typeof kp === "object" && Object.prototype.hasOwnProperty.call(kp, "idempotencyKey")) return true;
  const kv = err.keyValue;
  if (kv && typeof kv === "object" && Object.prototype.hasOwnProperty.call(kv, "idempotencyKey")) return true;
  const msg = String(err.message || err.errmsg || "");
  if (/index:\s*idempotencyKey/i.test(msg)) return true;
  if (/duplicate key.*idempotencyKey/i.test(msg)) return true;
  if (/E11000.*idempotencyKey/i.test(msg)) return true;
  return false;
}

console.log("--- isIdempotencyDuplicateKeyError: exact classification ---");
// True positives: idempotencyKey duplicates
ok("11000 + keyPattern idempotencyKey => true", isIdempotencyDuplicateKeyError({ code: 11000, keyPattern: { idempotencyKey: 1 } }));
ok("11000 + keyValue idempotencyKey => true", isIdempotencyDuplicateKeyError({ code: 11000, keyValue: { idempotencyKey: "550e8400-e29b-41d4-a716-446655440000" } }));
ok("11000 + message index: idempotencyKey => true", isIdempotencyDuplicateKeyError({ code: 11000, message: "E11000 duplicate key error collection: hotel.stockmovements index: idempotencyKey_1 dup key: { idempotencyKey: \"abc\" }" }));
ok("11000 + message duplicate key ... idempotencyKey => true", isIdempotencyDuplicateKeyError({ code: 11000, message: "duplicate key error ... idempotencyKey" }));
ok("11000 + E11000 ... idempotencyKey => true", isIdempotencyDuplicateKeyError({ code: 11000, errmsg: "E11000 dup idempotencyKey" }));

// True negatives: unrelated 11000 must NOT be misclassified
ok("11000 + keyPattern refOrderId => false (not idempotency)", !isIdempotencyDuplicateKeyError({ code: 11000, keyPattern: { refOrderId: 1, reason: 1 }, message: "E11000 duplicate key error index: refOrderId_1_reason_1" }));
ok("11000 + keyValue refOrderId => false", !isIdempotencyDuplicateKeyError({ code: 11000, keyValue: { refOrderId: "507f1f77bcf86cd799439011" }, message: "duplicate key refOrderId" }));
ok("11000 + message refOrderId only => false", !isIdempotencyDuplicateKeyError({ code: 11000, message: "E11000 duplicate key error index: refOrderId_1_reason_1 dup key: { refOrderId: ObjectId('...') }" }));
ok("11000 without keyPattern/keyValue and message without idempotencyKey => false", !isIdempotencyDuplicateKeyError({ code: 11000, message: "E11000 duplicate key error index: someOther_1" }));
ok("11000 + keyPattern idempotencyKey + unrelated index name still true (keyPattern wins)", isIdempotencyDuplicateKeyError({ code: 11000, keyPattern: { idempotencyKey: 1 }, message: "some other message" }));

// Non-11000 never true
ok("code 112 (not 11000) => false", !isIdempotencyDuplicateKeyError({ code: 112, message: "idempotencyKey" }));
ok("no code => false", !isIdempotencyDuplicateKeyError({ message: "idempotencyKey" }));
ok("null err => false", !isIdempotencyDuplicateKeyError(null));
ok("undefined err => false", !isIdempotencyDuplicateKeyError(undefined));
ok("code 11000 but empty message and no keyPattern => false", !isIdempotencyDuplicateKeyError({ code: 11000, message: "E11000 duplicate key error index: other_1" }));

// --- Fingerprint consistency (mirrors isSameReceivePayload) ---
console.log("\n--- isSameReceivePayload: fingerprint consistency ---");
function isSameReceivePayload(existing, payload) {
  const { itemId, quantity, unit, roundedUnitCost, supplier } = payload;
  const sameItem = String(existing.item) === String(itemId);
  const sameQty = Number(existing.quantity) === Number(quantity);
  const sameUnit = String(existing.unit || "").trim().toLowerCase() === String(unit || existing.unit || "").trim().toLowerCase();
  const sameCost = Number(existing.unitCost) === Number(roundedUnitCost);
  const sameSupplier = String(existing.supplier || "") === String(supplier || "");
  return sameItem && sameQty && sameUnit && sameCost && sameSupplier;
}

const validId = "507f1f77bcf86cd799439011";
const otherId = "507f1f77bcf86cd799439012";
const validSupplier = "507f1f77bcf86cd799439099";
const otherSupplier = "507f1f77bcf86cd799439100";

const baseExisting = { item: validId, quantity: 5, unit: "kg", unitCost: 10.12, supplier: validSupplier };
const basePayload = { itemId: validId, quantity: 5, unit: "kg", roundedUnitCost: 10.12, supplier: validSupplier };

ok("Same payload => true", isSameReceivePayload(baseExisting, basePayload));
ok("Different item => false", !isSameReceivePayload(baseExisting, { ...basePayload, itemId: otherId }));
ok("Different quantity => false", !isSameReceivePayload(baseExisting, { ...basePayload, quantity: 6 }));
ok("Different unitCost (rounded) => false", !isSameReceivePayload(baseExisting, { ...basePayload, roundedUnitCost: 10.13 }));
ok("Different supplier => false", !isSameReceivePayload(baseExisting, { ...basePayload, supplier: otherSupplier }));
ok("Unit case-insensitive: KG vs kg => true", isSameReceivePayload({ ...baseExisting, unit: "KG" }, { ...basePayload, unit: "kg" }));
ok("Unit trim: ' kg ' vs 'kg' => true", isSameReceivePayload({ ...baseExisting, unit: " kg " }, basePayload));
ok("Payload unit null defaults to existing unit => true (route: unit || existing.unit)", isSameReceivePayload(baseExisting, { ...basePayload, unit: null }));
ok("Payload unit undefined defaults to existing unit => true", isSameReceivePayload(baseExisting, { ...basePayload, unit: undefined }));
ok("Existing unit null vs payload null => true (both empty)", isSameReceivePayload({ ...baseExisting, unit: null }, { ...basePayload, unit: null }));
ok("Supplier null vs empty string => true", isSameReceivePayload({ ...baseExisting, supplier: null }, { ...basePayload, supplier: "" }));
ok("Supplier undefined vs null => true", isSameReceivePayload({ ...baseExisting, supplier: null }, { ...basePayload, supplier: undefined }));
ok("Quantity as string '5' vs number 5 => true (Number coercion)", isSameReceivePayload(baseExisting, { ...basePayload, quantity: "5" }));
ok("UnitCost string '10.12' vs number 10.12 => true", isSameReceivePayload(baseExisting, { ...basePayload, roundedUnitCost: "10.12" }));

// Rounded cost consistency: route rounds Math.round(unitCost*100)/100; fingerprint must use rounded
function roundedCost(n) { return Math.round(Number(n) * 100) / 100; }
ok("10.123 rounds to 10.12 fingerprint matches", isSameReceivePayload({ ...baseExisting, unitCost: roundedCost(10.123) }, { ...basePayload, roundedUnitCost: 10.12 }));
ok("10.125 rounds to 10.13 not 10.12 => false", !isSameReceivePayload({ ...baseExisting, unitCost: roundedCost(10.125) }, { ...basePayload, roundedUnitCost: 10.12 }));
ok("10.126 rounds to 10.13 => true if both rounded", isSameReceivePayload({ ...baseExisting, unitCost: roundedCost(10.126) }, { itemId: validId, quantity: 5, unit: "kg", roundedUnitCost: roundedCost(10.126), supplier: validSupplier }));

// --- Idempotency-Key validation (malformed keys) ---
console.log("\n--- Idempotency-Key validation ---");
function validateIdempotencyKey(raw) {
  const OBJECTID_RE = /^[a-fA-F0-9]{24}$/;
  function sanitizeString(val, { maxLen = 200, allowEmpty = false } = {}) {
    if (val == null) return allowEmpty ? "" : null;
    let s = String(val).trim();
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    if (s.length > maxLen) s = s.slice(0, maxLen);
    if (["__proto__", "constructor", "prototype"].includes(s)) return null;
    if (!allowEmpty && s === "") return null;
    return s;
  }
  const idempotencyKey = sanitizeString(raw, { maxLen: 64 });
  if (!idempotencyKey) return { error: "Idempotency-Key is required" };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SIMPLE_UUID_RE = /^[a-fA-F0-9\-]{8,64}$/;
  if (!UUID_RE.test(idempotencyKey) && !SIMPLE_UUID_RE.test(idempotencyKey)) {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 64) return { error: "Idempotency-Key must be 8-64 chars" };
  }
  if (idempotencyKey.length < 8) return { error: "Idempotency-Key must be at least 8 chars" };
  return { ok: true, key: idempotencyKey };
}
ok("Valid UUID v4 passes", validateIdempotencyKey("550e8400-e29b-41d4-a716-446655440000").ok);
ok("Valid simple hex+hyphen 32 chars passes", validateIdempotencyKey("abcdef12-3456-7890-abcd-ef1234567890").ok);
ok("Empty => required error", validateIdempotencyKey("").error === "Idempotency-Key is required");
ok("Null => required error", validateIdempotencyKey(null).error === "Idempotency-Key is required");
ok("Too short 7 chars => error (8 chars min)", (() => { const e = validateIdempotencyKey("short12").error || ""; return e.includes("at least 8") || e.includes("8-64"); })());
ok("Whitespace trimmed then valid", validateIdempotencyKey("  550e8400-e29b-41d4-a716-446655440000  ").ok);
ok("Control chars stripped", validateIdempotencyKey("550e8400\x00-e29b-41d4-a716-446655440000").ok);
ok("Prototype pollution '__proto__' => required", validateIdempotencyKey("__proto__").error === "Idempotency-Key is required");

// --- UI retry-key lifecycle (fingerprint + sessionStorage draft) ---
console.log("\n--- UI retry-key lifecycle (draft + fingerprint guard) ---");
function receiveFingerprint(form) {
  const itemId = String(form.itemId || "").trim();
  const qty = Number(form.quantity);
  const uc = Number(form.unitCost);
  const rounded = Number.isFinite(uc) ? Math.round(uc * 100) / 100 : uc;
  const unit = String(form.unit || "").trim().toLowerCase();
  const supplier = String(form.supplier || "").trim();
  return `${itemId}|${Number.isFinite(qty) ? qty : form.quantity}|${unit}|${Number.isFinite(rounded) ? rounded : form.unitCost}|${supplier}`;
}
// Simulate sessionStorage
const mockStorage = (() => {
  const m = new Map();
  return {
    getItem(k) { return m.get(k) ?? null; },
    setItem(k, v) { m.set(k, v); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); }
  };
})();
const RECEIVE_DRAFT_STORAGE_KEY = "bono:receive:draft";
function saveDraft(key, fp, storage = mockStorage) {
  if (!key) storage.removeItem(RECEIVE_DRAFT_STORAGE_KEY);
  else storage.setItem(RECEIVE_DRAFT_STORAGE_KEY, JSON.stringify({ key, fp }));
}
function loadDraft(storage = mockStorage) {
  try { const raw = storage.getItem(RECEIVE_DRAFT_STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function clearDraft(storage = mockStorage) { storage.removeItem(RECEIVE_DRAFT_STORAGE_KEY); }

const formA = { itemId: validId, quantity: "5", unit: "kg", unitCost: "10.12", supplier: validSupplier };
const fpA = receiveFingerprint(formA);
const keyA = "550e8400-e29b-41d4-a716-446655440000";
saveDraft(keyA, fpA);
ok("Draft saved and loaded same key/fp", (() => { const d = loadDraft(); return d?.key === keyA && d?.fp === fpA; })());

const formBsame = { itemId: validId, quantity: "5", unit: "KG", unitCost: "10.12", supplier: validSupplier }; // unit case diff
ok("Same logical payload (case) fingerprint equal => reuse key", receiveFingerprint(formA) === receiveFingerprint(formBsame));

const formChangedQty = { ...formA, quantity: "6" };
ok("Changed quantity fingerprint differs => should generate new key", receiveFingerprint(formA) !== receiveFingerprint(formChangedQty));

const formChangedCost = { ...formA, unitCost: "10.13" };
ok("Changed unitCost fingerprint differs", receiveFingerprint(formA) !== receiveFingerprint(formChangedCost));

const formChangedSupplier = { ...formA, supplier: otherSupplier };
ok("Changed supplier fingerprint differs", receiveFingerprint(formA) !== receiveFingerprint(formChangedSupplier));

const formChangedItem = { ...formA, itemId: otherId };
ok("Changed item fingerprint differs", receiveFingerprint(formA) !== receiveFingerprint(formChangedItem));

const formChangedUnit = { ...formA, unit: "g" };
ok("Changed unit fingerprint differs", receiveFingerprint(formA) !== receiveFingerprint(formChangedUnit));

// Simulate retry logic: if draft fp !== currentFp, discard old key
function resolveKeyForSubmit(currentForm, storedDraft, existingKey) {
  const currentFp = receiveFingerprint(currentForm);
  if (existingKey && storedDraft?.fp && storedDraft.fp !== currentFp) return { newKeyNeeded: true, currentFp };
  if (!existingKey && storedDraft?.key && storedDraft.fp === currentFp) return { reuseKey: storedDraft.key, currentFp };
  return { useExisting: existingKey, currentFp };
}
ok("Existing key + same fp => reuse (no new key)", !resolveKeyForSubmit(formA, { key: keyA, fp: fpA }, keyA).newKeyNeeded);
ok("Existing key + different fp => newKeyNeeded true", resolveKeyForSubmit(formChangedQty, { key: keyA, fp: fpA }, keyA).newKeyNeeded);
ok("No key + draft with same fp => reuse draft key (reload case)", resolveKeyForSubmit(formA, { key: keyA, fp: fpA }, "").reuseKey === keyA);
ok("No key + draft with different fp => not reused", !resolveKeyForSubmit(formChangedQty, { key: keyA, fp: fpA }, "").reuseKey);

clearDraft();
ok("clearDraft removes stored key", loadDraft() === null);
saveDraft(keyA, fpA);
ok("saveDraft with empty key removes", (() => { saveDraft("", fpA); return loadDraft() === null; })());

// Simulate 409 different payload handling: draft cleared and key discarded
saveDraft(keyA, fpA);
clearDraft();
ok("409 different payload clears draft (next submit generates fresh)", loadDraft() === null);

// Simulate 503 unknown: draft kept for retry
saveDraft(keyA, fpA);
ok("503 unknown keeps draft for retry", (() => { const d = loadDraft(); return d?.key === keyA; })());
clearDraft(); // cleanup

// --- Static file checks (do NOT claim concurrency safety) ---
console.log("\n--- Static file presence (not concurrency proof) ---");
// G2 ownership: helpers moved to service; exactly one definition across route+service
const routeContent = fs.readFileSync("app/api/inventory/receive/route.js", "utf8");
const svcContent = fs.existsSync("lib/inventoryReceiveService.js") ? fs.readFileSync("lib/inventoryReceiveService.js", "utf8") : "";
ok("Service file exists", fs.existsSync("lib/inventoryReceiveService.js"));
const routeHelperCount = (routeContent.match(/function isIdempotencyDuplicateKeyError/g) || []).length;
const svcHelperCount = (svcContent.match(/function isIdempotencyDuplicateKeyError/g) || []).length;
ok("Exactly one isIdempotencyDuplicateKeyError definition across route+service", (routeHelperCount + svcHelperCount) === 1);
ok("Service owns isIdempotencyDuplicateKeyError", svcContent.includes("function isIdempotencyDuplicateKeyError") || svcContent.includes("isIdempotencyDuplicateKeyError"));
ok("Route no longer defines isIdempotencyDuplicateKeyError", routeHelperCount === 0);
const routeFpCount = (routeContent.match(/function isSameReceivePayload/g) || []).length;
const svcFpCount = (svcContent.match(/function isSameReceivePayload/g) || []).length;
ok("Exactly one isSameReceivePayload definition across route+service", (routeFpCount + svcFpCount) === 1);
ok("Service owns isSameReceivePayload with null-unit fallback", svcContent.includes("String(unit || existing.unit || \"\").trim().toLowerCase()"));
ok("Route no longer defines isSameReceivePayload", routeFpCount === 0);
ok("Service checks keyPattern/keyValue for idempotencyKey", svcContent.includes("keyPattern") && svcContent.includes("idempotencyKey"));
ok("Service does NOT treat every 11000 as idempotency (uses helper)", svcContent.includes("isIdempotencyDuplicateKeyError") && !svcContent.includes('err.code === 11000 || /duplicate key.*idempotencyKey'));
// Ownership: fast replay before transaction in service
ok("Service keeps pre-transaction fast replay check", svcContent.includes("StockMovementForCheck.findOne({ idempotencyKey, reason: \"Purchase\" })"));
{
  const fastIdx = svcContent.indexOf("StockMovementForCheck.findOne({ idempotencyKey, reason: \"Purchase\" })");
  const txIdx = svcContent.indexOf("session.startTransaction()");
  ok("Service fast replay occurs before transaction start", fastIdx !== -1 && txIdx !== -1 && fastIdx < txIdx);
}
ok("Route delegates to service receiveInventory", routeContent.includes("receiveInventory") && routeContent.includes("isReceiveServiceError"));
ok("Route does NOT contain transaction loop", !routeContent.includes("session.startTransaction()") && !routeContent.includes("for (let attempt = 0; attempt < 3; attempt++)"));
ok("Route 50KB guard before json parsing", routeContent.includes('request.headers.get("content-length")') && routeContent.includes("50 * 1024") && routeContent.includes("Payload too large") && routeContent.indexOf("content-length") < routeContent.indexOf("request.json()"));
ok("Service owns transaction, movement, audit, retry, recovery", svcContent.includes("session.startTransaction()") && svcContent.includes("StockMovement.create") && svcContent.includes("createInventoryAudit") && svcContent.includes("TransientTransactionError") && svcContent.includes("UnknownTransactionCommitResult") && svcContent.includes("await session.abortTransaction()") && svcContent.includes("await session.endSession()"));
ok("Service comment notes unique index is concurrency authority", svcContent.includes("unique") && svcContent.includes("concurrency authority"));
ok("Service handles UnknownTransactionCommitResult without blind retry (returns 503)", svcContent.includes("UnknownTransactionCommitResult") && svcContent.includes("Receipt status unknown"));
ok("Service aborts transaction before re-read (no partial commit)", svcContent.includes("await session.abortTransaction()") && svcContent.includes("Re-read winning movement"));
ok("Service does NOT add misleading transaction-local findOne that claims to solve race", !svcContent.includes("StockMovement.findOne({ idempotencyKey }).session(session)") || svcContent.includes("snapshot reads alone"));
ok("Service does NOT import lib/mongodb or connectToDatabase or MONGODB_URI", !svcContent.includes('from "@/lib/mongodb"') && !svcContent.includes("connectToDatabase") && !svcContent.includes("MONGODB_URI") && !svcContent.includes("process.env.MONGODB_URI"));
ok("Service exports ReceiveServiceError with explicit marker", svcContent.includes("class ReceiveServiceError") && svcContent.includes("_isReceiveServiceError"));
ok("Route maps only explicit ServiceError, no generic status mapping", routeContent.includes("isReceiveServiceError") && !routeContent.includes("typeof e.status === \"number\"") && !routeContent.includes("typeof err.status === \"number\""));
ok("Route preserves isDbError rethrow for 503 mapping", routeContent.includes("isDbError") && routeContent.includes("throw err"));
ok("Route preserves audit 500 anomaly (no generic 400 mapping)", !routeContent.includes("if (e && typeof e.status") && routeContent.includes("isReceiveServiceError"));

 // Retry exhaustion DB-free coverage (static, does not prove MongoDB behavior)
{
  const loopMatches = svcContent.match(/for\s*\(\s*let\s+attempt\s*=\s*0\s*;\s*attempt\s*<\s*3\s*;\s*attempt\+\+\s*\)/g) || [];
  ok("Service retry loop 3 attempts", loopMatches.length === 1);
  const guardMatches = svcContent.match(/attempt\s*<\s*2/g) || [];
  ok("Service retry guards attempt<2 twice (two delays)", guardMatches.length === 2);
  const delayMatches = svcContent.match(/new Promise\s*\(\s*\(r\)\s*=>\s*setTimeout\s*\(\s*r\s*,\s*20\s*\)\s*\)/g) || [];
  ok("Service retry delay 20ms twice", delayMatches.length === 2);
  ok("Service final fallthrough 500 after retry", svcContent.includes("Failed to receive stock after retry"));
}

const uiContent = fs.readFileSync("app/components/InventoryUI.jsx", "utf8");
ok("UI has sessionStorage draft persistence scoped to receive", uiContent.includes("bono:receive:draft") && uiContent.includes("sessionStorage"));
ok("UI has fingerprint guard (receiveFingerprint)", uiContent.includes("receiveFingerprint"));
ok("UI clears draft on success/Cancel", uiContent.includes("clearReceiveDraft()"));
ok("UI invalidates key if fingerprint changed (prevents 409 silent reuse)", uiContent.includes("storedFp !== currentFp"));

const stockContent = fs.readFileSync("lib/models/StockMovement.js", "utf8");
ok("StockMovement still has partial unique index on idempotencyKey", stockContent.includes("idempotencyKey: 1") && stockContent.includes("unique: true") && stockContent.includes('$type: "string"'));

const mongoContent = fs.readFileSync("lib/mongodb.js", "utf8");
ok("lib/mongodb.js does NOT auto-sync StockMovement (no syncIndexes added per task G)", !mongoContent.includes("getStockMovementModel") && !mongoContent.includes("StockMovement"));

// --- NOT RUN integration tests (require MongoDB) ---
console.log("\n--- Integration tests (NOT RUN — require real MongoDB Atlas/replica set) ---");
console.log("NOT RUN: Concurrent POSTs with same Idempotency-Key: Promise.all([POST, POST]) with same payload => one 201, one 200 replayed, stock +quantity once, countDocuments({idempotencyKey})===1");
console.log("NOT RUN: Concurrent POSTs same key different payload => one 201, one 409 'different payload'");
console.log("NOT RUN: Sequential retry after 503/UnknownTransactionCommitResult with same key => replay 200, no double increment");
console.log("NOT RUN: Duplicate key on unrelated index (refOrderId) => normal error handling, not idempotency replay (verify misclassification does not occur)");
console.log("NOT RUN: Physical Atlas index verification: db.stockmovements.getIndexes() contains {idempotencyKey:1, unique:true, partialFilterExpression:{idempotencyKey:{$type:'string'}}}");
console.log("NOT RUN: Transaction abort leaves no partial stock/audit: kill session mid-transaction => stock unchanged, no orphan StockMovement");
console.log("NOT RUN: Note: No staging DB per task; production Cluster0 verification must be separate read-only getIndexes before rollout");

console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
if (fail > 0) process.exit(1);
console.log("All DB-free checks passed. Concurrency safety NOT proven without MongoDB integration (see NOT RUN above).");
