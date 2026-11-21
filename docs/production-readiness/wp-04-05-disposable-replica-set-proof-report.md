# WP-04-05 — Disposable Replica-Set Proof Report

**Status:** **WP04-05 BOUNDED DISPOSABLE PROOF CLOSED WITH EXPLICIT PRODUCTION LIMITATIONS**  
**Date:** 2026-11-11  
**Repository:** `C:\hotelms`  
**Branch / HEAD:** `main` / `69650435a6587d4577bc126f719fa1392bb934b3`  
**Authorization:** OWNER APPROVED — OD-10 (Bounded Disposable Replica-Set Proof Only)  
**Execution Mode:** Ephemeral loopback replica-set integration proof with TCP wire-level proxy  
**Production / Staging Access:** **NONE** (Prohibited & Enforced)  
**Production Activation:** **STRICTLY UNAUTHORIZED (DEFERRED TO WP04-06)**  

> **2026-11-14 update:** The separate, owner-authorized **WP04-05 L2 supplementary proof** (disposable local authenticated replica set, read-only scanner, D01–D10) is **ACCEPTED — PASS** — see §11. This does not retroactively accept the 2026-11-11 bounded persistence proof and does not sign G-REC-1 or authorize L3/staging/production.  

---

## 1. Executive Summary & Verification Boundaries

This report records the closure of **Work Package 04-05 (Disposable Replica-Set Proof)** for BONO Inventory V2 under governing decision **OD-10** (Schema Contracts) and **OD-23 Option B** (Item-Level Finding Identity).

WP04-05 is closed strictly as a **bounded disposable proof**. It validates MongoDB 8.0 WiredTiger engine semantics, multi-document transactions, concurrency patterns, query execution plans, and wire-level fault handling on an isolated loopback test environment. It does **not** deploy production models, does **not** create background worker daemons, and does **not** deploy production database indexes.

### Strict Boundary Delineation

| Architectural Component | Verified Disposable Proof Behavior | Production Implementation Boundary (WP04-06 Deferred) |
|---|---|---|
| **MongoDB Multi-Document Transactions** | Atomicity and rollback empirically verified across task and event documents; zero sequence gaps or phantoms on abort. | Production application routes and services do not yet execute recovery transactions. |
| **BSON Long (`Int64`) Serialization** | BSON type 18 confirmed via `$type` aggregation; native JS `BigInt` round-trips; atomic `$inc` preserves type 18; overflow guard fails closed at $1,000,000$. | Production models (`lib/models/`) not yet authored; BSON Long is not yet wired to production collections. |
| **Index Quality & Query Plans** | All 12 proposed indexes verified on disposable database; `.explain("executionStats")` confirms `IXSCAN` winning plans, zero hints, and zero in-memory `SORT` stages. | Production index migration script (`scripts/inventory-recovery-deploy-indexes.mjs`) is unauthorized and unexecuted. |
| **OD-23 Option B Concurrency** | Real independent clients `clientA` and `clientB` compete to create open task for same finding (exactly one succeeds with code 11000 on loser); item-level findings on same orderId succeed concurrently. | Validates MongoDB partial unique index constraint behavior; does not represent production task ingest worker. |
| **Finding Identity** | Test-local helper `buildFindingIdentityKey` canonicalizes and hashes OD-23 Option B payloads; `findingToIdentityKey` bridges classifier `dedupeKey`. | **Test-local helper only.** No production identity module exists in `lib/recovery/`. Shared production helper deferred to WP04-06. |
| **Wire Faults & Unknown-Commit** | In-memory loopback TCP proxy severs client socket during `commitTransaction`. Lost ACK adopts committed state; pre-commit drop retries exact sequence `1n`. | Wire-level proxy confirms driver/database semantics under commit ACK loss; does not represent production network infrastructure. |
| **Unknown-Commit Reconciliation** | Test-local helper `executeUnknownCommitReconciliation` executes fail-closed state transition to `MANUAL_REQUIRED` with `ESC_UNKNOWN_COMMIT` on simulated read failure. | **Test-local helper only.** No background reconciliation service or worker daemon (`lib/recovery/worker.js`) exists in the codebase. |
| **Mongoose Schemas** | Test-local `TaskSchema` and `EventSchema` validate field types, bounds, and sensitive-key rejection within the integration test. | **Test-local declarations only.** Production models (`lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`) do not exist. |
| **Standalone Topology Safety** | Ephemeral standalone mongod rejects transactions fail-closed (`MongoServerError: This MongoDB deployment does not support retryable writes...`). | Validates topology pre-flight guard logic; application-level topology verification middleware not yet deployed. |
| **Evidence Projection** | Authoritative `projectEvidence` imported directly from `lib/recovery/evidence.js`; unallowlisted fields dropped; quantities validated to $[0, 1000000]$. | Production evidence projection module is verified against persistence schema contracts. |

---

## 2. Environment, Topology, and Dependency Versions

- **Host OS:** Windows 11 Enterprise (AMD64)
- **Node.js Runtime:** `v24.14.0`
- **MongoDB Server:** `8.0.3` Enterprise / Community (WiredTiger storage engine)
  - Binary: `C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe`
- **MongoDB Topologies Tested:**
  1. Single-node replica set: `bonorecoveryrs` on `127.0.0.1:27019` (`--oplogSize 128`)
  2. Standalone server: `127.0.0.1:27020` (no replica set)
  3. Wire proxy: `127.0.0.1:27021` (TCP proxy forwarding to `127.0.0.1:27019`)
- **Mongoose ODM:** `9.9.3`
- **MongoDB Node.js Driver:** Bundled with Mongoose 9 (`~6.x`)
- **Branch / HEAD:** `main` / `69650435a6587d4577bc126f719fa1392bb934b3`

---

## 3. Strict Process Ownership and Safety Verification

1. **Three-Port Pre-Flight Guard:**
   - Prior to launching any process, the harness verifies ports `27019`, `27020`, and `27021` via `guardPortAvailable(port)`.
   - If any port is occupied, the test halts immediately with an explicit blocker error displaying the listener PID.
2. **PID Listener Verification (Anti-Hijack):**
   - Never assumes a listening port belongs to the spawned child process.
   - Spawns `mongod.exe` with explicit, isolated `--dbpath` directories in `os.tmpdir()`.
   - Attaches `error` and premature `exit` listeners to child process instances.
   - Inspects the operating system TCP connection table (`netstat -ano -p tcp`) to verify that the PID listening on the port matches `mongodProcess.pid` exactly.
   - Verifies process liveness via `process.kill(proc.pid, 0)`.
   - Only marks process ownership verified (`replSetOwnerVerified = true`, `standaloneOwnerVerified = true`) when PID match and liveness are confirmed.
3. **Fail-Closed Teardown Safety:**
   - If process ownership cannot be established, the harness fails closed and executes **no** shutdown, drop database, or cleanup command against the unverified listener.
   - Once verified, graceful shutdown `{ shutdown: 1 }` is issued to the child process, connections are closed with `force: true`, and temporary directories are purged with retry handling.
4. **Prohibited Application Ports Untouched:**
   - Application listeners on port `27017` (PID 4696) and port `27018` (PID 4516) remained untouched throughout the proof.
5. **No Production Database or Credentials:**
   - No `.env` or `.env.local` files were read.
   - Connection strings were generated strictly in memory for loopback addresses with run-specific database prefixes (`bono_recovery_wp04_05_*`).

---

## 4. Empirical Test Results

Test suite command:
```powershell
node --test tests/integration/wp04-05-persistence.integration.test.mjs
```

### 4.1 Suite Output (19/19 Tests Passing)
```text
▶ BONO WP04-05 Disposable Replica-Set Proof
  ▶ Proof A: Mongoose 9 / BSON Long Serialization & Round-Trip
    ✔ TEST-01: Mongoose 9 BigInt stores as BSON Long (type 18 / 'long') (52.6ms)
    ✔ TEST-02: BSON Long atomic $inc preserves BSON Long type (22.9ms)
    ✔ TEST-03: Safe sequence range [1, 1000000] and overflow fail-closed guard (24.2ms)
  ✔ Proof A: Mongoose 9 / BSON Long Serialization & Round-Trip (101.6ms)
  ▶ Proof B: Multi-Document Transaction Atomicity and Rollback
    ✔ TEST-04: Transaction commit atomically persists task counter increment and event insertion (50.0ms)
    ✔ TEST-05: Transaction abort rolls back both event and task sequence counter (zero gaps, zero phantoms) (28.2ms)
  ✔ Proof B: Multi-Document Transaction Atomicity and Rollback (78.8ms)
  ▶ Proof C: All 12 Proposed Index Definitions and Actual Behavior
    ✔ TEST-06: Task collection indexes (IDX-TSK-01 to IDX-TSK-06) verified (9.6ms)
    ✔ TEST-07: Event collection indexes (IDX-EVT-01 to IDX-EVT-06) verified (4.8ms)
    ✔ TEST-08: Explicit query plan verification via explain for all 12 proposed indexes (73.5ms)
  ✔ Proof C: All 12 Proposed Index Definitions and Actual Behavior (89.1ms)
  ▶ Proof D: OD-23 Option B Real Concurrency & WD-10 Preservation
    ✔ TEST-09: Real concurrency: Two independent clients compete to create open task for same finding; exactly one succeeds (53.0ms)
    ✔ TEST-10: Real concurrency & WD-10 preservation: Independent findings on same orderId succeed concurrently (23.4ms)
    ✔ TEST-11: Finding recurrence allowed after close with priorTaskId lineage (33.0ms)
  ✔ Proof D: OD-23 Option B Real Concurrency & WD-10 Preservation (110.5ms)
  ▶ Proof E: Real Concurrent Lease Contention & Monotonic Fencing
    ✔ TEST-12: Real concurrency: Two independent workers compete for one eligible lease; exactly one succeeds (25.1ms)
    ✔ TEST-13: Monotonic fencing rejects stale workers with expired tokens or old generations (20.0ms)
  ✔ Proof E: Real Concurrent Lease Contention & Monotonic Fencing (45.5ms)
  ▶ Proof F: Genuine Wire-Level Unknown-Commit Outcome & Reconciliation
    ✔ TEST-14: Genuine unknown-commit when write committed: client encounters network error during commit, test helper reconciles without duplicate (2072.0ms)
    ✔ TEST-15: Genuine unknown-commit when write aborted: client encounters network disconnect before commit, reconciles absence, and retries exact same sequence (2103.5ms)
    ✔ TEST-16: Ambiguous unknown-commit reconciliation: When authoritative read fails, protocol helper fails closed with ESC_UNKNOWN_COMMIT (44.0ms)
  ✔ Proof F: Genuine Wire-Level Unknown-Commit Outcome & Reconciliation (4240.5ms)
  ▶ Proof G: Standalone Topology Fail-Closed Verification
    ✔ TEST-17: Standalone MongoDB topology rejects transactions and fails closed (TRANSACTIONS_UNAVAILABLE) (2426.2ms)
  ✔ Proof G: Standalone Topology Fail-Closed Verification (2426.8ms)
  ▶ Proof H: Authoritative Evidence Projection Integration & Security
    ✔ TEST-18: Real WP04-01 projectEvidence integration: valid V1 evidence projects allowlist; forbidden nested fields rejected (17.1ms)
    ✔ TEST-19: Quantity escalation fields store finite numbers bounded to [0, 1000000] and reject negative, above-maximum, NaN, and Infinity (41.6ms)
  ✔ Proof H: Authoritative Evidence Projection Integration & Security (60.9ms)
✔ BONO WP04-05 Disposable Replica-Set Proof (10472.3ms)
ℹ tests 19
ℹ suites 9
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12381.5
```

### 4.2 DB-Free Regression Suite
Read-only recovery core, adapter, and classifier tests:
```powershell
node --test tests/wp04-01-recovery-core.test.mjs tests/wp04-03-recovery-adapter.test.mjs tests/wp04-03-recovery-classifier.test.mjs
```
**Result:** 92 tests passing across 13 suites in 0.88 seconds (0 failures, 0 skipped).

---

## 5. Detailed Index and Query Plan Assertions (TEST-08)

All 12 indexes were verified using `assertPlanQuality` with recursive blocking-sort checking on the disposable test database:

| Query # | Index Name | Key Pattern | Constraints | Winning Index | In-Memory `SORT` Stage Present? | `executionSuccess` |
|---|---|---|---|---|---|---|
| **Q1** | `IDX-TSK-01` | `{ taskId: 1 }` | `unique: true` | `IDX-TSK-01` | **No (`assertNoBlockingSort`)** | `true` |
| **Q2** | `IDX-TSK-02` | `{ findingIdentityKey: 1 }` | `unique: true, partialFilter: { isOpen: true }` | `IDX-TSK-02` | **No (`assertNoBlockingSort`)** | `true` |
| **Q3** | `IDX-TSK-03` | `{ orderId: 1, isOpen: 1 }` | Compound non-unique | `IDX-TSK-03` | **No (`assertNoBlockingSort`)** | `true` |
| **Q4** | `IDX-TSK-04` | `{ status: 1, isOpen: 1, nextAttemptAt: 1, leaseUntil: 1 }` | Compound scheduler queue | `IDX-TSK-04` | **No (`assertNoBlockingSort`)** | `true` |
| **Q5** | `IDX-TSK-05` | `{ leaseOwner: 1, leaseUntil: 1, leaseGeneration: 1 }` | `partialFilter: { isOpen: true }` | `IDX-TSK-05` | **No (`assertNoBlockingSort`)** | `true` |
| **Q6** | `IDX-TSK-06` | `{ status: 1, severity: 1, createdAt: 1 }` | `partialFilter: { status: "MANUAL_REQUIRED" }` | `IDX-TSK-06` | **No (`assertNoBlockingSort` on plan & stats)** | `true` |
| **Q7** | `IDX-EVT-01` | `{ eventId: 1 }` | `unique: true` | `IDX-EVT-01` | **No (`assertNoBlockingSort`)** | `true` |
| **Q8** | `IDX-EVT-02` | `{ taskId: 1, sequenceNumber: 1 }` | `unique: true` | `IDX-EVT-02` | **No (`assertNoBlockingSort` on plan & stats)** | `true` |
| **Q9** | `IDX-EVT-03` | `{ orderId: 1, timestamp: -1 }` | Compound audit trail | `IDX-EVT-03` | **No (`assertNoBlockingSort` on plan & stats)** | `true` |
| **Q10** | `IDX-EVT-04` | `{ eventType: 1, timestamp: -1 }` | Compound telemetry | `IDX-EVT-04` | **No (`assertNoBlockingSort` on plan & stats)** | `true` |
| **Q11** | `IDX-EVT-05` | `{ actorId: 1, timestamp: -1 }` | Compound operator audit | `IDX-EVT-05` | **No (`assertNoBlockingSort` on plan & stats)** | `true` |
| **Q12** | `IDX-EVT-06` | `{ taskId: 1, leaseGeneration: 1 }` | Compound fencing audit | `IDX-EVT-06` | **No (`assertNoBlockingSort`)** | `true` |

**Plan Quality Guarantee:** Zero index hints (`.hint()`) were used in any query. For every sorted query (Q6, Q8, Q9, Q10, Q11), `assertNoBlockingSort` recursively traversed both `queryPlanner.winningPlan` and `executionStats.executionStages` to confirm the absence of `SORT`, `SORT_DEFAULT`, `SORT_KEY_GENERATOR`, or `SORT_MERGE` stages.

---

## 6. Source-Review Observations

During final code review of the WP04-05 disposable harness and specification prototypes, four technical observations were identified and are recorded here for resolution during WP04-06 production design:

### Observation 1: Child Process `signalCode` Handling
- **Context:** In Node.js `child_process`, when a process exits as a result of receiving an operating system signal (e.g. `SIGTERM`, `SIGKILL`, or Windows job object termination), `child.exitCode` remains `null`, while `child.signalCode` (and the `signal` argument of the `'exit'` event) is populated.
- **Harness State:** In `verifyProcessOwnership`, process liveness checked `if (proc.exitCode !== null || proc.killed)`. While `proc.on("exit")` captured `signal !== null` into a local error variable, a comprehensive process termination check must evaluate:
  ```javascript
  if (proc.exitCode !== null || proc.signalCode !== null || proc.killed) { ... }
  ```
- **WP04-06 Recommendation:** In any production daemon supervisor or management script spawning MongoDB subprocesses, inspect both `exitCode` and `signalCode`.

### Observation 2: Safe Termination When Process Ownership Fails
- **Context:** If `verifyProcessOwnership` detects a conflict (e.g. port already owned by a different PID, or timeout before binding), `replSetOwnerVerified` remains `false`.
- **Harness State:** The `after()` cleanup hook safely bypassed sending database drop and shutdown commands to the unverified listener (`if (!replSetOwnerVerified) return;`). However, in doing so, it also skipped calling `proc.kill()` on the child process that the harness itself spawned, and skipped removing its temporary directory `tempDbDir`.
- **Resolution Principle:** The harness must always terminate *its own spawned child process* (`proc.kill()` using the PID returned by `spawn`) and delete its designated temporary directory on disk, while strictly refusing to issue TCP or database commands to the port or foreign listener.

### Observation 3: TCP Message-Framing Limitations of Proxy Commit Detection
- **Context:** The loopback TCP proxy detects `commitTransaction` using a binary buffer search:
  ```javascript
  if (proxyDropCommitAck && data.includes(Buffer.from("commitTransaction")))
  ```
- **Limitation:** TCP is a continuous byte-stream protocol without inherent message boundaries, whereas MongoDB uses structured `OP_MSG` framing with a 16-byte header (`messageLength`, `requestID`, `responseTo`, `opCode`).
- **Implication:** If a client packet is fragmented across multiple TCP chunks, the string `"commitTransaction"` could be split across chunks and missed. Conversely, if a document payload, comment, or query filter happens to contain the ASCII string `"commitTransaction"`, the proxy would falsely match it.
- **Proof Validity:** In this bounded disposable suite, transaction commit messages are small single-frame payloads and the test executed deterministically. However, this is an in-test simulation tool, not a production wire-protocol parser.

### Observation 4: `EventSchema` Enum Mismatch for `RECOVERY_MANUAL_REQUIRED`
- **Context:** In the test harness's `EventSchema`, the allowed `eventType` enum values are:
  ```javascript
  enum: [
    "RECOVERY_DETECTED",
    "RECOVERY_LEASED",
    "RECOVERY_RENEWED",
    "RECOVERY_RETRY_SCHEDULED",
    "RECOVERY_ESCALATED",
    "RECOVERY_APPROVED",
    "RECOVERY_RESOLVED",
    "RECOVERY_VERIFIED",
    "RECOVERY_CLOSED",
    "RECOVERY_CANCELLED",
    "RECOVERY_EVIDENCE_DRIFT"
  ]
  ```
- **Harness State:** In TEST-16, `executeUnknownCommitReconciliation` persisted an event with `eventType: "RECOVERY_MANUAL_REQUIRED"`. Because the insertion was performed against `directEvents` (the raw driver collection `connectionPrimary.db.collection(...)`), Mongoose schema validation was bypassed.
- **Implication:** Had this event been persisted via `EventModel.create(...)`, Mongoose would have rejected it with a `ValidationError: \`RECOVERY_MANUAL_REQUIRED\` is not a valid enum value for path \`eventType\``.
- **WP04-06 Requirement:** When authoring production `lib/models/RecoveryEvent.js`, the schema enum must explicitly include `"RECOVERY_MANUAL_REQUIRED"` (or align on `"RECOVERY_ESCALATED"` with a `diagnosticCode: "TIMEOUT"` / `diagnosticCode: "PERSISTENCE_TIMEOUT"` field).

---

## 7. Explicit Production Limitations & Non-Claims

The following boundaries are established and non-negotiable:

1. **No Production Worker or Reconciliation Integration:**
   - The tests prove that the OD-10 database mutations succeed atomically and that conflicting or stale writes are rejected by the database.
   - The tests do **not** prove background recovery daemon behavior, scheduler queue polling, worker process management, or production crash-recovery workflows.
2. **No Authoritative Model Files in `lib/models/`:**
   - `TaskSchema` and `EventSchema` in `tests/integration/wp04-05-persistence.integration.test.mjs` are test-local prototypes.
   - Authoritative production models (`lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`) have **not** been authored or approved.
3. **No Deployed Production Indexes:**
   - The 12 verified indexes were created explicitly on the ephemeral disposable database `bono_recovery_wp04_05_*`.
   - No indexes have been deployed to staging or production application databases.
4. **No Production Finding Identity Module:**
   - `buildFindingIdentityKey` is a test-local helper. No production identity service exists in `lib/recovery/`.
5. **No Production Topology Assurance:**
   - The test verified fail-closed behavior on an ephemeral standalone instance. Production application environments must enforce replica-set connection strings out-of-band.

---

## 8. Exact Files Touched

1. [`tests/integration/wp04-05-persistence.integration.test.mjs`](file:///c:/hotelms/tests/integration/wp04-05-persistence.integration.test.mjs) (Test-local comments and labels corrected; semantics unchanged)
2. [`docs/production-readiness/wp-04-05-disposable-replica-set-proof-report.md`](file:///c:/hotelms/docs/production-readiness/wp-04-05-disposable-replica-set-proof-report.md) (Updated proof report with explicit limitations and observations)

**Pre-existing working tree status:** All 136 baseline modified and untracked entries remain preserved exactly as found. No git stage, commit, reset, clean, or push was performed.

---

## 9. Conclusion and Stop Condition

Work Package **WP04-05 is hereby formally CLOSED as a bounded disposable proof**.

Per governing instructions:
- No further tests are to be executed.
- No production database or credentials were accessed.
- **WP04-06 (production models, worker implementation, index deployment scripts, and activation) remains strictly UNAUTHORIZED.**
- Work halts here pending formal owner review and decision.

---

## 10. Authorization and evidence reconciliation (2026-11-14, documentation only)

This section reconciles the 2026-11-11 record with the G-REC-1 readiness package. It does not re-run the proof, authorize new work, or sign anything.

| Question | Finding | Evidence |
|---|---|---|
| Was AUTH-2 granted? | **YES — for the bounded disposable proof only.** | Header: “OWNER APPROVED — OD-10 (Bounded Disposable Replica-Set Proof Only)”; test header: “SCOPE: DISPOSABLE REPLICA-SET PROOF CORRECTIONS ONLY”. No standalone AUTH-2 ticket file exists; the approval is recorded in this report and the test header. |
| What was authorized? | Loopback-only, credential-free, disposable replica-set proof on ports 27019/27020/27021; test-local schemas and helpers; 12 disposable indexes; persistence, transaction, concurrency, and wire-fault assertions. | §2, §3, §4; test header safety boundaries. |
| What was excluded? | WP04-06; production models and indexes; the index deployment script; production/staging access; production credentials; workers and schedulers; runtime integration; application databases and ports 27017/27018; `.env`/`.env.local`; any new work beyond the proof. | §1, §7, §9; test header safety boundaries. |
| Was it executed? | **YES — 19/19 tests passed**, plus 92 DB-free regression tests. | §4.1, §4.2. |
| Is formal L2 evidence complete? | **NO.** The executed suite does not record G-REC-1 L2 criteria 5–7: seeded D01–D10 classification, before/after document counts/hash, and the no-new-collection/index baseline. It proves persistence/index/wire behavior, not the read-only scanner L2. | `wp-04-implementation-work-packages.md` §6; `wp-04-implementation-acceptance-matrix.md` §2.1 criteria 5–7. |
| Was the proof formally accepted by the owner? | **NOT RECORDED.** This report says “Work halts here pending formal owner review and decision.” No signed acceptance exists. | §9; `wp-04-06-design-discovery-report.md` §10.3 (“not accepted as an implementation”). |
| Does this authorize L3? | **NO.** WP04-06 remains unauthorized; L3 requires its own authorization plus an approved staging environment. | §9; `wp-04-implementation-work-packages.md` §7. |

**Conclusion.** AUTH-2 was granted and the bounded proof was executed. The proof is **not** a complete G-REC-1 L2 evidence package and is **not** owner-accepted. L3 is **not authorized**. The prior `AUTH-2 not granted` wording in the readiness documents was incorrect and is corrected there without changing any gate state.

---

## 11. Owner acceptance — WP04-05 L2 supplementary proof (2026-11-14)

### 11.1 Decision recorded

The owner has explicitly accepted the **WP04-05 L2 supplementary proof**:

> **WP04-05 L2 Supplementary Proof: ACCEPTED — PASS** (owner decision, 2026-11-14).

This acceptance applies **only** to the completed disposable local authenticated replica-set proof and the evidence it submitted. It is a supplementary L2 proof acceptance; it is **not** overall L2 acceptance, **not** a G-REC-1 signature, and **not** a production-readiness determination.

### 11.2 Accepted evidence

| Item | Accepted result |
|---|---|
| Venue | Disposable, auth-enabled replica set on loopback `127.0.0.1:27023`; run-owned database `bono_recovery_wp04_05_l2_ee91d9e7a80d` |
| Detection coverage | **D01–D10 observed on the expected fixture orders** |
| Independent verifier | `wp04-05-l2-verifier-v1` — **`ok: true`, zero violations** |
| Findings | 16 findings; all D01–D10 represented |
| Document counts | 25/25 documents — before/after unchanged |
| Database digest | `da221bc0d792f3971cf1a2d7aeffae8290c47edea7adf8c6ed404a5e1d72f5b2` — before/after unchanged |
| Index inventory digest | `5f7ff97c8c09f98e544be1872c87fccd7fd10a98d9d5304ece97f81c283f7b5d` — before/after unchanged |
| Collection inventory | Unchanged (no new collection; no V2 collection) |
| Index inventory | Unchanged (no index created or dropped) |
| Scanner read-only privilege checks | **Passed** |
| Redaction check | **Passed** |
| Deterministic repeat check | **Passed** |
| Negative controls | **Detected as expected** |
| Cleanup | Disposable database dropped; run-owned `mongod` process terminated |
| Secrets | No credentials or connection URIs printed |

The canonical BSON digest construction used for the accepted evidence is recorded in `wp-04-05-l2-canonical-bson-digest-spec.md` (owner approval 2026-11-14).

### 11.3 Preserved limitations

The acceptance does not remove any limitation submitted with the proof:

1. The proof used **synthetic V1 fixtures only**.
2. No production data, production index deployment, runtime wiring, worker, or scheduler was exercised.
3. The before/after comparison used **two non-transactional read passes**; it is not a transactional snapshot guarantee.
4. The D06 windowed class was exercised under the **`ALERT_ONLY`** policy.
5. No **L3, staging, or production** authorization was granted or implied.

### 11.4 Deferred cases preserved

The following cases remain deferred and are **not** converted into passes by this acceptance:

| Deferred case | Reason code |
|---|---|
| `D05/STALE_LIVE_HOLD` | `W_STALE_UNSET_OR_AGE_NOT_PROJECTED` |
| `D06/CONSUMING_MOVEMENTS_COMPLETE` | `W_STALE_UNSET_OR_AGE_NOT_PROJECTED` |
| Three `D07/STATION_PARTIAL_CONSUMPTION` cases | `STATION_ATTRIBUTION_NOT_PROJECTED` |

### 11.5 Explicit non-claims

- This acceptance **does not** accept the **2026-11-11 bounded persistence proof**; that record retains its historical “not accepted as L2” status.
- This acceptance **does not** complete or sign **G-REC-1**. G-REC-1 remains **UNSIGNED**; criteria 8, 10 (staging part), 11, and 12 remain open.
- This acceptance **does not** authorize or imply **G-IDX-1**, **G-PAY-1**, **L3**, staging or production access, deployment, migration, runtime activation, workers, or schedulers.
- This acceptance **does not** change any application source, test, schema, index, script, or runtime behavior; it is documentation only.
- Inventory V2 remains **inactive**; production readiness is **not** established.
