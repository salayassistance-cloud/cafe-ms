// lib/offlineExport/exporters.mjs — per-collection record builders for the
// BONO offline sanitized export (Phase 2, Step 8).
//
// Pure: consumes the typed trees produced by contract.parseCanonicalValue and
// a sanitizer-owned context (pseudonymizer + counters). Implements the §1
// field matrix exactly: P = pseudonymize, R = raw verbatim, N = §4 typed,
// D = derived hash only, E = excluded. H1: Mixed snapshots are deep-scanned
// against the fixed allow-list only. DB-free; no mongoose/mongodb import.

import {
  ExportContractError,
  classifyUnit,
  emitTypedLeaf,
  hmacMessage,
  unitTag,
} from "./contract.mjs";

// H1 — Mixed snapshot allow-list (fixed; the exporter never extends it).
export const SNAPSHOT_UNIT_KEYS = Object.freeze(["unit", "stockUnit"]);
export const SNAPSHOT_NUMERIC_KEYS = Object.freeze([
  "currentStock",
  "quantity",
  "stockQuantity",
  "requiredQuantity",
  "availableQuantity",
  "shortageQuantity",
  "beforeStock",
  "afterStock",
]);

// A raw id string (ObjectId hex or stored string) for §3 fingerprint inputs.
function rawIdString(idNode) {
  if (idNode.t === "oid") return idNode.hex;
  if (idNode.t === "str") return idNode.s;
  throw new ExportContractError("INVALID_ID_TYPE", "id node is not oid/str");
}

function requireNode(doc, key, collection) {
  const entry = (doc.e ?? []).find(([k]) => k === key);
  if (!entry) {
    throw new ExportContractError("INVALID_INPUT_LINE",
      `${collection}: missing required field ${key}`);
  }
  return entry[1];
}

function optionalNode(doc, key) {
  const entry = (doc.e ?? []).find(([k]) => k === key);
  return entry ? entry[1] : undefined;
}

function asDoc(node, path) {
  if (node.t === "doc") return node;
  if (node.t === "null") return null;
  throw new ExportContractError("INVALID_INPUT_LINE", `expected document at ${path}`);
}

// Pseudonymize an id node; null stays null, missing stays absent.
function pseudoId(ctx, namespace, node, path) {
  if (node === undefined) return { absent: true };
  if (node.t === "null") return { value: null };
  hmacMessage(namespace, node); // fail closed on non oid/str types
  const pseudo = ctx.pseudonymize(namespace, node);
  return { value: pseudo, rawKey: node.t === "oid" ? `oid:${node.hex}` : `str:${node.s}` };
}

// Unit field export per §5: value (raw, never normalized) + vocabulary.
function unitField(ctx, collection, path, node) {
  const c = classifyUnit(node);
  if (c.missing) {
    ctx.countUnit(collection, path, "missing");
    return { missing: true };
  }
  if (c.unitStoredType === "null") {
    ctx.countUnit(collection, path, "null");
    return { value: null, unitStoredType: "null" };
  }
  if (c.unitStoredType === "string") {
    ctx.countUnit(collection, path, "string");
    return { value: c.node.s, unitStoredType: "string", unitState: c.unitState };
  }
  ctx.countUnit(collection, path, "nonString");
  ctx.countDrift(collection, "unitStoredTypeNonString");
  const leaf = emitTypedLeaf(c.node);
  return { value: leaf.value, unitStoredType: c.unitStoredType };
}

// N-mode numeric field export per §4 (type-preserving, never coerced).
function numericField(ctx, collection, node) {
  const leaf = emitTypedLeaf(node);
  if (leaf.valueType === "decimal128") ctx.countDrift(collection, "decimal128");
  if (leaf.valueType.startsWith("unknown:")) {
    ctx.countDrift(collection, "unknownBsonType", String(leaf.valueType.slice(8)));
  }
  return leaf.value;
}

// ---------------------------------------------------------------------------
// H1 bounded snapshot deep-scan
// ---------------------------------------------------------------------------

export function scanSnapshot(ctx, collection, snapshotField, node, out, counters) {
  const prefix = snapshotField;
  if (node === undefined) return;
  if (node.t === "null") {
    counters.nullSnapshots += 1;
    return;
  }
  walk(node, prefix);

  function walk(cur, path) {
    if (cur.t === "doc") {
      for (const [k, v] of cur.e) {
        const childPath = path ? `${path}.${k}` : k;
        if (SNAPSHOT_UNIT_KEYS.includes(k)) {
          if (v.t === "null") {
            out.push({ path: childPath, value: null, valueType: "null", unitStoredType: "null" });
            ctx.countUnit(collection, snapshotField, "null");
            counters.snapshotUnits += 1;
          } else if (v.t === "str") {
            const c = classifyUnit(v);
            out.push({
              path: childPath,
              value: v.s,
              valueType: "string",
              unitStoredType: "string",
              unitState: c.unitState,
            });
            ctx.countUnit(collection, snapshotField, "string");
            counters.snapshotUnits += 1;
          } else {
            const leaf = emitTypedLeaf(v);
            out.push({
              path: childPath,
              value: leaf.value,
              valueType: leaf.valueType,
              unitStoredType: `nonString:${unitTag(v)}`,
            });
            ctx.countUnit(collection, snapshotField, "nonString");
            counters.snapshotUnits += 1;
            if (leaf.valueType.startsWith("unknown:")) {
              ctx.countDrift(collection, "unknownBsonType", String(leaf.valueType.slice(8)));
            }
          }
        } else if (SNAPSHOT_NUMERIC_KEYS.includes(k)) {
          const leaf = emitTypedLeaf(v);
          out.push({ path: childPath, value: leaf.value, valueType: leaf.valueType });
          if (leaf.valueType === "decimal128") ctx.countDrift(collection, "decimal128");
          if (leaf.valueType.startsWith("unknown:")) {
            ctx.countDrift(collection, "unknownBsonType", String(leaf.valueType.slice(8)));
          }
        } else if (v.t === "doc" || v.t === "arr") {
          // Nested containers: recurse (allow-list keys may appear at any depth).
          walk(v, childPath);
        } else {
          // Unlisted key: never exported; counted by key name + path (L2).
          counters.unexpected.set(childPath, (counters.unexpected.get(childPath) ?? 0) + 1);
        }
      }
      return;
    }
    if (cur.t === "arr") {
      cur.e.forEach((v, i) => {
        const childPath = `${path}.${i}`;
        if (v.t === "doc" || v.t === "arr") walk(v, childPath);
        else counters.unexpected.set(path, (counters.unexpected.get(path) ?? 0) + 1);
      });
      return;
    }
    counters.unexpected.set(path, (counters.unexpected.get(path) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// Collection exporters
// ---------------------------------------------------------------------------

function exportInventoryItem(doc, ctx) {
  const collection = "inventoryitems";
  const record = {};
  record._id = pseudoId(ctx, "item", requireNode(doc, "_id", collection), "_id").value;
  const unit = unitField(ctx, collection, "unit", optionalNode(doc, "unit"));
  if (!unit.missing) {
    record.unit = unit.value;
    record.unitStoredType = unit.unitStoredType;
    if (unit.unitState !== undefined) record.unitState = unit.unitState;
  } else {
    record.unitStoredType = "missing";
  }
  if (optionalNode(doc, "currentStock") !== undefined) {
    record.currentStock = numericField(ctx, collection, optionalNode(doc, "currentStock"));
  }
  if (optionalNode(doc, "reservedStock") !== undefined) {
    record.reservedStock = numericField(ctx, collection, optionalNode(doc, "reservedStock"));
  }
  return record;
}

function exportRecipe(doc, ctx) {
  const collection = "recipes";
  const record = {};
  record._id = pseudoId(ctx, "recipe", requireNode(doc, "_id", collection), "_id").value;
  const ingredients = optionalNode(doc, "ingredients");
  record.ingredients = ingredients && ingredients.t === "arr"
    ? ingredients.e.map((ing, i) => {
        const row = {};
        const ingDoc = asDoc(ing, `ingredients[${i}]`);
        const ingRef = pseudoId(ctx, "item",
          requireNode(ingDoc, "inventoryItemId", collection), "ingredients[].inventoryItemId");
        row.inventoryItemId = ingRef.value;
        if (ingRef.rawKey) row.rawItemKey = ingRef.rawKey;
        const unit = unitField(ctx, collection, "ingredients[].unit",
          optionalNode(ingDoc, "unit"));
        if (!unit.missing) {
          row.unit = unit.value;
          row.unitStoredType = unit.unitStoredType;
          if (unit.unitState !== undefined) row.unitState = unit.unitState;
        } else {
          row.unitStoredType = "missing";
        }
        if (optionalNode(ingDoc, "quantity") !== undefined) {
          row.quantity = numericField(ctx, collection, optionalNode(ingDoc, "quantity"));
        }
        return row;
      })
    : [];
  const isActive = optionalNode(doc, "isActive");
  if (isActive !== undefined) {
    if (isActive.t !== "bool") {
      throw new ExportContractError("INVALID_INPUT_LINE", "recipes.isActive must be boolean");
    }
    record.isActive = isActive.b;
  }
  return record;
}

function exportStockMovement(doc, ctx) {
  const collection = "stockmovements";
  const record = {};
  const item = pseudoId(ctx, "item", requireNode(doc, "item", collection), "item");
  record.item = item.value;
  record.rawItemKey = item.rawKey;
  const unit = unitField(ctx, collection, "unit", optionalNode(doc, "unit"));
  if (!unit.missing) {
    record.unit = unit.value;
    record.unitStoredType = unit.unitStoredType;
    if (unit.unitState !== undefined) record.unitState = unit.unitState;
  } else {
    record.unitStoredType = "missing";
  }
  if (optionalNode(doc, "quantity") !== undefined) {
    record.quantity = numericField(ctx, collection, optionalNode(doc, "quantity"));
  }
  const type = optionalNode(doc, "type");
  if (type !== undefined && type.t === "str") record.type = type.s;
  const reason = optionalNode(doc, "reason");
  if (reason !== undefined && reason.t === "str") record.reason = reason.s;
  return record;
}

function exportInventoryAudit(doc, ctx) {
  const collection = "inventoryaudits";
  const record = {};
  const item = pseudoId(ctx, "item", requireNode(doc, "item", collection), "item");
  record.item = item.value;
  record.rawItemKey = item.rawKey;
  const unit = unitField(ctx, collection, "unit", optionalNode(doc, "unit"));
  if (!unit.missing) {
    record.unit = unit.value;
    record.unitStoredType = unit.unitStoredType;
    if (unit.unitState !== undefined) record.unitState = unit.unitState;
  } else {
    record.unitStoredType = "missing";
  }
  const action = optionalNode(doc, "action");
  if (action !== undefined && action.t === "str") record.action = action.s;
  for (const key of ["quantityDelta", "beforeStock", "afterStock"]) {
    if (optionalNode(doc, key) !== undefined) {
      record[key] = numericField(ctx, collection, optionalNode(doc, key));
    }
  }
  const counters = { unexpected: new Map(), snapshotUnits: 0, nullSnapshots: 0 };
  const before = optionalNode(doc, "beforeSnapshot");
  const after = optionalNode(doc, "afterSnapshot");
  const leavesBefore = [];
  const leavesAfter = [];
  scanSnapshot(ctx, collection, "beforeSnapshot", before, leavesBefore, counters);
  scanSnapshot(ctx, collection, "afterSnapshot", after, leavesAfter, counters);
  if (leavesBefore.length > 0) record.beforeSnapshot = leavesBefore;
  if (leavesAfter.length > 0) record.afterSnapshot = leavesAfter;
  record.__snapshotCounters = counters;
  return record;
}

function exportReservation(doc, ctx) {
  const collection = "inventoryreservations";
  const record = {};
  record._id = pseudoId(ctx, "reservation", requireNode(doc, "_id", collection), "_id").value;
  const orderId = pseudoId(ctx, "order", requireNode(doc, "orderId", collection), "orderId");
  record.orderId = orderId.value;
  record.rawOrderKey = orderId.rawKey;
  const status = optionalNode(doc, "status");
  if (status !== undefined && status.t === "str") record.status = status.s;

  const itemsNode = optionalNode(doc, "items");
  const items = itemsNode && itemsNode.t === "arr" ? itemsNode.e : [];
  record.items = items.map((it, i) => {
    const itDoc = asDoc(it, `items[${i}]`);
    const row = {};
    const itemRef = pseudoId(ctx, "item",
      requireNode(itDoc, "inventoryItemId", collection), "items[].inventoryItemId");
    row.inventoryItemId = itemRef.value;
    row.rawItemKey = itemRef.rawKey;
    const unit = unitField(ctx, collection, "items[].unit", optionalNode(itDoc, "unit"));
    if (!unit.missing) {
      row.unit = unit.value;
      row.unitStoredType = unit.unitStoredType;
      if (unit.unitState !== undefined) row.unitState = unit.unitState;
    } else {
      row.unitStoredType = "missing";
    }
    for (const key of ["requiredQuantity", "reservedQuantity", "shortageQuantity",
      "availableAtDecision", "consumedQuantity"]) {
      if (optionalNode(itDoc, key) !== undefined) {
        row[key] = numericField(ctx, collection, optionalNode(itDoc, key));
      }
    }
    return row;
  });

  for (const key of ["requirementFingerprint", "shortageFingerprint"]) {
    const n = optionalNode(doc, key);
    if (n !== undefined && n.t === "str") record[key] = n.s;
  }

  const approvalNode = asDoc(optionalNode(doc, "approval") ?? { t: "null" }, "approval");
  if (approvalNode) {
    const approval = {};
    for (const key of ["requirementFingerprint", "shortageFingerprint"]) {
      const n = optionalNode(approvalNode, key);
      if (n !== undefined && n.t === "str") approval[key] = n.s;
    }
    const shortagesNode = optionalNode(approvalNode, "shortages");
    approval.shortages = shortagesNode && shortagesNode.t === "arr"
      ? shortagesNode.e.map((s, i) => {
          const sDoc = asDoc(s, `approval.shortages[${i}]`);
          const row = {};
          const sRef = pseudoId(ctx, "item",
            requireNode(sDoc, "inventoryItemId", collection),
            "approval.shortages[].inventoryItemId");
          row.inventoryItemId = sRef.value;
          if (sRef.rawKey) row.rawItemKey = sRef.rawKey;
          const unit = unitField(ctx, collection, "approval.shortages[].unit",
            optionalNode(sDoc, "unit"));
          if (!unit.missing) {
            row.unit = unit.value;
            row.unitStoredType = unit.unitStoredType;
            if (unit.unitState !== undefined) row.unitState = unit.unitState;
          } else {
            row.unitStoredType = "missing";
          }
          for (const key of ["requiredQuantity", "availableQuantity", "shortageQuantity"]) {
            if (optionalNode(sDoc, key) !== undefined) {
              row[key] = numericField(ctx, collection, optionalNode(sDoc, key));
            }
          }
          return row;
        })
      : [];
    if (approval.shortages.length > 0 || approval.requirementFingerprint ||
        approval.shortageFingerprint) {
      record.approval = approval;
    }
  }

  const trigger = optionalNode(doc, "consumedTrigger");
  if (trigger !== undefined && trigger.t === "str") record.consumedTrigger = trigger.s;

  const voidsNode = optionalNode(doc, "voids");
  record.voids = voidsNode && voidsNode.t === "arr"
    ? voidsNode.e.map((v, i) => {
        const vDoc = asDoc(v, `voids[${i}]`);
        const row = {};
        for (const key of ["phase", "source", "station"]) {
          const n = optionalNode(vDoc, key);
          if (n !== undefined && n.t === "str") row[key] = n.s;
        }
        const line = pseudoId(ctx, "orderline",
          optionalNode(vDoc, "lineId"), "voids[].lineId");
        if (!line.absent) row.lineId = line.value ?? null;
        if (line.value) row.rawLineKey = line.rawKey;
        const vItems = optionalNode(vDoc, "items");
        row.items = vItems && vItems.t === "arr"
          ? vItems.e.map((vi, j) => {
              const viDoc = asDoc(vi, `voids[${i}].items[${j}]`);
              const vRow = {};
              const ref = pseudoId(ctx, "item",
                requireNode(viDoc, "inventoryItemId", collection),
                "voids[].items[].inventoryItemId");
              vRow.inventoryItemId = ref.value;
              vRow.rawItemKey = ref.rawKey;
              const unit = unitField(ctx, collection, "voids[].items[].unit",
                optionalNode(viDoc, "unit"));
              if (!unit.missing) {
                vRow.unit = unit.value;
                vRow.unitStoredType = unit.unitStoredType;
                if (unit.unitState !== undefined) vRow.unitState = unit.unitState;
              } else {
                vRow.unitStoredType = "missing";
              }
              if (optionalNode(viDoc, "quantity") !== undefined) {
                vRow.quantity = numericField(ctx, collection, optionalNode(viDoc, "quantity"));
              }
              return vRow;
            })
          : [];
        return row;
      })
    : [];
  return record;
}

function exportOrder(doc, ctx) {
  const collection = "orders";
  const record = {};
  record._id = pseudoId(ctx, "order", requireNode(doc, "_id", collection), "_id").value;
  const itemsNode = optionalNode(doc, "items");
  const items = itemsNode && itemsNode.t === "arr" ? itemsNode.e : [];
  record.items = items.map((it, i) => {
    const itDoc = asDoc(it, `items[${i}]`);
    const row = {};
    const line = pseudoId(ctx, "orderline", optionalNode(itDoc, "lineId"), "items[].lineId");
    if (!line.absent) row.lineId = line.value ?? null;
    if (line.rawKey) row.rawLineKey = line.rawKey;
    const componentsNode = optionalNode(itDoc, "components");
    const components = componentsNode && componentsNode.t === "arr" ? componentsNode.e : [];
    const exported = [];
    for (let j = 0; j < components.length; j += 1) {
      const cDoc = asDoc(components[j], `items[${i}].components[${j}]`);
      const kind = optionalNode(cDoc, "kind");
      // §1.6: filter to PRICED_COMPONENT only; others are excluded entirely.
      if (!kind || kind.t !== "str" || kind.s !== "PRICED_COMPONENT") {
        ctx.noteExcludedComponent(collection);
        continue;
      }
      const row2 = {};
      const compRef = pseudoId(ctx, "component",
        requireNode(cDoc, "componentId", collection),
        "items[].components[].componentId");
      row2.componentId = compRef.value;
      const itemRef = pseudoId(ctx, "item",
        requireNode(cDoc, "inventoryItemId", collection),
        "items[].components[].inventoryItemId");
      row2.inventoryItemId = itemRef.value;
      if (itemRef.rawKey) row2.rawItemKey = itemRef.rawKey;
      const unit = unitField(ctx, collection, "items[].components[].stockUnit",
        optionalNode(cDoc, "stockUnit"));
      if (!unit.missing) {
        row2.stockUnit = unit.value;
        row2.unitStoredType = unit.unitStoredType;
        if (unit.unitState !== undefined) row2.unitState = unit.unitState;
      } else {
        row2.unitStoredType = "missing";
      }
      if (optionalNode(cDoc, "stockQuantity") !== undefined) {
        row2.stockQuantity = numericField(ctx, collection,
          optionalNode(cDoc, "stockQuantity"));
      }
      exported.push(row2);
    }
    if (exported.length > 0) row.components = exported;
    return row;
  });
  return record;
}

export const EXPORTERS = {
  inventoryitems: exportInventoryItem,
  recipes: exportRecipe,
  stockmovements: exportStockMovement,
  inventoryaudits: exportInventoryAudit,
  inventoryreservations: exportReservation,
  orders: exportOrder,
};

export { rawIdString };
