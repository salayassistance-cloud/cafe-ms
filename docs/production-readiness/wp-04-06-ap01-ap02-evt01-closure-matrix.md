# WP-04-06 — AP-01 / AP-02 / EVT-01 Evidence Closure Matrix

**Status:** **OFFLINE EVIDENCE MATRIX — NO BLOCKER CLOSED.**
**Date:** 2026-11-14
**Repository:** `C:\hotelms`
**Scope:** BLK-AP-01 (approval model and separation of duties), BLK-AP-02 (rejection lifecycle), BLK-EVT-01 (event contract and append-only audit).
**Mode:** Offline source/test/documentation inspection only. No database, staging, production, `.env`, credential, deployment, migration, runtime wiring, worker, or scheduler access. No Git staging/commit/reset/clean/stash.

> **Authority.** The approved contract is `wp-04-06-design-consolidation-and-register.md` §2.4 (OD-10 signature, OD-10-A/B/C **APPROVED**, OD-10-D **NOT APPROVED**) plus register §1 (OD-24/25/26/27/27-SC/29/30/31/32/33/34/35/37 approved; OD-36 waived-by-selection). Historical "NOT APPROVED" cells in `wp-04-06-design-discovery-report.md` §19.4–§19.5 are superseded and are not used here.
>
> **Provenance caveat.** `lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`, `lib/recovery/identity.js`, `lib/recovery/taskWriter.js`, and `lib/recovery/operationReconciliation.js` are **untracked working-tree files**. This matrix records what exists in the working tree; it is not a committed-provenance or deployment claim (BLK-EVID-01 remains open).

---

## 1. Status legend

| Status | Meaning in this matrix |
|---|---|
| **VERIFIED** | Approved requirement is implemented in the named source path and covered by the named DB-free test. Offline evidence only. |
| **PARTIAL** | Implementation or test coverage covers part of the approved requirement; a named gap remains. |
| **MISSING** | No conforming implementation, or the implementation contradicts the approved contract. |
| **NOT APPLICABLE** | Clause does not apply to source/test closure in this scope. |

A clause is never marked VERIFIED on schema-field presence alone. Write path, transition behavior, authorization, immutability, and test coverage are required where the clause demands them.

---

## 2. Clause-by-clause matrix (OD-10-A/B/C, register §2.4)

### 2.1 Clause 1 — Collections

| Field | Value |
|---|---|
| Approved requirement | Production collections are `inventory_recovery_tasks`, `inventory_recovery_events`, `inventory_recovery_operation_history` (plural). |
| Implementation | `lib/models/RecoveryTask.js:447` (tasks collection), `lib/models/RecoveryTask.js:558` (history collection), `lib/models/RecoveryEvent.js:228` (events collection). |
| Test evidence | `tests/wp04-06-schema-contract.test.mjs:165` "task contract: schema metadata preserves approved constraints"; `:359` "event contract: event identity, sequence bounds, and append-only evidence metadata"; `:425` "H1 history contract: OPH identity, terminal states, and unique {taskId, operationId}". |
| Status | **VERIFIED** (offline schema metadata) |
| Gap | None in source naming. Deployment is separately gated (G-IDX-1); not a clause-1 gap. |
| Independent verification | Not required for naming; deployment acceptance is separate. |

### 2.2 Clause 2 — Approval record

| Sub-requirement | Implementation | Test evidence | Status |
|---|---|---|---|
| 2a. `approval.*` may first be created in `MANUAL_REQUIRED`; decision made only in `MANUAL_REQUIRED` | `ApprovalSchema` `RecoveryTask.js:135-152`; `LIFECYCLE_TRANSITIONS` T-APPROVE `MANUAL_REQUIRED → MANUAL_REQUIRED` `taskWriter.js:180-187`; status CAS `taskWriter.js:1495-1500` | `wp04-06-writer-boundary.test.mjs:2234` "W11: an authorized operator records approval in one transaction"; `:2273` "W11: invalid state, actor, role, approval and separation are rejected" (invalid state case) | **VERIFIED** |
| 2b. `approval.*` persists across T12 and all later statuses; never cleared | T12 `claimLease` `$set` excludes approval and has no `$unset` approval (`taskWriter.js:1259-1279`); lifecycle `$set` excludes approval (`:1579-1588`); approval is writable only via T-APPROVE allowlist (`:307`) | T12: `wp04-06-writer-boundary.test.mjs:1869` asserts `approval.state === "APPROVED"` after T12. No test asserts persistence through T14/`CLOSED` or `CANCELLED`. | **PARTIAL** |
| 2c. When `APPROVED`/`REJECTED`: `approvedBy`, `approvedAt`, `operatorRole` required, `notes` optional | `normalizeApprovalRecord` `taskWriter.js:713-747`; `resolveCanonicalApproval` `:767-808` | `wp04-06-writer-boundary.test.mjs:1384` "W5: T-APPROVE only emits RECOVERY_APPROVED for an APPROVED record"; `:1414`; `:1437`; `:1491` "W5: T-APPROVE persists exactly the validated approval" | **VERIFIED for APPROVED only**; the `REJECTED` branch is unreachable — see clause 3 |
| 2d. Terminal decisions immutable; flat `approvedBy`/`approvedAt` mirror nested, set in same transaction, never updated | Single canonical `$set` writes nested + flat together `taskWriter.js:1448-1450`; contradiction rejection `:767-808`, `:849-858`; CAS prevents a second approval: `requiresApprovalPending` allows only null/`PENDING` `:1539-1543` | `:1491` asserts nested and flat agree; `:1437` asserts contradictions fail closed. **No dedicated test for re-approval rejection or schema-level immutability** (approval fields are not `immutable: true` in `RecoveryTask.js:400-402`). | **PARTIAL** |
| 2e. `executedBy`/`executedAt` required for T12; `verifierId`/`verifiedAt` required for T14 | T12 sets executor attribution `taskWriter.js:1267-1271`; T14 sets verifier attribution `:1482-1487` | `:1869` (T12 executor fields); `:1671` "T14: a distinct verifier is accepted and server-attributed"; `:1699` "T14: caller-supplied verifier fields cannot override server attribution" | **VERIFIED** |
| 2f. `approvedBy`, `executedBy`, `verifierId` distinct | Approver≠executor/verifier `taskWriter.js:860-868`; executor≠approver at T12 `:1195-1198`, CAS `:1251`; verifier≠approver(both representations) and ≠executor at T14 `:1544-1570` | `:2273` (approver=executor / approver=verifier cases); `:1732` "T12: claimLease requires an explicit authorized OPERATOR distinct from the approver"; `:1554` "T14: closeTask requires an independent verifier distinct from approver and executor"; `:1609` "T14: verifier separation covers both approver representations and the executor" | **VERIFIED** |
| 2g. Nested/flat audit consistency at write and transition time | `resolveCanonicalApproval` `:767-808`; `assertApprovalDistinct` `:849-858`; T12 flat/nested contradiction check `:1200-1210`; T14 CAS flat↔nested equality `:1563-1569` | `:1437` "W5: T-APPROVE rejects conflicting approval and flat audit fields"; `:1770` "T12: incomplete or inconsistent approvals fail closed"; `:1609` | **VERIFIED** |

**Clause 2 overall: PARTIAL.** Conforming for the implemented `APPROVED` path. Open gaps: (i) no test proves approval persistence through `CLOSED`/`CANCELLED`; (ii) no explicit negative test proves re-approval is rejected; (iii) no `REJECTED` terminal decision exists (blocked by clause 3).

### 2.3 Clause 3 — Rejection lifecycle

| Field | Value |
|---|---|
| Approved requirement | `RECOVERY_REJECTED` is in the event enum; emitted only by `MANUAL_REQUIRED → MANUAL_REQUIRED`; sets `approval.state = REJECTED`, records deciding operator in `approval.*` and flat `approvedBy`/`approvedAt`; `status` stays `MANUAL_REQUIRED`; exactly one event with `details.fromStatus`/`toStatus = MANUAL_REQUIRED`; approval persists; no re-approval transition. |
| Implementation | `RECOVERY_REJECTED` exists in `EVENT_TYPES` (`lib/models/RecoveryEvent.js:38`). **No lifecycle row, no writer entry point, and no transition accepts `REJECTED`:** `LIFECYCLE_TRANSITIONS` (`taskWriter.js:157-232`) has no rejection row; `recordApproval` hard-rejects anything except `state === "APPROVED"` (`taskWriter.js:2222-2226`); W11 is the only approval entry point (`:85`). |
| Test evidence | Enum presence only: `tests/wp04-06-schema-contract.test.mjs:330`. No test names any rejection transition. Tests assert the opposite: `wp04-06-writer-boundary.test.mjs:1384` and `:2273` ("approval not approved" case) prove `REJECTED`/`PENDING` cannot be recorded. |
| Status | **MISSING** |
| Exact gap | The `MANUAL_REQUIRED → MANUAL_REQUIRED` rejection transaction required by clause 3 is absent: no writer path can set `approval.state = REJECTED`, no flat mirror is written for a rejection, and no `RECOVERY_REJECTED` event can be emitted. |
| Smallest closure action | Under explicit implementation authorization, add one fixed rejection entry point (or a `T-REJECT` row) that CAS-updates `MANUAL_REQUIRED → MANUAL_REQUIRED`, writes canonical `approval.*` + immutable flat `approvedBy`/`approvedAt`, and inserts exactly one `RECOVERY_REJECTED` event with `fromStatus`/`toStatus = MANUAL_REQUIRED`; add positive, zero-match, rollback, and "one event only" tests. |
| Independent verification | **Required** after implementation (transaction atomicity, event identity, no re-approval). |

### 2.4 Clause 4 — T14 `RECOVERY_VERIFIED` exactly once / `RECOVERY_CLOSED` reserved

| Sub-requirement | Implementation | Test evidence | Status |
|---|---|---|---|
| T14 `RESOLVED → CLOSED` emits exactly one `RECOVERY_VERIFIED` in the same transaction as task CAS + `isOpen:false` | T-CLOSE `taskWriter.js:203-209`; single `insertEvent` in the lifecycle transaction `:1597-1615`; `isOpen:false`/`closedAt` `:1584-1587` | `:1554`, `:1671` assert `eventType === "RECOVERY_VERIFIED"`. **No test asserts the event count is exactly one.** | **PARTIAL** |
| `RECOVERY_CLOSED` reserved and never emitted by T14 or any approved transition | Present in enum `RecoveryEvent.js:42`; no lifecycle row uses it; W7 rejects it as an unapproved effect event | Enum: `schema-contract.test.mjs:331`; W7 rejection: `writer-boundary.test.mjs:1208` "W7: an unapproved event type is rejected before any write" (includes `RECOVERY_CLOSED`). No T14-specific assertion. | **PARTIAL** |

**Clause 4 overall: PARTIAL.** Implementation is conforming; the gap is test explicitness, not behavior. Closure action: add an assertion that `closeTask` inserts exactly one event and that no `RECOVERY_CLOSED` event is produced by T14.

### 2.5 Clause 5 — Escalation / diagnostic separation

| Sub-requirement | Implementation | Test evidence | Status |
|---|---|---|---|
| `escalation.code` allowed set exactly `{ESC_UNKNOWN_COMMIT, ESC_EVIDENCE_DRIFT, ESC_EXHAUSTED, ESC_MANUAL_RULE}` | `RecoveryTask.js:76-81`, `EscalationSchema.code` `:156-160` | `schema-contract.test.mjs:211-213` | **VERIFIED** |
| Diagnostic allowed set exactly `{DOC_CORRUPT, INDEX_ABSENT, TIMEOUT, LEASE_EXPIRED, DRIFT_DETECTED, PERSISTENCE_TIMEOUT, CONFLICT, DRIFT, RETRY}` | `BASE_DIAGNOSTIC_CODES` is exact (`RecoveryEvent.js:60-70`), **but `DIAGNOSTIC_CODES = [...BASE_DIAGNOSTIC_CODES, ...ESCALATION_CODES]` (`:72-75`) and is the enum for `details.diagnosticCode` (`:129-133`).** | `schema-contract.test.mjs:339-346` explicitly asserts the union — i.e. the test encodes the non-conforming set. | **MISSING** |
| Enums disjoint; escalation code never used as diagnostic code and vice versa | Violated in three places: `escalateTask` passes `diagnosticCode: "ESC_EXHAUSTED"` (`taskWriter.js:2259`); `abandonOperation` emits `diagnosticCode: "ESC_UNKNOWN_COMMIT"` (`:2114`); enum union above. | Violations are codified by tests: `writer-boundary.test.mjs:2428` and `:2034`. | **MISSING** |
| `escalation.code` required on `RECOVERY_ESCALATED` | `escalateTask` sets `{code:"ESC_EXHAUSTED"}` (`:2257`), but `abandonOperation` emits `RECOVERY_ESCALATED` **without** setting `task.escalation` (`:2088-2094`, `:2102-2119`); schema default is `null` and not required (`RecoveryTask.js:156-160`). | `:2419` asserts task escalation on W12 only. No abandonment assertion. | **PARTIAL** |
| `UNKNOWN_COMMIT` observation emits no event, allocates no sequence/eventId, mutates nothing | `assessOperationOutcome`/`assessReplayEligibility` hold-only (`taskWriter.js:473-542`); no writer path emits for an observation | `:1072` "OD-31: PREPARED is unresolved and UNKNOWN_COMMIT is never persisted"; `:1089`; `:1119` | **VERIFIED** |

**Clause 5 overall: MISSING.** The approved disjoint-enum contract is contradicted by source and by tests. Closure action: remove escalation codes from `DIAGNOSTIC_CODES` and the `details.diagnosticCode` enum; stop emitting `ESC_*` as `diagnosticCode`; set a conforming `escalation.code` on every `RECOVERY_ESCALATED` (including abandonment); update the three tests that currently assert the violation. This requires authorized source/test changes and independent review.

### 2.6 Clause 6 — Required task fields

| Field | Value |
|---|---|
| Approved requirement | Eleven fields added: `findingCodeOnly` (default false), `durableClass` (default null), `fingerprintSchema` (`wp04-fingerprint-v1`), `evidenceSchema` (`wp04-evidence-v1`), `executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `escalation.expectedStatus`, `escalation.expectedQuantity`, `escalation.actualQuantity`; `escalation.actualStatus` retained. |
| Implementation | `RecoveryTask.js:336` (`findingCodeOnly`), `:337` (`durableClass`), `:340` (`fingerprintSchema`), `:341` (`evidenceSchema`), `:403` (`executedBy`), `:404` (`executedAt`), `:405` (`verifierId`), `:406` (`verifiedAt`), `:161` (`escalation.expectedStatus`), `:163` (`escalation.expectedQuantity`), `:171` (`escalation.actualQuantity`), `:162` (`escalation.actualStatus`). |
| Test evidence | `tests/wp04-06-schema-contract.test.mjs:165` asserts only the six flat fields (`:215-224`) and `escalation.code` (`:211-213`). It does **not** assert `findingCodeOnly`, `durableClass`, `fingerprintSchema`, `evidenceSchema`, or the three escalation quantity/status fields. |
| Status | **PARTIAL** (implementation present; test coverage incomplete) |
| Gap | No test pins the eleven approved fields or their defaults. |
| Smallest closure action | Extend the existing schema-contract test with exact path/default assertions for the eleven fields. No source change. |
| Independent verification | Not required for field presence; still part of independent closure review. |

### 2.7 Clause 7 — Enum alignment

| Field | Value |
|---|---|
| Approved requirement | Exact production enums for classification, severity, confidence, evidence level, `manualReasonCode`, `lastErrorCode`; `lastErrorField` ≤ 64 characters. |
| Implementation | `RecoveryTask.js:47` (`CLASSIFICATIONS`), `:49` (`SEVERITIES`), `:51` (`CONFIDENCES`), `:53` (`EVIDENCE_LEVELS`), `:68-74` (`MANUAL_REASON_CODES`), `:94-99` (`LAST_ERROR_CODES`), `:419-430` (`lastErrorField` maxlength 64 + validator). |
| Test evidence | `tests/wp04-06-schema-contract.test.mjs:129` "task contract: approved enums and operation-state constants are exact"; `:165` (schema metadata, `lastErrorField` 64 at `:195`). |
| Status | **VERIFIED** |
| Gap | None. |
| Independent verification | Not required beyond closure review. |

### 2.8 Clause 8 — Event details

| Sub-requirement | Implementation | Test evidence | Status |
|---|---|---|---|
| `details.toStatus` and `details.attempts` required; `fromStatus` optional/null | `RecoveryEvent.js:126-128` | `schema-contract.test.mjs:371-372` | **VERIFIED** |
| `details.diagnosticCode` optional, bounded by the technical diagnostic enum | Field optional (`RecoveryEvent.js:129-133`); **enum is the non-conforming union** | `schema-contract.test.mjs:354-356` asserts the union | **MISSING** (same root cause as clause 5) |
| `observedFingerprint` optional/null, 64-hex | `RecoveryEvent.js:134-138` | `schema-contract.test.mjs:359` (implicitly via schema checks; no direct case) | **VERIFIED** (source) |
| `leaseDurationMs` optional and positive | `RecoveryEvent.js:139` `min: 1` | No direct test | **PARTIAL** |
| `delta.consumedDelta` / `reservedDelta` optional finite numbers in `[0, 1000000]` | `RecoveryEvent.js:102-122`, validator `:97-100` | No direct test | **PARTIAL** |
| `fencingToken` optional/null UUID v4; version defaults; `projectedEvidence` default `{}` with recursive sensitive-key exclusion | `RecoveryEvent.js:200-223`, validator `:83-95` | `schema-contract.test.mjs:373-387` (defaults + sensitive keys) | **VERIFIED** |

**Clause 8 overall: PARTIAL/MISSING.** The only contract contradiction is the `diagnosticCode` enum; remaining gaps are test explicitness for `leaseDurationMs` and `delta` bounds.

### 2.9 Clause 9 — Operation history

| Field | Value |
|---|---|
| Approved requirement | Collection `inventory_recovery_operation_history`; `historyId = OPH:<taskId>:<operationId>`; full unique index `{taskId:1, operationId:1}` with no partial filter; insert-only, never upserted; no `archiveId`/`OPA:`/`IDX-OPA-01`; task CAS remains the fence. |
| Implementation | `RecoveryTask.js:479-563` (`RecoveryOperationHistorySchema`), `:482-487` (`historyId`), `:569` full unique index; `identity.js:258-264` (`buildOperationHistoryId`); `taskWriter.js:908-925` (`buildHistoryDocument`), `:1025-1038` (`insertHistory`, `insertMany` only), `:1885-1896` (same-transaction effect history), `:2124-2135` (same-transaction abandonment history). |
| Test evidence | `tests/wp04-06-schema-contract.test.mjs:425` "H1 history contract: OPH identity, terminal states, and unique {taskId, operationId}" (`:472-478` unique, no partial filter); `wp04-06-writer-boundary.test.mjs:996` "H1: effect writes task, event and history with the same session"; `:1028` "H1: a duplicate history key aborts the whole effect transaction"; `:1054` "H1: the task-document CAS is the fence, not the history row". |
| Status | **VERIFIED** (offline implementation + DB-free tests) |
| Gap | Deployed index uniqueness and real transaction atomicity are not proven offline; the accepted T2 H1 proof covers its disposable scope only. Deployment remains unauthorized (G-IDX-1). |
| Independent verification | Required for the deployed-index/atomicity claim, not for the offline source claim. |

### 2.10 Clause 10 — Recurrence

| Field | Value |
|---|---|
| Approved requirement | Recurrence after closure creates no task automatically and does not reopen the closed task; recurrence remains scanner evidence; no successor workflow is authorized; a future successor would use immutable `priorTaskId`. |
| Implementation | No writer or scanner path creates a successor or reopens a task. `priorTaskId` is immutable metadata only (`RecoveryTask.js:431-435`). Scanner boundary declares `createsRecoveryTasks:false`/`reopensClosedTasks:false`. |
| Test evidence | `tests/wp04-06-recovery-scanner.test.mjs:473` "never creates or reopens a recovery task and never persists findings" (asserts `boundary.createsRecoveryTasks === false`, `boundary.reopensClosedTasks === false`, `:502-504`). |
| Status | **VERIFIED** (prohibition) |
| Gap | Successor creation is intentionally absent (OD-40 controlling). No gap for the approved contract. |
| Independent verification | Not required. |

---

## 3. Explicit invariant coverage

| Required invariant | Covered by | Status |
|---|---|---|
| Nested/flat approval audit consistency | `taskWriter.js:767-808`, `:849-858`, `:1200-1210`, `:1563-1569`; tests `:1437`, `:1770`, `:1609` | **VERIFIED** |
| Approver/executor/verifier distinctness (pairwise) | `taskWriter.js:860-868`, `:1195-1198`, `:1251`, `:1544-1570`; tests `:2273`, `:1732`, `:1554`, `:1609` | **VERIFIED** |
| Approval persistence through later statuses | Implementation holds (no clear path); only T12 asserted at `:1895` | **PARTIAL** |
| Immutable terminal decisions / no re-approval | CAS `requiresApprovalPending` `taskWriter.js:1539-1543`; no dedicated test; schema fields not `immutable` | **PARTIAL** |
| `RECOVERY_REJECTED` behavior and event identity | Enum only (`RecoveryEvent.js:38`); no writer path | **MISSING** |
| `MANUAL_REQUIRED → MANUAL_REQUIRED` rejection | No transition row / entry point | **MISSING** |
| T14 `RECOVERY_VERIFIED` exactly once | `taskWriter.js:203-209`, `:1597-1615`; tests assert type only (`:1554`, `:1671`) | **PARTIAL** |
| `RECOVERY_CLOSED` reserved and not emitted | Enum `RecoveryEvent.js:42`; no transition uses it; W7 negative test `:1208` | **PARTIAL** |
| Escalation enum vs diagnostic separation | `RecoveryEvent.js:72-75`, `:129-133`; `taskWriter.js:2114`, `:2259` | **MISSING** |
| Event sequence/identity invariants | `identity.js:226-249`; `RecoveryTask.js:376-382`; `taskWriter.js:447-471`; tests `:878`, `:951`, schema `:359`, identity `:100` | **VERIFIED** |
| Append-only history identity and uniqueness | Clause 9 rows above | **VERIFIED** (offline) |
| Transaction/CAS guarantees and negative controls (implemented paths) | `taskWriter.js:965-979`, `:1000-1038`, `:1579-1595`; tests `:2353`, `:2374`, `:1028`, `:1609`, `:1770` | **VERIFIED** for implemented paths; **MISSING** for rejection |

---

## 4. Blocker impact

| Blocker | Current status | Evidence now available | Why it stays open |
|---|---|---|---|
| **BLK-AP-01** | **OPEN** | Clause 2 `APPROVED` path implemented and covered; distinctness and nested/flat consistency verified offline. | Clause 2 is **PARTIAL**: persistence-through-terminal and no-re-approval evidence are missing; the `REJECTED` terminal decision is absent. No independent closure review. |
| **BLK-AP-02** | **OPEN** | Enum value present; no writer path. | Clause 3 is **MISSING**. This matrix does not close it. |
| **BLK-EVT-01** | **OPEN** | Clauses 1, 7, 9, 10 verified; clause 4 partial; clauses 5 and 8 contradict the approved contract. | Source and tests currently encode the wrong diagnostic enum, so the event contract is not conforming. Append-only deployed behavior also remains unverified. |

**No existing blocker-status reference was edited.** The evidence does not conclusively support closing BLK-AP-01, BLK-AP-02, or BLK-EVT-01, and BLK-EVID-01 (untracked provenance, absent guarded deploy script) is unchanged. G-AUD-1 and G-GOV-1 remain unsigned.

---

## 5. Independent-review requirements

1. Review this matrix against register §2.4 clause-by-clause; confirm no clause was upgraded on schema presence alone.
2. Confirm the clause 5 finding: the diagnostic enum must exclude the four `ESC_*` values, and no `ESC_*` value may be written to `details.diagnosticCode`.
3. Confirm the clause 3 finding: no approved transition currently emits `RECOVERY_REJECTED`.
4. Verify the `REJECTED` implementation and the clause 5 correction after they are authored under a separate authorization.
5. Verify deployed index uniqueness/atomicity separately on a disposable replica set; this matrix does not cover it.
6. Record whether clause 6/8 test-coverage additions are sufficient, or whether further negative controls are required.

---

## 6. Files inspected

Source: `lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`, `lib/recovery/taskWriter.js`, `lib/recovery/operationReconciliation.js`, `lib/recovery/identity.js`.
Tests: `tests/wp04-06-schema-contract.test.mjs`, `tests/wp04-06-writer-boundary.test.mjs`, `tests/wp04-06-recovery-scanner.test.mjs`.
Documents: `wp-04-06-design-consolidation-and-register.md` (§1, §2.4, §10–§13), `wp-04-06-design-discovery-report.md`, `wp-04-implementation-acceptance-matrix.md`, `wp-04-implementation-work-packages.md`, `wp-04-test-and-acceptance-plan.md`, `wp-04-gate-dependency-map.md`.

**Files changed by this task:** this document only.
**Not changed:** no source, test, schema, index, script, configuration, environment file, database, or Git state.

---

## 7. Recommended next single action

Obtain owner authorization for one narrowly scoped offline correction package covering **clause 3 (rejection transaction)** and **clause 5 (disjoint diagnostic enum + `escalation.code` on every `RECOVERY_ESCALATED`)**, plus the clause 2/4/6/8 test-coverage additions. Those are the only gaps that block AP-02 and EVT-01; AP-01 then closes with the same package subject to independent review.

Until that authorization exists, the next safe action is **independent review of this matrix**, with BLK-AP-01, BLK-AP-02, and BLK-EVT-01 remaining **OPEN**.
