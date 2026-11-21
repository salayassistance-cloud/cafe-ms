# WP-04 — Implementation Acceptance Matrix

Status: **R-1 DB-FREE EVIDENCE ACCEPTED + WP04-05 L2 SUPPLEMENTARY PROOF ACCEPTED (2026-11-14) — STAGING EVIDENCE BLOCKED — NO GATE SIGNED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`
Companions: `wp-04-implementation-blueprint.md`, `wp-04-implementation-work-packages.md`, `wp-04-gate-dependency-map.md`, `wp-04-owner-decision-proposal.md`

> This matrix defines the evidence required to accept each WP-04 package and gate. **No gate is signed. No package is authorized for staging or runtime; AUTH-2 was granted on 2026-11-11 for the bounded WP04-05 disposable proof only.** WD-01…WD-14 are approved at policy level only. R-1 read-only source is present in the working tree and formally accepted (2026-11-14); Package 1 DB-free schema/identity tests pass 11/11 (2026-11-14). No staging or production database was contacted, and no database scan was performed. Inventory V2 remains inactive. G-REC-1, G-REC-2, G-REC-3, G-AUD-1, and G-GOV-1 are **UNSIGNED**; G-PAY-1 is **BLOCKED**.

> **Status reconciliation RC-5 (2026-11-14, documentation only).** The blanket “no criterion met / no code work performed” wording was stale after R-1 acceptance and the Package 1 test run. It is replaced by per-row evidence status below. No gate signature, package authorization, staging access, or database work is created by this correction. **Authorization reconciliation:** AUTH-2 was granted on 2026-11-11 for the bounded WP04-05 disposable proof only; the proof executed 19/19 but its G-REC-1 L2 evidence and owner acceptance are incomplete (see `wp-04-05-disposable-replica-set-proof-report.md` §10).

> **Status reconciliation RC-6 (2026-11-14, documentation only).** The owner has explicitly accepted the **WP04-05 L2 supplementary proof** — **ACCEPTED — PASS** — limited to the completed disposable local authenticated replica-set proof and its submitted evidence (D01–D10 observed on the expected fixture orders; independent verifier `ok: true` with zero violations; before/after document counts, canonical BSON digests, collection inventory, and index inventory unchanged; scanner read-only privilege checks, redaction, and deterministic repeat checks passed; negative controls detected; disposable database and `mongod` process cleaned up). Criteria 5–7 are marked **MET (L2 SUPPLEMENTARY PROOF)** for that accepted scope only. This is **not** overall L2 acceptance, **not** a G-REC-1 signature, and **not** production readiness. Criteria 8, 10 (staging part), 11, and 12 remain open; G-REC-1, G-REC-2, G-REC-3, G-AUD-1, and G-GOV-1 remain **UNSIGNED**; G-PAY-1 remains **BLOCKED**; L3, staging, and production remain unauthorized. The 2026-11-11 bounded persistence proof retains its historical “not accepted as L2” status. See `wp-04-05-disposable-replica-set-proof-report.md` §11.

---

## 1. How to read this matrix

| Status | Meaning |
|---|---|
| **NOT MET** | The criterion has no accepted evidence. |
| **NOT AUTHORIZED** | The package cannot start without a separate authorization, even if the criterion is defined. |
| **BLOCKED** | A prerequisite gate, staging environment, seeding authorization, method approval, or owner decision is absent. |
| **MET (DB-FREE)** | DB-free evidence exists and is accepted; no database or staging proof is implied. |
| **MET (L2 SUPPLEMENTARY PROOF)** | Evidence exists and is owner-accepted only for the 2026-11-14 disposable L2 supplementary proof; overall L2 and gate acceptance are not implied. |
| **PARTIALLY MET** | Some required evidence exists; the remaining evidence is listed and not accepted. |
| **MET (future)** | Full evidence exists, was independently verified, and the gate was signed. No row is in this state. |

Evidence labels follow the design pack: **VERIFIED** (source/git observed), **PROPOSED** (design only), **UNVERIFIED** (needs runtime/owner evidence). No row may be marked MET from a design document.

---

## 2. Gate acceptance matrix

### 2.1 G-REC-1 — Read-only inventory reconciliation available

| # | Criterion | Required evidence | Package | Status |
|---|---|---|---|---|
| 1 | D01–D10 implemented in a rule registry and classifier | Source + registry completeness test | WP04-01/02 | MET (DB-FREE) — R-1 accepted 2026-11-14 |
| 2 | Positive and negative fixture per rule | L1 suite results (C-01…C-40 plus negatives) | WP04-02/04 | MET (DB-FREE) — 290/290 regression incl. WP04-01/03 |
| 3 | Scanner structurally read-only | SC-01…SC-10 source-contract results | WP04-03/04 | MET (DB-FREE) — R-1 source-contract/runtime-isolation review |
| 4 | No write-capable import in the detection graph | Import-graph test | WP04-03/04 | MET (DB-FREE) — runtime-isolation test |
| 5 | Disposable replica-set classification works | L2 results for seeded D01–D10 | WP04-05 | MET (L2 SUPPLEMENTARY PROOF) — accepted 2026-11-14; D01–D10 observed on expected fixture orders |
| 6 | Before/after document counts and hash unchanged | L2 evidence | WP04-05 | MET (L2 SUPPLEMENTARY PROOF) — accepted 2026-11-14; 25/25 documents and canonical BSON digest unchanged |
| 7 | No new collection/index and no V2 collection | L2 collection/index list | WP04-05 | MET (L2 SUPPLEMENTARY PROOF) — accepted 2026-11-14; collection and index inventories unchanged |
| 8 | Staging sample matches manual read-only queries | L3 sample + query text | WP04-06 | BLOCKED |
| 9 | `--apply`/unknown flags refused; exit codes correct | CLI test | WP04-03/04 | MET (DB-FREE) — CLI boundary tests |
| 10 | Output redacted and deterministic | L1 + staging sample | WP04-03/04/06 | PARTIALLY MET — L1 determinism/redaction plus accepted L2 supplementary redaction/determinism checks (2026-11-14); L3 sample pending |
| 11 | No application source, schema, route, or UI change | Diff review | all | PARTIALLY MET — no app/UI/schema diff; final WP04-06 diff review pending |
| 12 | Owner signs report format and retention | Signed review | WP04-06 | BLOCKED (retention deferred) |

**Gate state: UNSIGNED.** The owner accepted the **WP04-05 L2 supplementary proof** on 2026-11-14, so criteria 5–7 are MET for that accepted disposable-proof scope only. Criteria 8, 10 (staging part), 11 (final review), and 12 remain open. Criterion 8 and 12 cannot be met until an approved staging environment and a retention decision exist; the staging counts/hash method remains unapproved at G0-1 (RC-4) and the M-02 seeded-data authorization is unresolved (RC-1). The accepted supplementary proof is **not** overall L2 acceptance and does **not** sign G-REC-1; the 2026-11-11 bounded persistence proof remains not accepted as L2. See `wp-04-05-disposable-replica-set-proof-report.md` §11.

### 2.2 G-REC-2 — Recovery schema and unique open-task index approved and deployed

| # | Criterion | Required evidence | Package | Status |
|---|---|---|---|---|
| 1 | Exact fields/enums approved; exactly seven statuses | Owner-signed schema | WP04-07 | MET (OD-10 approved 2026-11-14; BLK-SCH-01 CLOSED) |
| 2 | No `AWAITING_APPROVAL` or invented status | Schema test | WP04-07 | MET (Package 1 schema-contract 11/11, 2026-11-14) |
| 3 | Unique `taskId` deployed | Index dump | WP04-07/12 | NOT MET |
| 4 | Unique partial open task per order deployed | Index dump + duplicate test | WP04-07/12 | NOT MET |
| 5 | One open task per order under concurrency | Disposable proof | WP04-07 | NOT MET |
| 6 | Closed/cancelled history retained | Disposable proof | WP04-07 | NOT MET |
| 7 | No TTL | Index review | WP04-07 | NOT MET |
| 8 | No V2 collection/field | Source + index review | WP04-07 | NOT MET |
| 9 | G-IDX-1 evidence exists before uniqueness reliance | Index inventory | WP04-12 | NOT MET |
| 10 | Retention approved | Owner/finance signature | WP04-11 | NOT MET (deferred D-06) |

**Gate state: UNSIGNED.** Schema contract approved (OD-10); blocked by G-IDX-1 deployment, disposable proofs, and retention.

### 2.3 G-REC-3 — Worker lease/retry/audit/escalation proven

| # | Criterion | Required evidence | Package | Status |
|---|---|---|---|---|
| 1 | Two workers → one lease winner | L2 race test | WP04-09 | NOT MET |
| 2 | Lease expiry/reclaim with new token | L2 test | WP04-09 | NOT MET |
| 3 | Crash before/after action → no duplicate effect | L2 crash test | WP04-09 | NOT MET |
| 4 | Unknown commit: present/absent/contradictory handled | L2 test | WP04-09 | NOT MET |
| 5 | R2 idempotent consumption; R4 status-only finalize | L2 test | WP04-10 | NOT MET |
| 6 | Manual classes escalate; worker cannot approve/verify | Test | WP04-10 | NOT MET |
| 7 | Kill switch off by default; no public route; explicit identity | CLI/source/staging | WP04-10 | NOT MET |
| 8 | Audit failure aborts the action | Test | WP04-08/10 | NOT MET |
| 9 | Staging `--once` run with measured duration | L3 evidence | WP04-10 | BLOCKED |
| 10 | G-REC-2, G-AUD-1, G-GOV-1, G-DB-2/4 signed | Gate records | dependencies | NOT MET |

**Gate state: UNSIGNED.** Blocked by every prerequisite gate and by staging.

### 2.4 G-AUD-1 — Append-only audit available and tested

| # | Criterion | Required evidence | Package | Status |
|---|---|---|---|---|
| 1 | Insert-only evidence/audit API | Source + test | WP04-08 | NOT MET |
| 2 | No update/delete export or route | Source test | WP04-08 | NOT MET |
| 3 | Required fields present | Test | WP04-08 | NOT MET |
| 4 | Redaction proven | Test | WP04-08 | NOT MET |
| 5 | Unique event id | Disposable test | WP04-08 | NOT MET |
| 6 | Query by domain/order/task | Disposable test | WP04-08 | NOT MET |
| 7 | Audit failure aborts the guarded action | Test | WP04-08/10 | NOT MET |
| 8 | Retention approved | Owner/finance signature | WP04-11 | NOT MET (deferred D-06) |

**Gate state: UNSIGNED.**

### 2.5 G-GOV-1 — RACI, dual control, independent verification

| # | Criterion | Required evidence | Package | Status |
|---|---|---|---|---|
| 1 | Named approver, executor, verifier, backups per class | Signed RACI | WP04-11 | NOT MET (names deferred D-02) |
| 2 | Distinctness enforced in task/audit | Test | WP04-09/10 | NOT MET |
| 3 | Worker cannot approve | Test | WP04-09/10 | NOT MET |
| 4 | Escalation channel and SLA | Signed runbook | WP04-11 | NOT MET (deferred D-09) |
| 5 | Retention policy | Signed policy | WP04-11 | NOT MET (deferred D-06) |
| 6 | On-call named | Operations evidence | WP04-11 | NOT MET (deferred D-09) |

**Gate state: UNSIGNED.**

### 2.6 G-PAY-1 — Payment identity freeze proven on approved staging

| # | Criterion | Required evidence | Status |
|---|---|---|---|
| 1 | Approved isolated staging environment | Environment approval record | **BLOCKED** |
| 2 | Payment identity freeze exercised on staging | Staging evidence | **BLOCKED** |
| 3 | No inventory shortcut used to bypass payment staging | Review | **BLOCKED** |
| 4 | G-PAY-1 signature | Signed gate | **BLOCKED** |

**Gate state: BLOCKED.** WP-04 does not accept or bypass G-PAY-1.

---

## 3. Package acceptance matrix

| Package | Acceptance criteria | Required tests | Authorization | Status |
|---|---|---|---|---|
| **WP04-00** | Baseline matches; reviewer named; C1 scope recorded; deferred list restated | Status fingerprint check | AUTH-0 owner | NOT AUTHORIZED |
| **WP04-01** | Registry complete D01–D10; projection redacted; fingerprint deterministic | Registry, projection, FP-01…FP-08 | AUTH-1 | NOT AUTHORIZED / NOT MET |
| **WP04-02** | All rules classify; no auto action; output schema valid | C-01…C-40, dedupe, negative fixtures | AUTH-1 | NOT AUTHORIZED / NOT MET |
| **WP04-03** | Scanner read-only; CLI refusals; deterministic redacted output | SC-01…SC-10, OR-01…OR-08, L2 read-only | AUTH-1 (L2 AUTH-2) | NOT AUTHORIZED / NOT MET |
| **WP04-04** | Additive suite passes; baseline 0 fail/skip; no DB | Full DB-free suite | AUTH-1 | NOT AUTHORIZED / NOT MET |
| **WP04-05** | Seeded classes detected; zero mutation; index present/absent | IX-01…IX-05, before/after hash | AUTH-2 | AUTHORIZED (bounded proof, 2026-11-11) / EXECUTED 19/19 / L2 SUPPLEMENTARY PROOF ACCEPTED — PASS (2026-11-14) / OVERALL L2 NOT ACCEPTED |
| **WP04-06** | Staging sample matches; redaction; owner review | M-01…M-12 | AUTH-5 | BLOCKED — staging + M-02 seeding/hash approvals (WP04-05 L2 supplementary proof accepted 2026-11-14; overall L2/G-REC-1 still open) |
| **WP04-07** | Seven statuses; one open task; no TTL; no V2 | Schema + L2 convergence | AUTH-4 | NOT AUTHORIZED / NOT MET |
| **WP04-08** | Append-only; fail-closed; no delete/update | Insert/query/abort tests | AUTH-4 | NOT AUTHORIZED / NOT MET |
| **WP04-09** | One lease winner; expiry/reclaim; unknown commit; no duplicate | L1 + L2 race/crash | AUTH-4 | NOT AUTHORIZED / NOT MET |
| **WP04-10** | Worker off by default; R2/R4 only; manual escalates; audit aborts | L1 + L2 + staging `--once` | AUTH-5 | BLOCKED |
| **WP04-11** | Signed RACI/backups/SLA/retention/on-call | Tabletop + signed records | AUTH-0 | NOT AUTHORIZED / NOT MET |
| **WP04-12** | Exact index inventory; no URI/secret; no index write | Disposable index-present/absent | AUTH-3 | NOT AUTHORIZED / NOT MET |

No package row may move to MET without its own evidence package and an independent review.

---

## 4. Detection rule acceptance matrix

| Rule | Positive fixture | Negative fixture | Expected severity/confidence | Status |
|---|---|---|---|---|
| **D01** | `PAID` + `RELEASED(CONSUMPTION_FAILED)` + no movement; `PAID` + live hold; `PAID` + missing item evidence | Clean consumption; legacy deduction; approved shortage; inventory-free order | Critical/High–Medium | NOT IMPLEMENTED |
| **D02** | `CANCELLED` + sale deduction + no void; orphan deduction | `PREPARING` deduction without payment; valid void/reclassification | High–Critical/Medium–High | NOT IMPLEMENTED |
| **D03** | Two `(order,item,SaleDeduction)` rows; duplicate `sale:` key | One reclassified `Waste` row; distinct `Correction` rows | Critical/High | NOT IMPLEMENTED |
| **D04** | Two reservations; orphan; `RELEASED` with hold; `APPROVED` without approval | `NO_INVENTORY` zero items; valid approval | Critical–High/High–Medium | NOT IMPLEMENTED |
| **D05** | Hold on terminal order; paid with live hold; stale live hold | Zero-hold `NO_INVENTORY`; release already in flight | High–Medium/High–Medium | NOT IMPLEMENTED |
| **D06** | Stale `CONSUMING` with complete/partial/absent movements | Age below threshold; voided/waste movement | Critical–High/High | NOT IMPLEMENTED |
| **D07** | Consumed quantity mismatch; movement without reservation item; station partial | Whole order consumed at first station; approved shortage | High–Critical/High–Medium | NOT IMPLEMENTED |
| **D08** | Whole cancel after consumption; hold remains; line cancel no void | `ARCHIVE` source; shared item with active line | High–Medium/High–Medium | NOT IMPLEMENTED |
| **D09** | `PAYMENT_PENDING` + `paidAt`; paid transfer without account; prepared with live hold | Normal post-prep payment pending; rejected payment with consumed stock | Critical–High/Medium–High | NOT IMPLEMENTED |
| **D10** | Unknown enum; negative quantity; out-of-range; missing ref; drift; E0/E1 | Absent optional legacy field; transient mid-transaction state | High–Critical/High–Medium | NOT IMPLEMENTED |

Every negative fixture must prove the rule does **not** fire. A rule that cannot suppress a legitimate lifecycle is not accepted.

---

## 5. Cross-cutting acceptance criteria

| # | Criterion | Evidence | Status |
|---|---|---|---|
| X-01 | Detection plane cannot write | Source-contract + import-graph + before/after hash | NOT MET |
| X-02 | No V2 collection read/write/created; no `orderVersion`/`inventoryMode` | Source scan + L2 collection list | NOT MET |
| X-03 | No payment identity change after `PAID` | Source/action-map review | NOT MET |
| X-04 | No direct `$inc`/`$set` on stock or payment fields | Source test | NOT MET |
| X-05 | No deletion of movement/reservation/order/void/audit | Source test + review | NOT MET |
| X-06 | No negative-stock clamp | Source test | NOT MET |
| X-07 | No invented correction quantity | Classifier review + fixtures | NOT MET |
| X-08 | No combined payment+inventory transaction | Action-map review | NOT MET |
| X-09 | Output deterministic and redacted | L1 + staging sample | NOT MET |
| X-10 | No `.env`/`.env.local`/secret read | Test + review | NOT MET |
| X-11 | No index creation/drop/sync by WP-04 | CLI/source test | NOT MET |
| X-12 | No worker/queue/cron/scheduler/public route enabled | Source + staging review | NOT MET |
| X-13 | Existing tests not weakened; baseline passes | Full suite | NOT MET |
| X-14 | Pre-existing modified/untracked paths preserved | Before/after status comparison | NOT MET (this task preserves them; package evidence still required) |
| X-15 | No gate is signed by this matrix | Review | MET only in the sense that no gate is signed; no acceptance evidence exists |

---

## 6. Criteria that cannot be marked MET yet

| Criterion | Why blocked | Deferred item |
|---|---|---|
| Numeric `W_STALE` behaviour | No measured transaction lifetime | D-03 |
| Numeric live-hold staleness | No measured hold lifetime | D-04 |
| Legacy cutoff classification | No cutoff date or boundary sample | D-05 |
| Retention pass | No retention period approved | D-06 |
| Lease/retry numeric pass | Values are provisional, untested in production | D-07 |
| Production scan window | No approved window | D-08 |
| Alert routing/on-call | No sink or on-call owner | D-09 |
| Recovery schema acceptance | Exact fields unapproved | D-10 |
| Evidence collection acceptance | Shape unapproved | D-11 |
| G-IDX-1 acceptance | No index inventory | D-12 |
| External-writer coverage | No register | D-13 |
| RACI acceptance | No names/backups | D-02 |
| G-PAY-1 | No approved staging | — |
| D06 task creation | Alert-only policy | D-16 |
| Automatic hold release | Prohibited until approved | D-17 |
| Line-attributed correction | No allocation model | D-18 |
| Worker schedule | C5 not authorized | D-19 |

No deferred item is converted into an acceptance pass by inference.

---

## 7. Traceability matrix

| Decision | Blueprint section | Work package | Gate | Acceptance section |
|---|---|---|---|---|
| WD-01 | §5 | WP04-01…04 | G-REC-1 | §2.1, §4 |
| WD-02 | §5.4 | WP04-02, WP04-07 | G-REC-2 | §2.2, §4 |
| WD-03 | §8 | WP04-11 | G-GOV-1 | §2.5 |
| WD-04 | §5.7 | WP04-02 | G-REC-1, G-REC-3 | §2.1, §2.3, §4 |
| WD-05 | §5.8 | WP04-02 | G-REC-3, G-GOV-1 | §2.3, §2.5, §4 |
| WD-06 | §5.9 | WP04-02 | G-REC-2, G-PAY-2 | §4, §6 |
| WD-07 | §4.8 | WP04-08 | G-AUD-1, G-REC-2 | §2.2, §2.4 |
| WD-08 | §4.4–4.6 | WP04-09 | G-REC-3 | §2.3 |
| WD-09 | §4.9 | WP04-10 | G-REC-3 | §2.3, §5 |
| WD-10 | §5.6 | WP04-02 | G-REC-1 | §4 |
| WD-11 | §5.5 | WP04-02 | G-REC-1 | §4, §6 |
| WD-12 | §5.10 | WP04-12, WP04-07 | G-IDX-1, G-REC-2 | §2.2, §6 |
| WD-13 | §8.4 | WP04-11 | G-GOV-1, G-DB-1 | §2.5 |
| WD-14 | §7 | all | all recovery gates | §2 |

---

## 8. Current status summary

| Item | State |
|---|---|
| Owner decisions WD-01…WD-14 | **APPROVED (policy only, 2026-11-08)** |
| Implementation packages | **NO STAGING/RUNTIME PACKAGE AUTHORIZED; WP04-05 BOUNDED PROOF AUTHORIZED + EXECUTED 2026-11-11; L2 SUPPLEMENTARY PROOF ACCEPTED — PASS 2026-11-14 (OVERALL L2 NOT ACCEPTED)** |
| Detection/scanner code | **R-1 READ-ONLY SOURCE ACCEPTED (UNTRACKED); RUNTIME NOT WIRED** |
| Recovery schema/worker | **SCHEMA CONTRACT APPROVED (OD-10); MODEL/INDEX NOT DEPLOYED; NO WORKER** |
| Append-only audit | **NOT IMPLEMENTED** |
| Gates G-REC-1/2/3, G-AUD-1, G-GOV-1 | **UNSIGNED** |
| G-PAY-1 | **BLOCKED** |
| Inventory V2 | **INACTIVE** |
| Database/staging access | **NONE** |

**No gate in this matrix is accepted.** DB-free rows marked `MET (DB-FREE)` are accepted only for their stated proof scope. Rows marked `MET (L2 SUPPLEMENTARY PROOF)` are accepted only for the 2026-11-14 disposable L2 supplementary proof and do not constitute overall L2 or gate acceptance. A criterion becomes gate-MET only with all listed evidence, an independent review, and — for a gate — a separate signature by the accountable role.

---

## 9. Closing statement

This matrix is a control artifact. It records accepted DB-free evidence and the accepted 2026-11-14 WP04-05 L2 supplementary proof, but does not implement, deploy, sign a gate, authorize overall L2, or authorize staging.

**WP-04 design is complete; the R-1 read-only source is accepted; the WP04-05 L2 supplementary proof is accepted for its limited disposable scope. No gate is signed. G-REC-1 remains unsigned. G-PAY-1 remains blocked. L3/staging/production remain unauthorized. Inventory V2 remains inactive.**
This matrix task contacted no database and created or changed no application source, schema, route, API, index, script, test, or runtime configuration. The R-1 source exists separately under its own accepted authorization.