# WP-04-06 — AP-01 / AP-02 / EVT-01 Offline Correction Report

**Status:** **IMPLEMENTATION COMPLETE (OFFLINE WORKING TREE ONLY).** Independent verification and owner acceptance are still required. No blocker is closed by this report.
**Date:** 2026-11-14
**Repository:** `C:\hotelms`
**Authorization:** Owner-granted, narrowly scoped offline source-and-test correction package based on the closure matrix, independent review, and approved OD-10-A/B/C.
**Mode:** Offline working-tree edits only. No database, index, migration, deployment, runtime wiring, worker/scheduler, `.env`/secret, staging/production, or Git-state action.

> **Evidence class.** Every result below is offline implementation evidence against the in-memory writer harness and schema metadata. It is not a T2/P4/P5 runtime proof, not deployed-index proof, and not an owner or independent-review closure decision.

---

## 1. Files changed

| File | Change |
|---|---|
| `lib/models/RecoveryTask.js` | `durableClass` changed from `Mixed` to `Boolean` with `default: null`. |
| `lib/models/RecoveryEvent.js` | `DIAGNOSTIC_CODES` now equals the technical diagnostic set only; removed the `ESCALATION_CODES` union and unused import. |
| `lib/recovery/taskWriter.js` | W1 creation allowlist; `T-REJECT` row; `recordRejection` W11 entry point; REJECTED canonical approval handling; diagnostic/escalation validation on every relevant path; W8 escalation code; W12 diagnostic default corrected. |
| `tests/wp04-06-schema-contract.test.mjs` | Added `durableClass` and eleven-field assertions; added event-detail bound tests; changed diagnostic/escalation assertions to the disjoint contract. |
| `tests/wp04-06-writer-boundary.test.mjs` | Added W1 injection/durable-class tests; rejection lifecycle tests; approval persistence-through-terminal test; T14 event-count assertions; W5/W12 escalation-path tests; updated W8/W12 diagnostic assertions. |
| `docs/production-readiness/wp-04-06-ap01-ap02-evt01-correction-report.md` | This report (new). |

**Not modified:** `docs/production-readiness/wp-04-06-ap01-ap02-evt01-closure-matrix.md`, `docs/production-readiness/wp-04-06-ap01-ap02-evt01-independent-review.md`, blocker registers, approved OD decisions, and all unrelated POS/payment/inventory/Hotel/Kitchen/Barista/Jebena code.

---

## 2. Corrected clauses and implementation symbols

### 2.1 W1 / clause 2 — privileged-field injection

**Symbols:** `TASK_CREATION_FIELDS`, `pickCreationFields`, `assertDurableClass`, `createTaskFromFinding`.

- Replaced the caller-draft spread `{ ...task, ... }` with `{ ...pickCreationFields(task), ... }`.
- The allowlist admits only immutable finding/identity/classification/fingerprint metadata plus `durableClass` and `maxAttempts`.
- Unknown and privileged keys are rejected with `INVALID_ARGUMENT` before a session opens. This covers `approval`, `approvedBy`, `approvedAt`, `executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `closedAt`, `cancelledAt`, `resolution`, `status`, `isOpen`, lease fields, sequence counters, attempts, `pendingOperation`, `manualReasonCode`, `escalation`, `nextAttemptAt`, `lastErrorCode`, `lastErrorField`, `priorTaskId`, and timestamps.
- Legitimate creation behavior is preserved: detection still creates the task and `RECOVERY_DETECTED` event in one transaction, at sequence 1, with writer-owned `DETECTED` state.

### 2.2 Clause 3 — rejection lifecycle

**Symbols:** `T-REJECT`, `TRANSITION_FIELD_ALLOWLISTS["T-REJECT"]`, `resolveCanonicalApproval(..., "REJECTED")`, `recordRejection`, `WRITER_ENTRY_POINTS` W11, `writer.recordRejection`.

- Added the fixed lifecycle row `MANUAL_REQUIRED → MANUAL_REQUIRED` with event `RECOVERY_REJECTED`.
- `recordRejection` is a W11 method (no new W id); `WRITER_ENTRY_POINTS` remains 14 entries and the writer surface is regenerated from the allowlist.
- The transaction:
  - requires an explicit `REJECTED` approval record whose `approvedBy` is the acting operator;
  - validates role, role match, flat/nested agreement, and approver/executor/verifier distinctness through `assertApprovalDistinct`;
  - uses the task-document CAS with `requiresApprovalPending` (`approval.state` null or `PENDING`), status `MANUAL_REQUIRED`, lease generation, the positive unresolved-operation predicate, and the sequence predicate;
  - writes canonical `approval.*` and the flat `approvedBy`/`approvedAt` audit mirror in the same `$set`;
  - leaves `status = MANUAL_REQUIRED` and `isOpen = true`;
  - appends exactly one `RECOVERY_REJECTED` event at the next sequence with `fromStatus`/`toStatus = MANUAL_REQUIRED`;
  - writes no operation-history row because no operation is involved.
- `recordApproval` continues to require `APPROVED`; a terminal `APPROVED` or `REJECTED` record zero-matches the pending-decision CAS, preventing re-approval and terminal mutation.
- No automatic creation, reopening, recurrence, or replay behavior was added.

### 2.3 Clauses 5 / 8 — escalation and diagnostic separation

**Symbols:** `BASE_DIAGNOSTIC_CODES`, `DIAGNOSTIC_CODES`, `ESCALATION_CODES`, `assertDiagnosticCode`, `assertEscalationRecord`, `runLifecycle`, `escalateTask`, `abandonOperation`.

- `DIAGNOSTIC_CODES` is now exactly `{DOC_CORRUPT, INDEX_ABSENT, TIMEOUT, LEASE_EXPIRED, DRIFT_DETECTED, PERSISTENCE_TIMEOUT, CONFLICT, DRIFT, RETRY}`. It no longer contains any `ESC_*` value, so the two enums are disjoint.
- `details.diagnosticCode` is validated by `assertDiagnosticCode` on the generic lifecycle path and the W7 effect path. An `ESC_*` value is rejected as a diagnostic.
- Every `RECOVERY_ESCALATED` emission path now carries a valid `task.escalation.code`:
  - **W5 `T-EXHAUST`:** `assertEscalationRecord` requires `fields.escalation` with an approved code; missing/empty/diagnostic-valued codes are rejected before a session opens.
  - **W12 `escalateTask`:** defaults to `{ code: "ESC_EXHAUSTED" }` but validates a caller-supplied escalation; a caller object without `code`, or with a diagnostic value, is rejected.
  - **W8 `abandonOperation`:** writes `escalation: { code: "ESC_UNKNOWN_COMMIT" }` in the task and emits `diagnosticCode: null` (or a caller-supplied technical diagnostic).
- `escalateTask` no longer defaults `diagnosticCode` to `ESC_EXHAUSTED`; the default is `null`.
- No new event family was introduced. The only literal `RECOVERY_ESCALATED` emissions remain the T-EXHAUST row and W8.
- OD-27 / OD-27-SC / OD-31 hold-default behavior is unchanged: `PREPARED` remains unresolved, `UNKNOWN_COMMIT` is never persisted as an operation state, and an observation alone emits no event.

### 2.4 Clause 6 — `durableClass`

**Symbols:** `RecoveryTaskSchema.path("durableClass")`, `assertDurableClass`.

- Changed the declaration from `mongoose.Schema.Types.Mixed` to `Boolean` with `default: null`.
- W1 accepts only `true`, `false`, `null` (or omission) and rejects strings, numbers, objects, and arrays before any write.
- Existing read/write producers were checked: `lib/recovery/classifier.js` produces `false` or `null`; `lib/recovery/rules/registry.js` uses `false`; `tests/integration/support/t2RealWriter.mjs` uses `null`. No migration or new representation is introduced.

### 2.5 Clauses 2 / 4 / 6 / 8 — regression coverage

Added or strengthened tests for:

- approval persistence through T12, T5, T14/`CLOSED`, and `CANCELLED`;
- re-approval and re-rejection zero-matching the pending-decision CAS;
- nested/flat approval consistency on approval and rejection;
- T14 exactly one `RECOVERY_VERIFIED` and never `RECOVERY_CLOSED`;
- the eleven clause-6 fields and `durableClass` type/default;
- `leaseDurationMs` and delta bounds;
- every `RECOVERY_ESCALATED` path and negative controls for missing/invalid/injected escalation codes;
- rejection CAS, event-insert rollback, and no partial writes.

The tests use the real canonical writer (`createRecoveryTaskWriter`) and the DB-free in-memory harness. The WP04-05 integration suite was not used as writer evidence; it declares test-local Mongoose schemas and does not import the production writer.

---

## 3. Test evidence

### Focused suites

Command:

```powershell
node --test tests/wp04-06-schema-contract.test.mjs tests/wp04-06-writer-boundary.test.mjs
```

Result: **99 tests, 99 pass, 0 fail, 0 cancelled, 0 skipped.**

New/changed test names:

- `task contract: durableClass is Boolean|null and the eleven missing fields exist`
- `event contract: detail bounds for leaseDurationMs and delta are enforced`
- `event contract: approved event vocabulary removes RECOVERY_MANUAL_REQUIRED` (updated)
- `writer boundary: W1-W14 allowlist is exact and the writer surface matches it` (updated)
- `W1: privileged lifecycle and audit fields cannot be injected at creation`
- `W1: legitimate finding metadata persists and writer-owned state is fixed`
- `W1: durableClass accepts only Boolean or null`
- `approval persists through T12, T5, T14 and cancellation`
- `T14: closeTask requires an independent verifier distinct from approver and executor` (updated)
- `T14: a distinct verifier is accepted and server-attributed` (updated)
- `W11: an authorized operator records rejection in one transaction`
- `W11: invalid rejection state, actor, role, record and separation are rejected`
- `W11: rejection CAS, event failure and terminal decisions fail without partial writes`
- `W5: T-EXHAUST requires a valid escalation category and a technical diagnostic only`
- `W12: caller-supplied escalation must carry an approved category`
- `W12: escalation records the terminal exhaustion in one transaction` (updated)
- `OD-37: abandonment settles atomically with approved audit wording` (updated)
- `W7/W5 source contract: strict effect mapping and per-transition allowlists` (updated)
- `lifecycle transitions are the approved rows only` (updated)

### Full regression

Command:

```powershell
node --test tests/*.test.mjs
```

Result: **1,795 tests, 1,795 pass, 0 fail, 278 suites, 87 test files.** Exit code `0`. This compares with the earlier baseline of 1,784 passing tests; the increase is the new coverage above.

### Lint

Command:

```powershell
npx eslint lib/models/RecoveryTask.js lib/models/RecoveryEvent.js lib/recovery/taskWriter.js tests/wp04-06-schema-contract.test.mjs tests/wp04-06-writer-boundary.test.mjs
```

Result: **exit 0, no findings.**

**Build:** not run. A production `next build` would generate `.next` artifacts unrelated to this package, and these recovery modules are not wired into the app runtime. No build result is claimed.

---

## 4. Unresolved gaps and deviations

1. **No runtime transaction proof.** The writer tests use the DB-free in-memory harness. They prove transaction shape, CAS predicates, event identity, and rollback behavior as modelled, not real MongoDB server-time, isolation, or deployed-index uniqueness. T2/P4/P5 evidence remains the separately accepted runtime record.
2. **`durableClass` schema casting nuance.** The declared Mongoose type is `Boolean` with default `null`, so `SchemaBoolean.cast` coerces truthy/falsy raw values. Exact `true`/`false`/`null` enforcement is performed by `assertDurableClass` in the canonical W1 writer, which rejects all other representations. No migration was introduced.
3. **Schema-level approval immutability.** Flat approval fields remain writer-enforced rather than declared `immutable: true`. The owner requirement (reject re-approval and terminal mutation) is enforced by the writer CAS and negative tests; no schema-contract change was made.
4. **`T-EXHAUST` escalation category is caller-selected** from the approved set (W12 defaults to `ESC_EXHAUSTED`). The contract requires a valid code, not one fixed category per path.
5. **W8 always records `ESC_UNKNOWN_COMMIT`** because OD-37 abandonment is the operator-authorized response to an unresolved unknown-commit window. A caller-supplied technical diagnostic is still allowed; no escalation code can enter `details.diagnosticCode`.
6. **WP04-05 integration suite is not production-writer evidence.** It remains test-local and was not run; real database testing was outside the authorized boundary.
7. **Independent verification and owner acceptance are outstanding.** BLK-AP-01, BLK-AP-02, and BLK-EVT-01 remain **OPEN**.

---

## 5. Clause status — implementation evidence only

These statuses describe this offline working tree only. They do **not** close a blocker and are **not** an independent-review or owner-acceptance decision.

| Clause | Previous matrix/review status | Implementation evidence status | Remaining gate |
|---|---|---|---|
| 1 — Collections | VERIFIED | VERIFIED (unchanged) | Deployment remains gated. |
| 2 — Approval record | PARTIAL | **IMPLEMENTED / TESTED OFFLINE** | Independent verification; schema-level immutability remains writer-enforced. |
| 3 — Rejection lifecycle | MISSING | **IMPLEMENTED / TESTED OFFLINE** | Independent verification and owner acceptance. |
| 4 — T14 / `RECOVERY_CLOSED` | PARTIAL | **IMPLEMENTED / TESTED OFFLINE** | Independent verification. |
| 5 — Escalation / diagnostic separation | CONTRADICTED | **CORRECTED / TESTED OFFLINE** | Independent verification; runtime evidence if required. |
| 6 — Required fields | PARTIAL | **CORRECTED / TESTED OFFLINE** | Independent verification of the casting nuance. |
| 7 — Enum alignment | VERIFIED | VERIFIED (unchanged) | None in scope. |
| 8 — Event details | PARTIAL | **CORRECTED / TESTED OFFLINE** | Independent verification. |
| 9 — Operation history | VERIFIED | VERIFIED (unchanged) | Deployed-index/atomicity proof remains separate. |
| 10 — Recurrence | VERIFIED | VERIFIED (unchanged) | None in scope. |

**Blocker register:** BLK-AP-01, BLK-AP-02, and BLK-EVT-01 remain **OPEN**. No status entry was changed outside this report.

---

## 6. Boundary confirmation

- No database connection, query, or write was performed, including disposable or staging databases.
- No index creation, deployment, migration, schema deployment, or destructive schema operation was performed.
- No `.env`, `.env.local`, credential, secret, or secret-bearing log was read.
- No staging or production system, deployment, runtime wiring, activation, worker, or scheduler was touched.
- No Git staging, commit, reset, clean, or stash was performed. `git diff --cached` is empty; the changed files remain untracked working-tree files.
- No unrelated POS, payment, inventory, Hotel, Kitchen, Barista, or Jebena behavior was changed, and no approved OD decision or blocker register was modified.
- The closure matrix and independent-review report were not modified.

**Stop.** This report is returned for owner review. No further corrections were attempted.
