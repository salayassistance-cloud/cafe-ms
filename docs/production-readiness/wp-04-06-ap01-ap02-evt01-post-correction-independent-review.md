# WP-04-06 — Post-Correction Independent Review: AP-01 / AP-02 / EVT-01

**Status:** **INDEPENDENT REVIEW COMPLETE — CORRECTIONS SUBSTANTIALLY CONFIRMED, NOT CLOSED.**
**Date:** 2026-11-14
**Repository:** `C:\hotelms`
**Reviewed artifacts:**
- `docs/production-readiness/wp-04-06-ap01-ap02-evt01-closure-matrix.md` (original matrix)
- `docs/production-readiness/wp-04-06-ap01-ap02-evt01-independent-review.md` (prior review)
- `docs/production-readiness/wp-04-06-ap01-ap02-evt01-correction-report.md` (implementation claims)
- `docs/production-readiness/wp-04-06-design-consolidation-and-register.md` §2.4 (approved OD-10-A/B/C contract)
- `lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`, `lib/recovery/taskWriter.js`
- `tests/wp04-06-schema-contract.test.mjs`, `tests/wp04-06-writer-boundary.test.mjs`

**Mode:** Strictly read-only independent verification. No source/test/schema/index/migration edit. No database, disposable database, staging, production, `.env`, credential, runtime wiring, worker/scheduler, deployment, or Git-state action. The only file created is this report.

> **Authority.** Register §2.4 is the approved contract: OD-10 signature **APPROVED**; OD-10-A (approval model) **APPROVED**; OD-10-B (rejection lifecycle) **APPROVED**; OD-10-C (event contract) **APPROVED**; OD-10-D **NOT APPROVED**. Historical discovery-report "NOT APPROVED" cells remain superseded.
>
> **Provenance.** The production model/writer files and both WP04-06 test files are **untracked working-tree files**. `git diff --cached` is empty. This review records working-tree behavior only; it is not committed-provenance, deployment, or runtime proof.

---

## 1. Verdict summary

| # | Review requirement | Independent status | Basis |
|---|---|---|---|
| 1 | W1 creation allowlist blocks privileged lifecycle/audit fields through all creation entry points | **VERIFIED** (offline, writer-level) | `TASK_CREATION_FIELDS` + `pickCreationFields`; only task-creation insert is W1; 27-field injection test |
| 2 | `T-REJECT` / W11 implements the approved rejection contract, transaction atomicity, CAS, event identity, flat/nested consistency, no re-approval | **VERIFIED** (offline; runtime caveat) | New fixed row, canonical REJECTED normalization, task CAS, one event, rollback and terminal-decision negative tests |
| 3 | Every `RECOVERY_ESCALATED` path carries a valid `task.escalation.code`; diagnostic/escalation disjoint; `UNKNOWN_COMMIT` observed-only | **VERIFIED** (with one interpretive note) | W5/W8/W12 paths; `DIAGNOSTIC_CODES === BASE_DIAGNOSTIC_CODES`; no `UNKNOWN_COMMIT` operation state |
| 4 | T14 emits exactly one `RECOVERY_VERIFIED` and never `RECOVERY_CLOSED` | **VERIFIED** | Single `insertEvent`; T-CLOSE row; event-count and no-`RECOVERY_CLOSED` assertions |
| 5 | All eleven clause-6 fields and their bounds/types validated; event-detail bounds validated | **PARTIAL** | All eleven declared; only four have direct type/default assertions; seven lack them; `observedFingerprint` and UUID bounds untested |
| 6 | `durableClass` truly `Boolean|null` across schema, writer, serialization, read paths | **PARTIAL** | Exact at W1; Mongoose `Boolean` coercively casts; no read-path consumer; no DB-level proof |
| 7 | Writer-level approval guards distinguished from schema/database-level enforcement | **PARTIAL** | Writer CAS/guards verified; no `immutable: true` on approval/audit fields; no DB validator |
| 8 | Every new test has meaningful assertions/negative controls and uses the canonical writer, not local substitutes | **PARTIAL** | Canonical writer used and negative controls are real, but specific corrected claims lack direct tests; fake model harness bypasses Mongoose casting |
| 9 | No unrelated POS, payment, inventory, Hotel, Kitchen, Barista, or Jebena behavior changed | **VERIFIED** (scoped; provenance caveat) | Package files are recovery-only; no runtime importer of the writer/models; no unrelated module imports recovery |

**Bottom line.** The three corrections are present in the working tree and are materially stronger than the prior state. There is **no `CONTRADICTED` finding** in this review. The package is nevertheless **not eligible for blocker closure**:

1. Exact `durableClass` and terminal approval immutability are **writer-level only**; the schema does not enforce either at the database boundary.
2. Seven of the eleven clause-6 fields plus `observedFingerprint`/`fencingToken` bounds have **no direct assertions**, so the correction report's "eleven fields" test claim overstates what is tested.
3. W8's use of `ESC_UNKNOWN_COMMIT` is an **interpretive extension** of clause 5 that needs owner adjudication, even though it is not an `UNKNOWN_COMMIT` observation.
4. No real-database transaction proof exists; all evidence is the in-memory writer harness.

---

## 2. Evidence executed

| Check | Result |
|---|---|
| `node --test tests/wp04-06-schema-contract.test.mjs tests/wp04-06-writer-boundary.test.mjs` | **99/99 pass, 0 fail**; 0 suites, 0 skipped |
| `node --test tests/*.test.mjs` | **1,795/1,795 pass, 0 fail**; 278 suites, 87 test files; exit `0` |
| `npx eslint` on the five changed source/test files | exit `0`, no findings |
| Mongoose `Boolean` probe (`mongoose@9.9.3`) | omitted/default → `null`; `"yes"` → `true`; `1` → `true`; `0` → `false`; `null` → `null` |

The probe confirms the correction report's own caveat at §4.2: the schema type is a **coercing** Boolean, not an exact `true|false|null` validator.

---

## 3. Requirement-by-requirement findings

### 3.1 Requirement 1 — W1 creation allowlist

**Status: VERIFIED (offline, writer-level).**

**Requirement.** Every task-creation entry point must refuse privileged lifecycle/audit fields: approval, execution, verification, closure, cancellation, resolution, status, `isOpen`, lease, sequence, operation reservation, escalation, and timestamps.

**Source evidence.**
- `TASK_CREATION_FIELDS` — `lib/recovery/taskWriter.js:334-356`. It admits identity (`taskId`, `taskKey`, `findingIdentityKey`, `orderId`, `orderNumber`, `reservationId`, `itemId`, `lineId`), classification (`rule`, `code`, `classification`, `severity`, `confidence`, `evidenceLevel`, `findingCodeOnly`, `durableClass`, `fingerprintSchema`, `evidenceSchema`), fingerprints (`initialFingerprint`, `currentFingerprint`) and `maxAttempts`. Every privileged field is absent.
- `pickCreationFields(task)` — `taskWriter.js:712-724`. It rejects **any** key not in the allowlist with `INVALID_ARGUMENT` and builds the picked object from the allowlist only.
- `createTaskFromFinding` — `taskWriter.js:1168-1236`. It calls `pickCreationFields` at `:1185` inside `taskDocument`; it validates `durableClass` at `:1180`; it opens the transaction at `:1209`; and the only task insert in the module is `taskModel.insertMany([taskDocument])` at `:1211`.
- No second creation path exists: repository-wide, the only task-model insert is `:1211`; all other task writes are `updateOne`.

**Test evidence.**
- `W1: privileged lifecycle and audit fields cannot be injected at creation` — `tests/wp04-06-writer-boundary.test.mjs:664-708`. The test tries **27** privileged keys (approval, approvedBy/At, executedBy/At, verifierId/verifiedAt, closedAt, cancelledAt, resolution, status, isOpen, lease owner/token/until/generation, eventSequenceCounter, attempts, pendingOperation, manualReasonCode, escalation, nextAttemptAt, lastErrorCode, lastErrorField, priorTaskId, createdAt, updatedAt). For each it asserts `INVALID_ARGUMENT`, **zero writes**, **zero task documents**, and **zero events**.
- `W1: legitimate finding metadata persists and writer-owned state is fixed` — `:710-742`. Confirms legitimate metadata survives and writer-owned state (`DETECTED`, `isOpen`, null lease, generation `0n`, counter `1n`, attempts `0`, no pending operation) is fixed.
- `W1: durableClass accepts only Boolean or null` — `:744-764`. Positive `true|false|null`; negative `"true"|"false"|1|0|{}|[]`.

**Assessment.** The prior review's W1 bypass is closed. `pickCreationFields` runs **before** the session opens, so rejected drafts cannot produce a partial write.

**Residual observation (not a failure of the enumerated approval/audit fields).** The allowlist still accepts caller-selected `maxAttempts` (`taskWriter.js:355`). `maxAttempts` controls T-EXHAUST eligibility (`:1680-1682`) and is schema-immutable (`RecoveryTask.js:387`). The approved clause 6 does not identify it as a finding field, and the correction report explicitly treats it as legitimate (`correction-report.md:35`). This is a lifecycle parameter accepted at creation, not a finding-metadata field; the owner should confirm it is intentionally caller-controlled. It does not reopen the approval/audit injection finding.

---

### 3.2 Requirement 2 — `T-REJECT` / W11 rejection contract

**Status: VERIFIED (offline; runtime caveat).**

**Requirement.** The approved rejection is `MANUAL_REQUIRED → MANUAL_REQUIRED`: one transaction sets `approval.state = REJECTED`, writes canonical nested and flat audit fields, leaves status unchanged, inserts exactly one `RECOVERY_REJECTED` with from/to `MANUAL_REQUIRED`, retains the approval record, and defines no re-approval transition. Task CAS, sequence identity, and atomic rollback must hold.

**Source evidence.**
- Lifecycle row — `taskWriter.js:189-196`. `id: "T-REJECT"`, `from: "MANUAL_REQUIRED"`, `to: "MANUAL_REQUIRED"`, `eventType: "RECOVERY_REJECTED"`, `requiresApprovalPending: true`, `requiresApprovalDistinct: true`.
- Field allowlist — `taskWriter.js:317`: `["approval", "approvedBy", "approvedAt"]`.
- W11 entry point — `taskWriter.js:86` maps W11 to `["recordApproval", "recordRejection"]`; no new W id is introduced.
- `recordRejection` — `taskWriter.js:2402-2431`. Requires an explicit `REJECTED` record, requires `approval.approvedBy === actor.id`, defaults `approvedAt` to writer time, discards caller `fields`, and delegates to `runLifecycle` with `T-REJECT`.
- Canonical approval — `resolveCanonicalApproval(..., "REJECTED")` at `taskWriter.js:1574-1587`; normalization at `:826-860` requires state, non-empty `approvedBy`, authorized `operatorRole`, valid `approvedAt`, and string/null `notes`; it returns only the approved keys.
- Separation — `assertApprovalDistinct` at `:940-990` enforces `OPERATOR`, role membership, actor/record identity agreement, flat/nested agreement, and distinctness from `executedBy`/`verifierId`.
- CAS — `:1662-1669` (task identity, `isOpen`, status, lease generation, unresolved-operation predicate, sequence predicate); `:1687-1691` (`approval.state` null or `PENDING`); `:1692-1703` (`executedBy`/`verifierId`/flat-approver conditions).
- Atomic write — `:1727-1743` sets fields/status/`updatedAt` and increments the counter; `:1745-1763` inserts one event at the next sequence. No history write occurs.
- W5 cannot drive rejection: `:1536-1543` refuses any `applyTransition` transition outside `W5_TRANSITION_IDS = ["T-RETRY","T-EXHAUST","T-APPROVE"]` (`:310`).
- `RECOVERY_REJECTED` is in the event enum — `RecoveryEvent.js:37`.

**Test evidence.**
- `W11: an authorized operator records rejection in one transaction` — `tests/wp04-06-writer-boundary.test.mjs:2690-2729`. Asserts status stays `MANUAL_REQUIRED`, `isOpen: true`, sequence `5n`, eventId `EVT:<task>:5`, nested state/identity/role/notes, flat mirror equality, counter `5n`, exactly one `RECOVERY_REJECTED`, from/to `MANUAL_REQUIRED`, one shared session, and session ended.
- `W11: invalid rejection state, actor, role, record and separation are rejected` — `:2731-2818`. Nine negative cases: wrong status, non-operator, role mismatch, approver=executor, approver=verifier, APPROVED record, PENDING record, identity mismatch, unresolved `PREPARED` operation. Each asserts the exact error code, no write/event/history, approval unchanged, counter unchanged.
- `W11: rejection CAS, event failure and terminal decisions fail without partial writes` — `:2820-2889`. Zero-match CAS aborts; event-insert failure restores the task snapshot and aborts; for both `APPROVED` and `REJECTED` terminal states, both `recordApproval` and `recordRejection` zero-match and produce no event/history.
- `approval persists through T12, T5, T14 and cancellation` — `:2134-2190`. Approval survives claim, resolve, close, and cancellation.

**Assessment.** The prior `MISSING` rejection contract is implemented correctly at the writer level. The "no operation-history row" decision is honored. Flat/nested consistency is achieved by construction: `recordRejection` passes one canonical object and the lifecycle layer derives both representations from it.

**Residual gap.** There is **no direct behavioral test** that `applyTransition({ transitionId: "T-REJECT" })` is refused by W5; the guard is source-asserted only (`W7/W5 source contract...`, `:3174-3209`, and `lifecycle transitions...`, `:3277-3293`). This is a test-explicitness gap, not an implementation gap. Real MongoDB transaction atomicity remains unproven (see §4.4).

---

### 3.3 Requirement 3 — escalation/diagnostic separation and `UNKNOWN_COMMIT`

**Status: VERIFIED (with one interpretive note requiring owner adjudication).**

**Requirement.** Every `RECOVERY_ESCALATED` must carry a valid `task.escalation.code`; escalation and diagnostic enums are disjoint; `UNKNOWN_COMMIT` remains observed-only under OD-27/OD-31.

**Source evidence.**
- `ESCALATION_CODES` — `lib/models/RecoveryTask.js:76-81`: exactly `{ESC_UNKNOWN_COMMIT, ESC_EVIDENCE_DRIFT, ESC_EXHAUSTED, ESC_MANUAL_RULE}`.
- `BASE_DIAGNOSTIC_CODES` — `lib/models/RecoveryEvent.js:61-71`: exactly the nine technical values. `DIAGNOSTIC_CODES` — `:73`: a copy of `BASE_DIAGNOSTIC_CODES` only. No `ESC_*` union remains.
- `details.diagnosticCode` enum — `RecoveryEvent.js:127-131`: `[null, ...DIAGNOSTIC_CODES]`.
- `assertDiagnosticCode` — `taskWriter.js:735-743`, called on the generic lifecycle path (`:1547`), W7 effect path (`:1956`), and W8 (`:2128`).
- `assertEscalationRecord` — `taskWriter.js:749-779`: requires an object with a string `code` in `ESCALATION_CODES`; bounds `expectedStatus`/`actualStatus` to string/null and quantities to finite `[0, 1_000_000]`.
- **W5 T-EXHAUST** — `:1610-1620` requires a non-null `fields.escalation` and validates it before any session opens.
- **W12 `escalateTask`** — `:2433-2445` defaults to `{ code: "ESC_EXHAUSTED" }`, validates a caller-supplied object through T-EXHAUST, and defaults `diagnosticCode` to `null`.
- **W8 `abandonOperation`** — `:2241-2243` writes `escalation: { code: "ESC_UNKNOWN_COMMIT" }`; `:2255-2272` emits `RECOVERY_ESCALATED` with `diagnosticCode` from the validated technical value; the task update, event, and H1 history are in one transaction (`:2222-2288`).
- Only two literal `RECOVERY_ESCALATED` emission sites exist: the T-EXHAUST row constant and W8. This is source-asserted at `tests/wp04-06-writer-boundary.test.mjs:3205-3208`.
- OD-27/OD-31: `assessOperationOutcome` returns `UNRESOLVED/HOLD` for `PREPARED`; no writer path persists `state: "UNKNOWN_COMMIT"`. `lib/recovery/operationReconciliation.js` is read-only and performs only `findOne` (`:14`, `:191-231`).

**Test evidence.**
- `W5: T-EXHAUST requires a valid escalation category and a technical diagnostic only` — `:1481-1542`. Positive `ESC_MANUAL_RULE` + `TIMEOUT`; negatives: missing escalation, missing code, diagnostic used as escalation (`TIMEOUT`), escalation used as diagnostic (`ESC_EXHAUSTED`). Each negative asserts no write, status unchanged, no escalation, no event.
- `W12: caller-supplied escalation must carry an approved category` — `:1544-1572`. Negative `{}`, `{code:null}`, `{code:"TIMEOUT"}`; positive `ESC_EVIDENCE_DRIFT` + `DRIFT_DETECTED`.
- `W12: escalation records the terminal exhaustion in one transaction` — `:2900-2929`. Asserts `task.escalation = {code:"ESC_EXHAUSTED"}`, event `RECOVERY_ESCALATED`, `details.diagnosticCode === null`, one session.
- `OD-37: abandonment settles atomically with approved audit wording` — `:2304-2340`. Asserts `task.escalation.code === "ESC_UNKNOWN_COMMIT"` and `details.diagnosticCode === null`.
- `OD-31: PREPARED is unresolved and UNKNOWN_COMMIT is never persisted` — `:1202-1217`. Asserts `UNRESOLVED/HOLD`, not replayable, no literal `state: "UNKNOWN_COMMIT"`, and `TERMINAL_OP_STATES` excludes it.
- `event contract: approved event vocabulary removes RECOVERY_MANUAL_REQUIRED` — `tests/wp04-06-schema-contract.test.mjs:384-417`. Asserts `DIAGNOSTIC_CODES === BASE_DIAGNOSTIC_CODES`, no `ESC_*` in diagnostics, no diagnostic in escalations, and the event enum.

**Interpretive note — W8 `ESC_UNKNOWN_COMMIT`.** Clause 5 (`register.md:102`) says an `UNKNOWN_COMMIT` **observation** must emit nothing, and `ESC_UNKNOWN_COMMIT` "may be used only by a separately approved transition that explicitly authorizes it." W8 is an **operator-authorized abandonment** under approved OD-37, not an observation, so the observation-only rule is not violated. However, clause 5 does not name W8 or `ESC_UNKNOWN_COMMIT` in the OD-37 text, so "explicitly authorizes" is an interpretation, not a literal cross-reference. **Owner adjudication is required** before this sub-item can be treated as contractually closed. This is a documentation/authority gap, not a code contradiction.

---

### 3.4 Requirement 4 — T14 single-event rule

**Status: VERIFIED.**

**Requirement.** T14 (`RESOLVED → CLOSED`) emits exactly one `RECOVERY_VERIFIED` in the same transaction as the task CAS and `isOpen: false`; `RECOVERY_CLOSED` is never emitted.

**Source evidence.**
- T-CLOSE row — `taskWriter.js:212-218`: `from: "RESOLVED"`, `to: "CLOSED"`, `eventType: "RECOVERY_VERIFIED"`, `closes: true`.
- T14 verifier ownership — `:1630-1635`: writer sets `fields.verifierId = actor.id` and `fields.verifiedAt = now`.
- Distinctness CAS — `:1704-1718`: verifier distinct from flat approver, nested approver, and executor; flat/nested approver consistency.
- Single event — `:1745-1763`: one `insertEvent` in the same `runTransaction`/session as the task `updateOne` (`:1738-1743`).
- No literal `RECOVERY_CLOSED` emission exists in `taskWriter.js` (repository-wide search). `RECOVERY_CLOSED` remains only in the enum (`RecoveryEvent.js:41`).

**Test evidence.**
- `T14: closeTask requires an independent verifier distinct from approver and executor` — `tests/wp04-06-writer-boundary.test.mjs:1777-1836`. Negative missing actor, wrong type, same approver, same executor; positive asserts `CLOSED`, `isOpen:false`, `verifierId`, `events.documents.length === 1`, `eventType === "RECOVERY_VERIFIED"`, and no `RECOVERY_CLOSED`.
- `T14: a distinct verifier is accepted and server-attributed` — `:1900-1935`. Same count/no-`RECOVERY_CLOSED` assertions plus server-attributed `verifiedAt`.
- `T14: verifier separation covers both approver representations and the executor` — `:1838-1896`. Four negative cases, each asserts no write/event/history and unchanged status/counter.
- W7 negative — `:1339-1345` asserts W7 cannot emit `RECOVERY_VERIFIED`/`RECOVERY_CLOSED`.

**Assessment.** Conforms to clause 4. The prior review's "test explicitness only" gap is closed.

---

### 3.5 Requirement 5 — eleven clause-6 fields and event bounds

**Status: PARTIAL.**

**Requirement.** The eleven approved clause-6 fields must exist with the approved types/defaults/bounds, and the event-detail bounds must be validated.

**Source evidence — all eleven declared.**
| Field | Declaration | Type/default |
|---|---|---|
| `findingCodeOnly` | `RecoveryTask.js:336` | Boolean, default `false` |
| `durableClass` | `:339` | Boolean, default `null` |
| `fingerprintSchema` | `:342` | String, default `wp04-fingerprint-v1` |
| `evidenceSchema` | `:343` | String, default `wp04-evidence-v1` |
| `executedBy` | `:405` | String, default `null`, maxlength 128 |
| `executedAt` | `:406` | Date, default `null` |
| `verifierId` | `:407` | String, default `null`, maxlength 128 |
| `verifiedAt` | `:408` | Date, default `null` |
| `escalation.expectedStatus` | `:161` | String, default `null` |
| `escalation.expectedQuantity` | `:163-170` | Number, default `null`, finite `[0,1000000]` validator |
| `escalation.actualQuantity` | `:171-178` | Number, default `null`, finite `[0,1000000]` validator |

`escalation.actualStatus` is retained at `:162` and correctly not counted among the eleven.

**Test evidence — only partial.**
- `task contract: durableClass is Boolean|null and the eleven missing fields exist` — `tests/wp04-06-schema-contract.test.mjs:227-259`.
  - Asserts `durableClass.instance === "Boolean"`, `options.type === Boolean`, default `null`, and `cast(true|false|null)`.
  - Asserts **existence** of all eleven via `RecoveryTaskSchema.path(field)`.
  - Asserts defaults only for `findingCodeOnly`, `fingerprintSchema`, `evidenceSchema`.
  - It **does not** assert types/defaults/bounds for `executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `escalation.expectedStatus`, `escalation.expectedQuantity`, `escalation.actualQuantity`.
- `event contract: detail bounds for leaseDurationMs and delta are enforced` — `:261-281`. Positive/negative for `leaseDurationMs.min = 1`, `consumedDelta`/`reservedDelta` in `[0,1000000]`, `null`, `NaN`, string rejection.
- `event contract: event identity, sequence bounds, and append-only evidence metadata` — `:419-483`. Asserts `toStatus`/`attempts` required, `fencingToken` default `null`, version defaults, projected-evidence sensitive-key rejection, index metadata.
- **No test** exercises `details.observedFingerprint` 64-hex positive/negative, or the `fencingToken` UUID-v4 validator (only its default and one writer value).

**Assessment.** The fields exist and the source validators are present, but the correction report's claim that the eleven fields are tested (`correction-report.md:86`, `:109`) is only true for existence, not for type/default/bound. The event-detail bounds are mostly tested, with `observedFingerprint` and `fencingToken` UUID gaps. This is a **test-coverage deficiency**, not a missing implementation.

**Bypass note.** A caller cannot inject escalation quantities/types through T-EXHAUST without `assertEscalationRecord` validation (`taskWriter.js:769-777`), but a direct model write (outside the canonical writer, which OD-34 prohibits) relies on the Mongoose validator only.

---

### 3.6 Requirement 6 — `durableClass` is truly `Boolean|null`

**Status: PARTIAL.**

**Requirement.** `durableClass` must be exactly `true`, `false`, or `null` across schema declaration, writer, serialization, and read paths. Mongoose `Boolean` casting and null behavior must be explicitly investigated.

**Source evidence.**
- Schema — `lib/models/RecoveryTask.js:336-339`: `durableClass: { type: Boolean, default: null }`. The prior `Mixed` deviation is corrected.
- Writer — `lib/recovery/taskWriter.js:727-732`: `assertDurableClass` accepts only `undefined`, `null`, or `typeof === "boolean"`; called before any transaction at `:1180`.
- Producer — `lib/recovery/classifier.js:713`: `rule.findingCodeOnly === true ? false : null`. Also `lib/recovery/rules/registry.js:273`, `:722` (`false`) and `tests/integration/support/t2RealWriter.mjs:136` (`null`).
- Read paths — repository-wide, there is **no consumer** of `.durableClass` other than the W1 assertion and tests. No projection, serializer, or read-side validator exists to review.

**Mongoose probe (v9.9.3).** `new Model({})` → `null`; `{d:"yes"}` → `true`; `{d:1}` → `true`; `{d:0}` → `false`; `{d:null}` → `null`. Therefore the schema **coerces** truthy/falsy raw values rather than rejecting them. Exactness depends on the writer gate.

**Test evidence.**
- `task contract: durableClass is Boolean|null...` — `tests/wp04-06-schema-contract.test.mjs:227-235`: type, default, cast of `true|false|null`.
- `W1: durableClass accepts only Boolean or null` — `tests/wp04-06-writer-boundary.test.mjs:744-764`: positive `true|false|null`; negative `"true"|"false"|1|0|{}|[]`; each negative asserts no write.

**Assessment.**
- **Schema:** type correct, but coercive.
- **Writer:** exact at the only sanctioned creation path.
- **Serialization:** the writer harness passes raw values to a fake collection, so it does **not** exercise Mongoose casting; in production, `insertMany` would cast, but the writer assertion runs first.
- **Read paths:** no consumer to verify.
- **Database:** no collection validator or migration proof; a direct DB write bypassing OD-34 could store a truthy string that Mongoose would read as `true`.

This is **PARTIAL**, not VERIFIED. The correction report's own §4.2 caveat is accurate; the report should not be read as schema-level exactness.

---

### 3.7 Requirement 7 — writer-level vs schema/database-level approval enforcement

**Status: PARTIAL.**

**Requirement.** Do not treat writer guards as proof of schema or database enforcement.

**Source evidence.**
- `ApprovalSchema` — `lib/models/RecoveryTask.js:135-152`: `state`, `approvedBy`, `approvedAt`, `operatorRole`, `notes` are **not** `immutable: true`; all default `null` and are mutable paths.
- Flat audit fields — `RecoveryTask.js:402-408`: `approval`, `approvedBy`, `approvedAt`, `executedBy`, `executedAt`, `verifierId`, `verifiedAt` are **not** `immutable: true`.
- By contrast, identity fields are immutable (`taskId:249`, `taskKey:255`, `findingIdentityKey:261`, `orderId:267`, `orderNumber:272`, `initialFingerprint:347`, `maxAttempts:387`, `createdAt:443`).
- No database validator/JSON-schema is declared in these modules; `autoIndex: false` and the indexes are metadata only (`RecoveryTask.js:448-454`, `RecoveryEvent.js:225-243`).
- Writer enforcement is real: `requiresApprovalPending` (`taskWriter.js:1687-1691`), terminal `APPROVED` CAS (`:1719-1722`), `assertApprovalDistinct` (`:940-990`), and `resolveCanonicalApproval` (`:880-929`).
- `recordApproval` requires `APPROVED` (`:2370-2399`); `recordRejection` requires `REJECTED` (`:2402-2431`).

**Test evidence.**
- Re-approval/re-rejection zero-match — `tests/wp04-06-writer-boundary.test.mjs:2853-2888`.
- Approval persistence through terminal states — `:2134-2190`.
- Approval/rejection canonical consistency and distinctness — `:2528-2689`, `:2690-2889`.
- No test (and no schema declaration) proves a direct `updateOne` outside the writer cannot clear `approval`; the schema would allow it.

**Assessment.** The writer guards are **verified**; schema/database enforcement is **absent**. The correction report correctly discloses this (§4.3) and does not claim schema immutability. The requirement is therefore **PARTIAL** by definition: a writer-only guarantee is not a database guarantee. This is a real defense-in-depth gap: any future code path or operator write that bypasses the canonical writer can mutate a terminal approval decision. OD-34 forbids such a path, but the database does not enforce it.

---

### 3.8 Requirement 8 — test quality and canonical-writer use

**Status: PARTIAL.**

**Requirement.** Every new test must have meaningful assertions and negative controls; tests must use the canonical writer, not a test-local substitute.

**Verified.**
- Both WP04-06 suites import the production writer: `tests/wp04-06-writer-boundary.test.mjs:36` imports `createRecoveryTaskWriter`; `createWriter` (`:466-474`) passes the fake collections as `models` to the real factory. No test-local writer reimplementation exists.
- The fake session (`:314-337`) snapshots and restores all collections on error, so rollback assertions are meaningful within the harness.
- Negative controls are genuine and specific: 25 W1 injections, 9 rejection negatives, 4 T-EXHAUST negatives, 3 W12 negatives, 4 T14 separation negatives, zero-match CAS and event-failure rollback for rejection/escalation.
- Positive tests assert exact sequence/eventId, status/counter, flat/nested mirrors, session sharing, and event counts.
- The correction report correctly states the WP04-05 integration suite uses test-local schemas and is not writer evidence (`correction-report.md:91`; `tests/integration/wp04-05-persistence.integration.test.mjs:301`).

**Gaps.**
1. **Harness bypasses Mongoose casting/validation.** `createWriter` injects fake collections (`:466-474`), so schema defaults, enums, patterns, and `Boolean` casting are **not** exercised by the writer tests. This is the central reason requirement 6 cannot be upgraded.
2. **Overstated field coverage.** The test named "...the eleven missing fields exist" only asserts existence for seven of them (see §3.5).
3. **No `observedFingerprint` or UUID validator test.**
4. **No W5 `T-REJECT` refusal test** (source-asserted only).
5. **No direct test of `durableClass` omission → schema default `null`**; the writer test covers explicit `null` only.
6. **Fault injection is modelled.** `forceMatchedCount` (`:294-296`) and `failInsertWith` (`:271`) prove the writer's control flow and the harness's snapshot rollback, not MongoDB server behavior.

**Assessment.** The tests that exist are meaningful and use the canonical writer, so the correction report's "canonical writer, not test-local substitute" claim is confirmed. But "every new test" and full coverage of the corrected claims are not achieved. **PARTIAL.**

---

### 3.9 Requirement 9 — no unrelated behavior changed

**Status: VERIFIED (scoped; provenance caveat).**

**Evidence.**
- The correction package consists of exactly six working-tree items: `lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`, `lib/recovery/taskWriter.js`, `tests/wp04-06-schema-contract.test.mjs`, `tests/wp04-06-writer-boundary.test.mjs`, and `docs/production-readiness/wp-04-06-ap01-ap02-evt01-correction-report.md` (all `??` untracked; `git diff --cached` empty).
- The production modules import only `mongoose`, `node:crypto`, `../models/RecoveryTask.js`, `../models/RecoveryEvent.js`, `./identity.js`, and `./operationReconciliation.js` (`taskWriter.js:41-64`). No POS, payment, inventory, Hotel, Kitchen, Barista, or Jebena module is imported.
- Repository-wide, `lib/recovery/taskWriter.js` is imported only by `tests/wp04-06-writer-boundary.test.mjs:40` and `tests/integration/support/t2RealWriter.mjs:34`. No app route, service, or component imports the recovery writer or models. There is no runtime wiring.
- The recovery models are not imported by the unrelated modified files.

**Caveat.** Because the package files are untracked, Git has no baseline to diff; the claim is verified by **import/ownership inspection**, not by a commit diff. The broader working tree is dirty with many pre-existing unrelated modifications (`app/`, `lib/inventory*`, `lib/models/Order.js`, etc.) that this review does **not** attribute to the correction package and did **not** modify.

**Assessment.** No evidence of unrelated behavioral change within the package boundary. **VERIFIED (scoped).**

---

## 4. Cross-cutting analysis

### 4.1 Clause-level impact

| Clause | Prior status | Post-correction independent status | Note |
|---|---|---|---|
| 1 — Collections | VERIFIED | **VERIFIED** | Unchanged |
| 2 — Approval record | PARTIAL | **VERIFIED (writer-level) / PARTIAL (schema-level)** | W1 bypass closed; terminal CAS enforced; no `immutable` schema flag |
| 3 — Rejection lifecycle | MISSING | **VERIFIED (offline)** | Full W11 transaction and tests present |
| 4 — T14 / `RECOVERY_CLOSED` | PARTIAL | **VERIFIED** | Count and no-`RECOVERY_CLOSED` assertions present |
| 5 — Escalation/diagnostic | CONTRADICTED | **VERIFIED (with W8 interpretive note)** | Enums disjoint; every emission path has a code |
| 6 — Required fields | PARTIAL | **PARTIAL** | `durableClass` type fixed; schema coercion and test gaps remain |
| 7 — Enum alignment | VERIFIED | **VERIFIED** | Unchanged |
| 8 — Event details | PARTIAL | **VERIFIED / PARTIAL (test coverage)** | `diagnosticCode` fixed; `observedFingerprint`/UUID untested |
| 9 — Operation history | VERIFIED | **VERIFIED (offline)** | Unchanged |
| 10 — Recurrence | VERIFIED | **VERIFIED** | Unchanged |

### 4.2 Writer-level vs schema/database-level enforcement

| Control | Writer-level | Schema-level | Database-level |
|---|---|---|---|
| W1 privileged-field injection | **Enforced** (allowlist, pre-session) | Fields exist and are writable; no `immutable` | No validator |
| Terminal approval immutability | **Enforced** (pending-decision CAS) | **Not enforced** (no `immutable`) | **Not enforced** |
| Flat/nested approval mirror | **Enforced** (canonical object + CAS) | **Not enforced** (independent mutable paths) | **Not enforced** |
| `durableClass` exactness | **Enforced** (`assertDurableClass`) | Coercive `Boolean` (truthy/falsy cast) | **Not enforced** |
| `details.diagnosticCode` enum | **Enforced** (`assertDiagnosticCode`) | Enum enforced if Mongoose validation runs | **Not enforced** |
| `escalation.code` requirement | **Enforced** on W5/W12; hardcoded on W8 | Enum allows `null` (`RecoveryTask.js:156-160`) | **Not enforced** |

A database reader must not infer schema-level guarantees from the writer tests. This is the central caveat of the package.

### 4.3 Correction report claim check

- §2.1 W1 allowlist — **confirmed** by source and 27-field negative test.
- §2.2 rejection — **confirmed** by source and tests; the report's "no operation-history row" is correct.
- §2.3 escalation/diagnostic — **confirmed**; the only interpretive extension is W8 `ESC_UNKNOWN_COMMIT`.
- §2.4 `durableClass` — **confirmed at W1**, but "across schema/serialization/read paths" is not proven. The report's §4.2 caveat is accurate.
- §2.5 regression coverage — **partially confirmed**; the eleven-field and `observedFingerprint` gaps remain.
- §3 test counts — **independently reproduced**: 99/99 focused, 1,795/1,795 full, ESLint exit 0.
- §4.3 schema-level approval immutability — **confirmed absent**, correctly disclosed.
- §6 boundary — consistent with this review's observations, except that the package files are untracked and no commit diff exists.

### 4.4 Runtime and harness limitations

- The in-memory harness implements `withTransaction` with snapshot/restore (`tests/wp04-06-writer-boundary.test.mjs:314-337`), so rollback is **modelled**, not MongoDB-proven.
- `forceMatchedCount` and `failInsertWith` are test seams, not real driver faults.
- No read concern, write concern, isolation, retryable-write, or server-time (`$$NOW`) behavior is exercised.
- The correction report correctly labels this "offline implementation evidence" and does not claim T2/P4/P5.

---

## 5. Unresolved gaps, ranked

1. **Schema/database does not enforce terminal approval immutability.** `ApprovalSchema` and the flat audit fields are mutable (`RecoveryTask.js:135-152`, `:402-408`). Any path that bypasses the canonical writer can mutate a terminal decision. Owner must decide whether OD-34 alone is sufficient or whether `immutable: true`/a DB validator is required.
2. **`durableClass` exactness is writer-only.** Mongoose `Boolean` casts truthy/falsy values; only `assertDurableClass` rejects them (`taskWriter.js:727-732`). No read-path or DB-level proof exists.
3. **W8 `ESC_UNKNOWN_COMMIT` interpretation.** Clause 5 permits `ESC_UNKNOWN_COMMIT` only via a separately approved transition that explicitly authorizes it. W8 is an approved OD-37 abandonment, but the clause does not name W8 or the code. **Owner adjudication required.**
4. **Seven clause-6 fields lack direct type/default/bound assertions** (`executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `escalation.expectedStatus`, `escalation.expectedQuantity`, `escalation.actualQuantity`). Source declarations are present; tests are not.
5. **`observedFingerprint` 64-hex and `fencingToken` UUID-v4 validators have no direct positive/negative tests.** Source declarations are present (`RecoveryEvent.js:132-136`, `:198-203`).
6. **No W5 `T-REJECT` behavioral refusal test.** The guard exists (`taskWriter.js:1536-1543`) but is source-asserted only.
7. **No real-DB transaction/CAS/index proof.** The in-memory harness is the only evidence.
8. **No `durableClass` omission→default test**; explicit `null` is tested, omission is not.
9. **Provenance.** All package files are untracked; no commit diff or deployed-schema signature exists. This is a repository-state limitation, not a code defect.

---

## 6. Blocker disposition

| Blocker | Disposition | Rationale |
|---|---|---|
| **BLK-AP-01** (approval model / separation of duties) | **OPEN** | W1 injection is closed and writer-level separation is enforced, but schema/database immutability is absent and owner acceptance of the writer-only control is outstanding. |
| **BLK-AP-02** (rejection lifecycle) | **OPEN** | The rejection transaction is implemented and well tested offline, but closure requires owner acceptance and, if the gate requires it, runtime/database proof. Implementation evidence alone does not close it. |
| **BLK-EVT-01** (event contract / append-only audit) | **OPEN** | Enum disjointness and emission-path escalation codes are corrected; `observedFingerprint`/UUID test gaps and the W8 `ESC_UNKNOWN_COMMIT` interpretation remain. |

**No blocker status is changed by this review.** The correction report's "IMPLEMENTED / TESTED OFFLINE" labels are accepted as implementation evidence only.

---

## 7. Smallest next action

**Test-only (smallest, lowest-risk):** add one focused schema-contract block asserting the seven untested clause-6 field types/defaults, the `observedFingerprint` 64-hex validator, and the `fencingToken` UUID-v4 validator; add one `W5` behavioral test that `applyTransition({ transitionId: "T-REJECT" })` is refused. Then re-run the focused suites.

**Gating decision (not test-only):** obtain owner adjudication on the W8 `ESC_UNKNOWN_COMMIT` interpretation and on whether writer-only approval immutability is acceptable for BLK-AP-01. These are authority decisions, not code changes.

Do not close any blocker on the strength of this review alone.

---

## 8. Boundary confirmation

- No source, test, schema, index, migration, script, configuration, or governance file was edited. The only file created is this report.
- No database, disposable database, staging, or production connection/query/write was performed.
- No `.env`, `.env.local`, credential, or secret was read.
- No index deployment, migration, schema deployment, runtime wiring, worker/scheduler activation, or deployment was performed.
- No Git staging, commit, reset, clean, or stash was performed; `git diff --cached` remains empty.
- The closure matrix, prior independent-review report, correction report, approved OD decisions, and blocker registers were not modified.
- Tests were executed offline; they do not open a database connection.

**Stop.** This post-correction independent review is returned for owner review. BLK-AP-01, BLK-AP-02, and BLK-EVT-01 remain **OPEN**.
