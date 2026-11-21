# Phase 2.4 — Production Database Checklist (Decision D)

Status: **READ-ONLY CHECKLIST — NOT EXECUTED, NOT APPROVED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Decision: **D** — MongoDB production readiness
Companions: `phase-2-4-owner-decisions.md`, `phase-2-4-recovery-readiness.md`, `phase-2-4-destructive-operations-policy.md`

> No database connection was opened. No `.env`/`.env.local` value was read or printed. No index was created, dropped, or replaced. No backup, restore, failover, or load test was run. No deployment script was executed. No code, schema, model, migration, or environment variable was changed. Every item marked **UNVERIFIED** requires staging or production evidence that this phase is explicitly prohibited from collecting.

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in current source, tests, or git state. |
| **REAL-TESTED** | Exercised against the Phase 2.3 disposable replica set. |
| **INFERRED** | A logical consequence of verified code, not separately exercised. |
| **UNVERIFIED** | Cannot be proven without staging/production/DBA/owner input. |
| **OWNER DECISION** | Requires an explicit business, security, or operations decision. |

---

## 1. Purpose and scope

This document is the Decision D working checklist. It covers:

1. production topology and transaction capability;
2. read/write concern, read preference, and retry semantics;
3. timeout and connection-pool budget;
4. failover and recovery behaviour;
5. index inventory, unique constraints, and conflict handling;
6. guarded index deployment scripts and the Inventory V2 index plan;
7. backup, retention, restore verification, RPO/RTO;
8. operator-versus-staging verification duties.

It does **not** authorize any of those operations. It is the list the owner and DBA must sign before production.

**The single highest-priority finding remains:** the repository has no deployment path for the `InventoryItem`, `InventoryReservation`, `StockMovement`, or `PaymentInfo` indexes, while inventory idempotency and uniqueness depend on some of them. This is documented in §9 and is production-blocking.

---

## 2. Safety gate

| Check | Observed | Expected | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | same | PASS |
| Status entries | **130** | 130 | PASS |
| Phase 2.3 reports read | 4 of 4 | 4 | PASS |
| Source inspection | completed | required | PASS |
| Database connection | none | none | PASS |
| Index/deployment script executed | none | none | PASS |
| Code/schema/migration change | none | none | PASS |

Phase 2.4 documents live under the already-untracked `docs/production-readiness/` directory and add no separate `git status` entry. No pre-existing work was reset, cleaned, checked out, stashed, staged, committed, pushed, or overwritten.

---

## 3. Deployment topology (D-1)

### 3.1 Required capability

The application uses MongoDB multi-document transactions for inventory reservation, consumption, release, and void. Transactions require a **replica set** (single-node is technically sufficient for development) or a **mongos** sharded cluster. Standalone `mongod` does **not** support them.

**VERIFIED / REAL-TESTED:** on a standalone server the V1 helper fails closed with `503 TRANSACTIONS_UNAVAILABLE`; it does not silently degrade. This was proven in Phase 2.3. That is a safe failure, but it means inventory reservation/consumption is unavailable in production on a standalone deployment.

### 3.2 Options

| Topology | Transactions | Failover | Recommendation |
|---|---|---|---|
| Standalone `mongod` | No | None | Development only; **not production** |
| Single-node replica set | Yes | None (node is the only member) | Acceptable for staging/disposable tests only |
| Multi-node replica set (≥3 voting members, or PSA with a tested arbiter policy) | Yes | Yes | **Recommended production baseline** |
| `mongos` sharded cluster | Yes | Yes (per shard) | Acceptable if sharding is genuinely required; higher operational cost |

### 3.3 Required evidence (UNVERIFIED)

| Evidence | How to capture | Where |
|---|---|---|
| `hello` / `isWritablePrimary`, `setName`, `hosts`, `primary`, `me` | `db.adminCommand({ hello: 1 })` | Staging and production |
| Replica-set member health and roles | `rs.status()` | Staging and production |
| Write concern acknowledged by the expected number of members | `db.adminCommand({ getDefaultRWConcern: 1 })` and a write test | Staging |
| Transaction round-trip on the deployed topology | A disposable transaction insert/abort | Staging |
| Failover drill | Step down the primary during a load test | Staging only |

**OWNER DECISION:** approve the production topology, the number of data-bearing members, the failover policy, and whether a sharded cluster is required. Do not infer this from a connection string.

---

## 4. Transactions (D-2)

### 4.1 Verified application transaction behaviour

| Property | POS V1 | Inventory V2 helper |
|---|---|---|
| Status | Live | **Unwired** (not imported by any V1 service) |
| Retry attempts | 3 | `maxAttempts` default 5 |
| Backoff | Fixed 20 ms | Exponential with jitter, `baseDelayMs` 25, `maxDelayMs` 250 |
| Retry trigger | Transient transaction error only | Transient only |
| Unknown commit | **Never retried**; rethrown | Caller-owned `resolveOutcome` evidence contract |
| Unsupported topology | `503 TRANSACTIONS_UNAVAILABLE` | `TRANSACTIONS_UNAVAILABLE` |
| Explicit transaction options | None (`startTransaction()` with no options) | Options passed through; defaults documented |
| Session cleanup | `finally { endSession() }` | `finally { endSession() }` |

**Evidence:** `lib/inventoryReservationService.js` `runInTransaction`; `lib/inventory-v2/server/transaction.js`.

### 4.2 Gaps

1. **No explicit transaction budget.** Neither helper sets `maxCommitTimeMS`, `maxTimeMS`, `readConcern`, or `writeConcern` on the transaction. The server's default transaction lifetime and the driver's defaults apply. A transaction could outlive the HTTP gateway deadline.
2. **V1 helper has no evidence-based unknown-commit resolution.** It correctly refuses to retry, but the caller must still reconcile later; there is no built-in `resolveOutcome` equivalent in V1.
3. **The V2 helper is not wired.** Its contract is not protecting production today.
4. **No transaction metrics.** There is no counter for retries, unknown commits, or `TRANSACTIONS_UNAVAILABLE`; only structured logs.

### 4.3 Recommended transaction policy (OWNER DECISION)

| Parameter | Requirement |
|---|---|
| `maxCommitTimeMS` | Set below the HTTP request deadline (the POS connection uses a 3 s server-selection budget and a 30 s socket timeout; the platform gateway is ~5 s). The exact value is an owner/DBA decision. |
| `maxTimeMS` per operation | Bounded; no unbounded inventory scan inside a transaction. |
| `readConcern` | Snapshot/appropriate level for transactional reads; must be validated with the DBA. |
| `writeConcern` | Explicit majority (or the owner-approved equivalent) for financial/inventory writes. |
| Retry budget | Bounded; unknown commit never blindly retried; topology failure fails closed. |
| Observability | Emit retry count, commit outcome, and `TRANSACTIONS_UNAVAILABLE` rate. |

**No value in this table is asserted as correct for this deployment.** The owner/DBA must set it and the checklist in §14 must capture the evidence.

---

## 5. Read/write concern, read preference, and retryable writes (D-2)

### 5.1 Verified connection settings

POS (`lib/mongodb.js`):

| Option | Value |
|---|---|
| `bufferCommands` | `false` |
| `maxPoolSize` | `10` |
| `minPoolSize` | `0` |
| `serverSelectionTimeoutMS` | `3000` |
| `socketTimeoutMS` | `30000` |
| `connectTimeoutMS` | `10000` |
| `family` | `4` |
| `readConcern` | **not set** (driver/server default) |
| `writeConcern` | **not set** (driver/server default) |
| `readPreference` | **not set** (default `primary`) |
| `retryWrites` | **not set** (driver default) |
| `autoIndex` | not set on the POS connection; background provisioning is gated (see §9) |

Hotel (`lib/hotel/db/connection.js`):

| Option | Value |
|---|---|
| `dbName` | `bono_hotel` |
| `autoIndex` | `false` |
| `autoCreate` | `false` |
| `bufferCommands` | `false` |
| `maxPoolSize` | `10` |
| `minPoolSize` | `0` |
| `serverSelectionTimeoutMS` | `5000` |
| `connectTimeoutMS` | `10000` |
| `socketTimeoutMS` | `30000` |
| `readConcern` / `writeConcern` / `readPreference` / `retryWrites` | **not set** |

**VERIFIED:** neither connection expresses an explicit durability expectation.

### 5.2 Risks

- **Durability:** relying on server defaults means the effective write concern is whatever the cluster/URI supplies. If a URI parameter silently sets `w=1`, a financial write may be acknowledged before majority durability.
- **Read preference:** a future URI with `readPreference=secondary` could break read-after-write assumptions in payment/inventory flows.
- **Retryable writes:** driver defaults are usually on, but this is not explicit or documented; an operator change to the URI could alter it.
- **Unified URI:** POS and Hotel use different environment variables (`MONGODB_URI` and `ROOM_MONGODB_URI`) and must not be conflated.

### 5.3 Required checks (UNVERIFIED)

| Check | Method |
|---|---|
| Effective default write concern | `db.adminCommand({ getDefaultRWConcern: 1 })` |
| Effective URI options | Inspect the connection string **without printing it**; redact credentials |
| Read preference | Confirm `primary` for financial/inventory reads |
| Retryable writes | Confirm the intended value survives the URI and driver version |
| Cluster-level concern vs connection-level concern | Document which one wins and why |

**OWNER DECISION:** approve an explicit write concern (majority or equivalent), a read concern, a read preference, and a retryable-writes policy. Document them in the deployment runbook, not only in code.

---

## 6. Timeout and connection-pool budget (D-3)

### 6.1 Verified values

| Setting | POS | Hotel | Implication |
|---|---|---|---|
| `maxPoolSize` | 10 | 10 | Per process/instance; serverless fan-out multiplies this |
| `minPoolSize` | 0 | 0 | Cold-start handshakes under load |
| `serverSelectionTimeoutMS` | 3000 | 5000 | POS fails before the ~5 s gateway deadline; Hotel is closer to it |
| `socketTimeoutMS` | 30000 | 30000 | A slow query can hold a request for 30 s |
| `connectTimeoutMS` | 10000 | 10000 | Longer than the POS selection budget |
| `bufferCommands` | false | false | Fails fast instead of queueing |

### 6.2 Risks

1. **Pool exhaustion under fan-out.** With `maxPoolSize: 10` per instance and no explicit concurrency limit, a burst of serverless invocations can open many pools and exhaust the cluster connection limit.
2. **Timeout mismatch.** `socketTimeoutMS: 30000` exceeds the platform gateway deadline. A stalled operation may be cut off at the gateway while still running server-side.
3. **No backpressure.** There is no queue, bulkhead, or per-route concurrency cap.
4. **No pool metrics.** Saturation is not observable today.

### 6.3 Required staging tests (UNVERIFIED)

| Test | Pass criterion |
|---|---|
| Pool saturation | Requests fail cleanly (503/429) before the gateway deadline; no unbounded queue |
| Cold start | First request succeeds within budget after a cold instance |
| Slow query | A deliberately slow operation times out cleanly; no orphaned transaction |
| Serverless fan-out | Peak concurrency stays within the cluster connection limit (calculate instances × pool size) |
| Hotel + POS concurrent load | Both databases remain within their own limits |

**OWNER DECISION:** approve the pool size per environment, the connection ceiling, and the concurrency model (including whether a queue or rate limit is required).

---

## 7. Failover behaviour (D-6, part 1)

### 7.1 What is verified

- Transactions retry only transient errors; a failover typically surfaces as a transient or unknown-commit condition.
- Unknown commit is never retried blindly by V1.
- Standalone is rejected with 503.
- **No failover test has been run.** Phase 2.3 used a single-node disposable replica set only.

### 7.2 What must be proven before production (UNVERIFIED)

| Scenario | Expected behaviour | Evidence required |
|---|---|---|
| Primary step-down during a transaction | Transaction either commits once or fails cleanly; no duplicate | Log + data check |
| Primary step-down during a normal write | Driver retries or returns a clean error; no partial write | Log + data check |
| Network partition | Fails closed; no split-brain duplicate | Staging drill |
| Rolling restart | No lost acknowledged write; pool recovers | Staging drill |
| `TRANSACTIONS_UNAVAILABLE` burst | Alert fires; requests fail with 503; no silent success | Metric + alert |

**Recommendation:** run the failover drill on staging with the real driver version and the production connection options. Record the observed RPO effect in §11.

---

## 8. Index inventory and unique constraints (D-4)

### 8.1 Critical finding — deployment gap

**VERIFIED:** `scripts/sync-indexes.js` and the connection-path background provisioning cover exactly five models:

1. `orders`
2. `staffs`
3. `categories`
4. `menuitems`
5. `inventoryaudits`

**VERIFIED absence:** no repository script deploys indexes for:

- `InventoryItem` (`inventoryitems`),
- `InventoryReservation` (`inventoryreservations`),
- `StockMovement` (`stockmovements`),
- `PaymentInfo` (`paymentinfos`).

The Inventory V2 and Hotel deployment scripts do **not** cover these V1 collections either.

### 8.2 Index definitions present in source

| Collection | Index | Options | Correctness role | Deployed by a repo script? |
|---|---|---|---|---|
| `orders` | multiple (status/time, waiter, station, etc.) | non-unique | Query performance | **Yes** (`sync-indexes.js`) |
| `staffs` | per model | — | Auth/query | **Yes** |
| `categories` | per model | — | Query | **Yes** |
| `menuitems` | per model | — | Query | **Yes** |
| `inventoryaudits` | item, action, actor | non-unique | Audit query | **Yes** |
| `inventoryitems` | `{ category: 1, status: 1 }`, `{ supplier: 1, status: 1 }` | non-unique | Query | **No** |
| `inventoryreservations` | `orderId` | **unique** | One reservation per order | **No** |
| `inventoryreservations` | `orderNumber` | non-unique | Lookup | **No** |
| `inventoryreservations` | `status` | non-unique | Queue | **No** |
| `inventoryreservations` | `requirementFingerprint`, `shortageFingerprint` | non-unique | Diagnostics | **No** |
| `inventoryreservations` | `{ status: 1, createdAt: 1 }`, `{ status: 1, updatedAt: -1 }` | non-unique | Approval queue / stale holds | **No** |
| `stockmovements` | `{ item: 1, createdAt: -1 }` | non-unique | Reporting | **No** |
| `stockmovements` | `{ reason: 1, createdAt: -1 }` | non-unique | Consumption/waste reporting | **No** |
| `stockmovements` | `{ refOrderId: 1, reason: 1, item: 1 }` | **unique, partial** (`refOrderId` is ObjectId) | One sale deduction per order/item | **No** |
| `stockmovements` | `{ idempotencyKey: 1 }` | **unique, partial** (String) | Purchase-receipt idempotency | **No** |
| `paymentinfos` | none defined | — | — | **No** (nothing to deploy) |

### 8.3 The `StockMovement` replacement hazard

**VERIFIED:** the schema comment states the previous `(refOrderId, reason)` index rejected every multi-ingredient order and **must be replaced**. The current schema defines `(refOrderId, reason, item)` as unique partial.

**Risk (INFERRED):**
- If the old `(refOrderId, reason)` index still exists and is unique, valid multi-ingredient orders fail.
- If the new index is never created, duplicate sale deductions are possible under concurrency.
- If deployment uses `syncIndexes()` anywhere, it can drop an index outside the approval process.
- `createIndexes()` will not remove the old index; replacement requires an explicit, approved `dropIndex`.

### 8.4 Unique constraints and conflict handling

| Invariant | Backstop | If the index is absent |
|---|---|---|
| One reservation per order | unique `inventoryreservations.orderId` | Concurrent ensure could create duplicates; INFERRED |
| One sale deduction per order/item | unique partial `stockmovements.(refOrderId, reason, item)` | Duplicate deductions under concurrency; INFERRED |
| One purchase receipt per idempotency key | unique partial `stockmovements.idempotencyKey` | Duplicate receipts; INFERRED |
| Unique `(stayId, idempotencyKey)` (Hotel) | Hotel model definition; Hotel index script exists | Hotel script must be run; state UNVERIFIED |
| Payment evidence one per order version (V2) | V2 plan unique index | V2 not deployed/wired |

**Recommendation:** treat the four missing V1 index groups as a prerequisite. Add an approved, additive inventory-index step (or extend the guarded deployment command) and a separate, reviewed `dropIndex` for the obsolete `StockMovement` index. Do **not** re-enable `syncIndexes()`.

### 8.5 Duplicate preflight

Before creating any unique index, run a read-only duplicate check on the target collection. Example (illustrative, not executed):

```js
// inventoryreservations: duplicate orderId
db.inventoryreservations.aggregate([
  { $group: { _id: "$orderId", count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
]);

// stockmovements: duplicate sale deductions per order/item
db.stockmovements.aggregate([
  { $match: { reason: "SaleDeduction", refOrderId: { $type: "objectId" } } },
  { $group: { _id: { order: "$refOrderId", item: "$item" }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
]);
```

A non-empty result blocks index creation and requires manual reconciliation first. **Do not run against production in this phase.**

---

## 9. Guarded index deployment scripts

### 9.1 POS — `scripts/sync-indexes.js`

| Property | Verified behaviour |
|---|---|
| Confirmation | Requires `--confirm` |
| Production gate | Requires `--allow-production` when a production marker is set |
| Approval reference | Requires non-empty `POS_INDEX_DEPLOY_APPROVAL` in production |
| Operation | `createIndexes()` only |
| Destructive operation | Never drops/rebuilds |
| Conflict handling | Non-zero exit; operator inspects |
| Output | Does not print the URI/credentials |
| Coverage | **Nine models** (orders, staffs, categories, menuitems, inventoryaudits + inventoryitems, inventoryreservations, stockmovements, paymentinfos — see §9.4) |
| Legacy-index pre-check | Read-only `listIndexes` before any create; fails closed with an owner-gated manual removal procedure (inventory collections only) |
| Dry-run | `--dry-run` prints the exact plan offline; never connects, never requires `MONGODB_URI` |

### 9.2 Inventory V2 — `scripts/inventory-v2-deploy-indexes.mjs`

| Property | Verified behaviour |
|---|---|
| Confirmation | Requires `--confirm` |
| Production gate | Requires `--allow-production` plus non-empty `INVENTORY_V2_INDEX_DEPLOY_APPROVAL` |
| Operation | `createIndexes()` only |
| Verification | Inspects indexes before and after; verifies exact names, keys, uniqueness, TTL, and partial options |
| Failure policy | Fails closed on missing, unexpected, mismatched, duplicate, or forbidden indexes |
| Destructive operation | Never syncs, removes, or drops |
| Execution status | **Never executed** (Phase 2.0) |
| Coverage | V2 collections only |

### 9.3 Hotel — `scripts/hotel-deploy-indexes.mjs`

| Property | Verified behaviour |
|---|---|
| Confirmation | Requires `--confirm` |
| Production gate | Requires `--allow-production` plus non-empty `HOTEL_INDEX_DEPLOY_APPROVAL` |
| Connection | Hotel-only (`ROOM_MONGODB_URI`); never the POS URI |
| Operation | `createIndexes()` only; never `syncIndexes()`/`dropIndex()`/`dropIndexes()` |
| Failure policy | Reports unexpected/mismatched indexes and exits non-zero; never removes them |
| Coverage | Hotel models only |

### 9.4 Gap statement — **CLOSED (offline implementation only)**

The guarded scripts were well designed but **incomplete for V1 inventory**. No script deployed `InventoryItem`, `InventoryReservation`, `StockMovement`, or `PaymentInfo` indexes.

**Closure (this revision):** `scripts/sync-indexes.js` now covers all nine POS models. The four inventory collections are appended to the same guarded mechanism (no competing script) with an additional read-only legacy-index pre-check; the five original models keep their exact prior path. The plan is derived from the live Mongoose schemas via `lib/indexDeploymentPlan.js` (pure, offline, dependency-free) — index definitions are **not** duplicated by hand, so schema and plan cannot drift.

| Collection | Indexes deployed (exact schema definitions) |
|---|---|
| `inventoryitems` | `(category, status)`; `(supplier, status)` — non-unique |
| `inventoryreservations` | `orderId` **unique**; `orderNumber`; `status`; `requirementFingerprint`; `shortageFingerprint`; `(status, createdAt)`; `(status, updatedAt desc)` |
| `stockmovements` | `(item, createdAt desc)`; `(reason, createdAt desc)`; `(refOrderId, reason, item)` **unique, partial** `{ refOrderId: {$type: "objectId"} }`; `idempotencyKey` **unique, partial** `{ idempotencyKey: {$type: "string"} }` |
| `paymentinfos` | **No schema indexes defined today** — the script explicitly reports "nothing to create" instead of skipping the collection |

#### Exact commands (NOT YET EXECUTED against any shared environment)

```powershell
# 1. Offline plan review — no connection, no URI needed, writes nothing:
node scripts/sync-indexes.js --dry-run

# 2. Deployment (staging or production) — after the duplicate preflight (§8.5) passes:
node --env-file=.env.local scripts/sync-indexes.js --confirm
# Production additionally requires --allow-production and a non-empty
# POS_INDEX_DEPLOY_APPROVAL change/ticket reference (value never printed):
node --env-file=.env.local scripts/sync-indexes.js --confirm --allow-production
```

#### Prerequisites and warnings

- **Production deployment has NOT occurred.** Every run to date was offline (`--dry-run`) or against disposable local instances. Do not treat this code as evidence that any production index exists.
- **Run the read-only duplicate preflight (§8.5) on the target before deployment.** A non-empty duplicate result blocks unique-index creation and requires manual reconciliation.
- **Legacy index removal is never automatic.** The pre-check fails closed with the exact conflicting index (e.g. a legacy unique `(refOrderId, reason)` on `stockmovements`, which rejects every multi-ingredient order while it exists) and prints the owner-gated manual procedure: preflight → owner-approved ticket → separately reviewed maintenance window with a manual `dropIndex` → re-run `--confirm`. `createIndexes()` cannot remove the legacy index, and this command contains no removal of any kind.
- On conflict or duplicate-key failure the script exits non-zero before or during the additive build, never drops, and prints actionable remediation (compare `db.collection.getIndexes()`; §8.5 preflight).
- Test evidence: `tests/inventory-index-deployment.test.mjs` (26 DB-free tests: exact index definitions/options, gate behavior via real process spawns, dry-run output, conflict classification, unchanged behavior for the five original models).

---

## 10. Inventory V2 index plan (informational, not deployed)

**VERIFIED:** `lib/inventory-v2/server/indexPlan.js` defines **18 indexes across 7 `inventory_v2_*` collections**:

| Collection | Indexes | Notable unique constraints |
|---|---|---|
| `inventory_v2_allocations` | 4 | `allocationId`; `(orderId, allocationKey, epoch)` |
| `inventory_v2_waste_corrections` | 2 | `(allocationId, correctionId)` |
| `inventory_v2_approval_challenges` | 3 | `challengeId` only (unique); TTL cleanup; non-unique open lookup |
| `inventory_v2_approvals` | 3 | `(approvalGroupId, stage)`; `challengeId` |
| `inventory_v2_payment_evidence` | 2 | `evidenceId`; `(orderId, orderVersion)` |
| `inventory_v2_audit_events` | 2 | `eventId`; order timeline |
| `inventory_v2_policy_versions` | 2 | `policyVersion`; effective lookup |

Key design rules verified in source:

- The challenge collection has **exactly one** correctness-critical unique index (`challengeId`). A global unique `(approvalGroupId, stage)` on challenges would deadlock re-issuance.
- Uniqueness for `(approvalGroupId, stage)` belongs only to approvals.
- TTL is cleanup-only and must never decide whether a new document may exist.
- Deploying the plan creates empty collections and indexes; it does **not** wire V2 or change V1.

**OWNER DECISION:** approve the V2 index plan and its guarded deployment window only when V2 activation is approved. V2 remains unwired and undeployed; this document does not change that.

---

## 11. Backup, retention, RPO, and RTO (D-5)

### 11.1 Verified state

| Item | Evidence |
|---|---|
| Backup configuration | **No repository evidence** of any backup, snapshot, or PITR configuration |
| Restore procedure | **No repository evidence** |
| Restore drill | **None recorded** |
| RPO/RTO | **Not defined anywhere** |
| Retention policy | **Not defined** for orders, reservations, movements, audits, or logs |
| Encryption at rest | **Not documented** |
| Offsite/cross-region copy | **Not documented** |

**VERIFIED absence:** the repository cannot prove backup or restore readiness.

### 11.2 Why this is production-blocking

- A payment/inventory divergence cannot be reconstructed without the order, reservation, and movement history.
- Destructive administration (§ Decision C) requires a verified backup and export before execution.
- A restore that loses the `counters` collection can produce duplicate order numbers.
- A restore that loses unique indexes can silently admit duplicates after recovery.

### 11.3 Required decisions (OWNER DECISION)

| Item | Options | Evidence required before sign-off |
|---|---|---|
| Backup mechanism | Atlas continuous backup / `mongodump` schedule / filesystem snapshot | Provider configuration screenshot or command output |
| PITR window | Owner-selected | Documented window and cost |
| Retention | 30/90/365 days / longer | Written policy |
| Encryption | Provider-managed / customer-managed | Configuration evidence |
| Offsite copy | Required / not required | Configuration evidence |
| RPO | 0 / ≤15 min / ≤1 h / ≤24 h | Owner-approved value |
| RTO | 1 h / 4 h / 8 h / 24 h | Owner-approved value |
| Restore owner | Named person | Name and backup |
| Restore cadence | Monthly / quarterly / per release | Schedule |

**No RPO/RTO number is asserted here.** They depend on business tolerance and provider capability. The owner must choose and record them.

### 11.4 Retention considerations

| Data | Minimum consideration |
|---|---|
| `orders` (PAID/ARCHIVED) | Must survive any cleanup; financial evidence |
| `inventoryreservations` | Must support reconciliation with orders/movements |
| `stockmovements` | Append-only audit/ledger evidence |
| `inventoryaudits` | Append-only audit |
| `paymentinfos` snapshots on orders | Historical payment account evidence |
| `hotel_payments` / `hotel_audit_logs` | Separate Hotel retention policy |
| Recovery tasks/audit (proposed) | Owner/finance-defined retention; append-only |
| Application logs | Must be retained long enough for incident review; redacted |

---

## 12. Restore verification (D-5)

A backup is not a control until a restore has been proven. The following drill must be completed on an **isolated** environment, never over the production database.

### 12.1 Drill steps

1. Provision an isolated MongoDB target with the same major version and topology class.
2. Restore the latest backup (and, if PITR is claimed, restore to a chosen point in time).
3. Verify the `counters` collection, especially `order_seq`, is present and consistent.
4. Verify the unique indexes exist and are `unique: true` with the correct partial filters:
   - `inventoryreservations.orderId`
   - `stockmovements.(refOrderId, reason, item)`
   - `stockmovements.idempotencyKey`
   - Hotel `(stayId, idempotencyKey)` (if Hotel is in scope)
5. Run read-only reconciliation:
   - PAID orders with no deduction;
   - reservations in a live state on PAID orders;
   - duplicate sale deductions;
   - negative stock;
   - hold drift.
6. Verify application read paths against the restored copy (in a sandbox, not production).
7. Record restore duration (actual RTO) and the data-loss window (actual RPO).
8. Record the evidence: timestamp, backup ID, target, row counts, index list, reconciliation output, operator, verifier.

### 12.2 Pass criteria

| Criterion | Required result |
|---|---|
| Restore completes | Within the approved RTO |
| Data loss | Within the approved RPO |
| Counters intact | Yes |
| Unique indexes present | Yes, exact keys/options |
| PAID/ARCHIVED evidence intact | Yes |
| StockMovement intact | Yes |
| Reconciliation | No unexplained divergence |
| Application smoke test | Read paths work; no write test on production data |
| Evidence package | Stored and reviewed by an independent verifier |

**No restore has been performed. This drill is required before production sign-off.**

---

## 13. Monitoring, health, and alerting (D-6, part 2)

### 13.1 Verified state

| Item | Status |
|---|---|
| Structured logging with redaction | Present (`lib/operationalLogger.js`) |
| Log shipping/buffering | **None** (explicitly documented) |
| Alert sink / on-call routing | **None** |
| Health endpoint | Not verified in this phase |
| DB metrics (pool, transactions, `TRANSACTIONS_UNAVAILABLE`) | **None verified** |
| Backup success/failure alert | **None verified** |
| Index drift alert | **None** |

### 13.2 Required signals

| Signal | Why |
|---|---|
| `TRANSACTIONS_UNAVAILABLE` rate | Detects standalone/misconfigured topology or failover |
| Transaction retry/unknown-commit count | Detects contention and ambiguity |
| Pool saturation / connection count | Prevents gateway timeouts and cluster exhaustion |
| Server selection failures | Detects network/credentials/topology |
| Backup success/failure | Backup is not a control until monitored |
| Restore drill date | Prevent stale assurance |
| Index inventory drift | Detect missing unique indexes |
| PAID-without-deduction count | Recovery readiness |
| Duplicate movement count | Financial integrity |
| Negative stock count | Inventory integrity |

**OWNER DECISION:** approve the alert sink, severity routing, on-call owner, and acknowledgement path.

---

## 14. Operator-versus-staging verification matrix

**Rule:** all write, failover, restore, and destructive tests run on **staging with disposable data**. Production checks are **read-only** unless a separate approved change authorizes otherwise.

| # | Check | Environment | Mode | Evidence | This phase |
|---|---|---|---|---|---|
| 1 | Branch/HEAD/status gate | Repository | Read-only | Git output | **Done** |
| 2 | Topology (`hello`, `rs.status`) | Staging + production | Read-only | Redacted output | Not run |
| 3 | Default RW concern | Staging | Read-only | Command output | Not run |
| 4 | Effective URI options | Staging | Read-only | Redacted review | Not run |
| 5 | Transaction smoke test | Staging | Write (disposable) | Log + data check | Not run |
| 6 | Standalone 503 behaviour | Disposable | Write (disposable) | Phase 2.3 result | **REAL-TESTED** |
| 7 | Retry/unknown-commit | Staging | Write (disposable) | Test output | Not run (V1) |
| 8 | Failover drill | Staging | Write (disposable) | Logs + reconciliation | Not run |
| 9 | Pool saturation | Staging | Load test | Metrics | Not run |
| 10 | Duplicate preflight | Staging + production | Read-only | Aggregation output | Not run |
| 11 | Index inventory dump | Staging + production | Read-only | `getIndexes()` output | Not run |
| 12 | Missing inventory index creation | Staging | Approved write | Post-check | Not run |
| 13 | Old `StockMovement` index replacement | Staging | Approved write | Before/after `getIndexes()` | Not run |
| 14 | V2 index deployment | Staging | Approved write | Script verification output | Not run |
| 15 | Hotel index deployment | Staging (Hotel DB) | Approved write | Script verification output | Not run |
| 16 | Backup restore drill | Isolated restore target | Write (isolated) | RPO/RTO + reconciliation | Not run |
| 17 | Production read smoke test | Production | Read-only | Health output | Not run |
| 18 | Post-restore reconciliation | Isolated restore target | Read-only | Report | Not run |

### 14.1 Production read-only checks (allowed only with owner/DBA approval)

- `hello` / `rs.status()` summary (redacted).
- `getDefaultRWConcern`.
- `db.collection.getIndexes()` for the collections in §8.
- Duplicate preflight aggregations in §8.5.
- Counts for reconciliation (no document content export without approval).

### 14.2 Prohibited in this phase

- Any connection at all.
- Any index create/drop.
- Any restore over a live database.
- Any failover of a live cluster.
- Any destructive script.
- Any V2 activation.

---

## 15. Pre-production gate checklist

The owner/DBA must be able to answer **yes** with attached evidence for every row.

| # | Gate | Required evidence | Status |
|---|---|---|---|
| G1 | Topology is replica set or mongos | `hello`/`rs.status` evidence | ☐ |
| G2 | Transaction commit/abort/retry proven on the deployed topology | Staging test output | ☐ |
| G3 | Standalone returns 503 and is not used in production | Config + test | ☐ |
| G4 | Explicit write concern (majority or approved equivalent) | Config/URI review | ☐ |
| G5 | Explicit read concern/preference appropriate for financial reads | Config review | ☐ |
| G6 | Transaction budget set below the gateway deadline | Config review | ☐ |
| G7 | Pool size/concurrency model approved and load-tested | Staging metrics | ☐ |
| G8 | Failover drill passed | Staging logs + reconciliation | ☐ |
| G9 | Index inventory captured for every collection | `getIndexes()` output | ☐ |
| G10 | Missing inventory/stock indexes deployed | Post-deployment output | ☐ |
| G11 | Obsolete `StockMovement` index replaced with review | Before/after evidence | ☐ |
| G12 | Duplicate preflight clean before unique indexes | Aggregation output | ☐ |
| G13 | V2 index plan approved (if V2 is to be deployed) | Signed plan | ☐ |
| G14 | Hotel index deployment approved (if Hotel is in scope) | Signed plan | ☐ |
| G15 | Backup configured, encrypted, retained | Provider evidence | ☐ |
| G16 | PITR (or approved equivalent) configured | Provider evidence | ☐ |
| G17 | Restore drill passed within RPO/RTO | Drill report | ☐ |
| G18 | Post-restore reconciliation clean | Report | ☐ |
| G19 | Monitoring/alerting live with named on-call | Alert config + name | ☐ |
| G20 | Recovery ownership approved (Decision E) | Signed matrix | ☐ |
| G21 | Destructive policy approved (Decision C) | Signed policy | ☐ |
| G22 | Payment immutability/refund decision approved (Decision B) | Signed decision | ☐ |

**No gate is self-approved.** Financial and destructive gates require the owner plus the relevant independent reviewer.

---

## 16. Owner approval record

| ID | Decision | Approve / Reject / Defer | Conditions | Approver | Date |
|---|---|---|---|---|---|
| D-1 | Production topology (replica set/mongos, member count, failover) | | | | |
| D-2 | Write concern, read concern, read preference, retryable writes | | | | |
| D-3 | Transaction budget (`maxCommitTimeMS`, `maxTimeMS`) | | | | |
| D-4 | Pool size and concurrency model | | | | |
| D-5 | Inventory index deployment scope (including missing indexes) | | | | |
| D-6 | Obsolete `StockMovement` index replacement | | | | |
| D-7 | V2 index plan and deployment window | | | | |
| D-8 | Hotel index deployment | | | | |
| D-9 | Backup mechanism, encryption, retention | | | | |
| D-10 | RPO and RTO values | | | | |
| D-11 | Restore drill cadence and verifier | | | | |
| D-12 | Monitoring/alert sink and on-call owner | | | | |

---

## 17. Required tests (summary)

### 17.1 DB-free / source-contract

1. `sync-indexes.js` covers only the five documented models (regression guard).
2. No `syncIndexes()` returns to the connection path.
3. Production auto-indexing is off by default.
4. Guarded scripts require `--confirm`, `--allow-production`, and the approval env var.
5. No script prints the URI/credentials.
6. Index definitions for `StockMovement` remain unique partial.
7. `InventoryReservation.orderId` remains unique.
8. V2 plan remains 18 indexes across 7 collections with the challenge uniqueness rule.
9. No application code sets `autoIndex: true` for Hotel.
10. No destructive script is referenced by runtime code.

### 17.2 Staging integration

1. Transaction commit/abort.
2. Transient retry commits exactly once.
3. Unknown commit does not duplicate.
4. Standalone returns `503 TRANSACTIONS_UNAVAILABLE`.
5. Unique index rejects a duplicate reservation.
6. Unique partial index rejects a duplicate sale deduction.
7. Old index removal does not break valid multi-item deductions.
8. Failover preserves acknowledged writes and recovers the pool.
9. Pool saturation fails cleanly.
10. Backup restore preserves counters, evidence, and indexes.
11. Post-restore reconciliation passes.
12. V2 script verifies and never drops; Hotel script uses the Hotel connection only.

---

## 18. Production-blocking statement

**Decision D is production-blocking.** Specifically:

1. **Missing inventory/stock indexes.** Idempotency depends on indexes no repository script deploys.
2. **Unverified topology.** Transactions require replica set/mongos; production topology is not proven.
3. **Implicit concerns.** No explicit write/read concern, read preference, or transaction budget.
4. **Unproven failover.** No failover drill exists.
5. **No backup/restore evidence.** RPO/RTO are undefined and no restore has been verified.
6. **No alerting.** Structured logs are not an alert sink.

The guarded deployment scripts are a good foundation, but they do not close the V1 inventory index gap, and no script has been run against a real cluster.

**No database operation was performed in this phase. The next action is explicit owner approval of D-1 through D-12 and completion of the §15 gate with evidence before Phase 2.5.**
