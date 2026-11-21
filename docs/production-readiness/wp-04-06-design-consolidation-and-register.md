# WP-04-06 — Design Consolidation and Durable Owner Decision Register

**Status:** OWNER DECISIONS REGISTERED — **OD-10 APPROVED (2026-11-14)**: OD-10-A / OD-10-B / OD-10-C **APPROVED**, OD-10-D **NOT APPROVED** (OD-40 remains controlling), **BLK-SCH-01 CLOSED** — **WP04-06 T2 ACCEPTED (2026-11-14)** — **OD-38 / OD-39 / OD-40 RECORDED (2026-11-14)** — **R-1 READ-ONLY SOURCE IMPLEMENTED IN WORKING TREE; AUDITED, CORRECTED, AND INDEPENDENTLY VERIFIED (2026-11-14: 46/46 R-1 TESTS + 290/290 REGRESSION TESTS PASS, ESLINT CLEAN); R-1 FORMALLY ACCEPTED BY OWNER (2026-11-14); RUNTIME INTEGRATION NOT AUTHORIZED** — SOURCE IMPLEMENTATION APPROVED BY OWNER; RUNTIME INTEGRATION CONSTRAINED BY OD-38/OD-39; NO WORKER / SCHEDULER ACTIVATION — **WP04-06 FINAL OWNER ACCEPTANCE (2026-11-14): BLK-AP-01 / BLK-AP-02 / BLK-EVT-01 CLOSED; W8 `ESC_UNKNOWN_COMMIT` AUTHORIZATION RECORDED (§14); ACCEPTED RESIDUAL LIMITATIONS PRESERVED**
**Date:** 2026-11-12
**Repository:** `C:\hotelms`
**Branch / HEAD:** `main` / `69650435a6587d4577bc126f719fa1392bb934b3`
**Parent:** `wp-04-06-design-discovery-report.md` (R3)
**Authorization:** WP04-06 documentation completion only. This document registers owner decisions, records the **approved OD-10 schema contract (2026-11-14)** and H1 history contract, and is the authoritative amendment log for the cross-document changes listed in §4. It does **not** authorize implementation, schema/model creation, database access, index deployment, worker activation, or WP04-07.

> **Registration notice.** On 2026-11-12 the owner approved the consolidated WP04-06 design decisions recorded in §1, including the OD-27 scope clarification (OD-27-SC). Settled decisions are **not** reopened here. The status columns of R3 §19.4–§19.5 for the decisions listed in §1 are **superseded by this register**; R3 §19.4–§19.5 remain as written for historical record. This document contains no implementation-readiness claim: BLK-SCH-01 closes only when OD-10 is **signed**, and BLK-EVID-01 remains open until modules are authored under a separate authorization. **(Superseded for OD-10 only: OD-10 was signed on 2026-11-14; OD-10-A/B/C are approved, OD-10-D is not approved, and BLK-SCH-01 is CLOSED — see §2.4 and the OD-10 approval notice above.)**
> 
> **OD-10 approval notice (2026-11-14).** The owner has **APPROVED the OD-10 signature** and the consolidated production schema contract recorded in §2 and §3, together with **OD-10-A (approval model)**, **OD-10-B (rejection lifecycle)**, and **OD-10-C (event contract)**. **OD-10-D (recurrence successor workflow) is NOT APPROVED**; **OD-40** remains the controlling recurrence decision. The ten reconciled clauses are recorded verbatim in **§2.4**. **BLK-SCH-01 is CLOSED (2026-11-14)** because the complete approved contract is recorded consistently in this register and in `wp-04-06-design-discovery-report.md` §3.4. Approval of the schema contract is **not** index deployment authorization: no index is deployed, and deployment remains separately gated by **G-IDX-1**, the absent guarded deploy script, and a DBA window. No model, schema, script, database, worker, or runtime behaviour is changed by this recording.
>
> **Package 2/3 implementation note (2026-11-12).** Offline, DB-free authoring of `lib/recovery/taskWriter.js`, `lib/recovery/operationReconciliation.js`, and `tests/wp04-06-writer-boundary.test.mjs` was separately authorized after this register was written. The exact clarifications and current status are recorded in §10. This note does **not** authorize database access, migrations, index deployment, worker activation, T2, or production integration, and it does **not** close any gate.
>
> **T2 acceptance notice (2026-11-14).** The owner has formally accepted **WP04-06 T2** under **OD-35**, on the basis of the reviewed real-writer wire proof, the independent P4 verification, and the P5 integration negative control (final evidence run `wp04-06-t2-94e4714b61c9`). **BLK-T2-01 is CLOSED.** §10.5 and §11.5 are corrected accordingly; the full record is **§12**. T2 acceptance is **not** a gate signature: G-REC-1, G-REC-2, G-REC-3, G-AUD-1, G-GOV-1, G-IDX-1 and G-PAY-1 remain **UNSIGNED/BLOCKED**, OD-10 production schema/index authorization remains **PENDING**, and BLK-UC-01, BLK-UC-02, BLK-SCH-01, BLK-EVID-01, BLK-AP-01, BLK-AP-02 and BLK-EVT-01 remain **OPEN**. No staging, production, schema/index, runtime, or worker activation is authorized. **(Superseded for OD-10 and BLK-SCH-01 only: the owner approved the OD-10 signature, OD-10-A, OD-10-B, and OD-10-C on 2026-11-14; OD-10-D is not approved; BLK-SCH-01 is CLOSED. Index deployment remains PENDING/UNSIGNED under G-IDX-1 — see §2.4. Further superseded for blocker status only: BLK-AP-01, BLK-AP-02, and BLK-EVT-01 were CLOSED on 2026-11-14 — §14; BLK-UC-01 and BLK-UC-02 were CLOSED on 2026-11-15 by owner action on the crash/restart execution evidence — §15; BLK-EVID-01 remains OPEN.)**
>
> **OD-38 / OD-39 / OD-40 recording notice (2026-11-14).** Three further owner-approved policies are now formally recorded in this repository as **OD-38** (runtime detection boundary), **OD-39** (payment and Inventory runtime preservation), and **OD-40** (recurrence after task closure). They are registered in §1 and recorded in full in **§13**. The repository contains no original approval date, signature, meeting record, or evidence reference for them, and **none is invented**; the recorded date is the date of this documentation. Recording these decisions authorizes **no** runtime Recovery integration, writer call site, worker, scheduler, cron, observation persistence, or gate signature, and changes **no** application behaviour. OD-38 records explicitly that **no Recovery feature flag exists in source** and that the decision creates none.
>
> **R-1 implementation-status notice (correction package).** A **read-only R-1 source implementation** now exists in the working tree but is **untracked**: `lib/recovery/repositories.js`, `lib/recovery/scanner.js`, `scripts/inventory-recovery-scan.mjs`, and the four DB-free test files `tests/wp04-06-recovery-repositories.test.mjs`, `tests/wp04-06-recovery-scanner.test.mjs`, `tests/wp04-06-scan-cli.test.mjs`, and `tests/wp04-06-runtime-isolation.test.mjs`. The first implementation was audited; correction findings were identified and the correction package has been applied (missing Pass 2 order suppression, explicit pass-consistency and D06 coverage limitations, CLI remote-target and production gates, and test separation). **R-1 independent final verification was executed on 2026-11-14 and PASSED** (see §13.6). R-1 is **FORMALLY ACCEPTED BY THE OWNER on 2026-11-14**; the verification results and historical audit record above are preserved. Runtime integration remains **NOT AUTHORIZED**. No worker, scheduler, cron, route, or feature flag is authorized or added. **No database, staging, or production scan has been performed**, and this correction did not connect to MongoDB. OD-10 and every unsigned gate are unchanged. **(OD-10 was subsequently approved on 2026-11-14 and BLK-SCH-01 is CLOSED — see §2.4; every unsigned gate remains unchanged.)**
>
> **WP04-06 final acceptance and blocker-closure notice (2026-11-14).** The owner has formally **accepted the final focused test-gap independent review and the complete WP04-06 offline evidence set** (§14.2). On that basis **BLK-AP-01, BLK-AP-02, and BLK-EVT-01 are CLOSED (2026-11-14)** by owner action, with the residual limitations of §14.5 preserved explicitly (writer-CAS approval protection — not database-level immutability; in-memory transaction harness evidence; untracked/uncommitted provenance). **W8 (`abandonOperation`) is recorded as a separately authorized OD-37 abandonment transition — not an `UNKNOWN_COMMIT` observation path; `ESC_UNKNOWN_COMMIT` is used only by W8** (§14.4; §2.4 clause 5). No source, test, schema, index, database, or runtime change was made. **BLK-UC-01, BLK-UC-02, and BLK-EVID-01 remain OPEN**; **BLK-T2-01 and BLK-SCH-01 remain CLOSED**; all gates remain **UNSIGNED/BLOCKED** and unchanged.

---

## 1. Durable owner decision register (approved 2026-11-12)

| ID | Content | Status | Key references (R3 = `wp-04-06-design-discovery-report.md`) |
|---|---|---|---|
| OD-24 | **H1** — O2-style single-document reservation (`pendingOperation`) plus a separate append-only operation-history record | **APPROVED** | R3 L773, §11 matrix L808–823 |
| OD-25 | (a) one active operation per task, all generations | **APPROVED** | R3 L1322 |
| OD-26 | Representation-local positive `U` on the task document | **APPROVED** | R3 L1330; §22 |
| OD-27 | Hold-default; operator-authorized abandonment; **no automatic replay** of an unknown-commit window | **APPROVED** | R3 L1338 |
| OD-27-SC | **Scope clarification:** worker-bounded **same-identity** replay is permitted **only after a writer-observed definitive abort** (a determinate outcome of the effect attempt). `UNKNOWN_COMMIT` remains **observed-only**: the operation stays `PREPARED` and must **not** be replayed. All other OD-27 hold and operator-authorization rules unchanged. V1 evidence and operator authorization are never abort proof; audit wording is `OPERATOR_DECISION_AFTER_HOLD`, never `ABORT_CONFIRMED`. | **APPROVED** | resolves R3 §6.2 L602 vs §22.3 L1771–1774; audit wording R3 L1941, L2035 |
| OD-28 | (a) permanent sequence gaps, no reuse, fail-closed ceiling (`SEQUENCE_OVERFLOW`) | **APPROVED** | R3 L1346, §15.1–15.3 L1083–1096 |
| OD-29 | (a) `RECOVERY_ESCALATED` event + `details.diagnosticCode`; no new event-enum family; `RECOVERY_MANUAL_REQUIRED` removed from the production enum | **APPROVED** | R3 L1354, §15.5 L1102–1120 |
| OD-30 | **H1 atomicity resolution:** the **task-document CAS is the fence**; the history record is **NOT** the uniqueness fence (if it were, H1 converges to O1 — R3 L831). History records are inserted **in the same transaction** as `T_effect` / `T_abandon`. A unique history key (§3) is required for record identity and retry idempotency. | **APPROVED** | R3 §11.4 L826–834; §22.4 |
| OD-31 | (b) `UNKNOWN_COMMIT` observed only; operation stays `PREPARED` | **APPROVED** | R3 L1370 |
| OD-32 | (c) snapshot + fingerprint linkage; orphan snapshot = `MANUAL_REQUIRED` | **APPROVED** | R3 L1378 |
| OD-33 | **H1-with-abandonment-history** — H-D/H-C rejected; OD-36 moot | **APPROVED** | R3 §22.8 L2074–2093 |
| OD-34 | (a) single canonical writer module + operation allowlist + source test + runtime tracing | **APPROVED** | R3 L1394, §12 |
| OD-35 | (a) proof criteria P1–P6; P4/P5 mandatory | **APPROVED** (criteria); **T2 execution ACCEPTED 2026-11-14 — see §12** | R3 L1402, §18 L1216–1237; accepted evidence `wp04-06-t2-94e4714b61c9` |
| OD-36 | — | **WAIVED-BY-SELECTION** (moot: H-D not selected under OD-24/OD-33) | R3 L1295 area, §22.8 |
| OD-37 | Expired-original-lease identity predicate; **`ABANDONABLE_STATUSES = {LEASED}`** — only `LEASED` can hold a `PREPARED` operation conformingly | **APPROVED** | R3 L1414–1420, L1916, §22.6 |
| T9/ACQ | **Acquire/claim consistency amendment:** every claim/transition filter includes the positive unresolved-operation predicate `U_claim` — `$or: [{ pendingOperation: null }, { "pendingOperation.state": { $in: ["COMMITTED", "ABANDONED"] } }]` — and increments `leaseGeneration` **in the same write**. A claim cannot bypass OD-37: a generation bump on a non-terminal operation would permanently zero-match `T_abandon`. | **APPROVED** | R3 §13.4; SM T9 L144; CL §2.2 L66–118 |
| I-C | **Standalone `T_reserve`:** W6 is **not** folded into W2/W5. It is its own transaction immediately after the claim/transition and before the effect, under the same lease identity; it **emits no event** and reserves **exactly one** sequence. The folded variant remains unapproved (R3 L1825). | **APPROVED** | R3 L888, L1825 |
| H1-EXT | **Abandonment-history extension:** the H1 history record covers effect commits **and** abandonment records (extends the effect-commit-only definition at R3 L773/L2089) | **APPROVED** | R3 §22.8; §22.3.5 shape L1699–1735 |
| OD-38 | **Runtime detection boundary:** D01–D10 remain `DEFERRED` / `ALERT_ONLY` exactly as defined by their approved rule definitions; the Recovery scanner is **read-only**; findings do **not** autonomously create Recovery Tasks; the Recovery writer remains **unavailable to application runtime** (no writer call site or runtime activation); **no runtime observation persistence**; **no worker, scheduler, cron, or autonomous Recovery execution**. No Recovery feature flag exists in source, and this decision creates none. | **APPROVED (policy) - recorded 2026-11-14. R-1 read-only scanner/repository/CLI source is PRESENT IN THE WORKING TREE (untracked); audited, corrected, and independently verified on 2026-11-14; FORMALLY ACCEPTED BY OWNER 2026-11-14; runtime integration NOT AUTHORIZED.** | §13.1; `lib/recovery/rules/registry.js`; `lib/recovery/classifier.js` L670–715; `lib/recovery/scanner.js`; `lib/recovery/repositories.js` |
| OD-39 | **Payment / Inventory runtime preservation:** existing `payOrder()` behaviour and existing Inventory runtime failure logging are preserved unchanged; **no** runtime Recovery Task creation, persisted observation, or runtime fingerprint; `fingerprintEvidence()` may process **only approved projected scanner evidence bundles**; unknown-commit outcomes are **never automatically retried or replayed**; **D06 may inspect existing `CONSUMING` reservations**; payment state transitions, Inventory deduction semantics, and existing failure logging are not altered. | **APPROVED (policy) - recorded 2026-11-14. R-1 source is PRESENT IN THE WORKING TREE (untracked); no protected payment/Inventory runtime path was modified or imported; independently verified 2026-11-14; FORMALLY ACCEPTED BY OWNER 2026-11-14.** | §13.2; `lib/orderService.js` L1007–1045, L1083–1241; `lib/inventoryReservationService.js` L129–164, L1174–1376 |
| OD-40 | **Recurrence after closure:** if the same finding recurs after its Recovery Task is closed, **no new task is created automatically** and the **closed task is not reopened**; the recurrence is retained as **scanner evidence** pending a separately approved recurrence-handling policy. The `isOpen: false` terminal invariant and the existing unique-open-task identity rules are preserved. | **APPROVED (policy) - recorded 2026-11-14. R-1 read-only scanner source is PRESENT IN THE WORKING TREE (untracked) and has no task-creation or reopening path; independently verified 2026-11-14; FORMALLY ACCEPTED BY OWNER 2026-11-14; no recovery collection is read or written by R-1.** | §13.3; `lib/models/RecoveryTask.js` L361, L456–472; `lib/recovery/taskWriter.js` L1585 |
| OD-10 | Production schema contract — **APPROVED 2026-11-14** (signature); **OD-10-A** approval model, **OD-10-B** rejection lifecycle, and **OD-10-C** event contract all **APPROVED**; **OD-10-D** recurrence successor workflow **NOT APPROVED** (OD-40 controlling). The ten reconciled clauses are in §2.4; **BLK-SCH-01 is CLOSED**. Index deployment is **not** authorized by this signature and remains **PENDING** under G-IDX-1 + guarded deploy script + DBA window. | **APPROVED (2026-11-14)** — production schema contract; BLK-SCH-01 **CLOSED**; deployment remains **PENDING/UNSIGNED**. | R3 L1254, §3.1/§3.2; §2.4; R3 §3.4 |
| OD-04 | Retention periods (tasks, events, history records, evidence snapshots) | **OPEN — owner input required (§7)** | SM §10.2 L472–477; ODP L359–362 |
| OD-07 | Alerting (sink, on-call routing, SLA) | **OPEN — owner/operations input required (§7)** | SM §11.3 L526–528 |
| OD-09 | Lease duration, retry timing, ceiling numerics | **OPEN — test-derived only (§6)** | ODP WD-08/D-07/D-08 |

---

## 2. OD-10 production schema contract (APPROVED 2026-11-14; index deployment separately gated)

> **Provenance.** The owner approved the **OD-10 signature** on **2026-11-14**, together with OD-10-A, OD-10-B, and OD-10-C; **OD-10-D is not approved**. This section and §3 now record the approved production contract. `lib/models/RecoveryTask.js` / `RecoveryEvent.js` declarations remain **authored metadata**: no index listed in §2/§3 is deployed. Index deployment still requires **G-IDX-1**, the guarded deploy script (currently absent), and a DBA window (R3 §5.3). Approval of the contract does not deploy it.

Sources merged and divergences resolved: R3 §3.1 (L105–214) / §3.2 (L218–267) / §3.1.3 (L192–214), WP04-04 persistence design, WP04-05 disposable `TaskSchema`/`EventSchema`, and the production classifier vocabulary (`lib/recovery/classifier.js` L679–715).

### 2.1 `inventory_recovery_tasks`

| Area | Contract |
|---|---|
| Classification enums | `classification ∈ {DEFECT, ALERT, INFO}`; `severity ∈ {CRITICAL, HIGH, MEDIUM, INFO}`; `confidence ∈ {HIGH, MEDIUM, LOW}`; `evidenceLevel ∈ {E0, E1, E2, E3}` (grounded: `lib/recovery/classifier.js` L687–689; §2.4 clause 7) |
| Approval shape | Nested `approval.*` is the approval-cycle record; flat `approvedBy`/`approvedAt` are the immutable audit mirror; flat `executedBy`/`executedAt` and `verifierId`/`verifiedAt` are SoD attribution (both kept; §2.4 clause 2) |
| Separation of duties | `approvedBy`, `executedBy`, and `verifierId` MUST be **distinct identities**; `executedBy`/`executedAt` required for T12; `verifierId`/`verifiedAt` required for T14 (§2.4 clause 2) |
| Approval lifecycle | `PENDING` entry state; `APPROVED`/`REJECTED` are immutable terminal decisions. Rejection is `MANUAL_REQUIRED → MANUAL_REQUIRED`: `approval.state = REJECTED`, status unchanged, exactly one `RECOVERY_REJECTED`; no re-approval transition. The approval record persists across T12 and all later statuses (§2.4 clauses 2–3) |
| Additional required fields | `findingCodeOnly`, `durableClass`, `fingerprintSchema`, `evidenceSchema`, `executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `escalation.expectedStatus`, `escalation.expectedQuantity`, `escalation.actualQuantity` — the eleven fields missing from R3 §3.1; `escalation.actualStatus` already declared at R3 §3.1 L150 and retained (§2.4 clause 6) |
| Roles | `ROLE-RECOVERY-EXECUTOR` added to `approval.operatorRole` / `actorRole` unions (R3 L190, L261, L294) |
| `manualReasonCode` | Includes `AMBIGUOUS_COMMIT` (R3 L139, L1933) |
| Escalation | `RECOVERY_ESCALATED` + optional `details.diagnosticCode`; `escalation.code ∈ {ESC_UNKNOWN_COMMIT, ESC_EVIDENCE_DRIFT, ESC_EXHAUSTED, ESC_MANUAL_RULE}`; `RECOVERY_MANUAL_REQUIRED` **removed**; an `UNKNOWN_COMMIT` observation emits no event (§2.4 clause 5) |
| Reserved-event mapping | `RECOVERY_VERIFIED` → T14 (exactly one event); `RECOVERY_CLOSED` is **reserved and not emitted** by T14; `RECOVERY_EVIDENCE_DRIFT` → drift path (R3 L266, L1110–1111; §2.4 clause 4) |
| `lastErrorField` | 64-character bound |
| `pendingOperation` | `operationId`; `state ∈ {PREPARED} ∪ TERMINAL_OP_STATES`; `leaseGeneration`; `sequenceNumber`; `eventId`; `reservedAt`; `reservedBy`; **`intentDigest`** (fingerprint of the intended transition — R3 §6.3 L636); `settlement` metadata (R3 L1936–1943) |
| Codified constants | `TERMINAL_OP_STATES = {COMMITTED, ABANDONED}`; `ABANDONABLE_STATUSES = {LEASED}` |
| Abandonment audit wording | `basis: "OPERATOR_DECISION_AFTER_HOLD"` — never `ABORT_CONFIRMED` (R3 L1941, L2035) |

### 2.2 `inventory_recovery_events`

- Exactly one `sequenceNumber` per committed event; unique `{taskId, sequenceNumber}` (`IDX-EVT-02`, R3 L466–478) and unique `eventId` (`IDX-EVT-01`).
- Event enum updated per §2.1; WP04-04 contract and WP04-05 `EventSchema` updated in the same change (R3 §15.5 requirement, L1118).
- W7 effect events insert at the already-reserved `op.sequenceNumber`; **no counter `$inc` at effect time** (R3 §22.4.2 L1882, normative).

### 2.3 `inventory_recovery_operation_history`

See §3 — the collection contract is part of the OD-10 package.

### 2.4 OD-10 approved contract — ten reconciled clauses (2026-11-14)

> **Approval record.** Owner approval granted **2026-11-14**: **OD-10 signature APPROVED**; **OD-10-A (approval model) APPROVED**; **OD-10-B (rejection lifecycle) APPROVED**; **OD-10-C (event contract) APPROVED**; **OD-10-D (recurrence successor workflow) NOT APPROVED** — **OD-40 remains controlling**. The clauses below are the approved contract and supersede the corresponding R3 §3.1/§3.2 values where they differ. `OD-04` retention, `OD-07` alerting, `OD-09` numerics, migration/backfill, transaction-limit verification, and index deployment remain separate and are **not** approved by OD-10.

> **1. Collections.** The production collections are `inventory_recovery_tasks`, `inventory_recovery_events`, and `inventory_recovery_operation_history`. The singular forms in register §2.1/§2.2 are corrected to these plural forms.
>
> **2. Approval record.** `approval.*` is the approval-cycle record. It may first be created during `MANUAL_REQUIRED`. Once created, it MUST persist across T12 execution and all subsequent task statuses for auditability and MUST NOT be cleared on T12 or any later transition. The approval decision itself is made only while `status = MANUAL_REQUIRED`. When `approval.state` is `APPROVED` or `REJECTED`, `approval.approvedBy`, `approval.approvedAt`, and `approval.operatorRole` are required; `approval.notes` is optional. Terminal approval decisions (`APPROVED` or `REJECTED`) are immutable. The flat `approvedBy`/`approvedAt` are the immutable audit mirror of the same decision and MUST equal the nested values; they are set in the same transaction and never updated. The flat `executedBy`/`executedAt` are required for T12 execution; `verifierId`/`verifiedAt` are required for T14 closure. `approvedBy`, `executedBy`, and `verifierId` MUST be distinct identities.
>
> **3. Rejection.** `RECOVERY_REJECTED` is in the production event enum. It is emitted only by the `MANUAL_REQUIRED → MANUAL_REQUIRED` rejection decision: the transaction sets `approval.state = REJECTED`, records the deciding operator in `approval.*` and the flat `approvedBy`/`approvedAt`, leaves `status = MANUAL_REQUIRED`, and inserts exactly one `RECOVERY_REJECTED` event with `details.fromStatus = MANUAL_REQUIRED` and `details.toStatus = MANUAL_REQUIRED`. The approval record persists under clause 2. The task remains `MANUAL_REQUIRED` until T13 cancellation; no re-approval transition is defined by this contract.
>
> **4. T14.** T14 (`RESOLVED → CLOSED`) emits exactly one event, `RECOVERY_VERIFIED`, in the same transaction as the task CAS and `isOpen: false`. `RECOVERY_CLOSED` remains a reserved enum value and is NOT emitted by T14 or any currently approved transition; it may be used only by a future separately approved transition. State-machine and blueprint references listing both events for T14 are corrected to this single-event rule.
>
> **5. Escalation and diagnostic separation.** `escalation.code` is the escalation category and is required on `RECOVERY_ESCALATED`; its allowed values are `{ESC_UNKNOWN_COMMIT, ESC_EVIDENCE_DRIFT, ESC_EXHAUSTED, ESC_MANUAL_RULE}`. `details.diagnosticCode` is the observed technical cause and is optional; its allowed values are `{DOC_CORRUPT, INDEX_ABSENT, TIMEOUT, LEASE_EXPIRED, DRIFT_DETECTED, PERSISTENCE_TIMEOUT, CONFLICT, DRIFT, RETRY}`. The two enums are disjoint: an escalation code MUST NOT be used as a diagnostic code, and a diagnostic code MUST NOT be used as an escalation code. No escalation code requires a diagnostic code. Recommended mapping: `ESC_UNKNOWN_COMMIT` → `{TIMEOUT, PERSISTENCE_TIMEOUT, CONFLICT}` or null; `ESC_EVIDENCE_DRIFT` → `{DRIFT_DETECTED, DRIFT}` or null; `ESC_EXHAUSTED` → `{TIMEOUT, PERSISTENCE_TIMEOUT, CONFLICT, RETRY}` or null; `ESC_MANUAL_RULE` → any permitted diagnostic value or null. This mapping applies only to a permitted `RECOVERY_ESCALATED` event. An `UNKNOWN_COMMIT` observation MUST NOT emit `RECOVERY_ESCALATED`, MUST NOT allocate a `sequenceNumber` or `eventId`, and MUST NOT mutate the task document or the pending operation; the observation remains scanner/reconciliation evidence only. `ESC_UNKNOWN_COMMIT` remains a defined escalation category but is not used by an observation; it may be used only by a separately approved transition that explicitly authorizes it. OD-27/OD-31 are preserved exactly: the operation remains `PREPARED`; no automatic replay, abandonment, or task-status transition is authorized.
>
> **6. Required fields.** The production task contract includes the following eleven fields missing from the R3 §3.1 table: `findingCodeOnly` (Boolean, default false), `durableClass` (Boolean|null, default null), `fingerprintSchema` (String, default `wp04-fingerprint-v1`), `evidenceSchema` (String, default `wp04-evidence-v1`), `executedBy`, `executedAt`, `verifierId`, `verifiedAt`, `escalation.expectedStatus`, `escalation.expectedQuantity`, and `escalation.actualQuantity`. `escalation.actualStatus` is already declared in R3 §3.1 L150 and is retained; it is not one of the eleven missing fields.
>
> **7. Enum alignment.** `classification ∈ {DEFECT, ALERT, INFO}`; `severity ∈ {CRITICAL, HIGH, MEDIUM, INFO}`; `confidence ∈ {HIGH, MEDIUM, LOW}`; `evidenceLevel ∈ {E0, E1, E2, E3}`; `manualReasonCode ∈ {POLICY_MANUAL_RULE, EVIDENCE_DRIFT, ATTEMPTS_EXHAUSTED, PERSISTENCE_TIMEOUT, AMBIGUOUS_COMMIT}`; `lastErrorCode ∈ {EVIDENCE_DRIFT, TIMEOUT, CONFLICT, SEQUENCE_OVERFLOW}`; `lastErrorField` is capped at 64 characters. The R3 §3.1 values (`DEFECT/DISCREPANCY/DRIFT/CONTRADICTION/ALERT_ONLY`; `LOW/MEDIUM/HIGH/CRITICAL`; `E1–E3`; 128-character `lastErrorField`) are superseded for the production contract.
>
> **8. Event details.** `details.toStatus` and `details.attempts` are required; `details.fromStatus` is optional/null. `details.diagnosticCode` is optional and bounded by the technical diagnostic enum in clause 5; it is not an escalation category. `details.observedFingerprint` is optional/null and 64-hex when present; `details.leaseDurationMs` is optional and positive; `details.delta.consumedDelta` and `details.delta.reservedDelta` are optional finite numbers in `[0, 1000000]`. Top-level `fencingToken` is optional/null UUID v4; `fingerprintVersion` defaults to `wp04-fingerprint-v1`; `evidenceSchemaVersion` defaults to `wp04-evidence-v1`; `projectedEvidence` defaults to `{}` and MUST pass recursive sensitive-key exclusion.
>
> **9. Operation history.** The H1 history collection is `inventory_recovery_operation_history`. The deterministic record field is `historyId = OPH:<taskId>:<operationId>`. The unique index is `{taskId: 1, operationId: 1}`, full unique, with no partial filter; the record is insert-only and MUST NEVER be upserted. `archiveId`, the `OPA:` prefix, and `IDX-OPA-01` from R3 §22.3.5 are not part of the production contract and MUST NOT be built. The task-document CAS remains the operation fence; the history record is never the uniqueness fence.
>
> **10. Recurrence.** Recurrence after closure creates no Recovery Task automatically and does not reopen the closed task (OD-40). The recurrence is retained as scanner evidence. If a future, separately approved recurrence workflow creates a successor task, it MUST be a new task with `priorTaskId` referencing the predecessor `_id`; the predecessor’s `status`, `isOpen`, and timestamps are never revived or rewritten (OD-23). No automatic successor creation and no manual successor workflow are authorized by this contract.

---

## 3. H1 history record contract (OD-33 / OD-30 / H1-EXT)

- **Collection:** `inventory_recovery_operation_history`.
- **Deterministic record id:** `OPH:<taskId>:<operationId>` (id-shape pattern follows R3 §22.3.5 L1699–1735; lifecycle does **not**: records are written at effect/abandonment time per H1, not at replacement time per H-D — R3 §22.8 L2086–2090).
- **Unique index:** `{taskId: 1, operationId: 1}` UNIQUE. Under OD-25(a) every `operationId` is unique per task across all generations, so this is a full unique index (no partial filter required). Insert-only; **never upsert**; retry idempotent by deterministic key.
- **Fence rule (OD-30):** the history record is **not** the uniqueness fence; the task-document CAS (positive `U` + `U_claim`) serializes. Stated explicitly to avoid the O1-convergence trap (R3 L831).
- **Write points:** one same-transaction insert inside `T_effect` (`state: "COMMITTED"`) and inside `T_abandon` (`state: "ABANDONED"`), carrying the terminal `pendingOperation` fields: `taskId`, `operationId`, `state`, `leaseGeneration`, `sequenceNumber`, `eventId`, `reservedAt`, `reservedBy`, completion timestamp, `intentDigest`, `settlement` metadata. Abandonment records additionally carry `manualReasonCode` (incl. `AMBIGUOUS_COMMIT`) and `basis: "OPERATOR_DECISION_AFTER_HOLD"`.
- **Retention:** none defined here — governed by OD-04 (§7). No TTL by default; deletion prohibited while a record is the only evidence of an unresolved outcome (R3 §12.3 L900).
- **Deploy:** outside the 12 disposable indexes → requires the **OD-10 approval (recorded 2026-11-14)** + **G-IDX-1** + guarded deploy script (`--confirm`/`--allow-production`) + DBA window (R3 §5.3 L516–524). `IDX-OPA-01` (R3 L1721–1724) is **not** built — H-D not selected.

---

## 4. Cross-document amendment log (authoritative)

Each amendment is applied in the target document as a dated amendment notice referencing this section. Original text is preserved; the amendment notice states the supersession.

> **Locator caveat:** line numbers in this log are anchored to each document's **pre-amendment** text (HEAD `69650435a6587d4577bc126f719fa1392bb934b3`). After the amendment notices were inserted, positions shifted slightly (e.g., the R3 banner adds lines after L13; the §12.3/§13.4/§15.1 notes add lines at their insertion points). The `AMENDMENT 2026-11-12` notices themselves are the authoritative locators.

| ID | Document & location | Amendment |
|---|---|---|
| R3-AM1 | R3 (document banner) | §19.4/§19.5 status columns superseded by §1 of this register for OD-24…OD-35, OD-37; OD-10 limited-approval wording updated to "final proposal awaiting signature" *(historical; superseded by R3-AM6 on 2026-11-14)* |
| R3-AM2 | R3 §12.3 W6 (L888) | W6 re-scoped to a standalone `T_reserve` transaction (I-C): worker-executed immediately after the claim/transition and before the effect; same lease identity; **no event**; reserves exactly one sequence |
| R3-AM3 | R3 §13.4 notes (L1001–1008) | (a) per-transition `$inc` applies **only** to event-consuming lifecycle rows; W7 effect rows never increment the counter (§22.4.2 elevated to rule); (b) folded W2+W6 remains unapproved (I-C); (c) every lifecycle claim row gains `U_claim` and increments `leaseGeneration` in the same write (T9/ACQ); (d) expired-`LEASED` reclaim is a W2 variant per §22.6/OD-37 with `ABANDONABLE_STATUSES = {LEASED}`; the "OD-29/OD-37 not approved" caveat is superseded — both approved; W8 executable only with the approved event contract and settlement fields |
| R3-AM4 | R3 §15.1 (after item 6, L1088) | New item: a claim's lifecycle event and a subsequent operation reservation are **separate single-slot consumers in separate transactions**; each consumes exactly one sequence; the effect inserts at the already-reserved sequence with zero counter increment; single-slot ceiling guards remain sufficient |
| R3-AM5 | R3 §3.1/§3.2 | Enum/schema divergences resolved per §2 of this document |
| SM-AM1 | SM §6.2 acquire (L260–288) | Filter gains `U_claim`; update gains `$inc: { leaseGeneration: 1 }` in the same write |
| SM-AM2 | SM §7.3 (L368–391) | V1-evidence escalation path superseded for O2 operation flows by R3 §6.2/§16: V1 evidence is never abort proof; no evidence-based auto-escalation |
| SM-AM3 | SM §10.3 audit rows (L481–495) | Event-time sequence allocation superseded for O2 operation flows by reservation-time allocation (R3 §15.1/§22.4.2; effects never increment the counter) |
| CL-AM1 | CL §2.2 (L66–118) | Claim primitive gains `U_claim` inside the `$and` claim filter |
| CL-AM2 | CL §4.3 (L167–175) | Re-insert-on-unknown retry superseded for O2 operation flows by R3 §6.2 adoption-only / §13.2 R6: `UNKNOWN_COMMIT` observed-only, operation stays `PREPARED`, never re-run, never a new identity; step 3 remains valid only for pure event-publish writes |
| CL-AM3 | CL §3.1 (L134–151) | Event-time allocation superseded for O2 operation flows by reservation-time allocation (R3 §15.1/§22.4.2) |
| PD-AM1 | PD §6 (L249–274) | Event-time sequence allocation superseded for O2 operation flows by reservation-time model (R3 §15.1/§22.4.2); transition event and operation reservation are distinct single-slot consumers in separate transactions; §7.2 stale-generation defense unchanged |
| IX-AM1 | IX §4.1 (L74–91) | Polling note: surfaced candidates may still fail the claim CAS incl. `U_claim`; no index change required for the predicate (blocking is on the task document); H1 history unique index is outside the 12 disposable proposals → OD-10 + G-IDX-1 |
| RD-AM1 | RD §9.3 (L552–560) | "leaseToken increments on every acquisition" corrected — the monotonic fencing value is **`leaseGeneration`** (incremented in the same write as every acquisition/reclamation); `leaseToken` is a per-acquisition random UUID; claims additionally require `U_claim` |
| BP-AM1 | BP T9 row (L219) | T9 row aligned to the approved T9/Acquire contract (`U_claim` + same-write `leaseGeneration` increment); W6 noted as standalone `T_reserve` (I-C) |
| ODP-AM1 | ODP (banner) | WP04-06 decisions registered in §1 of this document; D-06…D-21 rows remain as written; deferred sub-items (retention → OD-04 owner input; alerting → OD-07 owner input; numerics → OD-09 test-derived) read together with this register |
| R0-AM1 | R3 §2.2 (L89–103), §19.3, §20 row 12, §21.4 | **BLK-EVID-01 evidence drift corrected (2026-11-14).** `lib/recovery/identity.js`, `lib/models/RecoveryTask.js`, and `lib/models/RecoveryEvent.js` are **present in the working tree but untracked** (not committed at HEAD). `lib/recovery/reconciliation.js` (the reserved WP04-03 scanner path — **not** the present WP04-06 auditor `lib/recovery/operationReconciliation.js`) and `scripts/inventory-recovery-deploy-indexes.mjs` remain **absent**. BLK-EVID-01 remains **OPEN**; presence of three untracked files is not closure. |
| R0-AM2 | R3 §1, §19.6, §20 row 23, §21.3, §21.4 | **OD-38 / OD-39 / OD-40 recorded (2026-11-14)** and aligned with this register §1 and §13. The three decisions are **APPROVED (policy)**. The **R-1 read-only source implementation is present in the working tree (untracked), was audited, corrected, and independently verified on 2026-11-14 (46/46 R-1 tests, 290/290 regression tests, ESLint clean); it was FORMALLY ACCEPTED BY THE OWNER on 2026-11-14**. No gate is signed, no feature flag is created, and no runtime activation is authorized. |
| R3-AM6 | R3 banner, §1, §3.4, §19.1, §19.3, §20 row 10, §21.8, §22.10 | **OD-10 approved (2026-11-14).** OD-10 signature, OD-10-A, OD-10-B, and OD-10-C approved; OD-10-D **not approved** (OD-40 controlling). The ten reconciled clauses are recorded verbatim in §2.4 of this register and §3.4 of R3. **BLK-SCH-01 CLOSED.** Index deployment remains **PENDING/UNSIGNED** under G-IDX-1 with the deploy script absent and no DBA window. All other blockers and gates are unchanged. |
| R3-AM7 | R3 banner, §18.1, §19.3 (intro + rows), §19.6, §20 (matrix conclusion), §21.4 | **WP04-06 final owner acceptance (2026-11-14); BLK-AP-01, BLK-AP-02, and BLK-EVT-01 CLOSED.** The owner accepted the final focused test-gap independent review and the complete offline evidence set (§14.2). **W8 `ESC_UNKNOWN_COMMIT` recorded as a separately authorized OD-37 abandonment transition — not an `UNKNOWN_COMMIT` observation path** (§14.4). Accepted residual limitations preserved (§14.5): writer-CAS approval protection, in-memory transaction harness evidence, untracked/uncommitted provenance. No gate signed; **BLK-UC-01, BLK-UC-02, and BLK-EVID-01 remain OPEN**. Full record: **§14**. |
| R3-AM8 | R3 banner, §19.3 (intro + rows), §21.4; register §12.5, §14.3, banner notice | **BLK-UC-01 and BLK-UC-02 CLOSED (2026-11-15, owner action, documentation only).** The owner approved the closure on the independently reviewed crash/restart execution evidence run **`wp04-06-t2-debdf49b933a`** (T2-A/B/C + T5-CRASH + T8-CRASH all PASSED): **BLK-UC-01** closes on the approved O2 `pendingOperation` design (OD-24/OD-25/OD-26/OD-28/OD-30/OD-37; I-C standalone `T_reserve`; T9/Acq — §1) implemented as W6 `reserveOperation` persisting the full reserved identity before the effect attempt, and the T5-CRASH proof of durable reservation recovery, zero-write HOLD, and exact-identity W7 replay; **BLK-UC-02** closes on the approved hold-default + operator-authorized OD-37 abandonment protocol (OD-27, OD-27-SC, OD-31, OD-37 — §1; W8 authorization §14.4), the read-only `assessOperationOutcome` HOLD path, and the T8-CRASH proof of the durable `PREPARED` crash world, the zero-write HOLD, and the authorized W8 settlement with the permanent sequence gap. **Residuals preserved (§15):** authorization is a settlement fence, **not abort proof** (`OPERATOR_DECISION_AFTER_HOLD`, never `ABORT_CONFIRMED`); OD-07 alerting input still required before the residual audit control is actionable; harness-only disposable replica-set evidence; Windows SIGKILL = TerminateProcess recorded as observed; single-run evidence requiring independent review; **BLK-EVID-01 remains OPEN**. No gate signed; all gates unchanged. Full record: **§15**. |

---

## 5. Documentation sequence corrections (owner-directed)

1. **OD-04 and OD-07 owner inputs are required before their dependent operational commitments are finalized** — retention before any TTL/archive policy; alerting before G-REC-3 operational sign-off and before the BLK-UC-02 residual audit control (R3 L2035) is actionable. No business value is invented for either (§7).
2. **OD-10 production schema/index implementation and deployment must be authorized before they occur** — offline model metadata (`lib/models/*`) is already authored and is non-authoritative. The **OD-10 production schema contract was approved by the owner on 2026-11-14** (§2.4); **BLK-SCH-01 is CLOSED**. That approval does **not** deploy anything: index deployment remains **PENDING/UNSIGNED** under G-IDX-1, requires the guarded deploy script (currently absent), and requires a DBA window. Authoring offline metadata does not require a signature; deploying it does.
3. **OD-09 values must be derived from actual tests, not invented** — the provisional values remain test inputs until disposable replica-set / staging `--once` evidence exists (§6).
4. **T2 proof is separately authorized and gates activation; it is not automatically a prerequisite for offline code authoring.** The wire proof (P1-P6, P4/P5 mandatory - R3 §18 L1216-1237) is produced under its own harness authorization and is evidence for **G-REC-1** and the G-REC-3 chain; it does not gate working-tree-only authoring of modules against the authored OD-10 metadata (unsigned when this note was written; the contract was subsequently approved on 2026-11-14 — §2.4). The proof has since been executed on the disposable replica set and **accepted under OD-35 on 2026-11-14** (§12); G-REC-1 and G-REC-3 remain **UNSIGNED**.

---

## 6. OD-09 — test-derived parameters (provisional until test evidence)

| Parameter | Provisional test value | Sign-off condition |
|---|---|---|
| Lease duration | 5 minutes | Disposable replica-set + staging `--once` evidence (crash, expiry, two-worker tests) before **G-REC-3** |
| Retry attempts | 5 | Same evidence |
| Backoff schedule | [0, 30, 60, 120, 240 s] | Same evidence |
| Retry cap | 15 minutes | Same evidence |
| Sequence ceiling | 1,000,000 | Architectural bound, not an OD-09 numeric (R3 §15.3 L1096); fail-closed `SEQUENCE_OVERFLOW` (R3 L1767, L1899); unchanged under I-C (one slot per transaction) |
| `transactionLifetimeLimitSeconds` | — | DBA verification required (R3 §19.1 L1256) |

---

## 7. Outstanding owner/operations input (single isolated block — no values invented)

> **OD-04 (retention) + OD-07 (alerting).** Non-inferable business values; required before their dependent commitments are finalized (§5.1).
> - **OD-04:** retention periods for tasks, events, history records, and evidence snapshots. Fixed constraints: no TTL by default (SM §10.2 L472–477); deletion prohibited while a record is the only evidence of an unresolved outcome (R3 L900). Needed for: OD-10 final scope, G-REC-2 "no-TTL proof" (GDM L251).
> - **OD-07:** alert sink, on-call routing, SLA. Current verified state: **no alert sink, on-call integration, dashboard, metric exporter, queue, or scheduler exists** (SM §11.3 L526–528). The approved hold-default and abandonment path are operationally inert without routing ("Detection and recovery without routing is not an operational control" — SM L528). Dependency for G-REC-3 and for the BLK-UC-02 residual control (R3 L2035).

---

## 8. Consistency anchors (must hold across all documents)

1. **OD-30 atomicity:** task-document CAS is the fence; history inserts are same-transaction with `T_effect`/`T_abandon`; the history record is never the fence.
2. **OD-33 history uniqueness:** unique `{taskId, operationId}` on `inventory_recovery_operation_history`; insert-only; deterministic `OPH:<taskId>:<operationId>`.
3. **OD-34 canonical writer:** every task/event write goes through the single writer module; no direct model/collection writes elsewhere (R3 §12.3/§12.4).
4. **OD-35 T2 criteria:** P1–P6, P4/P5 mandatory; static tests cannot prove runtime behavior (R3 L929); proof is runtime, on a disposable replica set. **Satisfied and accepted on 2026-11-14 (§12).**
5. **OD-37 LEASED-only abandonment:** `ABANDONABLE_STATUSES = {LEASED}`; abandonment requires an expired original lease (§22.6 identity predicate); claim `U_claim` prevents bypass-by-generation-bump.
6. **T9 `U_claim`:** every claim/transition filter carries the positive unresolved-operation predicate; `leaseGeneration` increments in the same write.
7. **I-C standalone `T_reserve`:** no fold into W2/W5; no event at reservation; exactly one sequence per transaction; W7 effects never `$inc`.

---

## 9. Non-claims

This document changes documentation only. It does not create or modify application code, models, schemas, indexes, migrations, tests, workers, routes, or runtime configuration. No database was contacted; no index was deployed; no worker was activated; no V1 writer was changed; no POS/payment/Hotel/Jebena behavior was altered. **No gate is signed** (G-REC-1, G-REC-2, G-REC-3, G-AUD-1, G-GOV-1 remain UNSIGNED; G-PAY-1 remains BLOCKED; G-IDX-1 remains UNSIGNED). The 2026-11-14 T2 acceptance (§12) is a proof acceptance under OD-35, not a gate signature. **No implementation is ready and no implementation-readiness claim is made.**

---

## 10. Package 3 — approved gap closures and implementation status (2026-11-12)

This section records the narrowly approved Package 3 clarifications and their offline implementation. It does not reopen any decision in §1 and does not change OD-09 numeric values, status transitions, the transition set, or the OD-10 schema field list.

### 10.1 OD-37 — original lease identity

- The original lease identity is the **task document's top-level** `leaseGeneration`, `leaseToken`, and `leaseOwner`.
- T9/Acquire `U_claim` prevents any claim while `pendingOperation.state = PREPARED`, and no other writer mutates `leaseToken`, so the top-level token remains the acquiring lease's token for the whole PREPARED operation lifetime.
- `T_abandon` binds all three top-level fields plus server-time expiry (`$expr` / `$$NOW`), the complete `pendingOperation` identity and expected state, and all existing task/status/sequence predicates.
- `pendingOperation.leaseToken` is **not** added; the OD-10 schema and its field list are unchanged.
- A transient, non-persisted `leaseToken` may ride on the operation handle returned by W6 so a caller can prove it holds the original lease. A mismatch is rejected as `OPERATION_MISMATCH`; the token is never written to the task.
- The worker-clock expiry pre-check is removed. The server-time CAS predicate is the sole expiry authority; a zero match aborts the transaction explicitly (`CAS_MISMATCH`), so clock skew can neither reject a valid abandonment nor accept an invalid one.

### 10.2 G_ATTEMPTS — scope

- `attempts < maxAttempts` applies only to **T2** (`DETECTED → LEASED`) and **T10** (`RETRY_SCHEDULED → LEASED`).
- It does **not** apply to **T9** expired-lease reclaim or **T12** approved manual reclaim. An expired `LEASED` task at or above `maxAttempts` remains reclaimable so it can reach **T7** (`MANUAL_REQUIRED`) or the approved W8 abandonment path.
- OD-09 numeric values, status transitions, and the transition set are unchanged. The state-machine guard text (§4.1 `G_ATTEMPTS`) and attempt-accounting note (§7.1) are amended to match.

### 10.3 Path ownership — WP04-03 vs WP04-06

- `lib/recovery/reconciliation.js` is reserved for the WP04-03 V1 read-only scanner. The reserved path is now **empty**: the stale near-duplicate of the WP04-06 auditor was archived byte-for-byte by the WP04-06 Track A path-conflict closure at `docs/production-readiness/archive/wp04-03-path-conflict/reconciliation.wp04-06-stale.js` (SHA-256 `DC58D15F05EA804D9E0CCB4E44A575184B985718936E338F1B4561D2CE37FC43`, unchanged before and after the move).
- The WP04-06 H1/operation-evidence reconciliation module now lives at `lib/recovery/operationReconciliation.js`.
- `lib/recovery/taskWriter.js` imports the shared non-proof/abort vocabulary from `operationReconciliation.js`; it does not import the reserved WP04-03 path.
- Boundary/source tests scan `operationReconciliation.js` and assert the writer's import path.

### 10.4 W11 — separation of duties

- W11 `recordApproval` enforces the §3.3 T-APPROVE row: the actor must be an `OPERATOR`; `actor.role` must equal the recorded `approval.operatorRole`; `approval.approvedBy` must equal the actor identity; and the approver must be distinct from `executedBy` and `verifierId`.
- Distinctness is enforced by a typed pre-check and repeated as CAS `$ne` clauses (`executedBy`, `verifierId`) so a concurrent write cannot bypass it.
- No new roles, permissions, or authorization policy are introduced. `ROLE-RECOVERY-EXECUTOR` remains represented only where the authored OD-10 metadata already lists it.

### 10.5 Implementation status (offline, DB-free)

| Item | Status |
|---|---|
| `lib/recovery/taskWriter.js` | Offline Package 2/3/4 code present; focused DB-free tests pass. W7 is restricted to T5 (`LEASED → RESOLVED`, `RECOVERY_RESOLVED`); W5 is restricted to T6/T7 plus the approval step with per-transition field allowlists. |
| `lib/recovery/operationReconciliation.js` | WP04-06 read-only auditor present at the new path. |
| `lib/recovery/reconciliation.js` | **RESOLVED — PATH CONFLICT CLOSED (WP04-06 Track A).** Register §10.3 reserves this path for the WP04-03 V1 read-only scanner, and the reserved path is now empty. The stale near-duplicate of the WP04-06 auditor was moved without byte changes to `docs/production-readiness/archive/wp04-03-path-conflict/reconciliation.wp04-06-stale.js` (SHA-256 `DC58D15F05EA804D9E0CCB4E44A575184B985718936E338F1B4561D2CE37FC43`). No runtime import references either path. |
| W11/W12 behaviour tests | Added: success, invalid input, CAS abort, event/sequence invariants, single-session rollback. |
| OD-37/G_ATTEMPTS tests | Added: token mismatch, matching identity, clock skew, T2/T10 limits, T9/T12 exemption. |
| W5/W7 strictness tests | Added: invalid event types, invalid status transitions, privileged-field injection, T5 resolution/effect-evidence requirements, T6 retry guard, T12 operator identity/attribution, T14 verifier distinctness, W8 missing-expiry rejection. |
| OD-35 / T2 proof | **ACCEPTED (2026-11-14).** The offline OP_MSG parser, independent P4 verifier, and disposable T2 runner were executed on the disposable replica set in run `wp04-06-t2-94e4714b61c9`. Reviewed verdicts: T2-A PASS, T2-B PASS, T2-C PASS, P4 PASS, P5 PASS, OP_MSG/sequence invariants PASS, H1 atomicity PASS, cleanup PASS, historical evidence PRESERVED. See `wp-04-06-t2-harness-and-evidence.md` and §12. **BLK-T2-01 CLOSED; BLK-UC-01/02 remain OPEN.** |
| OD-10 schema | **Production schema contract APPROVED 2026-11-14** (signature + OD-10-A/B/C; OD-10-D not approved). **BLK-SCH-01 CLOSED.** `lib/models/*` declarations are authored metadata; **no index is deployed**. Index deployment remains **PENDING** under G-IDX-1 + guarded deploy script + DBA window. |
| Database / indexes / workers / production | **Not touched.** No DB access, migration, index deployment, worker activation, or production integration. |

> **Non-claim:** Passing in-memory tests do not prove real MongoDB server-time behavior, transaction isolation, deployed index uniqueness, or production safety. The current offline suite is 77 focused writer tests (and 88 with the schema contract); it is **not** itself evidence for T2/P4/P5. The T2/P4/P5 evidence is the separate runtime run accepted in §12. No gate is signed and no production-readiness claim is made.

---

## 11. Package 4 — final offline source closure (2026-11-12)

This section records the Package 4 corrections. It changes no approved decision, no status vocabulary, no schema field, and no index.

### 11.1 Implemented versus deferred transitions

| Transition | Status | Writer path |
|---|---|---|
| T1 `— → DETECTED` | **Implemented** | W1 `createTaskFromFinding` |
| T2 `DETECTED → LEASED` | **Implemented** | W2 `claimLease` (G_ATTEMPTS applies) |
| T3 `DETECTED → CANCELLED` | **Implemented** | W10 `cancelTask` (explicit operator identity) |
| T4 `DETECTED → MANUAL_REQUIRED` | **Deferred, fail-closed** | No writer row |
| T5 `LEASED → RESOLVED` | **Implemented** | W7 `commitOperation` only, `RECOVERY_RESOLVED`; W9 `resolveTask` covers the already-correct path |
| T6 `LEASED → RETRY_SCHEDULED` | **Implemented** | W5 `applyTransition` (`T-RETRY`), requires `nextAttemptAt` and `attempts < maxAttempts` |
| T7 `LEASED → MANUAL_REQUIRED` | **Implemented** | W5 `T-EXHAUST` / W12 `escalateTask`, requires attempts exhausted |
| T8 `LEASED → CANCELLED` | **Implemented** | W10, worker lease identity |
| T9 expired-lease reclaim | **Implemented** | W2 (no G_ATTEMPTS) |
| T10 `RETRY_SCHEDULED → LEASED` | **Implemented** | W2 (G_ATTEMPTS applies) |
| T11 `RETRY_SCHEDULED → MANUAL_REQUIRED` | **Deferred, fail-closed** | No writer row |
| T12 `MANUAL_REQUIRED → LEASED` | **Implemented** | W2 with explicit `OPERATOR` actor, approval state/role/identity, and approver ≠ executor; writes `executedBy`/`executedAt` |
| T13 `MANUAL_REQUIRED → CANCELLED` | **Implemented** | W10, explicit operator identity |
| T14 `RESOLVED → CLOSED` | **Implemented** | W9 `closeTask`, explicit `VERIFIER` distinct from `approvedBy`/`executedBy`; `RECOVERY_VERIFIED` |
| T15 `RESOLVED → MANUAL_REQUIRED` | **Deferred, fail-closed** | No writer row |

W4 `releaseLease` remains **fail-closed and OPEN** (no approved target status). W13 `archiveClosedTasks` remains deferred by OD-04 retention. W14 `repairTask` remains deferred by corrective-write authorization. `APPLIED` resolution remains disabled/read-only (the task schema has no `APPLIED` value; `resolveTask` rejects it).

### 11.2 W7/W5 bypass prevention

- W7 resolves the effect transition through `EFFECT_TRANSITIONS`; only `LEASED → RESOLVED` / `RECOVERY_RESOLVED` is executable. Caller-supplied `eventType` is validated against the resolver and is never written directly. `toStatus`/`fromStatus` are derived from the resolved row.
- W7 writes only `resolution`, `currentFingerprint`, `lastErrorCode`, `lastErrorField`; closure, cancellation, approval, verification, execution, lease, identity and sequence fields are rejected as `INVALID_ARGUMENT` before a session opens.
- W7 requires `resolution = ALREADY_CORRECT` and a 64-hex `currentFingerprint`; it preserves I-C (event at the reserved sequence, no counter `$inc`) and H1 atomicity (task + event + history in one transaction).
- W5 is restricted to `T-RETRY`, `T-EXHAUST` and `T-APPROVE`; T5/T14 and all cancellation rows are rejected on this path. Field injection is rejected by omission from each row's allowlist. `T-APPROVE` requires an actual `APPROVED` approval record before `RECOVERY_APPROVED` can be written.

### 11.3 Actor and separation-of-duties controls

- W2: `SERVICE-WORKER`/`WORKER` for T2/T9/T10; explicit `OPERATOR` with an authorized role for T12.
- W3/W9 resolve: `SERVICE-WORKER`/`WORKER`.
- W9 close (T14): explicit `VERIFIER` with an authorized role, distinct from approver and executor (typed pre-check plus CAS `$ne`).
- W8: explicit `OPERATOR`, authorization identity/role match, operation-bound authorization, task/operation lease-generation equality, non-null valid `leaseUntil`; a missing expiry fails closed instead of comparing below a date.
- W10: explicit `OPERATOR` for DETECTED/MANUAL_REQUIRED; worker lease identity for LEASED cancellation.
- W11: `OPERATOR` only, role match, approver identity match, distinctness from executor/verifier (typed + CAS).

### 11.4 OD-10 and index provenance

- Authored `lib/models/RecoveryTask.js` / `RecoveryEvent.js` = schema/index **declarations** (`autoIndex: false`, no deployment).
- Deployed indexes = **none**. There is no recovery index deployment script.
- The **OD-10 production schema contract was approved by the owner on 2026-11-14** (§2.4); **BLK-SCH-01 is CLOSED**. Index deployment remains **PENDING/UNSIGNED** under G-IDX-1 and is not authorized by the signature.
- BLK-AP-01 remains **OPEN** as a provenance/authorization item even though the authored schema can represent `executedBy`/`verifierId` attribution. **(Superseded: BLK-AP-01 was CLOSED 2026-11-14 by the owner's final WP04-06 acceptance — §14; the writer-CAS-only residual of §14.5 remains disclosed.)**

### 11.5 Runtime evidence non-claims

Offline tests (including the 69 focused writer tests and the 1,580-test full offline suite) are DB-free and prove neither transaction isolation nor deployed index uniqueness. The T2 P1–P6 wire proof, independent P4 verification, and P5 negative control were executed separately on the disposable replica set and **accepted under OD-35 on 2026-11-14** (§12); index deployment remains **NOT RUN** and **UNAUTHORIZED**. Worker activation and production integration remain **NOT AUTHORIZED**.

---

## 12. T2 acceptance record (2026-11-14, documentation only)

### 12.1 Owner acceptance

The owner has formally **accepted WP04-06 T2** under **OD-35**. Formal acceptance occurred **after** the final successful evidence run (`wp04-06-t2-94e4714b61c9`, `status: EXECUTED_EVIDENCE_RECORDED`) and after the independent acceptance review. The earlier §10.5 statement ("NOT PASSED / NOT CLOSED") and §11.5 statement ("T2 ... OPEN/NOT RUN") are superseded by this record and retained in place only as pre-acceptance history.

### 12.2 Independent review verdict

| Check | Verdict |
|---|---|
| T2-A — armed W7 `commitTransaction` withholding; persisted state independently observed | **PASS** |
| T2-B — forwarded commit with ACK drop; retry-aware correlation; committed effect, event, and history | **PASS** |
| T2-C — P5 negative control; payload-only `commitTransaction` text not classified as a commit | **PASS** |
| P4 — separate `MongoClient`, `directConnection: true`, primary read preference, majority read concern, actual WP04 collection reads | **PASS** |
| P5 — integration negative control | **PASS** |
| OP_MSG-aware classification and transaction/sequence invariants (I-C) | **PASS** |
| H1 atomicity — task + effect event + operation history all-or-none | **PASS** |
| Disposable cleanup — mongod stopped, temp DB path removed, no leftover listener/artifact | **PASS** |
| Historical evidence integrity — all four evidence JSON files unchanged | **PRESERVED** |

Evidence reference: `docs/production-readiness/evidence/wp04-06-t2-94e4714b61c9.json` (final run). The reviewed run recorded 90 armed/withheld/severed commit frames in T2-A, 84 forwarded commits with 84 correlated ACK drops in T2-B, and zero commit detections in T2-C. Sequence invariants held: the W7 effect event occupied the reserved sequence 3 without incrementing `eventSequenceCounter` (counter remained 3).

### 12.3 Timeout semantics (corrected)

The 2,000 ms value recorded by the harness is the **overall timeout for the disposable-harness W7 `withTransaction()` call** — it bounds callback execution plus driver commit/retry handling. It is **not** a commit-retry-only deadline and **not** a production writer timeout. Active runner/source use `boundedWithTransactionTimeoutMS`; historical evidence JSON files retain the older label `boundedCommitRetryTimeoutMS` and are preserved unchanged.

### 12.4 BLK-T2-01 closure

**BLK-T2-01 is CLOSED (2026-11-14).** Reason: the OD-35 P1–P6 verification standard is satisfied by the reviewed real-writer proof, the independent P4 verification, and the P5 integration negative control, using parsed OP_MSG command classification rather than TCP byte-substring matching. The original blocking defect and its discovery are preserved as historical provenance in `wp-04-06-design-discovery-report.md` §18 and §19.3.

### 12.5 Residual non-claims and remaining gates

T2 acceptance is evidence for **G-REC-1** and the G-REC-3 chain; it does **not** sign either gate. It does **not** close or resolve:

- **BLK-UC-01** — durable post-crash operation identity is still not exercised by a crash/restart test. **(Superseded: CLOSED 2026-11-15 by owner action on the crash/restart execution evidence run `wp04-06-t2-debdf49b933a` — §15.)**
- **BLK-UC-02** — `UNKNOWN_COMMIT` representation and the operator resolution protocol remain unapproved. **(Approval wording corrected:** this line was stale when written — the resolution protocol was already **APPROVED** (OD-27, OD-27-SC, OD-31, OD-37; §1), and **W8 (`abandonOperation`) is recorded as a separately authorized OD-37 abandonment transition — not an `UNKNOWN_COMMIT` observation path; `ESC_UNKNOWN_COMMIT` is used only by W8** (§14.4, recorded 2026-11-14, the same date as this record). The BLK-UC-02 **blocker status itself remains OPEN** and is not closed by this correction. **(Further superseded: CLOSED 2026-11-15 by owner action on the crash/restart execution evidence — §15.)**)
- **BLK-AP-01 / BLK-AP-02** — approval schema / separation-of-duties and `PENDING`/`REJECTED` lifecycle gaps. **(Superseded: CLOSED 2026-11-14 by the owner's final WP04-06 acceptance — §14.)**
- **BLK-EVT-01** — event enum / field contract divergence. **(Superseded: CLOSED 2026-11-14 by the owner's final WP04-06 acceptance — §14.)**
- **BLK-SCH-01** — **CLOSED (2026-11-14)** on the owner's OD-10 signature and the consistent recording of the approved contract in both governance documents (§2.4; R3 §3.4).
- **BLK-EVID-01** — production module/script provenance.
- **OD-10** — production schema contract **APPROVED (2026-11-14)**; **index deployment remains PENDING/UNSIGNED** (G-IDX-1, absent deploy script, DBA window).
- **G-IDX-1** — production index deployment remains **UNSIGNED / BLOCKED**.
- **G-REC-1 / G-REC-3** — remain **UNSIGNED**.

These remain gates for their respective later integration/deployment stages. T2 acceptance authorizes **no** staging access, production access, database connection, schema change, index deployment, runtime Recovery integration, worker/scheduler activation, or change to POS/payment/inventory/Hotel/waiter/Kitchen/Barista/Jebena behavior.

### 12.6 This record is documentation-only

No file other than this register and the discovery report was changed by the acceptance-recording task. No database was contacted; no mongod was started; no migration, `syncIndexes`, or index deployment was run; no historical evidence JSON was modified; no code, test, package manifest, or application behavior was changed.

---

## 13. Runtime-boundary, payment-preservation, and recurrence decisions (recorded 2026-11-14)

> **Provenance statement.** **OD-38**, **OD-39**, and **OD-40** are **owner decisions** approved by the owner before this recording and **formally recorded in this repository on 2026-11-14**. The repository contains no original approval date, signature, meeting record, or evidence reference for them, and **none is invented**. Each subsection separates four distinct facts: (a) the owner decision; (b) the date it is recorded in this documentation; (c) its implementation status; and (d) the operational gates that remain unapproved and unsigned.

### 13.1 OD-38 — Runtime detection boundary

**Owner decision (approved policy).**

1. **D01–D10 remain `DEFERRED` / `ALERT_ONLY`** exactly as defined by the approved rule registry. D06 is the only `ALERT_ONLY` rule in the first release; the other nine are `DEFERRED`. No rule authorizes an automatic repair.
2. **The Recovery scanner is read-only.** It may read V1 order, reservation, movement, and inventory state only through the guarded adapter.
3. **Findings do not autonomously create Recovery Tasks.** Classifier findings carry `createsRecoveryTask: false` and `autoRecovery: "PROHIBITED"`.
4. **The Recovery writer remains unavailable to application runtime.** No writer call site, module import, route, or runtime activation is authorized by this decision. `lib/recovery/taskWriter.js` remains an offline module whose caller supplies the connection; it has no production caller.
5. **No runtime observation persistence is permitted.** Findings, evidence bundles, and fingerprints are not written to any collection at runtime.
6. **No worker, scheduler, cron, or autonomous Recovery execution** is authorized.

**Verified source state at recording time.** No Recovery feature flag exists in the repository: a repository-wide search for `process.env.*ENABLED`, `process.env.*FLAG`, and `FEATURE_` returns zero matches. This decision therefore **does not introduce a feature flag** and must not be read as claiming one exists. The "writer flag remains off by default" property is currently satisfied only by the **absence of any call site**, which is an implicit guarantee, not an enforced one.

- **Recording date:** 2026-11-14.
- **Implementation status:** **R-1 READ-ONLY SOURCE PRESENT IN THE WORKING TREE (UNTRACKED)** — `lib/recovery/scanner.js`, `lib/recovery/repositories.js`, and `scripts/inventory-recovery-scan.mjs` exist, were audited, corrected, and independently verified on 2026-11-14. **R-1 is FORMALLY ACCEPTED BY THE OWNER on 2026-11-14.** No route, worker, scheduler, cron, feature flag, runtime integration, or database scan was added. The earlier "NOT STARTED" status is retained as the status at recording time and is superseded for current R-1 source status by this bullet.
- **Operational gates:** unchanged and unsigned — G-REC-1, G-REC-2, G-REC-3, G-AUD-1, G-GOV-1, G-IDX-1, G-PAY-1.

### 13.2 OD-39 — Payment and Inventory runtime preservation

**Owner decision (approved policy).**

1. **Preserve existing `payOrder()` behaviour** exactly: the atomic payment write commits first and `applyPaidInventory()` runs afterwards without rolling back payment (`lib/orderService.js` L1083–1241, L1007–1045).
2. **Preserve existing Inventory runtime failure logging** exactly: `inventory_consumption_failed`, `inventory_consumption_warnings`, `inventory_consumption_error`, and `inventory_hook_failed` remain unchanged. No Recovery Task is created from them.
3. **Do not add** runtime Recovery Task creation, persisted observations, or runtime fingerprints.
4. **`fingerprintEvidence()` may only process approved projected scanner evidence bundles** produced by `projectEvidence()` / `collectEvidence()`. It must never be called on raw database documents.
5. **Unknown-commit outcomes are never automatically retried or replayed.** `runInTransaction()` retries only `TransientTransactionError` and excludes `UnknownTransactionCommitResult` (`lib/inventoryReservationService.js` L129–164); the operation stays `PREPARED` per OD-27-SC / OD-31.
6. **D06 may inspect existing `CONSUMING` reservation states.** `CONSUMING` is a normal transient claim state (`lib/inventoryReservationService.js` L1219–1243), not proof of a defect.
7. **Do not alter** payment state transitions, Inventory deduction semantics, or existing failure logging.

- **Recording date:** 2026-11-14.
- **Implementation status:** **R-1 READ-ONLY SOURCE PRESENT IN THE WORKING TREE (UNTRACKED); NO CHANGE TO PROTECTED PATHS BY R-1.** The payment/Inventory preservation requirement remains satisfied by not modifying those paths; R-1 imports no payment, order, Inventory, Hotel, Kitchen, Barista, or Jebena runtime module. **R-1 is independently verified (2026-11-14) and FORMALLY ACCEPTED BY THE OWNER on 2026-11-14.** The earlier "NOT STARTED" status is retained as the status at recording time and is superseded for current R-1 source status by this bullet.
- **Operational gates:** G-PAY-1 remains **BLOCKED**; G-AUD-1 remains **UNSIGNED**.

### 13.3 OD-40 — Recurrence after task closure

**Owner decision (approved policy).**

1. If the **same finding recurs after its Recovery Task is closed**, **no new task is created automatically**.
2. The **closed task is not reopened**.
3. The recurrence is **retained as scanner evidence** pending a separately approved recurrence-handling policy.
4. The **`isOpen: false` terminal-state invariant** is preserved, together with the existing unique-open-task identity rules: `IDX-TSK-02` is a unique partial index on `{ isOpen: true }`, and the writer sets `isOpen: false` at the terminal transition (`lib/models/RecoveryTask.js` L361, L456–472; `lib/recovery/taskWriter.js` L1585).

**Explicit non-claim.** This decision does **not** select a recurrence representation, does **not** authorize creation of a new task with `priorTaskId`, does **not** amend OD-23's scoping approval, and does **not** close OD-04 (retention) or any gate.

- **Recording date:** 2026-11-14.
- **Implementation status:** **R-1 READ-ONLY SCANNER SOURCE PRESENT IN THE WORKING TREE (UNTRACKED); NO TASK-CREATION OR REOPENING PATH.** The scanner emits `createsRecoveryTask: false` findings and reads no recovery collection. **R-1 is independently verified (2026-11-14) and FORMALLY ACCEPTED BY THE OWNER on 2026-11-14.** The earlier "NOT STARTED" status is retained as the status at recording time and is superseded for current R-1 source status by this bullet.
- **Operational gates:** G-REC-2, G-REC-3, G-AUD-1, G-GOV-1 remain **UNSIGNED**.

### 13.4 Status separation (decision vs recording vs implementation vs gate)

| Dimension | OD-38 | OD-39 | OD-40 |
|---|---|---|---|
| Owner decision | **APPROVED (policy)** | **APPROVED (policy)** | **APPROVED (policy)** |
| Recorded in this repository | **2026-11-14** | **2026-11-14** | **2026-11-14** |
| Original approval date / signature | **Not recorded; not invented** | **Not recorded; not invented** | **Not recorded; not invented** |
| Implementation status | **R-1 SOURCE PRESENT (UNTRACKED); AUDITED + CORRECTED + VERIFIED 2026-11-14; FORMALLY ACCEPTED BY OWNER 2026-11-14** | **R-1 SOURCE PRESENT (UNTRACKED); PROTECTED PATHS UNCHANGED; VERIFIED 2026-11-14; FORMALLY ACCEPTED** | **R-1 SOURCE PRESENT (UNTRACKED); NO TASK CREATION/REOPEN PATH; VERIFIED 2026-11-14; FORMALLY ACCEPTED** |
| Gate effect | **None** | **None** | **None** |
| Runtime activation | **Not authorized** | **Not authorized** | **Not authorized** |

### 13.5 Non-claims

Recording OD-38 / OD-39 / OD-40 is documentation only. It authorizes no schema change, index deployment, database connection, migration, runtime Recovery integration, writer call site, worker, scheduler, cron, feature flag, observation persistence, or change to POS / payment / Inventory / Hotel / waiter / Kitchen / Barista / Jebena behaviour. It signs no gate and closes no blocker: **BLK-EVID-01**, **BLK-SCH-01**, **BLK-UC-01**, **BLK-UC-02**, **BLK-AP-01**, **BLK-AP-02**, and **BLK-EVT-01** remain **OPEN**; **OD-10** remains **PENDING**; and the **T2 ACCEPTED / BLK-T2-01 CLOSED** record in §12 is unchanged. **(Superseded for OD-10 and BLK-SCH-01 only: OD-10 was approved on 2026-11-14 and BLK-SCH-01 is CLOSED — see §2.4. Further superseded for blocker status only: BLK-AP-01, BLK-AP-02, and BLK-EVT-01 were CLOSED on 2026-11-14 by the owner's final WP04-06 acceptance — §14. BLK-EVID-01, BLK-UC-01, and BLK-UC-02 remain OPEN; index deployment remains PENDING/UNSIGNED.)**

### 13.6 R-1 read-only source status (audited, corrected, verified, and formally accepted)

**Source present in the working tree (untracked).** R-1 consists of exactly these seven paths:

- `lib/recovery/repositories.js`
- `lib/recovery/scanner.js`
- `scripts/inventory-recovery-scan.mjs`
- `tests/wp04-06-recovery-repositories.test.mjs`
- `tests/wp04-06-recovery-scanner.test.mjs`
- `tests/wp04-06-scan-cli.test.mjs`
- `tests/wp04-06-runtime-isolation.test.mjs`

**Audit and correction.** The first implementation was audited and correction findings were identified. The applied correction removes the unsafe missing-Pass-2 fallback (an affected order is marked incomplete and all its findings are suppressed), states the non-transactional two-pass consistency limitation, states the windowed D06 coverage limitation without claiming exhaustive discovery, adds explicit remote-target and production authorization gates to the CLI, and separates the DB-free tests into the four authorized files. **R-1 is independently verified (2026-11-14) and FORMALLY ACCEPTED BY THE OWNER on 2026-11-14.**

**Final verification record (2026-11-14, read-only).** One consolidated verification was executed against the actual source and tests. Results: **46/46** R-1 tests pass (repositories, scanner, CLI, runtime isolation); **290/290** relevant DB-free regression tests pass (WP04-01 core, WP04-03 adapter/classifier, WP04-06 OP_MSG, schema contract, writer boundary, T2 proxy/runner); **ESLint clean** on the seven R-1 source/test files. Source checks confirmed: missing-Pass-2 orders are reported via `incompleteEvidence` with `passes.fullHistory.missingOrderIds` / `complete` and their orphan bundles suppressed; `SCAN_CONSISTENCY` and `D06_COVERAGE` state the non-transactional and non-exhaustive limits; the repository exposes only `findBounded` and rejects forbidden operators/projections; the CLI validates arguments and gates before the dynamic `import("mongoose")` and never prints the URI, host, or credentials; runtime isolation holds. Obsolete paths `lib/recovery/repository.js`, `scripts/recovery-scan.mjs`, and `tests/wp04-06-scanner.test.mjs` are absent. The nine authorized paths remain untracked and unmodified by unrelated work; no scanner run against a database, no database connection, and no environment/secret read occurred. No further R-1 audit cycle is required. **R-1 is FORMALLY ACCEPTED BY THE OWNER on 2026-11-14; the verification results above and the historical audit record are preserved.**

**Still not authorized or performed.** Runtime integration is **NOT AUTHORIZED**. No application route, worker, scheduler, cron, or feature flag imports or activates R-1. No Recovery Task creation or reopening path exists in R-1. **No database, staging, or production scan has been performed.** No environment file or secret was read by the correction. OD-10 and all unsigned gates remain unchanged. **(OD-10 was subsequently approved on 2026-11-14 and BLK-SCH-01 is CLOSED — see §2.4; all unsigned gates remain unchanged.)**

---

## 14. WP04-06 final owner acceptance and blocker closure record (2026-11-14, documentation only)

### 14.1 Owner acceptance

The owner has formally **accepted the WP04-06 final focused test-gap independent review and the complete WP04-06 offline evidence set on 2026-11-14**. On that basis the owner granted **closure of BLK-AP-01, BLK-AP-02, and BLK-EVT-01**. This record is documentation only; it changes no source, test, schema, index, database, gate signature, or runtime behavior.

### 14.2 Accepted evidence set (exact paths)

| Artifact | Path |
|---|---|
| Closure matrix | `docs/production-readiness/wp-04-06-ap01-ap02-evt01-closure-matrix.md` |
| Independent review (correction chain) | `docs/production-readiness/wp-04-06-ap01-ap02-evt01-independent-review.md` |
| Correction report (implementation) | `docs/production-readiness/wp-04-06-ap01-ap02-evt01-correction-report.md` |
| Post-correction independent review | `docs/production-readiness/wp-04-06-ap01-ap02-evt01-post-correction-independent-review.md` |
| Final focused test-gap closure (implementation) | `docs/production-readiness/wp-04-06-ap01-ap02-evt01-final-focused-test-gap-closure.md` |
| **Final focused test-gap independent review (acceptance basis)** | `docs/production-readiness/wp-04-06-final-focused-test-gap-independent-review.md` |

Supporting accepted records: the T2/P4/P5 disposable replica-set evidence `docs/production-readiness/evidence/wp04-06-t2-94e4714b61c9.json` (§12) and the approved production contract (§2.4/§3, OD-10). Independently confirmed test evidence at acceptance: **104/104** focused and **1,800/1,800** full DB-free tests pass, ESLint clean on the changed test files.

### 14.3 Blocker closures (2026-11-14)

| Blocker | Status | Closure basis |
|---|---|---|
| **BLK-AP-01** (approval model / separation of duties) | **CLOSED 2026-11-14** | Approved contract clauses 2 and 6 (§2.4; OD-10-A): nested `approval.*` plus the immutable flat audit mirror; `approvedBy`/`executedBy`/`verifierId` distinct identities; `executedBy`/`executedAt` required for T12, `verifierId`/`verifiedAt` required for T14. Implemented and verified in the accepted final review: W11 typed distinctness + CAS `$ne`, T12 executor attribution, T14 verifier distinctness, and direct clause-6 field assertions (`executedBy`/`verifierId` types, defaults, bounds). **Accepted residual (§14.5): approval-terminal protection is writer-CAS only — not database-level immutability.** |
| **BLK-AP-02** (rejection lifecycle) | **CLOSED 2026-11-14** | Clause 3 (§2.4; OD-10-B): `MANUAL_REQUIRED → MANUAL_REQUIRED` with `approval.state = REJECTED`, the immutable flat mirror, status unchanged, and exactly one `RECOVERY_REJECTED`; no re-approval transition; approval persists under clause 2. Implemented as W11 `recordRejection` (task CAS + one event in one transaction, no history row); W5 `T-REJECT` is unreachable through `applyTransition` (`TRANSITION_NOT_ALLOWED`, no write/event/history); negative controls verified in the accepted final review. |
| **BLK-EVT-01** (event contract / append-only audit) | **CLOSED 2026-11-14** | Clauses 4–5 and 8–9 (§2.4; OD-10-C): disjoint escalation/diagnostic enums; `RECOVERY_MANUAL_REQUIRED` removed; T14 emits exactly one `RECOVERY_VERIFIED`; reserved-event mappings recorded; `details.observedFingerprint` 64-hex and top-level `fencingToken` UUID-v4 bounds verified; UNKNOWN_COMMIT observation purity verified across ten writer entry points (no write, no event, no history, operation stays `PREPARED`). `ESC_UNKNOWN_COMMIT` is authorized only for the W8 abandonment transition (§14.4). |
| **BLK-UC-01** (durable post-crash operation identity) | **CLOSED 2026-11-15** | Approved O2 `pendingOperation` design (OD-24/OD-25/OD-26/OD-28/OD-30/OD-37; I-C standalone `T_reserve`; T9/Acq claim amendment — §1) implemented as W6 `reserveOperation`, which persists `operationId`/`sequenceNumber`/`eventId`/`leaseGeneration` **before** the effect attempt; crash/restart execution proof run `wp04-06-t2-debdf49b933a` (**T5-CRASH PASSED**): victim child SIGKILLed after exactly W1/W2/W6 (no `commitOperation`), fresh child reconciled read-only HOLD (`writesPerformed: 0`), fresh W7 completed at the exact durable reserved identity with the reserved fencing token; independent P4 (direct primary/majority) verified the committed world (events 3 / history 1). **Accepted residuals (§15):** harness-only disposable replica-set evidence; Windows SIGKILL = TerminateProcess recorded as observed, never claimed as POSIX delivery; single-run evidence requiring independent review; **BLK-EVID-01 remains OPEN**. |
| **BLK-UC-02** (`UNKNOWN_COMMIT` representation and resolution path) | **CLOSED 2026-11-15** | Approved hold-default + operator-authorized OD-37 abandonment protocol (OD-27, OD-27-SC, OD-31, OD-37 — §1; W8 authorization §14.4): `UNKNOWN_COMMIT` is an **observed-only condition** (operation stays `PREPARED`, no persisted status); read-only arbitration via `assessOperationOutcome` (zero-write HOLD, live-verified); W8 `abandonOperation` per R3 §22.6.2 with the expired-original-lease server-time predicate (`$$NOW ≥ leaseUntil`; `ABANDONABLE_STATUSES = {LEASED}`); crash/abandonment execution proof run `wp04-06-t2-debdf49b933a` (**T8-CRASH PASSED**): the armed W7 commit was withheld and never reached mongod, the durable `PREPARED` crash world had no partial rows (events 2 / history 0), and the authorized W8 settled `MANUAL_REQUIRED`/`AMBIGUOUS_COMMIT`/`ESC_UNKNOWN_COMMIT` with exactly one `RECOVERY_ESCALATED` event and one `ABANDONED` history row referencing the reserved event identity, leaving the reserved sequence as a **permanent gap** (OD-28). **Accepted residuals (§15):** authorization is a settlement fence, **not abort proof** (`OPERATOR_DECISION_AFTER_HOLD`, never `ABORT_CONFIRMED`); OD-07 alerting input still required before the residual audit control is actionable; harness-only evidence; single run requiring independent review. |

### 14.4 W8 / `ESC_UNKNOWN_COMMIT` authorization (recorded decision)

**Recorded owner decision (2026-11-14):** **W8 (`abandonOperation`) is a separately authorized OD-37 abandonment transition — not an `UNKNOWN_COMMIT` observation path.** `ESC_UNKNOWN_COMMIT` is used **only** by W8. This resolves the clause-5 wording "it may be used only by a separately approved transition that explicitly authorizes it" (§2.4):

- W8 is an allowlisted writer entry point (`WRITER_ENTRY_POINTS` W8 → `abandonOperation`); it requires an explicit operator authorization bound to the exact operation identity; it performs the task CAS under the OD-37 expired-original-lease predicate with `ABANDONABLE_STATUSES = {LEASED}`; and it emits exactly one `RECOVERY_ESCALATED` event plus one `inventory_recovery_operation_history` record in the same transaction, with `details.diagnosticCode: null`, `escalation.code = ESC_UNKNOWN_COMMIT`, `pendingOperation.state = ABANDONED`, and audit basis `OPERATOR_DECISION_AFTER_HOLD` (never `ABORT_CONFIRMED`).
- Every non-abandonment path remains observation-only per OD-27 / OD-27-SC / OD-31: an `UNKNOWN_COMMIT` observation never writes, never emits an event, never allocates a `sequenceNumber`/`eventId`, and leaves the operation `PREPARED`.
- The withdrawn "escalate with `ESC_UNKNOWN_COMMIT`" variant (R3 §15.5, L758) was the T5 worker-reconciliation observation path, not W8; there is no conflict with the approved contract.
- This recording is documentation only; it authorizes no runtime call site, worker, scheduler, or database access.

### 14.5 Preserved residual limitations (explicit, accepted)

These limitations are **accepted residuals disclosed at closure**, not defects, and remain true:

1. **Writer-CAS approval protection — not database-level immutability.** Terminal approval decisions (`APPROVED`/`REJECTED`) are protected by the canonical writer's CAS only (pending-decision CAS, distinctness `$ne` clauses, terminal CAS). Mongoose `immutable: true` was evaluated and **not** introduced (it is document/update-casting behavior, not database enforcement, and would break the sanctioned first writes of T-APPROVE/T-REJECT/T12/T14). No migration and no database constraint exists; a raw direct write outside the writer could still violate terminal immutability. Owner decision 2 (2026-11-14) retained the writer CAS as primary.
2. **In-memory transaction harness evidence only.** All transaction/CAS/rollback evidence is the DB-free in-memory test harness; it proves neither real-MongoDB server-time behavior, transaction isolation, nor deployed index uniqueness. The T2/P4/P5 disposable replica-set record (§12) remains the separate accepted runtime proof.
3. **Untracked / uncommitted provenance.** All WP04-06 package files (`lib/recovery/taskWriter.js`, `lib/models/RecoveryTask.js`, `lib/models/RecoveryEvent.js`, `tests/wp04-06-schema-contract.test.mjs`, `tests/wp04-06-writer-boundary.test.mjs`) are untracked working-tree files; `git diff --cached` is empty. No commit provenance is claimed. **BLK-EVID-01 remains OPEN** and unchanged.

### 14.6 Non-claims and unchanged statuses

This record changes documentation only. It authorizes no database access, migration, index deployment, staging or production access, runtime Recovery integration, writer call site, worker, scheduler, or change to POS / payment / Inventory / Hotel / waiter / Kitchen / Barista / Jebena behavior. It signs **no** gate: **G-REC-1, G-REC-2, G-REC-3, G-AUD-1, G-GOV-1 remain UNSIGNED; G-IDX-1 remains UNSIGNED/BLOCKED; G-PAY-1 remains BLOCKED** — all unchanged. **BLK-UC-01, BLK-UC-02, and BLK-EVID-01 remain OPEN**, unchanged; **BLK-T2-01 and BLK-SCH-01 remain CLOSED**, unchanged. No other blocker, gate, OD decision, or approval status is modified by this record.

---

## 15. Crash/restart execution record and BLK-UC-01/BLK-UC-02 closure (2026-11-15, documentation only)

> **Provenance.** The owner approved the **documentation-only closure of BLK-UC-01 and BLK-UC-02** on the independently reviewed crash/restart execution evidence below. The approved edit proposal is `wp-04-06-uc01-uc02-closure-proposal-draft.md` (criterion-by-criterion comparison; exact proposed edits). This section records the closure and the preserved residuals. **BLK-EVID-01 remains OPEN**; all gates remain **UNSIGNED/BLOCKED** and unchanged; no source, test, schema, model, script, index, database, runtime, worker, or scheduler change was made, and nothing was staged or committed.

### 15.1 Accepted execution evidence

Run **`wp04-06-t2-debdf49b933a`** — `EXECUTED_EVIDENCE_RECORDED`, process exit 0, evidence file `docs/production-readiness/evidence/wp04-06-t2-debdf49b933a.json`; disposable loopback replica set `bonowp0406t2rs` (mongod 8.0.34, `127.0.0.1:27031`, proxy 27032, bindIp loopback only), independent verifier (direct connection, primary read preference, majority read concern). Assertions: **T2_A, T2_B, T2_C, T5_CRASH, T8_CRASH — all PASSED.**

- **T2-A / T2-B / T2-C (re-verified in the same run):** sever-before-commit (every detected commit withheld, 0 correlation warnings; effect uncommitted; task `LEASED`/`PREPARED`); drop-commit-ack (every detected commit forwarded with a matching ACK-drop; driver retry committed; task `RESOLVED`/`COMMITTED`; task `leaseToken` equals the effect event `fencingToken`); negative control (zero commit detections with literal `commitTransaction` payload text).
- **T5-CRASH (durable post-crash operation identity — BLK-UC-01):** the victim child writer was SIGKILLed after exactly W1/W2/W6 (writer trace `createTaskFromFinding, claimLease, reserveOperation`; no `commitOperation` entry — asserted). The fresh child reconciled `UNRESOLVED/HOLD` with `writesPerformed: 0` against the durable `PREPARED` reservation, then completed W7 at the **exact durable reserved identity** (`t2-op-…-T5-CRASH`, sequence 3, `EVT:<taskId>:3`) using the reserved fencing token (verified equal to the reserved worker token). Independent P4 verified the committed world: events 3 / history 1 (one effect event at the reserved sequence + one history row).
- **T8-CRASH (hold and authorized abandonment — BLK-UC-02):** the armed W7 commit was withheld by the `withhold-commit-hold` proxy and **never reached mongod**; the victim was SIGKILLed while still inside the commit await (final phase `w7-started`). The post-kill world was verified independently: task `LEASED`, operation `PREPARED`, events 2 / history 0 — **no partial rows**. The fresh child reconciled read-only HOLD with zero writes, waited out the scenario's 2s lease, then executed the separately authorized W8 `abandonOperation` with authorization `crash-abandon:wp04-06-t2-debdf49b933a:T8-CRASH` bound to the exact `operationId` (`wp04-06-crash-operator`, `ROLE-INVENTORY-MANAGER`, basis `OPERATOR_DECISION_AFTER_HOLD`): the task settled to `MANUAL_REQUIRED` / `manualReasonCode AMBIGUOUS_COMMIT` / `escalation.code ESC_UNKNOWN_COMMIT`, the operation became `ABANDONED` with settlement metadata mirroring the authorization verbatim (task, event, and history records), exactly one `RECOVERY_ESCALATED` settlement event (sequence 4) and exactly one `ABANDONED` history row referencing the reserved `EVT:<taskId>:3` were written, and sequence 3 is a **permanent gap** (OD-28); final counts events 3 / history 1.

### 15.2 Blocker closures

The §14.3 closure table records both rows (added 2026-11-15) with the full closure basis; the §4 amendment log records them as **R3-AM8** with the corresponding R3 updates (banner, §19.3 intro + rows, §21.4). Summary:

- **BLK-UC-01 — CLOSED 2026-11-15.** Basis: the approved O2 `pendingOperation` design implemented as W6 `reserveOperation` (full reserved identity persisted before the effect attempt), plus the T5-CRASH proof of durable reservation recovery, zero-write HOLD reconciliation, and exact-identity W7 replay. The crash/restart test that §12.5 had listed as unexercised is now executed and independently verified.
- **BLK-UC-02 — CLOSED 2026-11-15.** Basis: the approved hold-default + operator-authorized OD-37 abandonment protocol (OD-27/OD-27-SC/OD-31/OD-37; W8 authorization §14.4), the read-only `assessOperationOutcome` HOLD path, and the T8-CRASH proof of the durable `PREPARED` crash world and the authorized W8 settlement with the permanent sequence gap. Per OD-31, `UNKNOWN_COMMIT` remains an **observed-only condition** — no persisted status exists or is required.

### 15.3 Preserved residual limitations (explicit, accepted)

1. **Authorization is not abort proof (R3 §22.6).** The W8 CAS is a settlement fence, not a historical abort record; the abandonment does not establish that the original effect transaction aborted, and the audit basis is `OPERATOR_DECISION_AFTER_HOLD`, never `ABORT_CONFIRMED`. This record claims no abort proof.
2. **OD-07 dependency (§5 item 1, §7).** The residual audit/operational control remains **not actionable** until OD-07 alerting input exists; this closure does not make G-REC-3 sign-off possible and does not activate any alerting.
3. **Harness-only evidence.** Disposable loopback replica set only; no runtime wiring, worker, or scheduler. Windows SIGKILL = TerminateProcess, recorded as observed (exitCode/signalCode as observed with platformNote), never claimed as POSIX signal delivery. The T8 scenario's short lease (`leaseMs` 2000) and host-time expiry wait are harness timing measures — the W8 CAS predicate itself is server-time (`$$NOW ≥ leaseUntil`), and elapsed time is never treated as abort proof (R3 §6.1 invariant 3).
4. **Single-run evidence.** One execution run; it requires independent review before any acceptance claim beyond this record.
5. **Untracked provenance (BLK-EVID-01 unaffected).** All WP04-06 package files remain untracked working-tree files; `git diff --cached` is empty. **BLK-EVID-01 remains OPEN** and is unchanged by this closure.

### 15.4 Historical provenance preserved

Three Phase B execution runs failed closed before the accepted run and are preserved untouched as provenance (never edited, overwritten, or regenerated):

| Run ID | Result | Notes |
|---|---|---|
| `wp04-06-t2-68aede0a0797` | **FAILED_CLOSED** | T2-A/B/C + T5-CRASH PASSED; T8-CRASH failed at the 45s fresh-W8 wait (mongod `transactionLifetimeLimitSeconds` reaper window). Cleanup clean. |
| `wp04-06-t2-f421dfb3a1b0` | **FAILED_CLOSED** | T8-CRASH completed functionally but the result object omitted `proxy.stats`; the evidence assertion failed closed. Cleanup clean. |
| `wp04-06-t2-d70a1e61908a` | **FAILED_CLOSED** | T8-CRASH fresh child completed W8 and exited between two status polls; the parent's `waitForStatusRecord` threw on exit before a final file read. Cleanup clean. |

Crash-proof harness changes (test-support only; no production source change): the `WITHHOLD_COMMIT_HOLD` proxy mode, the child worker module `tests/integration/support/t2CrashWorker.mjs`, the 150s fresh-W8 wait (`T8_FRESH_W8_TIMEOUT_MS`, documenting the 60s `transactionLifetimeLimitSeconds` reaper window), the pre-`abandonOperation` `w8-started` diagnostic status, and the `waitForStatusRecord` final-read-after-exit fix. Run-table provenance is recorded in `wp-04-06-t2-harness-and-evidence.md` §3.1.

### 15.5 Non-claims and unchanged statuses

This record changes documentation only. It authorizes no database access, staging or production access, schema change, index deployment (G-IDX-1 remains **UNSIGNED/BLOCKED**), migration, runtime Recovery integration, writer call site, worker, scheduler, feature flag, or change to POS / payment / Inventory / Hotel / waiter / Kitchen / Barista / Jebena behavior. It signs **no** gate: **G-REC-1, G-REC-2, G-REC-3, G-AUD-1, G-GOV-1 remain UNSIGNED; G-IDX-1 remains UNSIGNED/BLOCKED; G-PAY-1 remains BLOCKED** — all unchanged. **BLK-EVID-01 remains OPEN**; **BLK-T2-01 and BLK-SCH-01 remain CLOSED** — unchanged. Nothing here stages or commits anything.
