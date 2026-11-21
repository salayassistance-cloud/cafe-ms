# WP-04-06 — Final Focused Test-Gap Closure and Owner Decisions

**Status:** **COMPLETE — TEST-ONLY CLOSURE, NO SOURCE CHANGE REQUIRED. NO BLOCKER CLOSED.**
**Date:** 2026-11-14
**Repository:** `C:\hotelms`
**Mode:** Offline working-tree edits to two test files only. No database, disposable DB, staging, production, `.env`, secret, migration, index deployment, runtime wiring, deployment, worker/scheduler, or Git staging/commit/reset/clean/stash. Existing user changes preserved (`git diff --cached` remains empty).

---

## 1. Owner decisions as applied

**Decision 1 — W8 / `ESC_UNKNOWN_COMMIT`: RETAINED.** The retain condition is provable from the implementation:
- W8 is an allowlisted writer transition (`WRITER_ENTRY_POINTS` W8 → `abandonOperation`, `lib/recovery/taskWriter.js:83`), separately approved under **OD-37** (register §1/§2.4, APPROVED).
- It requires an explicit operator authorization bound to the exact operation identity (`taskWriter.js:2070-2096`), mutates the task via CAS, and emits exactly one event plus one H1 history record (`taskWriter.js:2222-2288`).
- It is **not** an observation-only path. The observation vocabulary (`assessOperationOutcome`, `assessOperationState`, reconciliation in `lib/recovery/operationReconciliation.js`) never writes. The withdrawn "escalate with `ESC_UNKNOWN_COMMIT`" variant (discovery report §15.5, L758) was the T5 worker-reconciliation observation path, not W8.
- New test encodes this proof: missing/mismatched authorization writes nothing; authorized W8 settles the operation as a transition.

**Decision 2 — Approval immutability: canonical writer CAS remains primary; schema `immutable` NOT introduced.** Evaluation result:
- Mongoose `immutable: true` is a document/update-casting behavior, **not** database-level enforcement — it must not be claimed as such.
- Adding it to `approval.*` / flat `approvedBy`/`approvedAt`/`executedBy`/`executedAt`/`verifierId`/`verifiedAt` would block the sanctioned first writes (T-APPROVE/T-REJECT set the approval fields from null; T12 sets `executedBy`; T14 sets `verifierId`), breaking approved transitions.
- No migration or database constraint was introduced. The writer CAS (`requiresApprovalPending`, distinctness `$ne` clauses) remains the primary boundary, as recorded in the post-correction review §4.2.

---

## 2. Files changed

| File | Change |
|---|---|
| `tests/wp04-06-schema-contract.test.mjs` | +2 tests (clause-6 field types/defaults/bounds; observedFingerprint/fencingToken UUID bounds) |
| `tests/wp04-06-writer-boundary.test.mjs` | +3 tests (W5 `T-REJECT` refusal; UNKNOWN_COMMIT observation is event-free/mutation-free; W8 separately-authorized-transition proof) |

**Not changed:** `lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`, `lib/recovery/taskWriter.js`, all other sources, the closure matrix, both prior review reports, the correction report, approved OD decisions, blocker registers, and all unrelated POS/payment/inventory/Hotel/Kitchen/Barista/Jebena code. No tracked file was modified; nothing was staged.

---

## 3. New tests and results

| Test name | File | Result |
|---|---|---|
| `task contract: remaining clause-6 field types, defaults and bounds are exact` | `tests/wp04-06-schema-contract.test.mjs` | **PASS** |
| `event contract: observedFingerprint is 64-hex and fencingToken is UUID v4` | `tests/wp04-06-schema-contract.test.mjs` | **PASS** |
| `W5: T-REJECT is not reachable through applyTransition` | `tests/wp04-06-writer-boundary.test.mjs` | **PASS** |
| `OD-27/OD-31: an UNKNOWN_COMMIT observation performs no write through any non-abandonment entry point` | `tests/wp04-06-writer-boundary.test.mjs` | **PASS** |
| `W8: ESC_UNKNOWN_COMMIT belongs only to the separately authorized abandonment transition` | `tests/wp04-06-writer-boundary.test.mjs` | **PASS** |

**Coverage added:**
- Clause-6 fields now directly asserted: `executedBy`/`verifierId` (String, default null, maxlength 128), `executedAt`/`verifiedAt` (Date, default null), `escalation.expectedStatus` (String, default null), `escalation.expectedQuantity`/`escalation.actualQuantity` (Number, default null, finite `[0, 1000000]` validator with negative controls for `-1`, `1000001`, `NaN`, `Infinity`, `"1"`).
- `details.observedFingerprint` 64-hex positive/negative controls; `fencingToken` UUID-v4 positive (lowercase/uppercase), negative (v1, bad variant, missing dashes, truncated, non-UUID), default `null`, `immutable: true` declaration.
- `applyTransition({ transitionId: "T-REJECT" })` refused with `TRANSITION_NOT_ALLOWED`, no write/event/history, status/approval/counter unchanged.
- Observation-only proof: `assessOperationOutcome` → `UNRESOLVED/HOLD/not replayable`; `assessOperationState` → `HOLD`; and 10 writer entry points (`claimLease`, `renewLease`, `reserveOperation`, `applyTransition` T-APPROVE/T-EXHAUST, `resolveTask`, `closeTask`, `cancelTask`, `recordApproval`, `recordRejection`, `escalateTask`) all fail `UNRESOLVED_OUTCOME` with zero writes, zero events, zero history, operation stays `PREPARED`, and no sequence consumed. W7 (effect) and W8 (authorized abandonment) are correctly excluded as authorized settlement paths.
- W8 proof: allowlist mapping, `INVALID_ARGUMENT` without authorization, `AUTHORIZATION_MISMATCH` for a foreign operation, and authorized settlement producing exactly one `RECOVERY_ESCALATED` with `diagnosticCode: null`, `escalation.code = ESC_UNKNOWN_COMMIT`, `pendingOperation.state = ABANDONED`, one history row, one session.

## 4. Commands and results

| Command | Result |
|---|---|
| `node --test tests/wp04-06-schema-contract.test.mjs tests/wp04-06-writer-boundary.test.mjs` | **104 tests, 104 pass, 0 fail** (was 99; +5 new) |
| `node --test tests/*.test.mjs` | **1,800 tests, 1,800 pass, 0 fail**, 278 suites, 87 test files; exit `0` (was 1,795; +5 new) |
| `npx eslint tests/wp04-06-schema-contract.test.mjs tests/wp04-06-writer-boundary.test.mjs` | exit `0`, no findings |

## 5. Remaining gaps (unchanged by this round)

1. **Schema/database does not enforce terminal approval immutability** — writer CAS remains primary per owner decision 2; no migration/DB constraint introduced or authorized.
2. **`durableClass` exactness is writer-level only** — Mongoose `Boolean` coerces truthy/falsy raw values; no DB-level or read-path proof (no read-path consumer exists).
3. **No real-database transaction/CAS/index proof** — all evidence is the DB-free in-memory harness; T2/P4/P5 runtime evidence remains the separate accepted record.
4. **W8 `ESC_UNKNOWN_COMMIT` contract wording** — the implementation proves W8 is a separately authorized transition, but clause 5 text does not name W8 or the code; a one-line owner recording of that authorization (documentation only) would remove the interpretation dependency. Not changed here without explicit authorization.
5. **Provenance** — package files remain untracked working-tree files; `git diff --cached` empty. No commit-provenance claim.

## 6. Boundary confirmation

- Only the two test files listed in §2 were edited; **no source file was changed** because no test exposed a violation of the approved decisions.
- No database, disposable DB, staging, or production access; no `.env`/secret read.
- No migration, index deployment, runtime wiring, deployment, worker, or scheduler action.
- No Git staging, commit, reset, clean, or stash; existing unrelated working-tree modifications were left untouched.
- BLK-AP-01, BLK-AP-02, and BLK-EVT-01 remain **OPEN**; no blocker register or approved OD decision was modified.

**Stop.** Returned for owner review.
