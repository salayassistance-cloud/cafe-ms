# BONO Inventory — Phase 2, Step 8: Offline Sanitizer & Validator

**Status: IMPLEMENTED (offline tooling only). The real stored-unit audit remains BLOCKED.**

- Implementation date: **2026-11-15**
- Contract implemented: `docs/inventory-stored-unit-audit-export-spec.md` (Step 7 corrected)
- New files: `lib/offlineExport/contract.mjs`, `lib/offlineExport/exporters.mjs`,
  `lib/offlineExport/sanitizer.mjs`, `lib/offlineExport/validator.mjs`,
  `tests/fixtures/offline-export/syntheticDump.mjs`, `tests/offline-export-sanitizer.test.mjs`,
  `docs/offline-export-sanitizer-validator.md` (this document)
- Existing files modified: **none**
- Database connections / queries: **0** — every module is DB-free by construction
- `.env` / `.env.local` / secrets accessed: **no**
- Real data processed: **no** — all executed data is synthetic fixtures

This document records invocation, input/output formats, and limitations. It does
not authorize any real-data export; that requires the separate owner
authorization described in the export spec (§7) and
`docs/inventory-unit-owner-decisions.md`.

---

## 1. Pipeline overview

```
owner-run, offline:
  mongodump  →  bsondump  →  <inputDir>/<collection>.ndjson   (canonical Extended JSON v2)

agent-provided, offline (no MongoDB access anywhere in the code):
  sanitizer.mjs  --input <dumpdir> --output <bundledir> --key <64hex>
      →  <bundledir>/<collection>.ndjson + manifest.json
  validator.mjs  --bundle <bundledir>
      →  exit 0 "BUNDLE ACCEPTED" | exit 1 "BUNDLE REJECTED <violations>"
```

- The sanitizer **never touches MongoDB**. Its input is a directory of
  per-collection NDJSON files in canonical Extended JSON v2 — exactly what
  `bsondump --pretty=false` emits for each `.bson` file of a local `mongodump`.
  The owner runs `mongodump`/`bsondump` themselves, offline.
- The validator re-derives every check from the bundle bytes and the manifest;
  it does not trust any sanitizer claim.
- The HMAC key never appears in any output. Only its SHA-256 fingerprint
  (`pseudonymKeyFingerprint`) is written to the manifest, and no id→pseudonym
  mapping is exported anywhere.

## 2. Invocation

### Sanitizer

```
node lib/offlineExport/sanitizer.mjs --input <dir> --output <dir> --key <64-hex> \
    [--key-file <path>] [--environment-label <label>] [--timestamp <iso>] \
    [--corroboration <json-file>]
```

- `--input` must contain exactly the six collection files
  (`inventoryitems.ndjson`, `recipes.ndjson`, `stockmovements.ndjson`,
  `inventoryaudits.ndjson`, `inventoryreservations.ndjson`, `orders.ndjson`).
  Any extra/unknown file aborts.
- `--key` (or `--key-file` with a single-line 64-hex key) is the HMAC-SHA256
  pseudonymization key, 32 bytes. On any contract violation the export aborts
  in full — no partial output is written.
- `--timestamp` pins `exportedAt`; otherwise the wall clock is used (record
  bytes are unaffected either way — determinism holds per collection file).
- `--corroboration` embeds an owner-supplied JSON object (e.g. counts from the
  production audit) verbatim into the manifest.

Exit codes: `0` written; `1` export aborted (`EXPORT ABORTED (<code>)`);
`2` usage error.

### Validator

```
node lib/offlineExport/validator.mjs --bundle <dir>
```

Exit `0` only if every fail-closed check passes; otherwise exit `1` with one
line per violation `[<code>] <message>`.

## 3. Outputs

`<output>/<collection>.ndjson` — one JSON object per record, LF-terminated,
deterministic §7.5 canonical serialization (fixed key order, sorted `qtyHex`,
ascending primary sort: the row-identity pseudonym where `_id` is exported;
for `stockmovements`/`inventoryaudits` a deterministic content key — see §5
below).

`<output>/manifest.json`:

```jsonc
{
  "spec": "docs/inventory-stored-unit-audit-export-spec.md",
  "contractVersion": "1.0.0",
  "sanitizer": { "name": "bono-offline-sanitizer", "version": "1.0.0" },
  "exportedAt": "<iso>",
  "environmentLabel": "",
  "collectionFilter": "all documents, no filter",
  "inputFormat": "canonical Extended JSON v2 NDJSON (bsondump), offline",
  "pseudonymKeyFingerprint": "<sha256 of key>",
  "namespaces": { "<ns>": { "distinctRawCount": n, "distinctPseudonymCount": n } },
  "collections": {
    "<collection>": {
      "file": "<collection>.ndjson",
      "sha256": "<digest of the exported bytes>",
      "documentsRead": n,
      "documentsWritten": n,
      "unitEntries": { "<field path>": { "missing": n, "null": n, "string": n, "nonString": n } },
      "drift": {
        "unknownBsonTypeCount": n, "unknownBsonTypes": { "<code>": n },
        "decimal128Count": n, "decimal128HexCount": 0,
        "unitStoredTypeCount": { "missing": n, "null": n, "string": n, "nonString": n },
        "unexpectedKeyCount": { "<path>": n },
        "excludedComponentsCount": n,     // orders only
        "nullSnapshotCount": n            // inventoryaudits only
      },
      "orphans": { "<ref path>": n }
    }
  },
  "corroboration": { ... }  // only when supplied
}
```

## 4. Validator checks (all fail-closed; any violation rejects the bundle)

File inventory (exact expected set), manifest structure/completeness,
`contractVersion`, key fingerprint format, per-file sha256 digests, UTF-8 BOM,
CR/CRLF, trailing LF, JSON parseability (line-aligned `INVALID_JSON`, never a
crash), `documentsRead`/`documentsWritten` vs actual record counts, whitelisted
keys per record context (`EXCLUDED_KEY_PRESENT` on any non-contract key),
pseudonym format, fingerprint format, byte-identical canonical serialization,
`qtyHex` presence/format/bit-exactness vs the exported IEEE-754 BE value,
primary sort order and duplicate detection, §5 unit vocabulary
(`unitState` re-derived from content), unit-entry and unit-total reconciliation
against the manifest, unknown-BSON-type drift reconciliation, namespace counts
recomputed from observed pseudonyms, cross-namespace pseudonym reuse, and
orphan recomputation (flag presence, `orphanRefs` paths, per-path counts).

## 5. Documented elaborations and spec errata (recorded, not silently deviated)

1. **§7.5 primary sort for `stockmovements`/`inventoryaudits`** — these
   collections export no `_id`. The "primary pseudonym" is implemented as a
   deterministic content key (`<item pseudonym>|<canonical record JSON>`),
   tie-broken only by input order, preserving determinism.
2. **§4 `-0` parenthetical erratum** — the spec's parenthetical
   (`0000000000000080`) contradicts the same row's "IEEE-754 **big-endian**
   hex" rule. The big-endian rule wins: negative zero is emitted as
   `8000000000000000` in `qtyHex` (JSON body emits `0`). Covered by tests.
3. **`decimal128HexCount` is always `0`** — the Extended JSON v2 input
   (`bsondump` output) carries Decimal128 values as decimal strings, not
   16-byte big-endian hex, so the sanitizer cannot produce §4's hex form.
   The manifest field is present for spec-compatibility and the limitation is
   recorded here. If the hex form is ever required, the owner must supply
   `.bson` bytes (BSON Decimal128 payload) instead of Extended JSON.
4. **§3 derived fingerprints** — `recomputedRequirementFingerprint` /
   `recomputedShortageFingerprint` are computed with the runtime's own pure
   rules (`lib/inventoryReservationRules.js`) over real ids **before**
   pseudonymization, so the recomputation matches what the live system would
   have produced.
5. **`documentsRead` is attested, not proven** — the sanitizer reports the
   number of documents actually parsed from the supplied dump files; it cannot
   prove those files contain everything the owner's database held. The owner's
   corroboration (counts, digests) is the attestation mechanism.

## 6. Security properties

- HMAC-SHA256, per-namespace messages (`<ns>|oid|<hex>` or `<ns>|str|<stored
  string>`), truncated to 24 hex chars (96 bits), consistent with 24-char
  ObjectId shape.
- Namespace separation: the same raw hex under two namespaces yields different
  pseudonyms; cross-namespace pseudonym reuse aborts the export.
- Collision policy is fail-closed: any two distinct identities mapping to one
  pseudonym aborts the export with no partial output (`PSEUDONYM_COLLISION`).
- The key and the id→pseudonym mapping never leave the sanitizer process;
  tests assert neither the key nor any raw id appears in any output file.
- Orphaned references (items/orders/lines not present in the export) are
  **kept and flagged** (`orphan: true`, `orphanRefs`), never dropped.

## 7. Tests

```
node --test tests/offline-export-sanitizer.test.mjs     # 50 tests, all passing
```

Synthetic-only, DB-free: the suite imports only the pure offline modules and
the fixture builder; no MongoDB connection, environment file, or application
service is loaded, so the test command cannot initiate database access. The
fixture key `SYNTHETIC_KEY_HEX = "11".repeat(32)` is a public test constant,
not a credential. Coverage: positive round trip, determinism, §2
pseudonymization (incl. namespace separation, null/missing passthrough,
string-id drift, independent HMAC re-derivation), collision fail-closed,
§4 type preservation (`-0`, NaN/±Infinity, int32/int64/Decimal128, dates,
unknown BSON types, bare-number rejection), §5 unit states (value/empty/
whitespace/null/missing, never normalized), H1 snapshot allow-list (nested
leaves, excluded-key counting), §1 matrix exclusions (`menuItemId`, non-priced
components), §3 derived fingerprints (independent recomputation), §7.5
canonical bytes, and 15 tampering cases (digest, missing/extra file, BOM, CRLF,
trailing newline, sort order, injected excluded key, removed/incorrect
`qtyHex`, count mismatches, orphan-flag removal, corrupted pseudonym,
namespace-count mismatch, cumulative violations).

Regression safety: `node --test tests/inventory-unit-adapter.test.mjs
tests/inventory-requirement-conversion.test.mjs` — 67/67 passing; no existing
runtime file was modified.

## 8. Status of the real-data audit

The sanitizer and validator are implemented and tested against synthetic data
only. The real stored-unit audit remains **BLOCKED** pending the owner-run
`mongodump`/`bsondump` step and the separate export authorization described in
the export spec §7 and the disposable audit document. No real data has been
processed, and no database connection exists anywhere in this code path.
