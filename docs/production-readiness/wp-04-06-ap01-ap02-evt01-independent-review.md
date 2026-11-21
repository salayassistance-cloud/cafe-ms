# WP-04-06 — Independent Review: AP-01 / AP-02 / EVT-01 Closure Matrix

**Status:** **INDEPENDENT REVIEW COMPLETE — MATRIX PARTIALLY CONFIRMED; FOUR FINDINGS CORRECTED/EXPANDED.**
**Date:** 2026-11-14
**Repository:** `C:\hotelms`
**Reviewed artifact:** `docs/production-readiness/wp-04-06-ap01-ap02-evt01-closure-matrix.md`
**Mode:** Read-only. No source, test, schema, index, script, configuration, or governance edit. No `.env`, credential, database, staging, production, deployment, worker/scheduler, or Git state access.

> **Authority.** Register §2.4 (OD-10 signature; OD-10-A/B/C approved; OD-10-D not approved) and register §1. Historical discovery-report "NOT APPROVED" cells are superseded.
>
> **Provenance.** The production model/writer files are untracked working-tree files. This review records working-tree behavior only; it is not a committed-provenance or deployment claim.

---

## 1. Verdict summary

| Clause | Matrix status | Independent status | Agreement |
|---|---|---|---|
| 1 — Collections | VERIFIED | **VERIFIED** | Confirmed |
| 2 — Approval record | PARTIAL | **PARTIAL** (one sub-invariant contradicted at W1) | Confirmed, with expansion |
| 3 — Rejection lifecycle | MISSING | **MISSING** | Confirmed |
| 4 — T14 / `RECOVERY_CLOSED` | PARTIAL | **PARTIAL** | Confirmed |
| 5 — Escalation/diagnostic | MISSING | **CONTRADICTED** | Classification corrected; substance confirmed and expanded |
| 6 — Required fields | PARTIAL | **PARTIAL** (one field contradicted) | Matrix missed a type deviation |
| 7 — Enum alignment | VERIFIED | **VERIFIED** | Confirmed |
| 8 — Event details | PARTIAL | **PARTIAL** (`diagnosticCode` contradicted) | Confirmed |
| 9 — Operation history | VERIFIED | **VERIFIED** (offline) | Confirmed |
| 10 — Recurrence | VERIFIED | **VERIFIED** | Confirmed |

**The matrix's central conclusions are confirmed:** BLK-AP-02 remains open because the rejection transaction does not exist; BLK-EVT-01 remains open because the diagnostic/escalation enums are not disjoint. The matrix is **not** fully confirmed because it missed a clause-6 type deviation, missed a W1 approval-injection path, and understated the clause-5 `escalation.code` gap.

---

## 2. Clause-by-clause review

### 2.1 Clause 1 — Collections

| Field | Finding |
|---|---|
| Approved requirement | Collections are `inventory_recovery_tasks`, `inventory_recovery_events`, `inventory_recovery_operation_history`. |
| Independent finding | Conforming. |
| Source evidence | `lib/models/RecoveryTask.js:447`; `lib/models/RecoveryTask.js:558`; `lib/models/RecoveryEvent.js:228`. |
| Test evidence | `tests/wp04-06-schema-contract.test.mjs:165`, `:359`, `:425`. |
| Matrix agreement | Agrees (VERIFIED). |
| Remaining gap | None at naming level. Deployment remains separately gated. |

### 2.2 Clause 2 — Approval record

| Field | Finding |
|---|---|
| Approved requirement | `approval.*` created only in `MANUAL_REQUIRED`; persists through T12 and later statuses; terminal decision immutable; nested/flat mirror consistent; `approvedBy`/`executedBy`/`verifierId` distinct. |
| Independent finding | **PARTIAL.** The approval transition and its audit mirror are conforming. Persistence holds because no write clears `approval`. Re-approval is blocked by CAS but has no test. **New: W1 `createTaskFromFinding` spreads an unfiltered caller task draft, so approval, executor, verifier, closure, and resolution fields can be seeded at task creation**, bypassing the "decision only in `MANUAL_REQUIRED`" and distinctness invariants. |
| Source evidence | `ApprovalSchema` `RecoveryTask.js:135-152`; flat fields `:400-406`; T-APPROVE `taskWriter.js:180-187`; canonical write `:1437-1450`; contradiction rejection `:767-808`, `:849-858`; re-approval CAS `:1539-1543`; distinctness `:860-868`, `:1195-1198`, `:1544-1570`; no clear path in T12 `:1259-1279` and lifecycle `:1579-1588`; **W1 draft spread `:1063-1076`**. |
| Test evidence | `wp04-06-writer-boundary.test.mjs:2234`, `:2273`, `:1384`, `:1414`, `:1437`, `:1491`, `:1732`, `:1770`, `:1869`, `:1554`, `:1609`, `:1671`, `:1699`. **W1 tests `:603`, `:622` do not test field injection.** No test asserts approval persistence through `CLOSED`/`CANCELLED`; no re-approval test. |
| Matrix agreement | **Partial disagreement.** The matrix's claim "approval is writable only via the T-APPROVE allowlist" is **incorrect**: W1 is an additional creation-time write path. |
| Remaining gap | (i) W1 must reject/strip privileged fields; (ii) add persistence-through-terminal test; (iii) add re-approval rejection test; (iv) schema-level immutability is absent (writer-only enforcement). |
| Smallest safe correction | Add a W1 creation allowlist that excludes `approval`, `approvedBy`, `approvedAt`, `executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `closedAt`, `cancelledAt`, `resolution`; add one negative test. |

### 2.3 Clause 3 — Rejection lifecycle

| Field | Finding |
|---|---|
| Approved requirement | `MANUAL_REQUIRED → MANUAL_REQUIRED` rejection sets `approval.state = REJECTED`, writes canonical + flat audit, leaves status unchanged, emits exactly one `RECOVERY_REJECTED` with from/to `MANUAL_REQUIRED`. |
| Independent finding | **MISSING.** No lifecycle row, no entry point, and no transaction can persist `REJECTED`. The model enum allows the value, but no conforming writer path exists, so event identity, sequence allocation, CAS, and transaction behavior for rejection are all absent. |
| Source evidence | Enum `RecoveryEvent.js:38`; lifecycle rows `taskWriter.js:157-232` (none is a rejection); entry points `:74-89`; `recordApproval` rejects non-`APPROVED` `:2222-2226`. |
| Test evidence | Enum only `wp04-06-schema-contract.test.mjs:330`. Tests assert the opposite: `wp04-06-writer-boundary.test.mjs:1384` and `:2273` ("approval not approved"). No rejection test exists. |
| Matrix agreement | Agrees (MISSING). |
| Remaining gap | Entire rejection transaction and its tests. |
| Smallest safe correction | Add one fixed rejection path with canonical/flat write, one-event insert, and positive/zero-match/rollback/count tests. |

### 2.4 Clause 4 — T14 and `RECOVERY_CLOSED`

| Field | Finding |
|---|---|
| Approved requirement | T14 emits exactly one `RECOVERY_VERIFIED` in the same transaction as the CAS and `isOpen:false`; `RECOVERY_CLOSED` is reserved and not emitted. |
| Independent finding | **PARTIAL.** The implementation emits exactly one event by construction and never emits `RECOVERY_CLOSED`. Tests assert the event type but not the count, and no T14-specific negative test proves `RECOVERY_CLOSED` is never written. |
| Source evidence | T-CLOSE `taskWriter.js:203-209`; single `insertEvent` `:1597-1615`; closure write `:1584-1587`; no other `RECOVERY_VERIFIED`/`RECOVERY_CLOSED` emission (repository-wide search). |
| Test evidence | `wp04-06-writer-boundary.test.mjs:1554`, `:1609`, `:1671`, `:1699`; W7 negative `:1208`. No event-count assertion. |
| Matrix agreement | Agrees (PARTIAL). |
| Remaining gap | Test explicitness only. |
| Smallest safe correction | Assert `events.documents.length === 1` after `closeTask` and assert no `RECOVERY_CLOSED` event is produced. |

### 2.5 Clause 5 — Escalation / diagnostic separation

| Field | Finding |
|---|---|
| Approved requirement | Escalation set is exactly the four `ESC_*` values; diagnostic set is exactly the nine technical values; the sets are disjoint; `escalation.code` is required on `RECOVERY_ESCALATED`; `UNKNOWN_COMMIT` observations emit nothing. |
| Independent finding | **CONTRADICTED.** The diagnostic enum is the union of both sets, so the sets are not disjoint. `ESC_EXHAUSTED` and `ESC_UNKNOWN_COMMIT` are written into `details.diagnosticCode`. `escalation.code` is not enforced on every `RECOVERY_ESCALATED` path. The matrix classified this as MISSING; under the review vocabulary it is **CONTRADICTED** because a non-conforming implementation exists. |
| Source evidence | `ESCALATION_CODES` `RecoveryTask.js:76-81`; `BASE_DIAGNOSTIC_CODES` `RecoveryEvent.js:60-70`; union `:72-75`; `details.diagnosticCode` enum `:129-133`; `escalateTask` diagnostic default `taskWriter.js:2259`; W8 diagnostic `:2114`; W8 `$set` omits `escalation` `:2088-2099`; W5 T-EXHAUST has no escalation-code validation `:1398-1490`. |
| Test evidence | `wp04-06-schema-contract.test.mjs:339-346` asserts the non-conforming union; `wp04-06-writer-boundary.test.mjs:2428` asserts `diagnosticCode === "ESC_EXHAUSTED"`; `:2034` asserts `diagnosticCode === "ESC_UNKNOWN_COMMIT"`; W12 escalation assertion `:2419`. |
| Emission-path trace | **Path A:** T-EXHAUST via W5 `applyTransition` or W12 `escalateTask`. W12 defaults `escalation.code`, but a caller-supplied `escalation` object without `code` is accepted. W5 can omit `escalation` entirely. **Path B:** W8 `abandonOperation` emits `RECOVERY_ESCALATED` and never sets `task.escalation`. Therefore not every `RECOVERY_ESCALATED` has the required code. |
| Matrix agreement | **Classification disagreement.** Matrix said MISSING and cited only W12/W8; the gap is broader (W5 path and W12 caller-supplied object) and is a contradiction, not absence. |
| Remaining gap | Disjointness, `escalation.code` enforcement on every escalation event, and removal of `ESC_*` from `diagnosticCode`. |
| Smallest safe correction | Remove `...ESCALATION_CODES` from `DIAGNOSTIC_CODES`; change W12/W8 diagnostics to permitted technical values (or null); require a conforming `escalation.code` on T-EXHAUST and W8; update the three tests that encode the violation. |
| OD-29 / OD-31 note | OD-31 observation-only behavior is conforming: `assessOperationState` returns `HOLD` for `PREPARED` and no writer path emits for an observation (`operationReconciliation.js:319-352`; tests `:1072`, `:1089`, `:1119`). OD-29's escalation event exists, but its diagnostic field is misused. |

### 2.6 Clause 6 — Required task fields

| Field | Finding |
|---|---|
| Approved requirement | Eleven fields with stated types/defaults, including `durableClass` as **Boolean|null**, default null. |
| Independent finding | **PARTIAL with one contradiction.** Ten fields conform. **`durableClass` is declared `mongoose.Schema.Types.Mixed` (`RecoveryTask.js:337`), not `Boolean|null`.** Mixed accepts any BSON value, so the approved type is not enforced. |
| Source evidence | `RecoveryTask.js:336-341`, `:161-171`, `:403-406`. |
| Test evidence | `wp04-06-schema-contract.test.mjs:165` checks only six flat fields and `escalation.code`; it does not assert the eleven fields, their types, or defaults. |
| Matrix agreement | **Disagreement.** The matrix marked clause 6 PARTIAL only for missing tests; it did not identify the `durableClass` type deviation. |
| Remaining gap | Type correction plus exact field/default assertions. |
| Smallest safe correction | Change `durableClass` to `Boolean` with `default: null`; add schema-contract assertions for all eleven fields. |

### 2.7 Clause 7 — Enum alignment

| Field | Finding |
|---|---|
| Independent finding | **VERIFIED.** All six enums and the 64-character `lastErrorField` cap match. |
| Source evidence | `RecoveryTask.js:47`, `:49`, `:51`, `:53`, `:68-74`, `:94-99`, `:419-430`. |
| Test evidence | `wp04-06-schema-contract.test.mjs:129`, `:165` (`:195` cap). |
| Matrix agreement | Agrees. |
| Remaining gap | None. |

### 2.8 Clause 8 — Event details

| Field | Finding |
|---|---|
| Independent finding | **PARTIAL.** `toStatus`/`attempts` required, `fromStatus` optional, `observedFingerprint` 64-hex, `leaseDurationMs` min 1, `delta` bounds, `fencingToken` UUID v4, version defaults, and sensitive-key exclusion all conform. **`details.diagnosticCode` uses the contradicted union enum.** `leaseDurationMs` and delta bounds have no direct tests. |
| Source evidence | `RecoveryEvent.js:102-143`, `:200-223`; validator `:83-95`. |
| Test evidence | `wp04-06-schema-contract.test.mjs:359-387`; union assertion `:354-356`. No test hits for `leaseDurationMs`, `consumedDelta`, or `reservedDelta` in `tests/*.test.mjs`. |
| Matrix agreement | Agrees on PARTIAL; the diagnostic sub-item is a contradiction, not merely a gap. |
| Remaining gap | Fix the diagnostic enum; add bound tests. |
| Smallest safe correction | Same enum correction as clause 5 plus three focused assertions. |

### 2.9 Clause 9 — Operation history

| Field | Finding |
|---|---|
| Independent finding | **VERIFIED (offline).** Collection, `OPH:` identity, full unique `{taskId,operationId}` index with no partial filter, insert-only `insertMany`, same-transaction effect/abandonment history, and absence of `archiveId`/`OPA:`/`IDX-OPA-01` all conform. No `upsert` exists in the writer. |
| Source evidence | `RecoveryTask.js:479-569`; `identity.js:258-264`; `taskWriter.js:908-925`, `:1025-1038`, `:1885-1896`, `:2124-2135`. |
| Test evidence | `wp04-06-schema-contract.test.mjs:425`, `:472-478`; `wp04-06-writer-boundary.test.mjs:996`, `:1028`, `:1054`. |
| Matrix agreement | Agrees. |
| Remaining gap | Deployed index/atomicity proof remains separate (G-IDX-1 / disposable proof). |

### 2.10 Clause 10 — Recurrence

| Field | Finding |
|---|---|
| Independent finding | **VERIFIED.** No task-creation or reopening path exists; scanner boundary declares both false; `priorTaskId` is immutable metadata with no writer setter. |
| Source evidence | `RecoveryTask.js:431-435`; `scanner.js:336-343`. |
| Test evidence | `wp04-06-recovery-scanner.test.mjs:473` (assertions at `:502-504`). |
| Matrix agreement | Agrees. |
| Remaining gap | None for the approved prohibition. |

---

## 3. Cross-cutting verifications

| Check | Result |
|---|---|
| Event sequence/identity invariants | **Confirmed.** `EVT:<taskId>:<seq>` (`identity.js:226-249`), unique `{taskId,sequenceNumber}` (`RecoveryEvent.js:238-241`), sequence predicates (`taskWriter.js:447-471`), I-C reserve/effect rules, OD-28 ceiling. Tests `:878`, `:951`, schema `:359`, identity `:100`. |
| Append-only history identity/uniqueness | **Confirmed offline.** Clause 9 above. |
| Transaction/CAS negative controls | **Confirmed for implemented paths**: W11 `:2353`, `:2374`; H1 `:1028`, `:1054`; T14 `:1609`; T12 `:1770`; OD-37 `:2048`. **Absent for rejection.** |
| Alternate recovery write paths | Only `lib/recovery/taskWriter.js` writes recovery collections. Test `:517` scans `lib`/`app`/`scripts`; models are metadata-only (`schema-contract.test.mjs:491-505`). |
| WP04-05 integration suite | **Not production evidence.** It declares test-local schemas (`tests/integration/wp04-05-persistence.integration.test.mjs:259-263`, `:300-301`) and imports neither the production models nor the production writer. Its conforming escalation/diagnostic usage does not validate clause 5 for the production path. |

---

## 4. Corrected or expanded findings

1. **Clause 6 — `durableClass` type mismatch (new).**
   Approved contract: `Boolean|null`. Implementation: `Mixed` (`RecoveryTask.js:337`). The matrix did not record this and marked the clause PARTIAL only for test coverage.

2. **Clause 2 — W1 approval-injection bypass (new).**
   `createTaskFromFinding` serializes `{...task}` without an allowlist (`taskWriter.js:1063-1076`). A caller can seed `approval`, `approvedBy`, `approvedAt`, `executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `closedAt`, `cancelledAt`, or `resolution`. This contradicts the "approval decision only in `MANUAL_REQUIRED`" and distinctness invariants. The matrix's statement that approval is writable only through T-APPROVE is wrong.

3. **Clause 5 — `escalation.code` gap is broader than reported.**
   The matrix cited W8 and W12. Independently, W5 `applyTransition(T-EXHAUST)` can emit `RECOVERY_ESCALATED` with no `escalation` field at all, and W12 accepts a caller-supplied `escalation` object without a `code`. Only the W12 default path sets a conforming code.

4. **Classification corrections.**
   Clause 5 is **CONTRADICTED**, not MISSING (a non-conforming enum and write path exist). Clause 8's `diagnosticCode` sub-item is likewise contradicted. Clause 3 remains MISSING (no implementation).

5. **Minor nuance, not a matrix error.**
   The approved immutability requirement is writer-behavioral; schema-level `immutable: true` is not strictly mandated. Its absence is therefore a hardening defect, not by itself a contract breach. The W1 bypass in finding 2 is the material issue.

---

## 5. Is the matrix independently confirmed?

**Partially.** Confirmed: clauses 1, 4, 7, 9, 10; the absence of the rejection transaction (clause 3); the non-disjoint diagnostic/escalation enums (clause 5); and the overall conclusion that BLK-AP-01, BLK-AP-02, and BLK-EVT-01 remain open.

**Not confirmed as written:** clause 6 is not merely test-incomplete (type deviation), and clause 2 has an unreported creation-time approval bypass. The matrix's clause-5 scope is understated.

---

## 6. Is the proposed offline correction package ready for owner authorization?

**Not yet as scoped.** The matrix proposed clause 3 + clause 5 + test additions. That package is necessary but incomplete. An owner-ready package must add:

1. W1 creation allowlist / privileged-field rejection (clause 2).
2. `durableClass` → `Boolean|null` (clause 6).
3. `escalation.code` enforcement on **all** `RECOVERY_ESCALATED` paths, including W5 T-EXHAUST and caller-supplied W12 escalation (clause 5).
4. The clause 2/4/6/8 test additions already proposed.

With those four additions, the package is a coherent offline correction bundle. BLK-AP-02 and BLK-EVT-01 should remain OPEN until it is implemented and independently reviewed.

---

## 7. Files inspected and changes

**Source:** `lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`, `lib/recovery/taskWriter.js`, `lib/recovery/operationReconciliation.js`, `lib/recovery/identity.js`, `lib/recovery/scanner.js`.
**Tests:** `tests/wp04-06-schema-contract.test.mjs`, `tests/wp04-06-writer-boundary.test.mjs`, `tests/wp04-06-recovery-scanner.test.mjs`, `tests/integration/wp04-05-persistence.integration.test.mjs`.
**Documents:** `wp-04-06-design-consolidation-and-register.md` (§1, §2.4), `wp-04-06-ap01-ap02-evt01-closure-matrix.md`.

**Files changed:** `docs/production-readiness/wp-04-06-ap01-ap02-evt01-independent-review.md` only. The closure matrix and all blocker registers are unmodified.

**Boundary confirmation:** No `.env`, `.env.local`, secret, credential, database, staging, or production system was read or contacted. No migration, deployment, runtime wiring, worker, or scheduler was started. No Git staging, commit, reset, clean, or stash was performed; the existing working tree was preserved.

**Stop.** No corrections were implemented.
