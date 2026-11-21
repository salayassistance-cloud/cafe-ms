# BONO Inventory — Real Stored-Unit Audit Preflight (Owner-Executable Package)

**Status: PREFLIGHT PACKAGE ONLY — PREPARATION DOCUMENTATION. THE REAL STORED-UNIT
AUDIT REMAINS BLOCKED. NOTHING IN THIS DOCUMENT AUTHORIZES DATABASE ACCESS OR
EXPORT EXECUTION.**

- Prepared: **2026-11-15**
- **Update 2026-11-15 (Stage 1–2 preparation, documentation only):** the owner
  has recorded the target database selection — `hotel_management`, the POS data
  store, owner-confirmed. Atlas role-creation checklist, collection-level
  permissions, the empirical `listDatabases` procedure, and credential-free
  evidence templates are now embedded in Stage 2. **The real stored-unit audit
  REMAINS BLOCKED**: this update authorizes no connection, no dump, no role or
  user change executed by anyone but the owner, and no export. Selection of the
  target does not prove what the collections contain and is not an export
  authorization.
- Deliverable: this document only. Files modified: **none**. Runtime behavior
  changed: **none**. Database connections: **0**. `.env`/`.env.local`/secrets
  accessed: **no**. `mongodump`/`bsondump`/sanitizer run against real data: **no**.
- Every command below is executed **by the owner, on the owner's approved
  environment, offline where indicated**. The audit agent never connects to any
  database; the only data the audit consumes is a validated sanitized bundle
  transferred per Stage 7.
- Placeholders in `<angle brackets>` are **owner-supplied**; none is invented
  here. No database name, credential, path, or connection string appears in or
  behind this document.

## 0. Authoritative sources reconciled

| # | Source | What this package draws from it |
|---|---|---|
| 1 | `docs/inventory-stored-unit-audit-export-spec.md` (Step 7 corrected, owner-approved) | §1 matrix/exclusions, §2 pseudonymization/collisions, §3 fingerprints, §4 serialization, §5 unit vocabulary, §6 evidence layers, §7 manifest/integrity/transfer, §8 ambiguities, §9 M1–M5 |
| 2 | `docs/inventory-stored-unit-audit-export-readiness-review.md` (Step 6, PASS WITH CORRECTIONS) | Corrections H1/H2/M1–M4/L1–L4 (all applied and verified in the corrected spec) and the 9-point prerequisite checklist (§ "Prerequisites checklist") |
| 3 | `docs/inventory-stored-unit-audit.md` (Step 4) | Why the audit is BLOCKED: no approved, explicitly named target; production `hotel_management` excluded absent separate authorization |
| 4 | `docs/inventory-stored-unit-disposable-audit.md` (Step 4) | Synthetic evidence boundaries (§7) and the four evidence classes the real export must supply (§8); disposable DB cleanup stays owner-review-only |
| 5 | `docs/offline-export-sanitizer-validator.md` (Step 8) | The implemented, offline-tested sanitizer/validator commands, output formats, and documented limitations |
| 6 | `docs/inventory-unit-owner-decisions.md` (M1–M5 approved; A7/A8 deferred) | Policy in force; §5.2: any implementation needs its own explicit narrow authorization; no policy is re-decided here |

Step 6 prerequisite checklist status at preparation time:

| Prerequisite | Status |
|---|---|
| 1. Corrections H1/H2/M1/M2 + Medium/Low applied to the spec | **Done** (verified in corrected spec; 353 → 500 lines) |
| 2. Owner approves corrected specification by name | **Done** (recorded in owner-decisions/Step 7 documents) |
| 3. Sanitizer separately authorized, source-reviewed, offline-tested | **Done** (Step 8; 50/50 offline tests; no DB code path) |
| 4. Offline validation script separately authorized | **Done** (Step 8 independent validator) |
| 5. Dedicated least-privilege read-only role created | **☐ Owner action — Stage 2** (checklist and templates now embedded in Stage 2) |
| 6. Owner names the approved target database explicitly | **Recorded 2026-11-15: `hotel_management`** (owner-selected POS data store; collection contents **not yet proven**; separate export authorization still required — see Stage 1) |
| 7. Log-evidence window configured with documented restore step | **☐ Owner action — Stage 3/8** |
| 8. Transfer channel agreed; digests verified at receipt | **☐ Owner action — Stage 7** |
| 9. Audit unblocked only after all of the above + separate export authorization | **BLOCKED — see §9** |

---

## 1. Stage sequence, artifacts, stop conditions, evidence

Overview:

```
Stage 1  Authorization + target naming          (owner, offline decision)
Stage 2  Least-privilege role + tool version    (owner, on approved environment)
Stage 3  Evidence window open                   (owner; parameter change, not a data write)
Stage 4  mongodump + bsondump                   (owner; read-only extraction, offline)
Stage 5  Sanitizer (offline)                    (owner; key never leaves the machine)
Stage 6  Independent validator (offline)        (owner; BUNDLE ACCEPTED required)
Stage 7  Digest-verified transfer               (owner → audit; sanitized bundle only)
Stage 8  Receipt checks + evidence close-out    (acceptance, then role/log/key teardown)
```

A stage may start only when the previous stage's evidence exists. **Any stop
condition aborts the run**: the partial artifacts are not used, the cause is
corrected, and the affected stages re-run from their start.

### Stage 1 — Authorization and target naming

Owner actions:

1. Record a **separate, explicit export authorization** covering: the exact
   stages below, the exact database named in action 2, the six collection
   names, and the transfer of the sanitized bundle. Approval of the spec, of
   the owner decisions, or of Step 8 implementation does **not** constitute
   this authorization (owner-decisions §5.2; spec §10).
2. **Name the target database explicitly** — by exact name, chosen by the
   owner. It must be a database the owner is authorized to export from. Per
   `docs/inventory-stored-unit-audit.md` §7, the production store
   (`hotel_management` on Atlas) may be named only under a separate written
   production-read authorization; a development/test copy is otherwise
   required. No name is guessed by anyone else, ever.

   **RECORDED 2026-11-15:** the owner has selected **`hotel_management`** as
   the target database for the BONO POS stored-unit audit and confirmed it is
   the POS data store. Two boundaries apply, recorded with the selection:

   - **Selection does not prove collection contents.** That the six audited
     collections exist in `hotel_management` with real stored data is an
     expectation to be verified in Stage 4 (pre/post document counts,
     `listCollections` under the export role, dump artifact set) — not a fact
     established by the selection statement.
   - **Selection does not authorize export.** Stage 1's separate, explicit
     export authorization (action 1) remains outstanding; the production-store
     status of `hotel_management` makes that gate load-bearing, not
     procedural.
3. Decide and record the **evidence-window bounds** (start/end UTC) and who
   holds the HMAC key.

Expected artifacts: a dated owner statement containing the authorization
sentence, the exact database name, the collection set (the six names from spec
§1), and the window bounds.

Stop conditions: no explicit export authorization; no named target; named
target is production without a separate production authorization.

Evidence retained: the owner statement (date, authorization text, database
name, window bounds). Database name may enter the manifest's
`environmentLabel` **only if** the owner separately approves that (spec §7.1);
otherwise a neutral label such as "approved environment, name withheld" is
used.

### Stage 2 — Least-privilege role and tooling verification

Owner actions:

1. **Verify tool versions** and record them (they go into the corroboration
   record, not the code):
   ```
   mongodump --version
   bsondump --version
   mongosh --version   (for the Stage 3 parameter command)
   ```
   Required: MongoDB Database Tools versions whose `mongodump` behavior against
   the target server version is known. The exact values are **owner-supplied
   evidence** (Stage 2d template) — none is assumed here. **Version-dependent
   privilege check (review M2):** determine empirically (Stage 2c) whether the
   chosen `mongodump` issues cluster-scope `listDatabases` even when `--db` is
   given; grant the extra action only if the empirical result requires it.
2. **Create the custom read-only role** scoped to the single approved database
   only (spec §6.1, review M2) — full checklist in Stage 2a/2b:
   - `find` on exactly the six approved collections of `hotel_management`;
     db-scoped `listCollections`/`listIndexes` for `mongodump`'s metadata needs;
   - the single cluster-scope `listDatabases` action **only if** the empirical
     Stage 2c result requires it — never by default;
   - no `readWrite`, no `dbAdminAnyDatabase`, no cluster-wide privileges, no
     other databases, `roles: []` (no inheritance);
   - `--oplog` is prohibited (it reads `local.oplog.rs`), so no oplog privilege
     is granted.
   Record the **role definition (name + privilege document, never
   credentials)** as part of the Stage 8 corroboration record (template:
   Stage 2e).
3. Create/use the dedicated export user with that role. Credentials are typed
   locally only — never pasted into chat, scripts, or files that leave the
   machine.

Expected artifacts: tool version strings; role name + privilege document;
user name (no credentials); Stage 2c empirical result.

Stop conditions: tool version cannot be determined; the target server rejects
role creation; the owner is unwilling/unable to restrict privileges to the
single database; the optional Stage 2e negative write probe unexpectedly
**succeeds** (role over-privileged — correct before any export).

Evidence retained: version outputs; role definition document; Stage 2c
empirical result; Stage 2e verification record.

#### Stage 2a — Atlas custom role creation (owner-executed; documented here only)

On Atlas, custom database roles are created in the project console (Database →
Advanced → **Custom Roles**) or through the Atlas Administration API/CLI; the
exact console wording varies between Atlas versions, so the owner follows their
console's Custom Roles editor. The definition below is MongoDB-standard and is
what must exist regardless of the creation surface. An owner with sufficient
project access may equivalently create the identical definition with `mongosh`
against the target:

```js
use admin
db.createRole({
  role: "<owner-chosen-role-name>",
  privileges: [
    { resource: { db: "hotel_management", collection: "inventoryitems" },
      actions: ["find"] },
    { resource: { db: "hotel_management", collection: "recipes" },
      actions: ["find"] },
    { resource: { db: "hotel_management", collection: "stockmovements" },
      actions: ["find"] },
    { resource: { db: "hotel_management", collection: "inventoryaudits" },
      actions: ["find"] },
    { resource: { db: "hotel_management", collection: "inventoryreservations" },
      actions: ["find"] },
    { resource: { db: "hotel_management", collection: "orders" },
      actions: ["find"] },
    // db-level metadata mongodump needs (collection "" = the whole database):
    { resource: { db: "hotel_management", collection: "" },
      actions: ["listCollections", "listIndexes"] },
  ],
  roles: []
})
```

Creation checklist:

| ☐ | Item |
|---|---|
| ☐ | Role name chosen by the owner (placeholder `<owner-chosen-role-name>` above is **not** a suggested name) |
| ☐ | Exactly six collection-scoped `find` privileges, per the approved §1 matrix set — nothing added, nothing broader |
| ☐ | One db-scoped privilege for `listCollections` + `listIndexes` (mongodump metadata; no document data) |
| ☐ | Optional `collStats` on the same db resource **only if** the owner wants size corroboration (spec §7.1 mentions it; the implemented sanitizer does not require it) |
| ☐ | No `listDatabases` at creation — added only via the Stage 2c empirical result |
| ☐ | `roles: []` — no inherited roles, so no built-in `read` expansion beyond the listed actions |
| ☐ | Dedicated export user created and assigned **only** this role; credentials typed locally, never shared |
| ☐ | Role definition (name + privilege document, no credentials) captured into the Stage 2e template |

#### Stage 2b — Why exactly these collection-level permissions

- The six collection names (`inventoryitems`, `recipes`, `stockmovements`,
  `inventoryaudits`, `inventoryreservations`, `orders`) are **not invented** —
  they are the approved export matrix set (spec §1), previously verified
  field-by-field against the Mongoose schemas in the Step 6 review (each model
  registers an explicit collection name).
- `find` is the only document-data action granted, and only on those six
  collections. Whatever else `hotel_management` contains is invisible to this
  role — no other collection name is assumed or listed here.
- `listCollections`/`listIndexes` at db scope return metadata only (collection
  and index names/shapes); they are what `mongodump` enumerates before reading.
- Collection-scoping (rather than db-wide `read`) is the tighter form of the
  spec's §6.1 "read on the approved database": it bounds the blast radius of
  any sanitizer/tool defect to the audited set.
- Server-enforced read-only (spec §6.1): with no write action granted, any
  write attempt by the export user is rejected by the server itself, and the
  refusal surfaces in server logs — writes become *impossible*, not merely
  unobserved.

#### Stage 2c — Empirical `listDatabases` verification (never granted by default)

The review's M2 point: built-in `read` lacks cluster-scope `listDatabases`, yet
some `mongodump` versions issue `listDatabases` even when `--db` is given.
Whether **this** version requires it is determined empirically, without
granting the action "to be safe":

1. Create the role **without** `listDatabases` (Stage 2a).
2. Open the Stage 3 evidence window (`slowOpThresholdMs: 0`).
3. Run the Stage 4 `mongodump` attempt under the export user.
   - **If it completes:** the verified version does not require the action.
     Record `NOT REQUIRED`; the action is never granted. The success itself is
     the evidence.
   - **If it fails with an authorization error naming `listDatabases`**
     (MongoDB error code 13, `Unauthorized`): the verified version requires it.
     Add **exactly one** cluster action to the role —
     `{resource: {cluster: true}, actions: ["listDatabases"]}` — via the same
     creation surface (Atlas role edit), then re-run the dump from a clean
     dump directory so the authoritative artifact set comes from one complete
     pass. Record `REQUIRED` with the log excerpt as evidence.
4. Scope note (spec §6.1): `listDatabases` returns database **names and sizes
   only**, never document data — this is why the action is grantable at all;
   it is still added only when empirically necessary.
5. The failed attempt (if any) reads no data and writes nothing; pre/post
   document counts are unaffected. Its log line is part of the evidence
   package, and the grant + re-run are recorded in the corroboration record.
6. **Never** grant `listDatabases` speculatively: an unneeded cluster action
   weakens the least-privilege claim and the spec's evidence layer 1.

#### Stage 2d — Version evidence template (owner-supplied; fill in, never estimate)

```
VERSION EVIDENCE — export environment
  Date (UTC):                    <owner fills>
  MongoDB server version:        <owner fills>   (mongosh --quiet --eval "db.version()")
  mongodump version:             <owner fills>   (mongodump --version)
  bsondump version:              <owner fills>   (bsondump --version)
  mongosh version:               <owner fills>   (mongosh --version)
  Node.js runtime (export machine): <owner fills> (node --version)
  Database Tools ↔ server compatibility: <owner fills> (confirmed by the owner
      against the MongoDB Database Tools compatibility notes for the recorded
      versions)
  listDatabases requirement:     <REQUIRED | NOT REQUIRED>  (evidence: Stage 2c)
  Notes: the Step 8 sanitizer/validator were developed and tested against
  Node v24.14.0; behavior on a materially older owner runtime is not asserted,
  so the recorded value is reviewed before Stage 5 rather than assumed fine.
```

#### Stage 2e — Role verification evidence template (credential-free)

Everything pasted into this template is checked against one rule: **no
connection string, host, password, secret, or API key may appear.** Outputs
are scrubbed by the owner before archiving (the commands below print user and
role **names**, which are the only identity data retained).

```
ROLE VERIFICATION EVIDENCE
  Date (UTC):                       <owner fills>
  Target database:                  hotel_management
  Role name:                        <owner-chosen-role-name>
  Privilege document (verbatim):    <paste the createRole privileges exactly as
                                     created — the document contains no credentials
                                     by construction; verify no credential-shaped
                                     string before archiving>
  Export user name:                 <owner fills, or "withheld by owner">
  Verification 1 — connectionStatus:
      command:  db.runCommand({ connectionStatus: 1 })   (run AS the export user)
      expected: authenticated user + exactly the custom role; no inherited roles
      output:   <scrubbed>
  Verification 2 — role privileges:
      command:  db.getSiblingDB("admin").getRole("<owner-chosen-role-name>",
                   { showPrivileges: true })
      expected: exactly the Stage 2a privilege list (six collection finds +
                listCollections/listIndexes; listDatabases only per Stage 2c)
      output:   <scrubbed>
  Verification 3 (optional, before the Stage 3 window) — negative write probe:
      action:   as the export user, attempt a harmless insert into a clearly
                named scratch collection of the target database
      expected: Unauthorized (code 13) — its refusal in the server log is the
                spec §6.1 "server-enforced impossibility" evidence
      IF THE PROBE UNEXPECTEDLY SUCCEEDS: STOP. The role is over-privileged;
                correct the role before any export. The scratch document the
                probe created is removed by the owner and the incident is
                recorded in the evidence package.
  Empirical listDatabases result:   <REQUIRED | NOT REQUIRED> (Stage 2c)
  Confirmed absent from the role:   readWrite, dbAdminAnyDatabase, any
                                    cluster-scoped action beyond the Stage 2c
                                    result, any inherited role
  Recorded by:                      <owner designation>
```


### Stage 3 — Evidence window opened (server parameter change, not a data write)

Owner actions (spec §6.3, review M1):

1. Record the pre-change value:
   ```
   mongosh ... --quiet --eval "db.adminCommand({getParameter: 1, slowOpThresholdMs: 1})"
   ```
2. Activate full per-command logging for the window:
   ```
   mongosh ... --quiet --eval "db.adminCommand({setParameter: 1, slowOpThresholdMs: 0})"
   ```
   (Optionally raise the `COMMAND` component verbosity as well.) This is a
   server **parameter** change — not a write to any collection.
3. Record the exact window **start time (UTC)**.

Stop conditions: the owner cannot change server parameters (then the log layer
of evidence cannot be produced and the export cannot proceed under the spec's
evidence requirements — escalate before continuing).

Evidence retained: pre-change value, activation timestamp.

### Stage 4 — Extraction: `mongodump` + `bsondump` (read-only, then offline)

Owner actions:

1. Run `mongodump` **against the approved database only**, to a local
   directory. The **first attempt doubles as the Stage 2c empirical
   `listDatabases` test**: if it fails on an `Unauthorized` `listDatabases`
   error, complete Stage 2c (grant the single cluster action, record the
   evidence) and re-run from a clean dump directory. Safe invocation
   requirements (spec §6.2/§7.3):
   - `--db <approved-database>` and the approved collection set; no other
     database;
   - **no `--oplog`** (prohibited, review M2); `--gzip` is neither required nor
     prohibited;
   - the URI/credentials are typed locally, never pasted into chat or scripts;
   - no writes are possible by construction (tool contains no write path; the
     Stage 2 role would reject any anyway).
2. Immediately after, verify the log evidence: filter the mongod log to the
   window and the export user's connections; the only commands must be `find` /
   `listCollections` / `listIndexes` / `listDatabases`. Record pre/post
   per-collection document counts (equality expected) and the server-wide
   opcounters delta — both as **corroborating, non-attributable** context only.
3. Convert the dump to the sanitizer's input format — canonical Extended JSON
   v2 NDJSON, one file per collection:
   ```
   for each dumped <collection>.bson:
       bsondump --type=canonical <collection>.bson > <dumpdir>/<collection>.ndjson
   ```
   `--type=canonical` is required: the sanitizer parses canonical Extended JSON
   v2 (tagged scalars, e.g. `{"$numberDouble":"12.5"}`), exactly what
   `bsondump` canonical mode emits; relaxed mode would emit bare JSON numbers
   and the sanitizer fails closed on those (`NON_CANONICAL_NUMBER`).
4. **Ensure all six input files exist even for empty collections:**
   `inventoryitems.ndjson`, `recipes.ndjson`, `stockmovements.ndjson`,
   `inventoryaudits.ndjson`, `inventoryreservations.ndjson`, `orders.ndjson`.
   `mongodump` does not create a `.bson` file for an empty collection — in that
   case the owner creates the corresponding empty (zero-byte) `.ndjson` file.
   The sanitizer requires every one of the six files to be present (an empty
   file is valid; a missing file is an abort).

Expected artifacts: local dump directory; six `<collection>.ndjson` files
(canonical Extended JSON v2; possibly empty); log excerpt; count/opcounter
notes.

Stop conditions: **any command outside `find`/`listCollections`/`listIndexes`/
`listDatabases` appears in the window** (spec §6.3.4: the export is treated as
failed evidence, the sanitized data from that window is not used, and the
export re-runs after investigation); a write attempt by the export user is
recorded in the log (impossible-by-construction check failed); any dump file
for a collection outside the approved set appears; count mismatch pre/post.

Evidence retained: log excerpt with connection/user context; activation and
restoration timestamps; pre/post counts; opcounters delta (context only);
tool versions.

### Stage 5 — Sanitizer (offline; the key never leaves the owner's machine)

Owner actions (`docs/offline-export-sanitizer-validator.md` §2):

```
node lib/offlineExport/sanitizer.mjs ^
  --input <dumpdir-with-ndjson> ^
  --output <bundledir> ^
  --key-file <locally-generated-64-hex-key-file> ^
  --environment-label <owner-approved-label> ^
  --timestamp <iso-utc> ^
  --corroboration <owner-corroboration.json>
```

- The key: locally generated, 32 random bytes as 64 hex characters, stored only
  locally, never transferred, never pasted into chat. Only its SHA-256
  fingerprint (`pseudonymKeyFingerprint`) appears in the manifest.
- `--corroboration` (owner-supplied JSON object, carried verbatim into the
  manifest) is the manifest carrier for the facts the offline sanitizer cannot
  observe itself (see §5, limitation L-4). Recommended contents — names and
  counts only, never credentials: tool names/versions, role definition
  (name + privileges), window start/end timestamps and restoration timestamp,
  pre/post per-collection document counts, opcounters delta, export operator
  designation, and — only if the owner approves — the database name.
- Determinism check required by spec §7.5: re-run the sanitizer once locally
  into a second output directory with the same key, input, and timestamp, and
  verify byte-identity of every collection file:
  ```
  node lib/offlineExport/sanitizer.mjs ... --output <bundledir-2> ...
  fc /b <bundledir>\<c>.ndjson <bundledir-2>\<c>.ndjson   (for each of the six)
  ```
  Every pair must be byte-identical. A difference is a stop condition.
- Owner spot checks (spec §7.3.4): manifest digests; a few raw unit samples
  visible only to the owner; absence of excluded field names (automated — the
  Stage 6 validator's whitelist scan rejects any non-contract key; the owner
  may additionally grep the bundle for the §7.4 exclusion names, e.g.
  `menuItemId`, `waiterInfo`, `idempotencyKey`, `totalCost` — absence expected).

Expected artifacts: `<bundledir>` with six `<collection>.ndjson` +
`manifest.json`; a second byte-identical bundle; spot-check notes.

Stop conditions: any sanitizer abort (`EXPORT ABORTED (<code>)` — e.g.
`PSEUDONYM_COLLISION`, `INVALID_ID_TYPE`, `NON_CANONICAL_NUMBER`,
`DUPLICATE_ROW_ID`, missing input file); the sanitizer must have produced
**no partial output** (fail-closed all-or-nothing, verified by Step 8 tests);
byte-identity failure on regeneration; key or any raw id discovered in any
output file.

Evidence retained: manifest (this is the bundle's integrity record); the
owner's spot-check note; confirmation that the dump and key remain local.

### Stage 6 — Independent validator (offline; fail-closed)

Owner actions:

```
node lib/offlineExport/validator.mjs --bundle <bundledir>
```

Required outcome: `BUNDLE ACCEPTED — all contract checks passed.` (exit 0).
The validator re-derives every check from the bundle bytes and manifest — it
trusts nothing from the sanitizer (file inventory, digests, encoding, counts,
canonical serialization, whitelist keys, pseudonym format, `qtyHex` bit
exactness, sort order, unit vocabulary, namespace counts, cross-namespace
reuse, orphan recomputation, drift counters).

Stop conditions: **any violation line / exit 1**. A partially valid bundle is
never accepted; the cause is corrected and Stage 5–6 re-run.

Evidence retained: the acceptance run's output text.

### Stage 7 — Digest-verified transfer (sanitized bundle only)

Owner actions:

1. Transfer **only** the six `.ndjson` files and `manifest.json`. Never the
   key, never the dump, never any mapping table (spec §7.3.5; review §9 PASS).
2. Digest verification at both ends:
   ```
   (owner side)   certify / sha256sum / Get-FileHash  → per-file SHA-256 (must equal manifest.sha256)
   (audit side)   independently recompute SHA-256 of every received file and compare
   ```
   The manifest itself must also be covered (its bytes are hashed out-of-band
   per the agreed channel, or the owner states the manifest digest in the
   transfer note).
3. The audit agent's acceptance re-run (`validator.mjs --bundle`) must end in
   `BUNDLE ACCEPTED` on the received copy.

**Receipt rule (M3, spec §7.2):** on **any** digest mismatch, missing file,
unexpected extra file, or document/count/namespace-count mismatch, the entire
bundle is rejected — no partial acceptance, no per-file rescue. The owner
corrects the cause and performs a **new verified transfer**; the audit
consumes only a bundle whose every check passes. Validator rejection codes
that fire here include `DIGEST_MISMATCH`, `MISSING_FILE`, `UNEXPECTED_FILE`,
`BOM`, `CRLF`, `TRAILING_NEWLINE`, `INVALID_JSON`, `COUNT_MISMATCH`,
`DOCUMENTS_READ_MISMATCH`, `NON_CANONICAL_SERIALIZATION`, `EXCLUDED_KEY_PRESENT`,
`PSEUDONYM_FORMAT`, `QTY_HEX_*`, `SORT_ORDER`, `DUPLICATE_PRIMARY`,
`NAMESPACE_*`, `UNIT_*`, `ORPHAN_*`, `DRIFT_COUNT_MISMATCH`,
`MANIFEST_*`.

Expected artifacts: transfer note with per-file digests; audit-side acceptance
output.

Stop conditions: any digest mismatch; any unexpected file in the transfer;
acceptance failure on the received copy.

### Stage 8 — Receipt, acceptance, and close-out

After audit-side acceptance:

1. Owner tears down the evidence window and privileges, recording timestamps:
   - restore `slowOpThresholdMs` to its pre-change value (Stage 3's recorded
     value) and lower verbosity if raised;
   - drop the export role (and user) after the window closes (spec §6.1);
   - archive the log excerpt, activation/restoration timestamps, role
     definition, tool versions, and pre/post counts as the export's evidence
     package.
2. Owner deletes the local dump directory and the key file **after** the
   transfer is accepted (spec §7.3.5).
3. The audit then (and only then) proceeds offline: pseudonym-preserving unit
   distributions, adapter classification, fingerprint stored-vs-recomputed
   comparison (mismatches are findings, not defects), orphan-inclusive counts —
   per spec §9 M1–M5 and the disposable audit's §8 evidence list.
4. The disposable database `bono_unit_audit_disposable_20261115_a1` remains
   untouched; its cleanup stays owner-review-only (disposable-audit §9).

---

## 2. Consolidated prerequisite checklist

### A. Owner decisions and confirmations required

| ☐ | Item | Source |
|---|---|---|
| ☐ | Explicit, narrowly scoped export authorization for the exact stages, database (`hotel_management`), and collection set — **still outstanding** | owner-decisions §5.2; spec §10 |
| ☐ | Exact target database named by the owner — **Recorded 2026-11-15: `hotel_management`** (owner-selected POS store; contents unproven; export authorization separate) | Step 4 audit §7; review prereq 6 |
| ☐ | Confirmation that the six collections are the complete approved set ("all documents, no filter") | spec §7.1 |
| ☐ | Approval of the environment label wording (database name enters the manifest only if separately approved) | spec §7.1 |
| ☐ | Owner-supplied corroboration content (counts, opcounters, window times, role definition) | spec §7.1; §5 L-4 below |
| ☐ | M1–M5 remain in force unchanged; no new alias, no backfill, no re-decision | owner-decisions; spec §9 |
| ☐ | Assignment of who holds the HMAC key and where the key file lives (local only) | spec §7.3 |

### B. Least-privilege role capabilities required

| ☐ | Item |
|---|---|
| ☐ | Custom role (not bare built-in `read`) scoped to the single approved database: `read` actions on that database only |
| ☐ | Single cluster-scope action `{resource: {cluster: true}, actions: ["listDatabases"]}` **only if** the verified `mongodump` version requires it (review M2); otherwise omitted |
| ☐ | No `readWrite`, no `dbAdminAnyDatabase`, no cluster-wide roles, no other databases, no oplog privileges |
| ☐ | Dedicated export user; credentials typed locally, never shared in chat/scripts |
| ☐ | Role definition (name + privilege document, never credentials) recorded for the evidence package and the corroboration record |
| ☐ | Role (and user) dropped after the export window closes |

### C. Owner-selected target database

| ☐ | Item |
|---|---|
| ☐ | Exact database name supplied by the owner in writing (Stage 1) — **Recorded 2026-11-15: `hotel_management`** |
| ☐ | Database contains the six collections with the real stored data to audit — **☐ still unproven; verified in Stage 4** |
| ☐ | Production `hotel_management` named under a separate written authorization — **Recorded: owner selection statement 2026-11-15 (target selection only; explicitly not an export authorization)** |
| ☐ | No URI/credential in chat, scripts, or this document — local typing only |

### D. Evidence-window logging and restoration

| ☐ | Item |
|---|---|
| ☐ | Pre-change `slowOpThresholdMs` value recorded (Stage 3) |
| ☐ | `setParameter slowOpThresholdMs: 0` activated at window start; activation timestamp recorded |
| ☐ | Window start/end UTC + (where feasible) export user connection id(s) noted |
| ☐ | Post-window log filtered to the window + export user; only `find`/`listCollections`/`listIndexes`/`listDatabases` present |
| ☐ | Log excerpt archived (with connection/user context) |
| ☐ | `slowOpThresholdMs` (and verbosity, if raised) restored; restoration timestamp recorded |
| ☐ | Any out-of-set command in the window ⇒ export treated as failed evidence; data not used; re-run after investigation |
| ☐ | `db.setProfilingLevel(2)` NOT used anywhere (it would write `system.profile`) |
| ☐ | Optional (Enterprise only): audit filter on the export user for write actions |

### E. `mongodump` / `bsondump` versions and safe invocation

| ☐ | Item |
|---|---|
| ☐ | `mongodump --version`, `bsondump --version`, `mongosh --version` recorded |
| ☐ | Version compatibility with the target server version confirmed by the owner |
| ☐ | `listDatabases` requirement determined empirically for the verified version (decides checklist B row 2) |
| ☐ | `mongodump --db <approved-database>` only; approved collection set; **no `--oplog`**; local output directory |
| ☐ | `bsondump --type=canonical` per `.bson` → six `<collection>.ndjson` files |
| ☐ | All six `.ndjson` files exist even for empty collections (empty file where the collection is empty) |
| ☐ | Dump directory stays local; deleted after acceptance (Stage 8) |

### F. Digest-verified transfer

| ☐ | Item |
|---|---|
| ☐ | Transfer set = six `.ndjson` + `manifest.json` only |
| ☐ | Owner-side per-file SHA-256 == manifest `sha256` values |
| ☐ | Audit-side independent recompute matches; manifest integrity covered by the agreed channel |
| ☐ | Any mismatch ⇒ full bundle rejection, re-export, new verified transfer (M3) |

### G. Sanitizer and independent validator commands (implemented, offline-tested)

| ☐ | Item |
|---|---|
| ☐ | Sanitizer: `node lib/offlineExport/sanitizer.mjs --input <dir> --output <dir> --key-file <file> [--environment-label ...] [--timestamp <iso>] [--corroboration <json>]` |
| ☐ | Validator: `node lib/offlineExport/validator.mjs --bundle <dir>` → must print `BUNDLE ACCEPTED` |
| ☐ | Determinism: regenerate once locally, byte-identical collection files (spec §7.5) |
| ☐ | Node.js present on the owner machine; the Step 8 files (`lib/offlineExport/*`) deployed there unchanged (digest them from repo HEAD if desired) |
| ☐ | Key (64 hex) generated locally; never exported; only `pseudonymKeyFingerprint` in the manifest |
| ☐ | No mapping table, dump, or key file in the transfer |

### H. Receipt, count, and bundle acceptance checks

| ☐ | Item |
|---|---|
| ☐ | Per-collection `documentsRead == documentsWritten == actual record count` |
| ☐ | Per-file sha256 == manifest; encoding checks clean (no BOM, LF-only, trailing LF) |
| ☐ | Namespace injectivity: `distinctRawCount == distinctPseudonymCount` per namespace; observed distinct pseudonyms == manifest counts; no cross-namespace reuse |
| ☐ | Unit-entry reconciliation: per-path buckets and aggregate `unitStoredTypeCount` totals match the records |
| ☐ | Drift counters reconcile (`unknownBsonTypeCount`/`unknownBsonTypes`, `decimal128Count`, `unexpectedKeyCount`) |
| ☐ | Orphans: kept, flagged, counted per reference path; validator recomputation matches the manifest (never dropped) |
| ☐ | Excluded-key absence (validator whitelist scan; optional owner grep of §7.4 names) |
| ☐ | `qtyHex` presence/format/bit-exactness for every exported double (incl. `-0` → `8000000000000000`) |
| ☐ | Canonical serialization byte-identical; ascending primary sort; no duplicate primary |
| ☐ | Corroboration record present when supplied (counts/opcounters/window) |

---

## 3. Known limitations (must stay visible; none silently corrected)

- **L-1 `decimal128HexCount` is always `0`.** With Extended JSON v2 input
  (`bsondump` output), Decimal128 arrives as an exact decimal string, not as
  16-byte big-endian hex, so the §4 `$decimal128Hex` companion cannot be
  produced from this input format. The manifest keeps the field (always `0`)
  and the sanitizer/validator/tests document it. Byte-level Decimal128
  verification would require the owner to supply `.bson` payloads instead — a
  format change that needs its own decision, not a silent substitution.
- **L-2 `documentsRead` is owner-attested, not independently proven.** The
  sanitizer reports the documents it parsed from the supplied files; it cannot
  prove those files contained everything the database held. Completeness rests
  on the owner's corroboration (pre/post document counts, "all documents, no
  filter" statement, log window evidence) — which is exactly why Stage 3/4
  logging and the corroboration record are prerequisites, not paperwork.
- **L-3 Specification errata remain visible (not silently corrected):**
  1. §4's negative-zero parenthetical (`0000000000000080`) contradicts the same
     row's "IEEE-754 **big-endian** hex" rule; the big-endian rule wins —
     `-0` is exported as `8000000000000000` in `qtyHex` (documented in
     `docs/offline-export-sanitizer-validator.md` §5; spec text untouched).
  2. §7.5's "primary pseudonym" ordering is defined for row-identity `_id`
     pseudonyms; `stockmovements` and `inventoryaudits` export no `_id`, so the
     implemented sort key for them is a deterministic content key
     (`<item pseudonym>|<canonical record JSON>`) — a documented elaboration,
     not a reinterpretation of any rejection condition.
  3. §4's `$decimal128Hex` "where available" clause is unavailable under
     Extended JSON v2 input (see L-1).
- **L-4 Offline corroboration carrier.** Spec §7.1 lists pre/post `opcounters`
  and document counts as manifest content, but the sanitizer is offline by
  design and cannot observe server statistics. The implemented manifest carries
  these via the owner-supplied `--corroboration` object. This is an approved
  architecture consequence (no DB connection path exists), recorded here so
  the manifest's corroboration field is not mistaken for sanitizer-observed
  data.

## 4. Unresolved ambiguities and missing prerequisites (owner-supply required)

None of the following may be invented; each is an explicit owner input:

1. **Target database name** — **RESOLVED 2026-11-15:** the owner selected
   `hotel_management` (the POS data store, owner-confirmed). Contents remain
   unproven until the Stage 4 dump and count evidence; the separate export
   authorization remains outstanding.
2. **Export authorization wording** — the separate narrow authorization does
   not exist yet; its text is an owner deliverable.
3. **Tool versions and the `listDatabases` requirement** — unverified until the
   owner runs Stage 2 on the approved environment; the role definition depends
   on the result. The Stage 2d/2e templates define exactly what evidence is
   recorded; **no version value is asserted in this document**.
4. **Server-parameter capability** — whether the owner can/will set
   `slowOpThresholdMs: 0` on the target server is unknown; without it the
   §6.3 log-evidence layer cannot be produced and the export cannot proceed
   under the spec's evidence requirements.
5. **Community vs Enterprise server** — determines whether the optional
   Enterprise audit-filter improvement (§6.3.5) is available; absence does not
   block (the parameter mechanism is the required baseline).
6. **Corroboration JSON contents/format** — the carrier is implemented; the
   exact fields the owner will attest (and whether the database name appears)
   are an owner decision.
7. **Environment label wording** — pending the owner's approval (database name
   included or withheld).
8. **Transfer channel** — agreed mechanism for moving six files + manifest with
   digest coverage is not yet chosen (any channel works; the digest rule is
   what is mandatory).
9. **Node.js availability on the owner's export machine** — the sanitizer and
   validator are Node programs (developed against Node v24); the owner must
   confirm a Node runtime on the machine where Stages 5–6 run, and the Step 8
   files must be present there unmodified.
10. **Empty-collection file creation** — the owner must know in advance that
    `mongodump` omits empty collections and that an empty `.ndjson` placeholder
    is then required (Stage 4, step 4); this is an implementation-documented
    requirement, not a spec re-interpretation.

## 5. Blocked status and remaining gates

The real stored-unit audit **remains BLOCKED**. It unblocks only when:

1. every checklist row in §2 is checked with its evidence retained, and
2. a separately authorized, digest-verified sanitized bundle passes
   `validator.mjs --bundle` with `BUNDLE ACCEPTED` on the audit side.

**Remaining gates after the 2026-11-15 target selection** (none may be skipped;
none is satisfied by the selection):

| # | Gate | Owner action | Stage |
|---|---|---|---|
| 1 | Separate, explicit export authorization covering Stages 3–8, the database `hotel_management`, and the six-collection set | owner statement | 1 |
| 2 | Custom least-privilege role + dedicated export user created and verified (Stage 2e evidence record) | owner, on Atlas | 2 |
| 3 | Version evidence complete (server / mongodump / bsondump / mongosh / Node.js) | owner fills Stage 2d | 2 |
| 4 | Empirical `listDatabases` result recorded (action granted only if REQUIRED) | owner, inside the Stage 3 window | 2c/3/4 |
| 5 | Evidence window opened and later restored, with timestamps | owner | 3/8 |
| 6 | Dump, sanitize, validate executed with all stop conditions clear; `BUNDLE ACCEPTED` locally | owner | 4–6 |
| 7 | Corroboration contents and environment-label wording approved (whether the database name enters the manifest is still an owner decision) | owner | 5 |
| 8 | Transfer channel agreed; digest-verified transfer; audit-side `BUNDLE ACCEPTED` | owner + audit | 7 |
| 9 | Close-out: role/user dropped, log parameter restored, dump and key deleted — all timestamped | owner | 8 |
| 10 | Collection contents proven (document counts, dump artifact set) — the selection statement does not establish this | Stage 4 evidence | 4 |

This document authorizes none of it. It was produced without any database
connection, without running `mongodump`, `bsondump`, the sanitizer, or the
validator against any real data, and without reading `.env`, `.env.local`,
or any secret. The 2026-11-15 update made no connection and changed no role,
user, or server state — it is documentation only. Git: nothing staged,
committed, stashed, reset, or cleaned; all pre-existing working-tree changes
and untracked files are preserved.
