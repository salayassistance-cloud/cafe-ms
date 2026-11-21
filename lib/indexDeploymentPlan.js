// Inventory V1 index deployment plan — pure, offline, dependency-free.
//
// Companion to the guarded `scripts/sync-indexes.js` deployment command. This
// module contains NO database access, NO mongoose import, and NO side effects:
// it derives the index plan from live Mongoose schemas (passed in by the
// caller) and classifies conflicts between the plan and an existing index
// list, so the deployment script can fail closed BEFORE any createIndexes()
// call.
//
// Coverage (Phase 2.4 gap statement, see
// docs/production-readiness/phase-2-4-production-database-checklist.md §9.4):
// InventoryItem, InventoryReservation, StockMovement, PaymentInfo. The five
// models already covered by the script (orders, staffs, categories,
// menuitems, inventoryaudits) keep their existing path unchanged.

// The four inventory collections whose correctness-critical indexes were not
// previously deployed by any repository script. `conflictScan` marks the
// collections that receive an explicit read-only legacy-index pre-check
// before any additive build. PaymentInfo defines no schema indexes today; it
// is listed so the deployment explicitly reports that nothing needs creating
// instead of the collection being silently absent from the plan.
export const INVENTORY_INDEX_MODELS = Object.freeze([
  Object.freeze({
    label: "inventoryitems",
    collection: "inventoryitems",
    module: "../lib/models/InventoryItem.js",
    getter: "getInventoryItemModel",
    conflictScan: true,
  }),
  Object.freeze({
    label: "inventoryreservations",
    collection: "inventoryreservations",
    module: "../lib/models/InventoryReservation.js",
    getter: "getInventoryReservationModel",
    conflictScan: true,
  }),
  Object.freeze({
    label: "stockmovements",
    collection: "stockmovements",
    module: "../lib/models/StockMovement.js",
    getter: "getStockMovementModel",
    conflictScan: true,
  }),
  Object.freeze({
    label: "paymentinfos",
    collection: "paymentinfos",
    module: "../lib/models/PaymentInfo.js",
    getter: "getPaymentInfoModel",
    conflictScan: true,
  }),
]);

// Reproduce the index name the MongoDB server generates for a key when no
// explicit `name` option is set: `<field>_<direction>` joined by `_`.
// Mongoose schemas in this repository do not set explicit index names, so
// these are the exact names `createIndexes()` will use.
export function mongooseIndexName(key) {
  return Object.entries(key || {})
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

// Build the deployment plan for one model from its Mongoose schema.
// `schema.indexes()` returns `[keyObject, optionsObject]` pairs — the exact
// definitions `model.createIndexes()` will send. Pure and offline.
export function buildIndexPlan(model) {
  return (model.schema.indexes() || []).map(([key, options]) => ({
    name: mongooseIndexName(key),
    key: deepFreezeCopy(key),
    options: deepFreezeCopy(options || {}),
  }));
}

function deepFreezeCopy(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepFreezeCopy(value[k]);
  return Object.freeze(out);
}

// Key fields of an index spec, in declaration order (directions ignored).
function keyFields(key) {
  return Object.keys(key || {});
}

// Classify conflicts between the indexes that exist on a collection and the
// schema-derived plan. Read-only input; pure output. Never suggests an
// automatic remedy — every conflict carries manual, owner-gated guidance.
//
// Conflict kinds:
//   NAME_TAKEN      — an existing index has the same generated name as a
//                     planned index but a different key/options. createIndexes
//                     would fail with IndexOptionsConflict (85/86).
//   SUPERSEDED_PREFIX — an existing index whose key is a strict leading subset
//                     of a planned compound key (e.g. the documented legacy
//                     unique `(refOrderId, reason)` under the new
//                     `(refOrderId, reason, item)`). createIndexes succeeds,
//                     but BOTH indexes then apply: a legacy unique prefix
//                     rejects every multi-ingredient order even though the new
//                     index is correct.
export function findLegacyConflicts(existingSpecs, plannedSpecs) {
  const conflicts = [];
  const existing = Array.isArray(existingSpecs) ? existingSpecs : [];

  for (const planned of plannedSpecs || []) {
    for (const current of existing) {
      const currentKey = normalizeKey(current.key || current);
      const currentOpts = current.options || {};
      const plannedFields = keyFields(planned.key);
      const currentFields = keyFields(currentKey);

      if (current.name === planned.name) {
        const sameKey = stableJson(currentKey) === stableJson(planned.key);
        const sameOpts = stableJson(normalizeOptions(currentOpts)) === stableJson(normalizeOptions(planned.options));
        if (!sameKey || !sameOpts) {
          conflicts.push({
            kind: "NAME_TAKEN",
            collection: null, // filled in by the caller context
            indexName: current.name,
            existing: { key: currentKey, options: summarizeOptions(currentOpts) },
            planned: { key: planned.key, options: summarizeOptions(planned.options) },
            guidance: REMOVAL_GATE_TEXT,
          });
        }
        continue;
      }

      // Strict leading-subset check (same field order, fewer fields).
      const isPrefix =
        currentFields.length < plannedFields.length &&
        plannedFields.slice(0, currentFields.length).every((f, i) => f === currentFields[i]);
      if (isPrefix) {
        conflicts.push({
          kind: "SUPERSEDED_PREFIX",
          collection: null,
          indexName: current.name,
          existing: { key: currentKey, options: summarizeOptions(currentOpts) },
          planned: { key: planned.key, options: summarizeOptions(planned.options) },
          unique: currentOpts.unique === true,
          guidance: REMOVAL_GATE_TEXT,
        });
      }
    }
  }
  return conflicts;
}

export const REMOVAL_GATE_TEXT = [
  "Legacy index conflicts with a planned correctness-critical index.",
  "Do NOT proceed and do NOT remove the conflicting index automatically.",
  "Required procedure (separately reviewed and owner-gated):",
  "  1. Run the read-only duplicate preflight for the collection",
  "     (docs/production-readiness/phase-2-4-production-database-checklist.md §8.5).",
  "  2. Obtain an owner-approved change/ticket reference for the removal.",
  "  3. In a separately approved maintenance window, an operator manually runs",
  "     a dropIndex command for the conflicting index — never in the same",
  "     operation as, and never before, the duplicate preflight passes.",
  "  4. Re-run this deployment command with --confirm afterwards.",
  "This command never drops, rebuilds, or modifies an existing index.",
].join("\n");

function normalizeKey(key) {
  const out = {};
  for (const [k, v] of Object.entries(key || {})) {
    out[k] = typeof v === "string" ? v.toLowerCase() : v;
  }
  return out;
}

function normalizeOptions(options) {
  const { background, ...rest } = options || {}; // deployment-machinery noise
  void background;
  return rest;
}

function summarizeOptions(options) {
  const summary = {};
  for (const k of ["unique", "sparse", "partialFilterExpression", "expireAfterSeconds", "collation"]) {
    if (options && options[k] !== undefined) summary[k] = options[k];
  }
  return summary;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
