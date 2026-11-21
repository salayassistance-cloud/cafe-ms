// BONO Inventory — Phase 2, Step 8: offline sanitizer + validator tests.
//
// DB-free and fully synthetic. These tests import only pure modules
// (lib/offlineExport/*, lib/inventoryReservationRules.js) and the synthetic
// fixture builder; no MongoDB connection, environment file, or application
// service is ever loaded, so the test command cannot initiate database access.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  COLLECTIONS,
  ExportContractError,
  collisionCheck,
  createPseudonymizer,
} from "../lib/offlineExport/contract.mjs";
import { runSanitizer, sanitizeExport } from "../lib/offlineExport/sanitizer.mjs";
import { validateBundle } from "../lib/offlineExport/validator.mjs";
import {
  ID,
  SYNTHETIC_KEY_HEX,
  buildSyntheticDump,
  int,
  oid,
} from "./fixtures/offline-export/syntheticDump.mjs";
import {
  buildRequirementFingerprint,
  buildShortageFingerprint,
} from "../lib/inventoryReservationRules.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "bono-offline-export-"));
}

function writeDump(dir, dump) {
  mkdirSync(dir, { recursive: true });
  for (const collection of COLLECTIONS) {
    const docs = dump[collection] ?? [];
    const text = docs.length === 0 ? "" : `${docs.map((d) => JSON.stringify(d)).join("\n")}\n`;
    writeFileSync(join(dir, `${collection}.ndjson`), text, "utf8");
  }
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Independent HMAC helper (test-side re-derivation of §2 pseudonyms).
function pseudoOf(namespace, messageTail) {
  return crypto.createHmac("sha256", Buffer.from(SYNTHETIC_KEY_HEX, "hex"))
    .update(`${namespace}|${messageTail}`, "utf8").digest("hex").slice(0, 24);
}
const itemPseudoOf = (hex) => pseudoOf("item", `oid|${hex}`);
const PSEUDO = {
  item1: itemPseudoOf(ID.item1),
  item2: itemPseudoOf(ID.item2),
  item3: itemPseudoOf(ID.item3),
  item4: itemPseudoOf(ID.item4),
  item5: itemPseudoOf(ID.item5),
  legacy: pseudoOf("item", "str|legacy-item-id"),
  order1: pseudoOf("order", `oid|${ID.order1}`),
  order2: pseudoOf("order", `oid|${ID.order2}`),
  orderOrphan: pseudoOf("order", `oid|${ID.orderOrphan}`),
  line1: pseudoOf("orderline", `oid|${ID.line1}`),
  recipe1: pseudoOf("recipe", `oid|${ID.recipe1}`),
  recipe2: pseudoOf("recipe", `oid|${ID.recipe2}`),
  reservation1: pseudoOf("reservation", `oid|${ID.reservation1}`),
  reservation2: pseudoOf("reservation", `oid|${ID.reservation2}`),
};
const byId = (collection, pseudo) =>
  bundleRecords[collection].find((r) => r._id === pseudo);

// Shared pristine bundle built once for all tests.
const dumpDir = tempDir();
const bundleDir = tempDir();
const TIMESTAMP = "2026-11-15T00:00:00.000Z";
let manifest;
let bundleRecords = {};

before(() => {
  writeDump(dumpDir, buildSyntheticDump());
  manifest = runSanitizer({
    inputDir: dumpDir,
    outputDir: bundleDir,
    keyHex: SYNTHETIC_KEY_HEX,
    environmentLabel: "synthetic test",
    timestamp: TIMESTAMP,
  });
  for (const collection of COLLECTIONS) {
    const text = readFileSync(join(bundleDir, `${collection}.ndjson`), "utf8");
    bundleRecords[collection] =
      text.length === 0 ? [] : text.slice(0, -1).split("\n").map((l) => JSON.parse(l));
  }
});

after(() => {
  rmSync(dumpDir, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Positive round trip
// ---------------------------------------------------------------------------

describe("positive round trip", () => {
  test("the pristine synthetic bundle validates fail-closed clean", () => {
    const result = validateBundle(bundleDir);
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
  });

  test("document counts match the synthetic dump", () => {
    const expected = { inventoryitems: 6, recipes: 2, stockmovements: 3,
      inventoryaudits: 2, inventoryreservations: 2, orders: 2 };
    for (const collection of COLLECTIONS) {
      assert.equal(manifest.collections[collection].documentsWritten, expected[collection]);
      assert.equal(manifest.collections[collection].documentsRead, expected[collection]);
      assert.equal(bundleRecords[collection].length, expected[collection]);
    }
  });

  test("manifest carries the spec, key fingerprint and namespace stats", () => {
    assert.equal(manifest.spec, "docs/inventory-stored-unit-audit-export-spec.md");
    assert.equal(manifest.pseudonymKeyFingerprint, sha256(Buffer.from(SYNTHETIC_KEY_HEX, "hex")));
    assert.equal(manifest.namespaces.item.distinctRawCount, 8); // 6 items + orphan + string-drift id
    assert.equal(manifest.namespaces.item.distinctPseudonymCount, 8);
    assert.equal(manifest.namespaces.order.distinctRawCount, 3);
    assert.equal(manifest.namespaces.orderline.distinctRawCount, 1);
    assert.equal(manifest.namespaces.component.distinctRawCount, 1); // DECOR component excluded
    assert.equal(manifest.namespaces.recipe.distinctRawCount, 2);
    assert.equal(manifest.namespaces.reservation.distinctRawCount, 2);
  });

  test("the HMAC key, raw ids and mapping never appear in the bundle", () => {
    for (const collection of COLLECTIONS) {
      const text = readFileSync(join(bundleDir, `${collection}.ndjson`), "utf8");
      assert.ok(!text.includes(SYNTHETIC_KEY_HEX), `key leaked into ${collection}`);
      for (const raw of [ID.item1, ID.itemOrphan, ID.line1, ID.order1, ID.orderOrphan,
        ID.recipe1, ID.reservation1, ID.component1, "legacy-item-id"]) {
        assert.ok(!text.includes(raw), `raw id ${raw} leaked into ${collection}`);
      }
    }
    const manifestText = readFileSync(join(bundleDir, "manifest.json"), "utf8");
    assert.ok(!manifestText.includes(SYNTHETIC_KEY_HEX));
  });

  test("excluded business values never reach the export", () => {
    for (const collection of COLLECTIONS) {
      const text = readFileSync(join(bundleDir, `${collection}.ndjson`), "utf8");
      for (const forbidden of ["ORD-100", "WAITER", "menuItemId", "orderNumber",
        "waiterName", "secretNote", "free text"]) {
        assert.ok(!text.includes(forbidden), `"${forbidden}" leaked into ${collection}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism (§7.5)
// ---------------------------------------------------------------------------

describe("deterministic output", () => {
  test("record files are byte-identical across runs (timestamps differ)", () => {
    const outA = tempDir();
    const outB = tempDir();
    try {
      runSanitizer({ inputDir: dumpDir, outputDir: outA, keyHex: SYNTHETIC_KEY_HEX,
        timestamp: "2026-01-01T00:00:00.000Z" });
      runSanitizer({ inputDir: dumpDir, outputDir: outB, keyHex: SYNTHETIC_KEY_HEX,
        timestamp: "2026-02-02T00:00:00.000Z" });
      for (const collection of COLLECTIONS) {
        const a = readFileSync(join(outA, `${collection}.ndjson`));
        const b = readFileSync(join(outB, `${collection}.ndjson`));
        assert.ok(a.equals(b), `${collection}.ndjson not byte-identical across runs`);
      }
    } finally {
      rmSync(outA, { recursive: true, force: true });
      rmSync(outB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Pseudonymization (§2)
// ---------------------------------------------------------------------------

describe("pseudonymization", () => {
  test("identical raw ids map identically across collections", () => {
    const itemPseudo = PSEUDO.item1;
    assert.equal(byId("inventoryitems", itemPseudo)._id, itemPseudo);
    assert.equal(
      bundleRecords.recipes.flatMap((r) => r.ingredients).find((i) => i.inventoryItemId === itemPseudo)
        .inventoryItemId,
      itemPseudo
    );
    assert.equal(bundleRecords.stockmovements.find((r) => r.item === itemPseudo).item, itemPseudo);
    assert.equal(bundleRecords.inventoryaudits.find((r) => r.item === itemPseudo).item, itemPseudo);
    assert.equal(
      byId("inventoryreservations", PSEUDO.reservation1).items[0].inventoryItemId, itemPseudo);
    assert.equal(
      bundleRecords.orders.flatMap((o) => o.items.flatMap((it) => it.components ?? []))
        .find((c) => c.inventoryItemId === itemPseudo).inventoryItemId,
      itemPseudo
    );
  });

  test("orders lineId and voids lineId share one orderline pseudonym", () => {
    const linePseudo = PSEUDO.line1;
    const order = bundleRecords.orders.find(
      (o) => o.items.some((it) => it.lineId === linePseudo));
    const reservation = bundleRecords.inventoryreservations.find(
      (r) => (r.voids ?? []).some((v) => v.lineId === linePseudo));
    assert.equal(order.items[0].lineId, linePseudo);
    assert.equal(reservation.voids[0].lineId, linePseudo);
  });

  test("the same raw hex maps differently under different namespaces", () => {
    const p = createPseudonymizer(SYNTHETIC_KEY_HEX);
    const asItem = p.pseudonymize("item", { t: "oid", hex: ID.line1 });
    const asLine = p.pseudonymize("orderline", { t: "oid", hex: ID.line1 });
    assert.notEqual(asItem, asLine);
  });

  test("null stays null and missing stays absent", () => {
    const reservation2 = byId("inventoryreservations", PSEUDO.reservation2);
    assert.equal(reservation2.voids[1].lineId, null);
    const order2 = byId("orders", PSEUDO.order2);
    assert.ok(!("lineId" in order2.items[0]));
  });

  test("pseudonym equals an independently computed HMAC truncation", () => {
    const rec = byId("inventoryitems", PSEUDO.item1);
    assert.equal(rec._id, PSEUDO.item1);
  });

  test("string-id drift uses the |str| HMAC message", () => {
    const ingredient = bundleRecords.recipes
      .flatMap((r) => r.ingredients)
      .find((i) => i.inventoryItemId === PSEUDO.legacy);
    assert.equal(ingredient.inventoryItemId, PSEUDO.legacy);
  });
});

// ---------------------------------------------------------------------------
// Collision detection (§2.5, fail-closed)
// ---------------------------------------------------------------------------

describe("collision detection aborts the export", () => {
  test("collisionCheck flags two identities sharing one pseudonym", () => {
    const maps = new Map([["item", new Map([["oid:a", "aa"]])]]);
    const used = new Map([["aa", { ns: "item", rawKey: "oid:a" }]]);
    assert.throws(() => collisionCheck(maps, used, "item", "oid:b", "aa"),
      (err) => err instanceof ExportContractError && err.code === "PSEUDONYM_COLLISION");
  });

  test("collisionCheck flags cross-namespace pseudonym reuse", () => {
    const maps = new Map([["order", new Map()]]);
    const used = new Map([["aa", { ns: "item", rawKey: "oid:a" }]]);
    assert.throws(() => collisionCheck(maps, used, "order", "oid:x", "aa"),
      (err) => err instanceof ExportContractError && err.code === "PSEUDONYM_COLLISION");
  });

  test("collisionCheck accepts a repeated identical mapping", () => {
    const maps = new Map([["item", new Map([["oid:a", "aa"]])]]);
    const used = new Map([["aa", { ns: "item", rawKey: "oid:a" }]]);
    assert.equal(collisionCheck(maps, used, "item", "oid:a", "aa"), true);
  });

  test("a non-oid/str id fails closed and writes nothing", () => {
    const bad = buildSyntheticDump();
    bad.inventoryitems[0]._id = int(5); // int32 at an id position
    assert.throws(
      () => sanitizeExport({ docsByCollection: bad, keyHex: SYNTHETIC_KEY_HEX }),
      (err) => err instanceof ExportContractError && err.code === "INVALID_ID_TYPE"
    );
    const outDir = tempDir();
    try {
      const inDir = tempDir();
      writeDump(inDir, bad);
      assert.throws(() => runSanitizer({ inputDir: inDir, outputDir: outDir, keyHex: SYNTHETIC_KEY_HEX }));
      assert.deepEqual(readdirSync(outDir), [], "no partial output may be written");
      rmSync(inDir, { recursive: true, force: true });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("duplicate row _id in the dump aborts the export", () => {
    const bad = buildSyntheticDump();
    bad.inventoryitems[1]._id = oid(ID.item1);
    assert.throws(
      () => sanitizeExport({ docsByCollection: bad, keyHex: SYNTHETIC_KEY_HEX }),
      (err) => err.code === "DUPLICATE_ROW_ID"
    );
  });
});

// ---------------------------------------------------------------------------
// §4 Type-preserving serialization
// ---------------------------------------------------------------------------

describe("BSON type preservation (§4)", () => {
  test("negative zero double: JSON emits 0, qtyHex carries the sign bit", () => {
    const rec = byId("inventoryitems", PSEUDO.item3);
    assert.equal(rec.currentStock, 0); // JSON.stringify(-0) === "0"
    assert.equal(rec.qtyHex.currentStock, "8000000000000000"); // IEEE-754 BE
  });

  test("NaN and Infinity are tagged specials, never bare JSON", () => {
    assert.deepEqual(byId("inventoryitems", PSEUDO.item4).currentStock, { $special: "NaN" });
    assert.deepEqual(byId("inventoryitems", PSEUDO.item5).reservedStock, { $special: "Infinity" });
  });

  test("int32 / int64 / decimal128 keep their exact tagged forms", () => {
    assert.deepEqual(byId("inventoryitems", PSEUDO.item2).currentStock, { $int32: 5 });
    const mlIngredient = bundleRecords.recipes
      .flatMap((r) => r.ingredients)
      .find((i) => i.inventoryItemId === PSEUDO.item2);
    assert.deepEqual(mlIngredient.quantity, { $int64: "250" });
    assert.deepEqual(byId("inventoryitems", PSEUDO.item4).reservedStock, { $decimal128: "10.5" });
  });

  test("dates are emitted as $date UTC and unknown BSON types fail closed tagged", () => {
    const audit = bundleRecords.inventoryaudits.find((r) => r.item === PSEUDO.item4);
    // Snapshot leaves are sorted by path; "currentStock" is the only leaf here.
    assert.deepEqual(audit.beforeSnapshot[0].value,
      { $date: "2026-01-02T03:04:05.678Z" });
    assert.equal(audit.beforeSnapshot[0].valueType, "date");
    assert.deepEqual(audit.afterSnapshot[0].value, { $unknownBsonType: "5" });
    assert.equal(audit.afterSnapshot[0].valueType, "unknown:5");
  });

  test("drift counters record Decimal128 and unknown types without values", () => {
    assert.equal(manifest.collections.inventoryitems.drift.decimal128Count, 1);
    assert.equal(manifest.collections.inventoryitems.drift.decimal128HexCount, 0);
    assert.equal(manifest.collections.inventoryaudits.drift.unknownBsonTypeCount, 1);
    assert.deepEqual(manifest.collections.inventoryaudits.drift.unknownBsonTypes, { 5: 1 });
  });

  test("a bare JSON number in the dump input fails closed", () => {
    const bad = buildSyntheticDump();
    bad.inventoryitems[0].currentStock = 12.5; // not canonical Extended JSON
    assert.throws(
      () => sanitizeExport({ docsByCollection: bad, keyHex: SYNTHETIC_KEY_HEX }),
      (err) => err instanceof ExportContractError && err.code === "NON_CANONICAL_NUMBER"
    );
  });
});

// ---------------------------------------------------------------------------
// §5 Raw unit preservation
// ---------------------------------------------------------------------------

describe("raw unit preservation (§5)", () => {
  test("unit values are exported byte-exact with the §5 vocabulary", () => {
    const items = {
      kg: byId("inventoryitems", PSEUDO.item1),
      padded: byId("inventoryitems", PSEUDO.item2),
      empty: byId("inventoryitems", PSEUDO.item3),
      nullUnit: byId("inventoryitems", PSEUDO.item4),
      missing: byId("inventoryitems", PSEUDO.item5),
      whitespace: byId("inventoryitems", itemPseudoOf(ID.item6)),
    };
    assert.deepEqual(items.kg.unit, "kg");
    assert.equal(items.kg.unitStoredType, "string");
    assert.equal(items.kg.unitState, "value");
    // Padded text is a VALUE state — never trimmed (whole point of §5).
    assert.deepEqual(items.padded.unit, " KG ");
    assert.equal(items.padded.unitState, "value");
    assert.deepEqual(items.whitespace.unit, "   ");
    assert.equal(items.whitespace.unitState, "whitespace");
    assert.deepEqual(items.empty.unit, "");
    assert.equal(items.empty.unitState, "empty");
    assert.deepEqual(items.nullUnit.unit, null);
    assert.equal(items.nullUnit.unitStoredType, "null");
    assert.equal(items.missing.unitStoredType, "missing");
    assert.ok(!("unit" in items.missing));
  });

  test("manifest unit buckets reconcile per path", () => {
    const unitEntries = manifest.collections.inventoryitems.unitEntries;
    assert.deepEqual(unitEntries.unit, { missing: 1, null: 1, string: 4, nonString: 0 });
    const movements = manifest.collections.stockmovements.unitEntries;
    assert.deepEqual(movements.unit, { missing: 1, null: 1, string: 1, nonString: 0 });
  });

  test("aggregated unitStoredTypeCount totals match the per-path buckets", () => {
    const totals = manifest.collections.inventoryitems.drift.unitStoredTypeCount;
    assert.deepEqual(totals, { missing: 1, null: 1, string: 4, nonString: 0 });
  });
});

// ---------------------------------------------------------------------------
// H1 Mixed snapshot allow-list
// ---------------------------------------------------------------------------

describe("H1 Mixed snapshot allow-list", () => {
  test("only allow-listed leaves are exported, with exact dotted paths", () => {
    const a1 = bundleRecords.inventoryaudits.find((r) => r.item === PSEUDO.item1);
    assert.deepEqual(
      a1.beforeSnapshot.map((l) => l.path).sort(),
      ["beforeSnapshot.currentStock", "beforeSnapshot.unit"]
    );
    const unitLeaf = a1.beforeSnapshot.find((l) => l.path === "beforeSnapshot.unit");
    assert.deepEqual(unitLeaf.value, "kg");
    assert.equal(unitLeaf.unitStoredType, "string");
    assert.equal(unitLeaf.unitState, "value");
    // Null inside a snapshot stays null; nested allow-list keys are found.
    const afterPaths = a1.afterSnapshot.map((l) => l.path);
    assert.deepEqual(afterPaths.sort(), [
      "afterSnapshot.currentStock",
      "afterSnapshot.nested.unit",
      "afterSnapshot.stockUnit",
      "afterSnapshot.unit",
    ]);
    const nullUnit = a1.afterSnapshot.find((l) => l.path === "afterSnapshot.unit");
    assert.deepEqual(nullUnit.value, null);
    assert.equal(nullUnit.unitStoredType, "null");
    const nested = a1.afterSnapshot.find((l) => l.path === "afterSnapshot.nested.unit");
    assert.deepEqual(nested.value, "g");
    const padded = a1.afterSnapshot.find((l) => l.path === "afterSnapshot.stockUnit");
    assert.deepEqual(padded.value, " kg ");
    assert.equal(padded.unitState, "value");
  });

  test("unlisted snapshot keys are excluded and counted per path", () => {
    const unexpected = manifest.collections.inventoryaudits.drift.unexpectedKeyCount;
    assert.equal(unexpected["beforeSnapshot.secretNote"], 1);
    assert.equal(unexpected["beforeSnapshot.cost"], 1);
    assert.equal(unexpected["afterSnapshot.oddKey"], 1);
  });

  test("snapshot unit leaves are counted in the manifest", () => {
    const unitEntries = manifest.collections.inventoryaudits.unitEntries;
    assert.deepEqual(unitEntries.beforeSnapshot, { missing: 0, null: 0, string: 1, nonString: 0 });
    assert.deepEqual(unitEntries.afterSnapshot, { missing: 0, null: 1, string: 2, nonString: 0 });
  });
});

// ---------------------------------------------------------------------------
// §1 matrix exclusions
// ---------------------------------------------------------------------------

describe("matrix exclusions (§1)", () => {
  test("recipes.menuItemId is excluded", () => {
    const r2 = byId("recipes", PSEUDO.recipe2);
    assert.ok(!("menuItemId" in r2));
    // recipe2's string-id ingredient does not resolve to an exported item, so
    // it legitimately carries the orphan flag (L1) alongside the matrix keys.
    assert.deepEqual(
      Object.keys(r2).sort(),
      ["_id", "ingredients", "isActive", "orphan", "orphanRefs"]
    );
  });

  test("orders keep only audited component/line relationships", () => {
    const o1 = byId("orders", PSEUDO.order1);
    assert.deepEqual(Object.keys(o1), ["_id", "items"]);
    assert.equal(o1.items[0].components.length, 1); // DECOR filtered out
    assert.equal(o1.items[0].components[0].componentId !== undefined, true);
    assert.equal(manifest.collections.orders.drift.excludedComponentsCount, 1);
    const o2 = byId("orders", PSEUDO.order2);
    assert.deepEqual(o2.items[0], {}); // no lineId, no components
  });

  test("orphans are kept, flagged and counted (L1)", () => {
    const movement = bundleRecords.stockmovements.find((r) => r.orphan);
    assert.equal(movement.orphan, true);
    assert.deepEqual(movement.orphanRefs, ["item"]);
    assert.equal(manifest.collections.stockmovements.orphans.item, 1);
    const reservation = byId("inventoryreservations", PSEUDO.reservation2);
    assert.equal(reservation.orphan, true);
    assert.deepEqual(reservation.orphanRefs, ["orderId"]);
    assert.equal(manifest.collections.inventoryreservations.orphans.orderId, 1);
  });
});

// ---------------------------------------------------------------------------
// §3 Derived fingerprints
// ---------------------------------------------------------------------------

describe("derived fingerprints (§3)", () => {
  test("recomputed fingerprints equal an independent computation on real ids", () => {
    const r1 = byId("inventoryreservations", PSEUDO.reservation1);
    const rows = [{ inventoryItemId: ID.item1, unit: "kg", requiredQuantity: 0.5,
      availableAtDecision: 12.5, shortageQuantity: 0 }];
    assert.equal(r1.requirementFingerprint, "f".repeat(64)); // stored hash verbatim
    assert.equal(r1.recomputedRequirementFingerprint,
      buildRequirementFingerprint(ID.order1, rows));
    assert.equal(r1.recomputedShortageFingerprint,
      buildShortageFingerprint(r1.recomputedRequirementFingerprint, rows));
  });
});

// ---------------------------------------------------------------------------
// Fail-closed bundle validation (M3) — tampering cases
// ---------------------------------------------------------------------------

function copyBundle() {
  const dir = tempDir();
  cpSync(bundleDir, dir, { recursive: true });
  return dir;
}

function rewriteManifestDigests(dir) {
  const manifestPath = join(dir, "manifest.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const collection of COLLECTIONS) {
    m.collections[collection].sha256 =
      sha256(readFileSync(join(dir, `${collection}.ndjson`)));
  }
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, "utf8");
}

function editRecords(dir, collection, editFn) {
  const file = join(dir, `${collection}.ndjson`);
  const text = readFileSync(file, "utf8");
  const lines = text.slice(0, -1).split("\n").map((l) => JSON.parse(l));
  const edited = lines.map((r, i) => editFn(r, i));
  writeFileSync(file, `${edited.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

describe("validator rejects tampered bundles (fail-closed)", () => {
  test("any digest mismatch rejects the bundle", () => {
    const dir = copyBundle();
    try {
      const file = join(dir, "inventoryitems.ndjson");
      writeFileSync(file, `${readFileSync(file, "utf8")}`, "utf8"); // rewrite identical
      const bytes = readFileSync(file);
      bytes[bytes.length - 2] = 0x20; // flip trailing byte content
      writeFileSync(file, bytes);
      const result = validateBundle(dir);
      assert.equal(result.ok, false);
      assert.ok(result.violations.some((v) => v.code === "DIGEST_MISMATCH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file rejects the bundle in full", () => {
    const dir = copyBundle();
    try {
      rmSync(join(dir, "inventoryreservations.ndjson"));
      const result = validateBundle(dir);
      assert.equal(result.ok, false);
      assert.ok(result.violations.some((v) => v.code === "MISSING_FILE"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unexpected extra file rejects the bundle", () => {
    const dir = copyBundle();
    try {
      writeFileSync(join(dir, "extra.txt"), "x", "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "UNEXPECTED_FILE"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRLF line endings reject the bundle", () => {
    const dir = copyBundle();
    try {
      const file = join(dir, "recipes.ndjson");
      writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"), "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "CRLF"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a UTF-8 BOM rejects the bundle", () => {
    const dir = copyBundle();
    try {
      const file = join(dir, "recipes.ndjson");
      writeFileSync(file, `\uFEFF${readFileSync(file, "utf8")}`, "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "BOM"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing trailing newline rejects the bundle", () => {
    const dir = copyBundle();
    try {
      const file = join(dir, "recipes.ndjson");
      writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, ""), "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "TRAILING_NEWLINE"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("broken primary-key sort order rejects the bundle", () => {
    const dir = copyBundle();
    try {
      editRecords(dir, "stockmovements", (r, i) => r, undefined);
      const file = join(dir, "stockmovements.ndjson");
      const lines = readFileSync(file, "utf8").slice(0, -1).split("\n");
      const swapped = [lines[1], lines[0], lines[2]].join("\n") + "\n";
      writeFileSync(file, swapped, "utf8");
      rewriteManifestDigests(dir);
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "SORT_ORDER"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an injected excluded key rejects the bundle even with fixed digests", () => {
    const dir = copyBundle();
    try {
      editRecords(dir, "recipes", (r) => {
        if (!("isActive" in r)) return r;
        return { ...r, menuItemId: "x".repeat(24) };
      });
      rewriteManifestDigests(dir);
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "EXCLUDED_KEY_PRESENT"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a removed qtyHex map rejects the bundle even with fixed digests", () => {
    const dir = copyBundle();
    try {
      editRecords(dir, "inventoryitems", (r) => {
        const { qtyHex, ...rest } = r;
        void qtyHex;
        return rest;
      });
      rewriteManifestDigests(dir);
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "QTY_HEX_MISSING"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("qtyHex bits that contradict the number reject the bundle", () => {
    const dir = copyBundle();
    try {
      editRecords(dir, "inventoryitems", (r) => {
        if (!r.qtyHex || !r.qtyHex.currentStock) return r;
        return { ...r, qtyHex: { ...r.qtyHex, currentStock: "0000000000000000" } };
      });
      rewriteManifestDigests(dir);
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "QTY_HEX_BITS"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a document-count mismatch rejects the bundle", () => {
    const dir = copyBundle();
    try {
      const manifestPath = join(dir, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      m.collections.inventoryitems.documentsWritten = 99;
      writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "COUNT_MISMATCH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a documentsRead/documentsWritten mismatch rejects the bundle", () => {
    const dir = copyBundle();
    try {
      const manifestPath = join(dir, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      m.collections.orders.documentsRead = 1;
      writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "DOCUMENTS_READ_MISMATCH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removing an orphan flag rejects the bundle", () => {
    const dir = copyBundle();
    try {
      editRecords(dir, "stockmovements", (r) => {
        if (!r.orphan) return r;
        const { orphan, orphanRefs, ...rest } = r;
        void orphan;
        void orphanRefs;
        return rest;
      });
      rewriteManifestDigests(dir);
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "ORPHAN_FLAG"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupted pseudonym rejects the bundle", () => {
    const dir = copyBundle();
    try {
      editRecords(dir, "inventoryitems", (r, i) => {
        if (i !== 0) return r;
        return { ...r, _id: "zz" };
      });
      rewriteManifestDigests(dir);
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "PSEUDONYM_FORMAT"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a manifest namespace count mismatch rejects the bundle", () => {
    const dir = copyBundle();
    try {
      const manifestPath = join(dir, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      // Bump both counts so the manifest remains internally consistent and the
      // validator must catch the mismatch against the OBSERVED pseudonyms.
      m.namespaces.item.distinctRawCount += 1;
      m.namespaces.item.distinctPseudonymCount += 1;
      writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "NAMESPACE_COUNT_MISMATCH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a manifest unit-count mismatch rejects the bundle", () => {
    const dir = copyBundle();
    try {
      const manifestPath = join(dir, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      m.collections.inventoryitems.unitEntries.unit.string = 99;
      writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, "utf8");
      const result = validateBundle(dir);
      assert.ok(result.violations.some((v) => v.code === "UNIT_COUNT_MISMATCH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("violations are cumulative: multiple defects are all reported", () => {
    const dir = copyBundle();
    try {
      // Two independent per-file defects: a rewritten record file (digest
      // mismatch) plus a manifest count error. Neither breaks the file
      // inventory, so both must be reported together.
      writeFileSync(join(dir, "recipes.ndjson"),
        readFileSync(join(dir, "recipes.ndjson"), "utf8").replace("}", "]"), "utf8");
      const manifestPath = join(dir, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      m.collections.orders.documentsRead = 1;
      writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, "utf8");
      const result = validateBundle(dir);
      assert.equal(result.ok, false);
      assert.ok(result.violations.some((v) => v.code === "DIGEST_MISMATCH"));
      assert.ok(result.violations.some((v) => v.code === "DOCUMENTS_READ_MISMATCH"));
      assert.ok(result.violations.length >= 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
