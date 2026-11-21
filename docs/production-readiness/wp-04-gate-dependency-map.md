# WP-04 — Gate Dependency Map

Status: **DECISIONS APPROVED (WD-01 … WD-14) — NO GATE SIGNED — NOT IMPLEMENTED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Basis: `wp-04-owner-decision-proposal.md`; `phase-2-5-work-package-matrix.md`; `phase-2-5-safety-and-deployment-gates.md`; `phase-2-5-test-and-acceptance-plan.md`; `phase-2-4-owner-decisions.md`
Companion: `wp-04-owner-decision-proposal.md`, `wp-04-implementation-blueprint.md`

> The owner approved the recommended defaults for **WD-01 through WD-14** on **2026-11-08**; see `wp-04-owner-decision-proposal.md` §16. That approval is design/policy only. This map shows what must be true before each recovery gate can be signed. It does **not** sign a gate, start a work package, create a collection/index/worker, or authorize recovery. **G-REC-1, G-REC-2, G-REC-3, G-AUD-1, and G-GOV-1 remain UNSIGNED.** G-PAY-1 remains **BLOCKED**. Inventory V2 remains inactive.

> **Status reconciliation RC-5 (2026-11-14, documentation only).** R-1 read-only source is present in the working tree and formally accepted (2026-11-14); Package 1 DB-free schema/identity tests pass 11/11. The failure reasons in §9 are refreshed accordingly. No gate is signed, no staging sample exists, and G-REC-1 remains **UNSIGNED**.

---

## 1. Purpose

The four WP-04 documents define detection, recovery state, and tests. This map answers one operational question:

> *Which evidence, owner decision, and prerequisite gate must exist before WP-04 can move from a read-only report to a durable recovery worker?*

It also prevents three failure modes:

1. **Signing a gate from a design document** instead of runtime evidence.
2. **Enabling the worker** before the schema, audit, ownership, or index evidence exists.
3. **Treating detection as authority** to correct stock or payment.

### 1.1 Decision status

All fourteen owner decisions are **APPROVED** at design/policy level (2026-11-08), with the deferred items listed in `wp-04-owner-decision-proposal.md` §16.3. Approval of a decision does not satisfy a gate; every gate below still requires its own evidence package and signature.

---

## 2. Gate catalogue

### 2.1 Recovery and audit gates

| Gate | Definition | Accountable role | Blocks | Current state |
|---|---|---|---|---|
| **G-REC-1** | Read-only inventory reconciliation is implemented, proven read-only, and produces a reviewed report for D01–D10. | `ROLE-OWNER` + `ROLE-INVENTORY-APPROVER` | Recovery operations review; any later worker design | **UNSIGNED — NOT STARTED** |
| **G-REC-2** | Recovery schema and unique open-task index are approved, deployed, and verified. | `ROLE-OWNER` + `ROLE-DBA` | Worker implementation (WP-06) | **UNSIGNED — NOT STARTED** |
| **G-REC-3** | Worker lease, retry, unknown-commit, escalation, kill switch, and audit behaviour are proven on a disposable replica set and staging `--once`. | `ROLE-OWNER` + `ROLE-OPERATIONS` + `ROLE-TECHNICAL-LEAD` | Automated recovery enablement | **UNSIGNED — NOT STARTED** |
| **G-AUD-1** | Append-only POS audit collection and service are deployed and proven; audit failure aborts the guarded action. | `ROLE-OWNER` + `ROLE-FINANCE-APPROVER` | Any destructive or recovery action; G-REC-3 | **UNSIGNED — NOT STARTED** |
| **G-GOV-1** | RACI, dual control, independent verification, escalation, and retention are signed with named roles/backups. | `ROLE-OWNER` | All recovery and destructive operations; G-REC-3 | **UNSIGNED — NOT STARTED** |

### 2.2 Prerequisite gates referenced by the map

| Gate | Definition | Blocks | Current state |
|---|---|---|---|
| **G-IDX-1** | V1 index coverage for reservations, movements, inventory items, payment accounts, and orders is deployed or explicitly reported absent. | G-REC-2 | **UNSIGNED** |
| **G-DB-1** | Topology, concerns, and index inventory are reproducible read-only evidence. | G-REC-2, G-REC-3 | **UNSIGNED** |
| **G-DB-2** | Explicit transaction budget/concerns/pool are signed. | G-REC-3 | **UNSIGNED** |
| **G-DB-4** | Failover, pool, and alert routing are proven; an on-call is named. | G-REC-3 | **UNSIGNED** |
| **G-PAY-1** | Payment identity freeze is proven on approved staging. | Payment release; WP-03 confidence | **BLOCKED** |
| **G-PAY-2** | Finance-approved adjustment ledger or explicit out-of-scope policy. | Any refund/chargeback/write-off | **UNSIGNED** |

### 2.3 Gate ownership

| Role | Gate responsibility |
|---|---|
| `ROLE-OWNER` | Signs every gate; owns policy, retention, and scope. |
| `ROLE-INVENTORY-APPROVER` | Co-signs G-REC-1 and inventory-impacting recovery. |
| `ROLE-FINANCE-APPROVER` | Co-signs G-AUD-1 and any financial-impact class. |
| `ROLE-TECHNICAL-LEAD` | Produces rule/worker evidence; cannot sign a financial gate alone. |
| `ROLE-DBA` | Produces index/topology evidence; cannot sign a financial gate. |
| `ROLE-OPERATIONS` | Produces schedule/kill-switch/alert evidence. |
| `ROLE-INDEPENDENT-VERIFIER` | Verifies task after-states; cannot sign a gate they executed. |

Role placeholders are organisational responsibilities, not system accounts or permissions.

---

## 3. Dependency graph

```text
                        WP-04 OWNER DECISIONS
                        (WD-01 … WD-14)
                               |
                               v
                 +-----------------------------+
                 | WP-04 implementation        |
                 | read-only scanner/classifier|
                 +--------------+--------------+
                                |
                                v
                        +---------------+
                        |   G-REC-1     |  read-only reconciliation
                        +-------+-------+  (no recovery, no write)
                                |
                                v
                   recovery review may begin
                   (manual, evidence-only)

  WP-13 read-only evidence
        |
        v
  +-----------+     +----------------+     +----------------+
  |  G-DB-1   |---->|    G-IDX-1     |---->|    G-REC-2     |
  +-----------+     | (WP-11/WP-12)  |     | (WP-05 schema) |
                    +----------------+     +-------+--------+
                                                   |
  WP-07 append-only audit                         |
        |                                          |
        v                                          |
  +-----------+                                    |
  |  G-AUD-1  |------------------------------------+
  +-----------+                                    |
                                                   |
  WP-17 RACI                                       |
        |                                          |
        v                                          |
  +-----------+                                    |
  |  G-GOV-1  |------------------------------------+
  +-----------+                                    |
                                                   |
  WP-14 budget + WP-16 alert/failover              |
        |                                          |
        v                                          |
  +-----------+     +----------------+             |
  |  G-DB-2   |---->|    G-DB-4      |-------------+
  +-----------+     +----------------+             |
                                                   v
                                          +----------------+
                                          |    G-REC-3     |
                                          | (WP-06 worker) |
                                          +-------+--------+
                                                  |
                                                  v
                                    C5 worker enablement
                                    (separate owner/ops ticket)
```

### 3.1 Hard edges

| From | To | Why |
|---|---|---|
| WD-01…WD-14 | G-REC-1 | Binding approval recorded 2026-11-08; implementation still requires a separate authorization, and the gate requires evidence. |
| WP-04 implementation | G-REC-1 | The gate is evidence of a working read-only report. |
| G-DB-1 | G-IDX-1 | Index inventory must exist before index deployment can be verified. |
| G-IDX-1 | G-REC-2 | A unique open-task index cannot be trusted if the collection/index baseline is unknown. |
| WD-07 | G-AUD-1 | Append-only evidence history must be approved before the audit model is finalized. |
| WP-07 | G-AUD-1 | The audit collection/service must exist and pass redaction/append-only tests. |
| G-REC-2 | G-REC-3 | The worker cannot lease a task that has no schema/index. |
| G-AUD-1 | G-REC-3 | Every recovery action needs an append-only audit record. |
| G-GOV-1 | G-REC-3 | Named approver/executor/verifier is required before execution. |
| G-DB-2/G-DB-4 | G-REC-3 | Transaction budget and alert routing are required for safe retry/on-call. |
| G-REC-3 | C5 enablement | Proven worker behaviour is a prerequisite, not a substitute, for the enablement ticket. |

### 3.2 No shortcut edges

| Illegal shortcut | Why it is rejected |
|---|---|
| G-REC-1 → worker enablement | A read-only report does not prove schema, lease, audit, or ownership. |
| G-REC-2 → automated recovery | Schema existence does not prove worker safety. |
| G-AUD-1 → destructive admin | Audit is necessary, not sufficient; G-GOV-1 and WP-08/WP-18 are also required. |
| Design document → any gate | A gate requires runtime/operational evidence and a signature. |
| "No findings on staging" → gate | Absence of findings is not proof of read-only correctness or coverage. |
| "Index exists in schema" → G-IDX-1 | Deployed presence is unverified until `getIndexes()` evidence. |

---

## 4. Work-package prerequisites

| WP | Title | Prerequisites | Produces | Gate |
|---|---|---|---|---|
| **WP-04** | Read-only inventory reconciliation | WD-01, WD-10, WD-11, WD-12, WD-14 approved 2026-11-08; separate implementation authorization required | `lib/recovery/*` (candidate), `scripts/reconcile-inventory.mjs`, tests | G-REC-1 |
| **WP-05** | Recovery job schema and indexes | WD-02, WD-07, WD-14; owner signs fields | `InventoryRecoveryJob` model, schema tests | G-REC-2 |
| **WP-06** | Recovery lifecycle service and worker | G-REC-2, G-AUD-1, G-GOV-1, G-DB-2/G-DB-4 | task service, worker CLI, tests | G-REC-3 |
| **WP-07** | Durable POS audit foundation | WD-07, WD-14; retention decision | `PosAuditEvent` model, append-only service | G-AUD-1 |
| **WP-11** | V1 index coverage | G-DB-1; DBA window | index deployment evidence | G-IDX-1 |
| **WP-12** | Replace obsolete `StockMovement` index | G-IDX-1, G-DB-1 | create-then-drop evidence | G-IDX-1 |
| **WP-13** | Database readiness verification | Owner approval for read-only evidence | topology/concern/index report | G-DB-1 |
| **WP-14** | Transaction concerns/budget/pool | G-DB-1; D-2/D-3 sign-off | explicit budget/concerns | G-DB-2 |
| **WP-16** | Failover/pool/alerting proof | G-DB-2; G-DB-1 | staging drill + on-call | G-DB-4 |
| **WP-17** | RACI, dual control, verification | WD-03; owner names roles | signed RACI | G-GOV-1 |
| **WP-03** | Read-only payment reconciliation | G-PAY-1; WP-02 optional | payment findings | G-PAY-3 |
| **WP-02** | Payment adjustment ledger | Finance gate | append-only adjustments | G-PAY-2 |

WP-04 does not start WP-05, WP-06, WP-07, WP-09, WP-11, WP-12, WP-13, WP-14, WP-16, or WP-17.

---

## 5. Approved-decision-to-gate map

| Decision | State | Primary gate(s) | Evidence the decision unlocks |
|---|---|---|---|
| WD-01 | APPROVED 2026-11-08 | G-REC-1 | D01–D10 may be designed as read-only detection; implementation still needs separate authorization. |
| WD-02 | APPROVED 2026-11-08 | G-REC-2 | Task taxonomy is fixed; no `R9`/`R10` in the first implementation. |
| WD-03 | APPROVED 2026-11-08 | G-GOV-1, G-REC-3 | Approver/executor/verifier placeholders and distinctness policy. |
| WD-04 | APPROVED 2026-11-08 | G-REC-1, G-REC-3 | D06 is alert-only until measurement; no finalize. |
| WD-05 | APPROVED 2026-11-08 | G-REC-3, G-GOV-1 | No age-based release; evidence-based manual release only. |
| WD-06 | APPROVED 2026-11-08 | G-REC-2, G-PAY-2 | Shortage remains report-only; accounting semantics deferred. |
| WD-07 | APPROVED 2026-11-08 | G-AUD-1, G-REC-2 | Append-only evidence history is required. |
| WD-08 | APPROVED 2026-11-08 | G-REC-3 | Lease/retry values remain provisional and require test evidence. |
| WD-09 | APPROVED 2026-11-08 | G-REC-3 | Worker disabled by default; C5 to enable. |
| WD-10 | APPROVED 2026-11-08 | G-REC-1 | Item-level first; mandatory line-level deferred. |
| WD-11 | APPROVED 2026-11-08 | G-REC-1 | Legacy cutoff process; no invented date. |
| WD-12 | APPROVED 2026-11-08 | G-IDX-1, G-REC-2 | Index evidence required before uniqueness reliance. |
| WD-13 | APPROVED 2026-11-08 | G-GOV-1, G-DB-1 | External writers must be named and documented. |
| WD-14 | APPROVED 2026-11-08 | All recovery gates | Gate evidence definitions are approved; signatures are not. |

### 5.1 Decision blocking matrix (contingency)

All WD decisions are currently approved. This matrix applies only if an approval is later revoked, amended, or found inapplicable.

| If this approval is revoked/amended | These gates cannot be signed |
|---|---|
| WD-01 | G-REC-1 |
| WD-02 | G-REC-2 (taxonomy ambiguous) |
| WD-03 | G-GOV-1, G-REC-3 |
| WD-04 | G-REC-3 (D06 behaviour ambiguous) |
| WD-05 | G-REC-3 (release behaviour ambiguous) |
| WD-06 | G-REC-2 (shortage class ambiguous); any write-off path |
| WD-07 | G-AUD-1, G-REC-2 |
| WD-08 | G-REC-3 |
| WD-09 | G-REC-3 |
| WD-10 | G-REC-1 (scope ambiguous) |
| WD-11 | G-REC-1 (legacy classification ambiguous) |
| WD-12 | G-IDX-1, G-REC-2 |
| WD-13 | G-GOV-1, G-DB-1 |
| WD-14 | All recovery gates |

---

## 6. Evidence matrix

| Evidence | G-REC-1 | G-REC-2 | G-REC-3 | G-AUD-1 | G-GOV-1 |
|---|---|---|---|---|---|
| Owner-signed decision (WD-01/10/11) | required | — | — | — | — |
| Owner-signed schema (WD-02/07) | — | required | — | — | — |
| Named roles and backups (WD-03) | — | — | required | — | required |
| Source-contract read-only test | required | — | — | — | — |
| DB-free unit tests | required | required | required | required | — |
| Disposable replica-set tests | required | required | required | required | — |
| Staging read-only sample | required | — | — | — | — |
| Staging `--once` worker run | — | — | required | — | — |
| Index dump (`getIndexes`) | — | required | — | — | — |
| Duplicate preflight | — | required | — | — | — |
| Append-only audit proof | — | — | required | required | — |
| Redaction proof | required | — | required | required | — |
| Kill-switch proof | — | — | required | — | — |
| Alert routing / on-call | — | — | required | — | required |
| Retention decision | required | required | — | required | required |
| Independent verifier signature | required | required | required | required | required |
| No V2 / no `orderVersion` / no `inventoryMode` | required | required | required | required | required |

### 6.1 Evidence package per gate

| Gate | Minimum package |
|---|---|
| G-REC-1 | D01–D10 source + L0/L1/L2 results; staging sample; before/after hash; redaction sample; owner sign-off |
| G-REC-2 | Signed schema; index dump; duplicate preflight; unique open-task proof; no-TTL proof; no-V2 proof |
| G-REC-3 | Two-worker race; lease expiry/reclaim; crash before/after; unknown commit present/absent/contradictory; R2/R4 only; kill switch; audit; staging `--once`; on-call |
| G-AUD-1 | Append-only API; no update/delete; unique event id; redaction; query paths; audit-failure abort; retention |
| G-GOV-1 | Signed RACI with backups; distinctness tests; worker-cannot-approve test; escalation channel/SLA; retention policy |

---

## 7. Sequencing and release waves

```text
Wave 0 — decisions and read-only visibility
  0.1 WD-01 … WD-14 approved 2026-11-08 (recommended defaults, design/policy only).
  0.2 Separate implementation authorization for the read-only slice.
  0.3 WP-04 implementation (read-only) after that authorization.
  0.4 G-REC-1 evidence and signature.

Wave 1 — foundations
  1.1 WP-13 read-only DB evidence -> G-DB-1.
  1.2 WP-07 append-only audit -> G-AUD-1.
  1.3 WP-11 index coverage -> G-IDX-1.
  1.4 WP-17 RACI draft; names pending.

Wave 2 — recovery schema
  2.1 WP-05 schema/index -> G-REC-2 (requires G-IDX-1 + WD-02/07).
  2.2 WP-12 obsolete index replacement -> G-IDX-1.

Wave 3 — worker proof
  3.1 WP-14 transaction budget -> G-DB-2.
  3.2 WP-16 alert/failover proof -> G-DB-4.
  3.3 WP-06 worker tests -> G-REC-3.
  3.4 WP-17 signature -> G-GOV-1.

Wave 4 — C5 enablement
  4.1 Separate owner/operations ticket.
  4.2 Kill switch verified off by default.
  4.3 On-call acknowledged.
  4.4 No V2 activation.
```

### 7.1 Wave exit criteria

| Wave | Exit |
|---|---|
| 0 | WD decisions recorded; G-REC-1 signed; no recovery execution. |
| 1 | G-DB-1, G-AUD-1, G-IDX-1 signed; no production write. |
| 2 | G-REC-2 signed; schema/index deployed and verified; no worker. |
| 3 | G-DB-2, G-DB-4, G-REC-3, G-GOV-1 signed; worker disabled by default. |
| 4 | C5 enablement signed; worker may run only R2/R4; manual classes escalate. |

---

## 8. Blocking conditions and stop conditions

### 8.1 Gate-blocking conditions

A gate cannot be signed if any of the following is true:

1. The owner decision for that gate is not signed.
2. The required evidence package is incomplete.
3. A prerequisite gate is unsigned.
4. A unique index is claimed but not verified.
5. The audit collection is absent or not append-only.
6. No independent verifier is named.
7. The kill switch is not proven off by default.
8. A staging run touched non-disposable data.
9. The output contains a secret, full account number, PIN, or token.
10. The implementation activates V2, adds `orderVersion`/`inventoryMode`, changes Hotel, or alters POS UI.
11. A C2/C3/C4/C5 change is bundled with a C1 deploy.
12. The proposed action would write stock/payment outside the approved primitive.

### 8.2 Global stop conditions

Return to the owner if:

- source behaviour cannot be established;
- required evidence is unavailable;
- a rule would alter accounting or inventory quantities;
- production access is required;
- a user change would be overwritten;
- a business/accounting rule must be chosen;
- a broader architecture decision is required;
- no approver, executor, or verifier is named;
- the scanner cannot be proven read-only.

### 8.3 Hard prohibitions

- No automatic repair.
- No direct `$inc`/`$set` on stock or payment fields.
- No movement/reservation/order/audit deletion.
- No negative-stock clamp.
- No invented correction quantity.
- No payment reversal via inventory recovery.
- No V2 activation.
- No scheduled worker in a C1 deploy.
- No WP-13/WP-09 work under WP-04.
- No gate signature from a design document alone.

---

## 9. Current status

| Gate | Status | Reason |
|---|---|---|
| **G-REC-1** | **UNSIGNED** | R-1 read-only source accepted (2026-11-14); WP04-05 L2 supplementary proof **ACCEPTED — PASS** (2026-11-14) for its disposable scope only; the 2026-11-11 bounded proof’s L2 evidence remains incomplete and overall L2 is not accepted; no L3 staging sample or signed gate package (RC-6). |
| **G-REC-2** | **UNSIGNED** | Schema contract approved (OD-10, 2026-11-14; BLK-SCH-01 CLOSED); model/index not deployed or accepted. |
| **G-REC-3** | **UNSIGNED** | WP-06 worker not implemented or tested. |
| **G-AUD-1** | **UNSIGNED** | WP-07 audit not implemented. |
| **G-GOV-1** | **UNSIGNED** | RACI and names not assigned. |
| G-IDX-1 | UNSIGNED | Index coverage not deployed/verified. |
| G-DB-1 | UNSIGNED | Topology/concern evidence not collected. |
| G-DB-2 | UNSIGNED | Transaction budget/concerns not signed. |
| G-DB-4 | UNSIGNED | Failover/alert proof not executed. |
| G-PAY-1 | **BLOCKED** | No approved isolated staging environment. |
| G-PAY-2 | UNSIGNED | Finance boundary not approved. |

### 9.1 What remains true

- WD-01 … WD-14 are approved at design/policy level (2026-11-08).
- WP-04 design is complete; the R-1 read-only source is accepted, but runtime integration is not authorized and no staging evidence exists.
- No recovery worker, queue, lease, recovery record, or automatic repair exists.
- No stock, payment, accounting, or reservation mutation was performed.
- No database, staging, `.env`, or secret was accessed.
- No existing application source, schema, route, API, index, or runtime configuration was changed; the R-1 read-only scanner source is new and untracked.
- Inventory V2 remains inactive.
- No gate is signed.
- G-REC-1 remains unsigned.
- G-PAY-1 remains blocked.

---

## 10. Change control

1. A gate definition changes only by a new signed owner decision, not by editing this map.
2. A decision changes only by a new version of `wp-04-owner-decision-proposal.md`; the 2026-11-08 approval and any prior signatures remain recorded.
3. A gate signature records: gate, decision version, evidence package hash, signatory, date, and any conditions.
4. A failed gate stops the wave; a later pass does not retroactively waive the failure.
5. A gate signature never authorizes a C5 operation by itself.
6. A C5 enablement requires its own ticket, maintenance window, backup/export reference, and on-call confirmation.
7. No gate may be signed by the same person who executed the evidence without an independent verifier.

### 10.1 Signature record (blank)

| Gate | Decision version | Evidence package hash | Signatory | Date | Conditions |
|---|---|---|---|---|---|
| G-REC-1 | — | — | — | — | — |
| G-REC-2 | — | — | — | — | — |
| G-REC-3 | — | — | — | — | — |
| G-AUD-1 | — | — | — | — | — |
| G-GOV-1 | — | — | — | — | — |

**No gate is signed.** This map records the approved decisions and their gate dependencies, but it signs no gate and authorizes no implementation or recovery.
