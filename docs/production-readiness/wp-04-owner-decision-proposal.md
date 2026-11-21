# WP-04 — Owner Decision Record (formerly Proposal)

Status: **OWNER-APPROVED (RECOMMENDED DEFAULTS) — DESIGN/POLICY ONLY — NOT IMPLEMENTED**
Approval date: 2026-11-08 (as supplied by the execution environment)
Original proposal date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Basis: `wp-04-reconciliation-design.md`, `wp-04-detection-rule-matrix.md`, `wp-04-recovery-state-machine.md`, `wp-04-test-and-acceptance-plan.md`; Phase 2.3 recovery/idempotency; Phase 2.4 decisions A–E; Phase 2.5 blueprint, matrix, gates, and test plan
Companion: `wp-04-gate-dependency-map.md`

> On 2026-11-08 the owner explicitly approved the recommended defaults for **WD-01 through WD-14**, without amendments or additional notes. That approval is limited to **design and policy**. It does not authorize code implementation, a recovery collection, a worker, a queue, a lease, a scheduler, an index, a migration, a seed, database access, staging tests, production operations, or Inventory V2 activation. No application code, schema, collection, index, route, worker, queue, cron, lease, migration, seed, environment variable, or runtime configuration was created or changed. No database, staging environment, `.env`, `.env.local`, secret, or credential was accessed. No stock, payment, accounting, or reservation record was mutated. Inventory V2 remains inactive. WP-13 and WP-09 were not started. **No gate is signed.** G-REC-1 remains **UNSIGNED**. G-PAY-1 remains **BLOCKED**.

> **AMENDMENT 2026-11-12 — WP04-06 DESIGN CONSOLIDATION (see `wp-04-06-design-consolidation-and-register.md` §4 ODP-AM1):** the WP04-06 owner decisions (OD-24…OD-35, OD-37 with `ABANDONABLE_STATUSES = {LEASED}`, OD-27-SC, OD-30, T9/Acquire `U_claim`, I-C standalone `T_reserve`, H1 abandonment-history) are now registered in that document's durable register. This document's D-01…D-21 rows remain as written and are read **together with** the WP04-06 register: retention remains deferred to the OD-04 owner input; alerting remains deferred to the OD-07 owner/operations input; lease/retry numerics remain provisional until test-derived sign-off (OD-09); the production schema contract (OD-10) remains a final proposal awaiting owner signature.

---

## 0. How to read this proposal

### 0.1 Decision states

| State | Meaning |
|---|---|
| **PROPOSED — NOT APPROVED** | A recommendation that has **not** been approved. In this document, only deferred sub-items remain in this state. |
| **OWNER APPROVAL REQUIRED** | A deferred item that still requires an explicit owner/accounting/operations decision. Silence is not approval. |
| **DEFERRED DECISION** | Deliberately not decided; a later gate, measurement, or named assignment must supply evidence first. |
| **PROHIBITED BEHAVIOUR** | Must not be implemented regardless of the approved surrounding decision. |
| **APPROVED** | Approved by the owner on **2026-11-08**. Approval applies only to the stated recommendation; deferred numerics, named assignments, and gate signatures remain unapproved. |

### 0.2 Evidence labels

| Label | Meaning |
|---|---|
| **VERIFIED** | Observed in current source, models, or git state at HEAD. |
| **INFERRED** | A logical consequence of verified code, not separately exercised. |
| **UNVERIFIED** | Requires staging, production, DBA, finance, or owner evidence. |
| **PROPOSED** | This document's recommendation; not approved. |
| **OWNER DECISION** | Requires an explicit signed choice. |

### 0.3 Safety boundary

This document records a policy approval, not an implementation authorization. It does not authorize:

- implementation of D01–D10;
- a recovery collection, worker, lease, queue, cron, scheduler, or public route;
- any stock, payment, accounting, or reservation write;
- index creation, migration, seed, or `syncIndexes()`;
- Inventory V2 activation;
- WP-13 or WP-09 work;
- production or staging database access.

---

## 1. Decision summary

| ID | Decision | Requested task item | Owner decision (2026-11-08) | Status | Gate |
|---|---|---|---|---|---|
| **WD-01** | Approve D01–D10 as read-only detection rules | 1 | **APPROVED** — D01–D10 are the read-only detection vocabulary | APPROVED | G-REC-1 |
| **WD-02** | Decide whether D02/D09 become durable `R9`/`R10` classes | 2 | **APPROVED** — no `R9`/`R10` in the first implementation; D02/D09 stay finding codes | APPROVED | G-REC-2 |
| **WD-03** | Define approver/executor/verifier roles for every class | 3 | **APPROVED** — role-placeholder matrix in §3; named people deferred | APPROVED (placeholders) | G-GOV-1 |
| **WD-04** | Stale-`CONSUMING` alert-only until measured | 4 | **APPROVED** — alert/report only; no task, no status change | APPROVED (threshold deferred) | G-REC-1, G-REC-3 |
| **WD-05** | Live reservation staleness without age-based release | 5 | **APPROVED** — report only; release requires evidence + approval | APPROVED (threshold deferred) | G-REC-3, G-GOV-1 |
| **WD-06** | Shortage accounting semantics | 6 | **APPROVED** — report only, no correction quantity; accounting meaning deferred | APPROVED (report-only) / ACCOUNTING DEFERRED | G-REC-2, G-PAY-2 |
| **WD-07** | Append-only recovery evidence history | 7 | **APPROVED** — append-only events, never overwrite; shape/retention deferred | APPROVED (requirement) | G-AUD-1, G-REC-2 |
| **WD-08** | Lease/retry/backoff/jitter provisional until tested | 8 | **APPROVED** — values remain provisional and must be tested; numerics NOT approved | APPROVED (posture) / NUMERICS DEFERRED | G-REC-3 |
| **WD-09** | Scheduled worker disabled by default | 9 | **APPROVED** — disabled; explicit `--execute` + worker identity; C5 to enable | APPROVED | G-REC-3 |
| **WD-10** | Line-level reconciliation mandatory or deferred | 10 | **APPROVED** — mandatory line-level deferred; item-level first | APPROVED | G-REC-1 |
| **WD-11** | Legacy cutoff decision process | 11 | **APPROVED** — evidence-based process; no invented date | APPROVED (date deferred) | G-REC-1 |
| **WD-12** | Deployed index verification before uniqueness reliance | 12 | **APPROVED** — read-only `getIndexes()` evidence first; rules work both ways | APPROVED (deployment deferred) | G-IDX-1, G-REC-2 |
| **WD-13** | External/manual database writer ownership | 13 | **APPROVED** — named owner + register + audit before reliance | APPROVED (register pending) | G-GOV-1, G-DB-1 |
| **WD-14** | G-REC-1/2/3, G-AUD-1, G-GOV-1 evidence | 14 | **APPROVED** — evidence requirements in §15 define the gates; signatories/dates deferred | APPROVED (definitions) | All recovery gates |

**All fourteen recommendations are approved for design and policy only (2026-11-08).** No gate is signed. Deferred numerics, named assignments, retention periods, maturity dates, and operational sinks are listed in §16.3 and are **not** approved by inference. The approval does not authorize code implementation.

---

## 2. WD-01 — Approve D01–D10 as read-only detection rules

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (design/policy only)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Approve D01–D10 as the read-only detection vocabulary for WP-04. |
| Deferred | Any automatic action, task creation, or correction derived from a rule. |
| Prohibited | Any write, task, worker, or repair performed under the label "detection". |

### 2.1 What is being approved

Approval means the ten rules may be implemented as a read-only scanner/classifier with the field-level design in `wp-04-detection-rule-matrix.md`:

| Rule | Class |
|---|---|
| D01 | `PAID` order with missing required stock deduction |
| D02 | Stock deduction without successful payment/accounting evidence |
| D03 | Duplicate stock movements |
| D04 | Duplicate or inconsistent reservations |
| D05 | Expired or abandoned reservations |
| D06 | Orders stuck in `CONSUMING` |
| D07 | Partial multi-station stock deductions |
| D08 | Cancelled items with inconsistent inventory state |
| D09 | Payment verification/rejection with inconsistent stock state |
| D10 | Missing, malformed, or conflicting recovery evidence |

### 2.2 What approval does **not** authorize

- Creating a recovery task or record.
- Starting a worker or scheduler.
- Changing a reservation status, stock quantity, payment field, or order status.
- Reading production data without a separate C5 approval.
- Treating a finding as proof of fraud, loss, or a required correction.

### 2.3 Options

| Option | Description | Assessment |
|---|---|---|
| **A (recommended)** | Approve D01–D10 as read-only rules only. | Smallest authority; enables G-REC-1 evidence without recovery risk. |
| B | Approve only a subset (for example D01, D03–D08). | Weakens coverage of D02/D09 and the evidence-integrity gate. |
| C | Defer all detection until a worker design exists. | Removes the only immediate control; not recommended. |

### 2.4 Acceptance evidence

- L0/L1 tests for D01–D10, including positive and negative fixtures.
- Read-only source-contract proof.
- L2 disposable read-only proof with before/after document hashes.
- Staging sample matching manual queries.
- Owner review of the output format and retention.

---

## 3. WD-02 — Decide whether D02 and D09 require durable `R9`/`R10` task classes

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (Option A: no `R9`/`R10` in the first implementation)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Do **not** add `R9`/`R10` in the first implementation. Keep D02 and D09 as read-only finding codes that always route to manual review. |
| Deferred | Adding `R9`/`R10` until staging volume and a manual procedure justify a durable class. |
| Prohibited | Coercing D02/D09 into an existing automatic class (R2/R4) or inventing a correction. |

### 3.1 Why this is a real decision

The approved Phase 2.5 recovery vocabulary is R1–R8. It covers:

- R1: `PAID` with no deduction;
- R2: `PAID` with a live reservation and no movement;
- R3: stale `CONSUMING`;
- R4: movement exists, reservation not `CONSUMED`;
- R5: duplicate movements;
- R6: consumed without movement;
- R7: hold drift;
- R8: negative stock.

It does **not** explicitly cover:

- **D02** — a movement exists but payment/accounting evidence is absent or the lifecycle cannot explain it. This is the inverse of R1.
- **D09** — payment verification/rejection fields contradict the order/stock state.

### 3.2 Options

| Option | Description | Consequence |
|---|---|---|
| **A (recommended)** | Keep D02/D09 as read-only findings; route them to `MANUAL_REQUIRED` under the nearest existing class (D02 → R7 context; D09 → R1/R7 context) and record the precise `findingClass` in the audit. | No WP-05 schema change; no new automatic path; the distinct finding is still visible. |
| B | Add `R9` (deduction without payment/accounting) and `R10` (payment-workflow contradiction) to the task schema and RACI. | Better task taxonomy, but a WP-05 schema change, new tests, new ownership, and a longer gate. |
| C | Defer the decision until WP-04 staging shows whether D02/D09 volume is material. | Avoids premature taxonomy; leaves a known representational gap. |

### 3.3 Recommendation

Adopt **A now**, with a documented trigger for revisiting:

- if staging reports D02 or D09 for more than a threshold the owner sets, or
- if manual review repeatedly needs a distinct queue, or
- if WP-05 is being revised for another reason.

### 3.4 Prohibited behaviour

- Treating D02 as "inventory gain" or D09 as "payment invalid" without evidence.
- Creating an automatic R9/R10 action.
- Reusing `R2`/`R4` primitives for D02/D09.
- Editing payment identity under either class.

---

## 4. WD-03 — Ownership roles for every recovery class

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (role placeholders only; named people deferred to WP-17/G-GOV-1)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Approve the role-placeholder matrix below. Names and backups are assigned separately in WP-17/G-GOV-1. |
| Deferred | Named individuals, shift rota, escalation channel, and retention. |
| Prohibited | Same person as approver and executor; executor or approver as sole verifier; worker self-approval. |

### 4.1 Role placeholders

These are **organisational responsibilities**, not system roles, accounts, or permissions. Assigning them creates no Staff role, login, or API authority.

| Placeholder | Responsibility | Must not |
|---|---|---|
| `ROLE-OWNER` | Signs policy, gates, retention, and scope. | Execute or verify an individual task. |
| `ROLE-INVENTORY-APPROVER` | Approves inventory-impacting manual classes. | Execute the same task. |
| `ROLE-FINANCE-APPROVER` | Approves payment/accounting-impacting classes. | Execute the same task. |
| `ROLE-RECOVERY-EXECUTOR` | Executes the approved single step. | Approve its own task or verify it. |
| `ROLE-INDEPENDENT-VERIFIER` | Re-reads the after-state and signs closure. | Be the approver or executor of the same task. |
| `ROLE-TECHNICAL-LEAD` | Owns rules, classifier, worker code, and evidence format. | Approve a financial correction. |
| `ROLE-DBA` | Verifies topology, indexes, and duplicate preflight. | Approve an inventory/payment correction. |
| `ROLE-OPERATIONS` | Owns the schedule, kill switch, alert routing, and runbook. | Approve a financial correction. |
| `ROLE-ONCALL` | Acknowledges and triages alerts. | Approve or execute a correction. |
| `ROLE-DATA-OWNER` | Owns legacy cutoff, external writers, and data-shape decisions. | Approve a financial correction alone. |

### 4.2 Class ownership matrix

| Class / sub-code | Approver | Executor | Independent verifier | Notes |
|---|---|---|---|---|
| **D01 / R1** — `PAID` missing deduction | `ROLE-FINANCE-APPROVER` + `ROLE-INVENTORY-APPROVER` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | No automatic action. |
| **D01** — `ALREADY_CORRECT_LEGACY` | `ROLE-INVENTORY-APPROVER` | `ROLE-RECOVERY-EXECUTOR` (record-only) | `ROLE-INDEPENDENT-VERIFIER` | Resolve as no-write; no reservation invented. |
| **D02 / R9 if approved** — deduction without payment | `ROLE-FINANCE-APPROVER` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | Manual accounting review; no movement deletion. |
| **D03 / R5** — duplicate movements | `ROLE-FINANCE-APPROVER` + `ROLE-INVENTORY-APPROVER` | `ROLE-FINANCE-APPROVER`-designated accounting operator | `ROLE-INDEPENDENT-VERIFIER` | Manual only; rows preserved. |
| **D04 / R5/R7** — reservation identity/structure | `ROLE-INVENTORY-APPROVER` | `ROLE-DBA` + `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | DBA executes data-shape work, not financial approval. |
| **D05 / R2** — `PAID` with live hold | `ROLE-INVENTORY-APPROVER` (standing approval) | `ROLE-RECOVERY-EXECUTOR` (future worker or operator) | `ROLE-INDEPENDENT-VERIFIER` | Only approved automatic class; WP-04 does not enable it. |
| **D05 / R7** — terminal/stale hold | `ROLE-INVENTORY-APPROVER` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | No age-based release. |
| **D06 / R3 conclusive** — finalize candidate | `ROLE-INVENTORY-APPROVER` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | Status-only; no stock change. |
| **D06 / R3 ambiguous** | `ROLE-INVENTORY-APPROVER` + `ROLE-TECHNICAL-LEAD` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | No automatic finalize. |
| **D07 / R4** — movement complete, no hold | `ROLE-INVENTORY-APPROVER` (standing approval) | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | Status-only; no stock change. |
| **D07 / R6** — mismatch/missing item | `ROLE-FINANCE-APPROVER` + `ROLE-INVENTORY-APPROVER` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | Manual accounting review. |
| **D08 / R5/R7** — cancellation/void | `ROLE-INVENTORY-APPROVER` + `ROLE-TECHNICAL-LEAD` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | Void/reclassification is an accounting fact. |
| **D09 / R1/R7** — payment/stock contradiction | `ROLE-FINANCE-APPROVER` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | Payment identity is frozen; no reversal. |
| **D10** — evidence integrity | `ROLE-DATA-OWNER` + `ROLE-TECHNICAL-LEAD` | `ROLE-RECOVERY-EXECUTOR` | `ROLE-INDEPENDENT-VERIFIER` | Blocks every automatic action. |
| **Scanner/report** | `ROLE-OWNER` (schedule) | `ROLE-OPERATIONS` or automated scanner | `ROLE-FINANCE-APPROVER` (sample review) | Read-only; no task. |
| **Index deployment** | `ROLE-OWNER` + `ROLE-DBA` | `ROLE-DBA` | `ROLE-TECHNICAL-LEAD` | C3 window; WP-11/WP-12. |
| **Worker enablement** | `ROLE-OWNER` + `ROLE-OPERATIONS` | `ROLE-OPERATIONS` | `ROLE-INDEPENDENT-VERIFIER` | C5 operation; WP-06. |

### 4.3 Separation rules

1. Approver ≠ executor on the same task.
2. Verifier ≠ approver and ≠ executor on the same task.
3. The automated worker never approves or verifies.
4. A developer/operator never approves a financial correction.
5. A manager cannot self-verify their own execution.
6. Backups must be named for every role before production reliance.

### 4.4 Prohibited behaviour

- Inventing employee names or assigning real people in this proposal.
- Treating a placeholder as a system role or permission.
- One person holding approver and verifier because "it is faster".
- A worker identity derived from a Staff cookie or POS session.

---

## 5. WD-04 — Stale `CONSUMING` is alert-only until transaction lifetime is measured

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (alert-only; `W_STALE` value NOT approved)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | D06 reports stale `CONSUMING` as an alert/finding only. It does not create a recovery task, change reservation status, or finalize consumption. |
| Deferred | Any `FINALIZE_CANDIDATE` action until WP-14 measures the real transaction lifetime. |
| Prohibited | Auto-finalize, auto-release, status mutation, or stock change based on age. |

### 5.1 Rationale

`CONSUMING` is an internal claim inside the consumption transaction. It should not be durable in the happy path. However, the maximum legitimate transaction lifetime is **UNVERIFIED** at this HEAD: no production/staging measurement exists.

Until WP-14 establishes the transaction budget and WP-16 proves failover behaviour:

- no age threshold can be declared safe;
- an age-based action could race a legitimate slow transaction;
- a status-only finalize could hide a partial deduction.

### 5.2 Recommended operating rule

| Observation | Output | Action |
|---|---|---|
| `CONSUMING`, age < provisional `W_STALE` | none | Ignore. |
| `CONSUMING`, age ≥ provisional `W_STALE` | D06 finding, `Medium`/`High` | Alert only. |
| Movements complete, no hold | `FINALIZE_CANDIDATE` label | Report; **no task, no write**. |
| Partial/ambiguous | `Critical` finding | Report; manual investigation. |

### 5.3 Exit condition

WP-14 must record:

- approved transaction budget;
- measured p99 transaction lifetime on the disposable replica set and staging;
- failover behaviour;
- a recommended `W_STALE` with margin.

The owner then decides whether D06 may create a task. WP-04 does not.

---

## 6. WD-05 — Live reservation staleness is reported, never released on age alone

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (report-only; staleness threshold NOT approved)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Report stale/terminal holds. Never release a hold solely because it is old. Release requires evidence + approval + audit. |
| Deferred | Any automatic release class, including terminal-order holds. |
| Prohibited | Age-based release, bulk hold reset, or `clear-orders` as a recovery tool. |

### 6.1 Evidence required before release

1. Order is terminal (`CANCELLED`/`ARCHIVED`) or proven abandoned by an owner-approved procedure.
2. No active line requires the item.
3. No payment settlement depends on the hold.
4. The reservation and `reservedStock` arithmetic agree.
5. An approver and a distinct executor are named.
6. The action uses the existing conditional release primitive, never a raw `$inc`.
7. The after-state is independently verified.

### 6.2 Prohibited behaviour

- Releasing because `age > N`.
- Releasing a `PAID` order's hold without consumption evidence.
- Resetting `reservedStock` globally to "clean up".
- Using `clear-orders` (production-disabled and out of scope).
- Treating a stale hold as evidence of theft.

---

## 7. WD-06 — Shortage accounting semantics remain unresolved

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (report-only posture); ACCOUNTING SEMANTICS DEFERRED** |
| Type | OWNER-APPROVED POLICY + ACCOUNTING DECISION REQUIRED |
| Recommended default | Keep shortage semantics unresolved. Report the approval snapshot and shortage quantity; do not assign a loss, receivable, cost, or correction. |
| Deferred | Accounting treatment, valuation, write-off, and any correction quantity. |
| Prohibited | Inventing a shortage value, clamping stock, or treating `shortageQuantity` as negative stock. |

### 7.1 Why it cannot be decided here

The code records an approved shortage snapshot (`required`, `available`, `shortage`) and does not represent it as negative stock. It does **not** define:

- whether the shortfall is an accepted loss, a receivable, a supplier claim, or an operational exception;
- the cost/valuation basis;
- whether it affects revenue, COGS, or reporting;
- who may write it off.

These are accounting/business decisions. WP-04 must not invent them.

### 7.2 Recommended handling

- Detection reports `shortageQuantity`, approval identity, approval timestamp, and reason.
- A shortage never creates a correction movement or a stock value.
- Any future write-off is a separate, finance-approved adjustment (WP-02 domain).

### 7.3 Prohibited behaviour

- `currentStock` adjustment to "cover" a shortage.
- Treating `shortageQuantity > 0` as a duplicate or a deduction failure.
- Using shortage as a reason to skip D01/D07 evidence.

---

## 8. WD-07 — Recovery evidence history is append-only

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (append-only requirement); collection shape and retention DEFERRED** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Every evidence read/decision appends an immutable evidence event. Prior evidence is never overwritten or deleted. |
| Deferred | Exact collection shape and retention period. |
| Prohibited | Mutating `evidence` in place, deleting evidence, or storing only the latest snapshot. |

### 8.1 Recommended model

| Record | Content |
|---|---|
| `evidenceEvent` | `taskId`, `orderId`, `fingerprint`, `capturedAt`, `capturedBy`, bounded snapshot, `reason` (detection, re-read, drift, verification) |
| `task.evidenceFingerprint` | The current authoritative fingerprint (a pointer, not a replacement for history) |
| `task.evidence` | Optional latest bounded projection for convenience; never the only copy |

### 8.2 Rules

1. Append only; no update/delete API.
2. Every execution and verification records the fingerprint it acted on.
3. Evidence drift appends a new event and changes the task state; it does not rewrite the old event.
4. Closed/cancelled tasks retain all evidence.
5. Retention is owner/finance-approved; no TTL by default.

### 8.3 Schema impact

The Phase 2.5 WP-05 proposal currently has one `evidence` object. Append-only history is a **schema refinement** that must be approved before WP-05 implementation. It is not implemented by WP-04.

---

## 9. WD-08 — Lease, retries, backoff, and jitter are provisional

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (provisional posture); LEASE/RETRY NUMERIC VALUES NOT APPROVED** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Treat the proposed values as provisional and require WP-06/WP-14 test evidence before enablement. |
| Deferred | Final production values. |
| Prohibited | Unbounded retries, blind retry of unknown commits, or tuning by guess in production. |

### 9.1 Provisional values

| Parameter | Provisional value |
|---|---|
| Lease duration | 5 minutes |
| Renewal | same owner + token + live lease |
| `maxAttempts` | 5 |
| Backoff | 30 s → 60 s → 120 s → 240 s → 480 s |
| Cap | 15 minutes |
| Jitter | Proposed; exact percentage not approved |
| Unknown commit | Zero automatic retries; evidence resolution only |
| Topology unavailable | Schedule later + alert |

### 9.2 Required evidence before final approval

- Two-worker race: one lease winner.
- Lease expiry and reclaim: one reclaim, evidence re-read.
- Crash before/after action: no duplicate effect.
- Unknown commit present/absent/contradictory.
- Transaction budget from WP-14.
- Staging `--once` run with a measured duration.

---

## 10. WD-09 — Scheduled recovery worker remains disabled by default

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (disabled by default; schedule/hosting deferred)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | No schedule, no public route, no default-on worker. Enablement is a separate C5 operation after all gates. |
| Deferred | Schedule, hosting location, and on-call rotation. |
| Prohibited | Auto-start, default-on environment flag, public recovery endpoint, or a worker identity from a Staff session. |

### 10.1 Recommended controls

1. `RECOVERY_WORKER_ENABLED` (proposed name) defaults absent/false; the CLI exits when not explicitly enabled.
2. `RECOVERY_WORKER_ID` or `--worker-id` is mandatory; no default.
3. `--execute` is mandatory; without it the worker runs dry-run/read-only.
4. No HTTP route exposes execution.
5. Enabling a schedule is a C5 change with owner/operations approval.
6. The kill switch can stop future work but does not delete durable tasks.
7. Audit failure aborts execution.

### 10.2 Prohibited behaviour

- Shipping the worker enabled in a normal application deploy.
- Running it inside a request handler or POS client.
- Using a Manager PIN as the worker credential.
- Auto-enabling because a staging run passed.

---

## 11. WD-10 — Line-level reconciliation: mandatory or deferred

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (mandatory line-level deferred; item-level first)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | **Defer mandatory line-level reconciliation.** Implement item-level detection first; retain line-level evidence where it is safe. |
| Deferred | Mandatory line-level reconciliation and any line-attributed correction. |
| Prohibited | Inferring a correction for one line when the reservation aggregates by inventory item. |

### 11.1 Rationale

`InventoryReservation.items` aggregates by `inventoryItemId`, not by order line. A movement can therefore be attributable to an item but not safely to a single line when two lines share that item. Line-level findings are inherently `Medium` confidence.

### 11.2 Recommended scope

| Level | Status |
|---|---|
| Item-level quantity reconciliation | Required for WP-04. |
| Whole-order cancellation/void evidence | Required. |
| Line-level cancellation evidence (presence of a void) | Required, `Medium` confidence. |
| Line-level quantity correction | Deferred; requires an item/line allocation model. |

### 11.3 Prohibited behaviour

- Releasing an item because one of its lines was cancelled while another active line still needs it.
- Creating a line-attributed movement without an allocation model.
- Reporting a line-level gap as `Critical` without item-level proof.

---

## 12. WD-11 — Legacy cutoff decision process (no invented date)

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (process only; CUTOFF DATE DEFERRED)** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Approve a documented, evidence-based cutoff process. Do not set a date in WP-04. |
| Deferred | The actual cutoff date. |
| Prohibited | Inventing a date, backfilling reservations, or marking all legacy orders `ALREADY_CORRECT`. |

### 12.1 Required process

1. **Identify the reservation start.** Find the earliest order with an `InventoryReservation` document and the earliest `requirementFingerprint`.
2. **Identify line identity coverage.** Find the earliest order where every inventory-linked line has a stable `lineId` and component evidence.
3. **Identify legacy deductions.** Find orders with `SaleDeduction` but no reservation.
4. **Test completeness.** Sample orders before and after each candidate boundary; confirm whether reservation coverage is complete.
5. **Record limitations.** A pre-cutoff order with no reservation and no movement is `UNKNOWN`, not automatically correct.
6. **Owner signs the cutoff and the exception policy.**
7. **No data change.** The cutoff is a reporting boundary, not a migration.

### 12.2 Classification before the cutoff

| Evidence | Classification |
|---|---|
| Legacy `SaleDeduction`, no reservation | `ALREADY_CORRECT_LEGACY`; no new reservation. |
| No reservation, no movement, inventory-free lines | `NO_INVENTORY_REQUIREMENT`. |
| No reservation, no movement, inventory-linked lines | `PAID_NO_RESERVATION_NO_DEDUCTION` at `Medium`; manual review. |
| Malformed/unknown legacy shape | `LEGACY_SHAPE` + D10; no guess. |

### 12.3 Prohibited behaviour

- Setting a cutoff without source/staging evidence.
- Creating reservations for historical orders.
- Backfilling movements.
- Treating "old" as "correct".

---

## 13. WD-12 — Deployed index verification before relying on uniqueness

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (verification requirement); index deployment DEFERRED** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Require read-only `getIndexes()` evidence for `InventoryReservation`, `StockMovement`, `InventoryItem`, `PaymentInfo`, and `Order` before any rule or gate relies on uniqueness. |
| Deferred | Index deployment (WP-11/WP-12) and the index window. |
| Prohibited | Assuming the unique indexes exist, running `syncIndexes()` in WP-04, or creating/dropping an index as part of detection. |

### 13.1 Verified gap

The application connection path and `scripts/sync-indexes.js` do not cover `InventoryReservation`, `StockMovement`, `InventoryItem`, or `PaymentInfo`. The schema declares unique indexes, but **deployed presence is UNVERIFIED**.

### 13.2 Required evidence

| Collection | Index to verify |
|---|---|
| `inventoryreservations` | `orderId` unique |
| `stockmovements` | `(refOrderId, reason, item)` unique partial |
| `stockmovements` | `idempotencyKey` unique partial |
| `inventoryitems` | expected query indexes |
| `paymentinfos` | expected query indexes |
| `orders` | expected status/createdAt indexes |

### 13.3 Operating rule

- D03/D04 must report duplicates **and** `INDEX_ABSENT` when uniqueness cannot be proven.
- No gate may claim "duplicates are impossible" without the evidence.
- Index creation is a separate C3 operation with a duplicate preflight.
- The old `(refOrderId, reason)` index is handled by WP-12, not WP-04.

---

## 14. WD-13 — External/manual database writer ownership

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (register requirement); writer inventory and names DEFERRED** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Create an external-writer register with a named owner, purpose, credential class, audit path, and change process for every writer outside the application. |
| Deferred | The actual inventory of writers and their owners. |
| Prohibited | Unlogged manual writes, shared credentials, or recovery that assumes the application is the only writer. |

### 14.1 Required register fields

| Field | Content |
|---|---|
| Writer ID | Stable identifier. |
| Owner role | `ROLE-DATA-OWNER` / `ROLE-DBA` / `ROLE-OPERATIONS`. |
| Type | Script, manual shell, BI export, migration, backup restore, vendor tool. |
| Collections | What it reads/writes. |
| Credential class | Read-only, read-write, admin; never the value. |
| Audit | Where the action is recorded. |
| Change process | Ticket/approval required. |
| Last verified | Evidence date. |

### 14.2 Why it matters

A recovery task based on application evidence can be invalidated by an external write. Until writers are known:

- D10 treats cross-document contradictions as possible;
- the worker must re-read evidence immediately before action;
- no rule may assume a single writer;
- no "hold drift" correction may run without checking for an external writer.

### 14.3 Prohibited behaviour

- A shared production credential with no named owner.
- Manual stock edits with no audit.
- Recovery that ignores an external write window.
- Using a BI/export credential for writes.

---

## 15. WD-14 — Gate evidence requirements

| Field | Value |
|---|---|
| Status | **APPROVED — 2026-11-08 (evidence definitions); SIGNATORIES AND DATES DEFERRED** |
| Type | OWNER-APPROVED POLICY |
| Recommended default | Approve the evidence requirements below as the definition of G-REC-1, G-REC-2, G-REC-3, G-AUD-1, and G-GOV-1. |
| Deferred | Sign-off dates and named signatories. |
| Prohibited | Signing a gate from a design document, a code review alone, or a staging run that touched non-disposable data. |

### 15.1 G-REC-1 — Read-only inventory reconciliation available

| Requirement | Evidence |
|---|---|
| D01–D10 implemented | Source + DB-free tests |
| Positive and negative fixture per rule | L1 results |
| Scanner provably read-only | Source-contract tests + before/after document hash |
| Disposable replica-set classification | L2 results |
| Staging read-only sample matches manual queries | L3 evidence |
| No write path (`--apply` refused) | CLI test |
| No V2 collection read/created | Integration evidence + source scan |
| Output redacted and deterministic | L1 + staging sample |
| No application/UI change | Diff review |
| Owner signs format/retention | Signed review |

**Current status: UNSIGNED.** No implementation exists.

### 15.2 G-REC-2 — Recovery schema and unique open-task index approved and deployed

| Requirement | Evidence |
|---|---|
| Exact fields/enums approved | Owner-signed schema |
| Unique `taskId` | Index dump |
| Unique partial `{ orderId: 1 }` where `isOpen: true` | Index dump + duplicate test |
| No TTL | Index review |
| No V2 collection name | Source/index review |
| No `orderVersion`/`inventoryMode` | Search + test |
| One open task per order | Disposable proof |
| Closed history retained | Disposable proof |
| Retention approved | Owner/finance signature |

**Current status: UNSIGNED.** WP-05 not started.

### 15.3 G-REC-3 — Worker lease/retry/audit/escalation proven

| Requirement | Evidence |
|---|---|
| Two workers, one lease winner | L2 race test |
| Lease expiry/reclaim | L2 test |
| Crash before/after action, no duplicate | L2 crash test |
| Unknown commit present/absent/contradictory | L2 test |
| R2 idempotent consumption | L2 test |
| R4 status-only finalize, no stock change | L2 test |
| Manual classes escalate | L2/L3 test |
| Worker cannot approve/verify | Test |
| Kill switch off by default | CLI/staging |
| Worker identity explicit, no public route | Source/staging |
| Audit write failure aborts | Test |
| Staging `--once` run | L3 evidence |

**Current status: UNSIGNED.** WP-06 not started.

### 15.4 G-AUD-1 — Append-only audit available and tested

| Requirement | Evidence |
|---|---|
| Append-only insert API | Source + test |
| No update/delete export or route | Source test |
| Required fields present | Test |
| Redaction proven | Test |
| Unique `eventId` | Disposable test |
| Query by domain/order/task | Disposable test |
| Audit failure aborts destructive/recovery action | Test |
| Retention approved | Owner/finance signature |

**Current status: UNSIGNED.** WP-07 not started.

### 15.5 G-GOV-1 — RACI, dual control, independent verification signed

| Requirement | Evidence |
|---|---|
| Named approver, executor, verifier, backups per class | Signed RACI |
| Distinctness enforced in audit/schema | Test |
| Worker cannot approve | Test |
| Escalation channel and SLA | Signed runbook |
| Retention policy | Signed policy |
| On-call named | Operations evidence |

**Current status: UNSIGNED.** WP-17 not started.

### 15.6 Gate dependency summary

```text
WD-01 (rules) ──> G-REC-1
WD-12 (index evidence) ──> G-IDX-1 ──> G-REC-2
WD-07 (append-only evidence) ──> G-REC-2 + G-AUD-1
WD-02 (R9/R10 taxonomy) ──> G-REC-2 (if approved)
WD-03 (roles) + WD-08 (lease/retry) + WD-09 (kill switch) ──> G-REC-3
WD-13 (external writers) ──> G-GOV-1 + G-DB-1
G-REC-2 + G-AUD-1 + G-REC-3 + G-GOV-1 ──> worker enablement (C5)
G-REC-1 ──> recovery operations may begin review, not execution
```

All fourteen decisions are approved at policy level, but **no gate is signed by this approval**. Gate signatures still require the evidence packages below.

The full map is in `wp-04-gate-dependency-map.md`.

---

## 16. Approval record

**Owner approval statement (supplied by the execution environment, 2026-11-08):**

> The owner explicitly approved the recommended defaults for WP-04 decisions WD-01 through WD-14, without amendments or additional notes.

**Approval scope:** design and policy only.
**Approval date:** 2026-11-08 (as supplied by the execution environment).
**Recorded by:** implementation-planning documentation task. This record is not a gate signature and creates no system identity.

| ID | Decision | Owner choice | Approval basis | Date |
|---|---|---|---|---|
| WD-01 | D01–D10 read-only rules | **APPROVED** — recommended default | Explicit owner approval; no amendment | 2026-11-08 |
| WD-02 | R9/R10 durable classes | **APPROVED** — no `R9`/`R10` in first implementation | Explicit owner approval; no amendment | 2026-11-08 |
| WD-03 | Ownership role matrix | **APPROVED** — role placeholders; names deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-04 | Stale `CONSUMING` alert-only | **APPROVED** — alert-only; threshold deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-05 | No age-based hold release | **APPROVED** — report-only; threshold deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-06 | Shortage accounting unresolved | **APPROVED** — report-only; accounting deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-07 | Append-only evidence history | **APPROVED** — append-only requirement; shape/retention deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-08 | Provisional lease/retry values | **APPROVED** — provisional posture; numerics not approved | Explicit owner approval; no amendment | 2026-11-08 |
| WD-09 | Worker disabled by default | **APPROVED** — disabled; schedule deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-10 | Line-level deferred | **APPROVED** — item-level first | Explicit owner approval; no amendment | 2026-11-08 |
| WD-11 | Legacy cutoff process | **APPROVED** — process only; date deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-12 | Index verification required | **APPROVED** — verification requirement; deployment deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-13 | External writer register | **APPROVED** — register requirement; inventory deferred | Explicit owner approval; no amendment | 2026-11-08 |
| WD-14 | Gate evidence requirements | **APPROVED** — evidence definitions; signatories/dates deferred | Explicit owner approval; no amendment | 2026-11-08 |

### 16.1 What the approval authorizes

| Decision | Authorized at policy level | Still prohibited / not authorized |
|---|---|---|
| WD-01 | Define D01–D10 as the read-only detection vocabulary | Implementing the scanner, any write, task, worker, or repair |
| WD-02 | Keep D02/D09 as finding codes; no new durable class now | Any automatic action for D02/D09; inventing a correction |
| WD-03 | Use the role-placeholder matrix and enforce distinctness in design | Creating system permissions, accounts, or named assignments |
| WD-04 | Report stale `CONSUMING` as alert-only | Status finalize, stock change, or an invented `W_STALE` |
| WD-05 | Report stale holds; release only with evidence and approval | Age-based or bulk release |
| WD-06 | Report shortage evidence and quantity | Any accounting value, write-off, or correction quantity |
| WD-07 | Design append-only evidence history | Mutating or deleting prior evidence |
| WD-08 | Treat lease/retry values as provisional test inputs | Treating numerics as production policy or tuning by guess |
| WD-09 | Keep the worker disabled by default and require explicit identity/`--execute` | Scheduling in a normal deploy or exposing a public route |
| WD-10 | Item-level detection first; retain safe line evidence | Line-attributed corrections without an allocation model |
| WD-11 | Apply the evidence-based cutoff process | Inventing a date or backfilling reservations/movements |
| WD-12 | Demand deployed-index evidence before uniqueness reliance | Creating/dropping indexes in WP-04 or assuming schema indexes exist |
| WD-13 | Build the external-writer register | Unlogged manual writes or shared production credentials |
| WD-14 | Use the gate evidence definitions in §15 | Signing a gate without runtime/operational evidence |

### 16.2 Approval scope

**Approved:**

1. The fourteen policy decisions and recommended defaults recorded above.
2. The read-only detection vocabulary D01–D10.
3. The role-placeholder ownership matrix (placeholders only).
4. The detection posture: alert-only D06, no age-based release, item-level first, report-only shortage.
5. The durable-recovery policy: append-only evidence, provisional lease/retry posture, worker disabled by default.
6. The gate evidence definitions and the requirement to verify deployed indexes and external writers.

**Not approved (explicit exclusions):**

1. Any code implementation, scanner, classifier, CLI, model, collection, or test file.
2. Any recovery record, worker, queue, cron, scheduler, lease, retry loop, or public route.
3. Any index creation, deletion, migration, seed, or `syncIndexes()`.
4. Any stock, payment, accounting, or reservation mutation.
5. Any change to application source, schema, routes, APIs, scripts, runtime configuration, Hotel, POS UI, or reporting.
6. Any database, staging, production, `.env`, `.env.local`, secret, or credential access.
7. Inventory V2 activation or any `orderVersion`/`inventoryMode` field.
8. WP-13 or WP-09 work.
9. Any gate signature, gate pass, or waiver.
10. Any named employee, approver, executor, verifier, on-call owner, or signatory.
11. Any numeric threshold, retention period, lease value, retry count, backoff, jitter, scan window, or cutoff date.
12. Any shortage accounting meaning, valuation, write-off, refund, chargeback, or adjustment rule.

### 16.3 Remaining deferred decisions (NOT approved)

| # | Deferred item | Related decision | Who must decide | Evidence required first |
|---|---|---|---|---|
| D-01 | Shortage accounting semantics: accepted loss, receivable, supplier claim, or other | WD-06 | Owner + accounting/finance | Approved accounting policy; no value is inferred from `shortageQuantity` |
| D-02 | Named approver, executor, independent verifier, and backups per class | WD-03 | Owner / WP-17 | Signed RACI and distinctness evidence |
| D-03 | Numeric stale-`CONSUMING` threshold `W_STALE` | WD-04 | Owner + technical lead | WP-14 transaction budget and measured p99 lifetime |
| D-04 | Numeric live-reservation staleness threshold | WD-05 | Owner / operations | Measured hold lifetime and business policy |
| D-05 | Legacy historical cutoff date | WD-11 | Owner / data owner | Read-only reservation-start and line-identity evidence |
| D-06 | Evidence and output retention periods | WD-07, WD-14 | Owner + finance/legal | Retention policy and storage decision |
| D-07 | Lease duration, retry count, backoff, jitter, and cap values | WD-08 | Owner + technical lead | WP-06/WP-14 two-worker, crash, and expiry tests |
| D-08 | Production scan window, transaction-lifetime limit, and read budget | WD-04, WD-14 | Owner + DBA | WP-13/WP-14 evidence on approved staging |
| D-09 | Alert sink, on-call ownership, escalation channel, and SLA | WD-14 | Owner / operations | Approved sink and on-call rota |
| D-10 | Exact recovery task fields and enums | WD-02, WD-07 | Owner / WP-05 | Signed WP-05 schema |
| D-11 | Exact append-only evidence collection shape | WD-07 | Owner / WP-05, WP-07 | Signed evidence schema and audit contract |
| D-12 | Index deployment window and any index change | WD-12 | Owner + DBA / WP-11, WP-12 | `getIndexes()` inventory and duplicate preflight |
| D-13 | External-writer inventory, owners, credential classes, and audit paths | WD-13 | Owner / data owner / DBA | Completed writer register |
| D-14 | Gate signatories and sign-off dates | WD-14 | Owner | Complete evidence package per gate |
| D-15 | Volume threshold that triggers reconsideration of `R9`/`R10` | WD-02 | Owner | Staging D02/D09 volume report |
| D-16 | Whether D06 may ever create a task or finalize a candidate | WD-04 | Owner | WP-14 measurement and WP-16 failover proof |
| D-17 | Whether any terminal-order hold may ever be auto-released | WD-05 | Owner | Approved release policy and evidence contract |
| D-18 | Line-to-item allocation model for any line-attributed correction | WD-10 | Owner / technical lead | Approved allocation model and tests |
| D-19 | Whether a scheduled worker may run, and where | WD-09 | Owner / operations | G-REC-2, G-REC-3, G-AUD-1, G-GOV-1 |
| D-20 | R9/R10 taxonomy adoption, if ever needed | WD-02 | Owner | Staging volume plus a distinct manual queue |
| D-21 | Recovery task model name, collection name, and index names | WD-02, WD-07 | Owner / WP-05 | G-REC-2 schema approval |
| D-22 | Approval/verification UI or operational channel | WD-03 | Owner / operations | No UI is approved by WP-04 |

No deferred item above is approved by the WD-01…WD-14 approval. A recommendation is never converted into a numeric policy by inference.

---

## 17. Prohibited behaviour (global)

Regardless of any decision above:

1. No stock, payment, accounting, or reservation mutation by WP-04.
2. No recovery collection, worker, queue, cron, scheduler, or public route.
3. No automatic repair.
4. No `--apply`/`--fix`/`--repair` path.
5. No deletion of movements, reservations, voids, orders, or audit records.
6. No negative-stock clamp.
7. No invented correction quantity.
8. No payment identity change after `PAID`.
9. No combined payment+inventory transaction.
10. No Inventory V2 activation, collection, route, or field.
11. No `orderVersion`/`inventoryMode`.
12. No production/staging access, `.env` read, secret read, index creation, migration, seed, or `syncIndexes()`.
13. No Git stage, commit, push, deploy, reset, clean, checkout, or stash.
14. No WP-13 or WP-09 work.
15. No claim that G-REC-1 or G-PAY-1 is signed.

---

## 18. Closing statement

On **2026-11-08** the owner approved the recommended defaults for **WD-01 through WD-14**. That approval is a design and policy decision. It does not implement, test, deploy, or sign any gate, and it does not resolve the deferred items in §16.3.

**Approved decisions: WD-01 … WD-14 (recommended defaults, design/policy only).**
**Deferred decisions: §16.3 (22 items) — not approved.**
**WP-04 remains design-only and not implemented.**
**G-REC-1 remains unsigned.**
**G-PAY-1 remains blocked.**
**Inventory V2 remains inactive.**

No database was contacted. No application source, schema, route, index, script, or runtime configuration was changed. No stock, payment, accounting, or reservation record was mutated.
