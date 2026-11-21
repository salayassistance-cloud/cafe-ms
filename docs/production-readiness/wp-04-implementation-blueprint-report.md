# WP-04 — Implementation Blueprint Report

Status: **DOCUMENTATION AND PLANNING COMPLETE — NO CODE IMPLEMENTED — NO GATE SIGNED**
Date: 2026-11-08
Repository: `C:\hotelms`
Branch: `main`
HEAD: `69650435a6587d4577bc126f719fa1392bb934b3`

> This report records the owner approval of WD-01 through WD-14 and the planning documents produced from it. No application source, schema, collection, index, route, API, script, test, environment variable, or runtime configuration was created or changed. No database, staging, `.env`, `.env.local`, secret, or credential was accessed. No stock, payment, accounting, or reservation record was mutated. Inventory V2 remains inactive. **No gate is signed.** G-REC-1, G-REC-2, G-REC-3, G-AUD-1, and G-GOV-1 remain **UNSIGNED**. G-PAY-1 remains **BLOCKED**.

---

## 1. Task outcome

| Item | Result |
|---|---|
| Owner approval recorded | **WD-01 … WD-14 — APPROVED (recommended defaults, design/policy only)** |
| Implementation blueprint | Created |
| Work-package breakdown | Created |
| Acceptance matrix | Created |
| Code implemented | **None** |
| Database contacted | **None** |
| Gate signed | **None** |
| Inventory V2 activated | **No** |
| WP-13 / WP-09 started | **No** |
| Recommended first package | **WP04-01**, only after **WP04-00** records a separate implementation authorization |

---

## 2. Owner-approved decisions and approval scope

### 2.1 Approval statement

> The owner explicitly approved the recommended defaults for WP-04 decisions WD-01 through WD-14, without amendments or additional notes.

- **Approval date:** 2026-11-08 (as supplied by the execution environment).
- **Scope:** design and policy only.
- **Effect:** the recommended policy is binding on the blueprint; it does not implement, test, deploy, or sign a gate.
- **Recorded in:** `wp-04-owner-decision-proposal.md` §16.

### 2.2 Approved decisions

| ID | Approved policy |
|---|---|
| WD-01 | D01–D10 are the read-only detection vocabulary. |
| WD-02 | No `R9`/`R10` in the first implementation; D02/D09 remain finding codes. |
| WD-03 | Role-placeholder ownership matrix; distinct approver/executor/verifier. |
| WD-04 | Stale `CONSUMING` is alert-only; no task or status change. |
| WD-05 | No age-based hold release; release requires evidence and approval. |
| WD-06 | Shortage is report-only; no correction quantity or valuation. |
| WD-07 | Evidence history is append-only. |
| WD-08 | Lease/retry values remain provisional test inputs. |
| WD-09 | Scheduled worker disabled by default; separate C5 to enable. |
| WD-10 | Mandatory line-level reconciliation deferred; item-level first. |
| WD-11 | Evidence-based legacy cutoff process; no invented date. |
| WD-12 | Verify deployed indexes before relying on uniqueness. |
| WD-13 | External/manual writers must be registered and owned. |
| WD-14 | Gate evidence definitions approved; signatures remain separate. |

### 2.3 Explicit exclusions

The approval does **not** authorize:

1. any code implementation, scanner, classifier, CLI, model, collection, test, or migration;
2. any recovery record, worker, queue, lease, retry loop, cron, scheduler, or public route;
3. any index creation, deletion, or `syncIndexes()`;
4. any stock, payment, accounting, or reservation mutation;
5. any application source, schema, route, API, script, runtime configuration, Hotel, POS UI, or reporting change;
6. any database, staging, production, `.env`, `.env.local`, secret, or credential access;
7. Inventory V2 activation or any `orderVersion`/`inventoryMode` field;
8. WP-13 or WP-09 work;
9. any gate signature, pass, or waiver;
10. any named person, approval/execution/verification assignment, on-call owner, or signatory;
11. any numeric threshold, retention period, lease value, retry count, backoff, jitter, scan window, or cutoff date;
12. any shortage accounting meaning, valuation, write-off, refund, chargeback, or adjustment rule.

### 2.4 Remaining deferred decisions

These remain **DEFERRED / OWNER DECISION REQUIRED** and are not approved by inference:

| Area | Deferred item |
|---|---|
| Shortage | Accounting meaning: accepted loss, receivable, supplier claim, or other (WD-06) |
| Ownership | Named approver, executor, independent verifier, and backups (WD-03) |
| Stale `CONSUMING` | Numeric `W_STALE` threshold (WD-04) |
| Live reservations | Numeric staleness threshold (WD-05) |
| Legacy | Historical cutoff date (WD-11) |
| Retention | Evidence and output retention periods (WD-07, WD-14) |
| Lease/retry | Lease duration, retry count, backoff, jitter, cap (WD-08) |
| Operations | Production scan window and transaction-lifetime limits (WD-04, WD-14) |
| Alerting | Alert sink, on-call ownership, escalation channel, SLA (WD-14) |
| Schema | Exact recovery task fields/enums and evidence collection shape (WD-02, WD-07) |
| Indexes | Index deployment window and changes (WD-12) |
| External writers | Writer inventory, owners, credential classes, audit paths (WD-13) |
| Gates | Gate signatories and sign-off dates (WD-14) |
| Taxonomy | `R9`/`R10` adoption trigger and threshold (WD-02) |
| D06 | Whether D06 may ever create a task or finalize (WD-04) |
| Holds | Whether any terminal-order hold may ever be auto-released (WD-05) |
| Lines | Line-to-item allocation model for any line-attributed correction (WD-10) |
| Worker | Whether a scheduled worker may run, and where (WD-09) |

The full 22-item register is in `wp-04-owner-decision-proposal.md` §16.3.

---

## 3. Files created and modified

`docs/production-readiness/` is entirely untracked at this HEAD, so all document edits are untracked-path changes; no tracked file was touched.

### 3.1 Created (4)

| File | Purpose | Lines | Bytes |
|---|---|---|---|
| `docs/production-readiness/wp-04-implementation-blueprint.md` | Architecture boundaries, layers, lifecycle, rules, packages, gates | 446 | 41,064 |
| `docs/production-readiness/wp-04-implementation-work-packages.md` | WP04-00…WP04-12 with tests, acceptance, rollback, stop conditions | 285 | 24,471 |
| `docs/production-readiness/wp-04-implementation-acceptance-matrix.md` | Gate, package, rule, and cross-cutting acceptance criteria | 204 | 16,085 |
| `docs/production-readiness/wp-04-implementation-blueprint-report.md` | This report | — | — |

### 3.2 Modified (2, both already untracked)

| File | Change |
|---|---|
| `docs/production-readiness/wp-04-owner-decision-proposal.md` | Title/status updated; WD-01…WD-14 marked APPROVED; §16 approval record, scope, exclusions, and 22 deferred items recorded; closing statement updated. |
| `docs/production-readiness/wp-04-gate-dependency-map.md` | Header/status, decision-status note, decision-to-gate map, wave 0, and closing statement updated. Gate states unchanged and still unsigned. |

No other file was edited, moved, renamed, or deleted.

---

## 4. Baseline and final Git status

### 4.1 Baseline (captured before any edit)

| Measure | Value |
|---|---|
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Total entries | **295** |
| Modified (` M`) | **61** |
| Untracked (`??`) | **234** |
| Deleted | **0** |
| Staged | **0** |
| Status file | `%LOCALAPPDATA%\Temp\opencode\wp04-impl-status-before.txt` |
| SHA-256 | `30747325cb74e13b43f9fa727943aa1125760c853e34fba61d2d88ef8e4a4f7f` |

### 4.2 Final (after this report is written)

| Measure | Value |
|---|---|
| Branch | `main` |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` |
| Total entries | **299** |
| Modified (` M`) | **61** |
| Untracked (`??`) | **238** |
| Deleted | **0** |
| Staged | **0** |
| Status file | `%LOCALAPPDATA%\Temp\opencode\wp04-impl-status-after.txt` |
| SHA-256 | `c8ce107d3996a6df9b554e9e4554ab7e8b448b28e1b6fbf68dfe1186be0b97ea` |

### 4.3 Delta

| Measure | Result |
|---|---|
| Added paths | **4** — the four authorized `wp-04-implementation-*.md` documents |
| Removed paths | **0** |
| Unexpected modified paths | **0** — modified count unchanged at 61 |

The expected delta is the four new `wp-04-implementation-*.md` documents and zero removals. This is exactly what was observed.

---

## 5. Preservation proof

The final verification compares the complete baseline status list with the complete final status list (`Compare-Object`). The acceptance condition is:

1. `removedCount = 0` — every one of the 61 modified and 234 pre-existing untracked paths is still present;
2. the only added paths are the four authorized new documents;
3. modified count remains 61, deleted count remains 0, staged count remains 0;
4. branch and HEAD are unchanged.

Baseline and final status snapshots are stored outside the repository. No Git stage, commit, push, deploy, reset, clean, checkout, stash, restore, merge, or rebase was run.

**Actual final verification (2026-11-08):**

| Check | Observed | Required | Result |
|---|---|---|---|
| Branch | `main` | `main` | PASS |
| HEAD | `69650435a6587d4577bc126f719fa1392bb934b3` | unchanged | PASS |
| Removed paths vs baseline | **0** | 0 | PASS |
| Added paths vs baseline | **4** (the authorized implementation docs) | only the 4 authorized | PASS |
| Modified count | **61** | 61 | PASS |
| Deleted count | **0** | 0 | PASS |
| Staged count | **0** | 0 | PASS |

All 61 modified and all 234 pre-existing untracked paths are still present. The only delta is the four new `wp-04-implementation-*.md` documents. No pre-existing user change was overwritten, deleted, or reverted.

---

## 6. Gate status

| Gate | Status | Reason |
|---|---|---|
| **G-REC-1** | **UNSIGNED** | Read-only scanner not implemented; no staging sample. |
| **G-REC-2** | **UNSIGNED** | Recovery schema/index not implemented or deployed. |
| **G-REC-3** | **UNSIGNED** | Worker not implemented or tested. |
| **G-AUD-1** | **UNSIGNED** | Append-only audit not implemented. |
| **G-GOV-1** | **UNSIGNED** | RACI and named roles not assigned. |
| G-IDX-1 | UNSIGNED | Index inventory not collected. |
| G-DB-1 | UNSIGNED | Topology/concern evidence not collected. |
| G-DB-2 | UNSIGNED | Transaction budget not signed. |
| G-DB-4 | UNSIGNED | Failover/alert proof not executed. |
| G-PAY-1 | **BLOCKED** | No approved isolated staging environment. |
| G-PAY-2 | UNSIGNED | Finance boundary not approved. |

The policy approval of WD-01…WD-14 does not change any gate state. No gate is signed or passed.

---

## 7. Recommended first implementation package

**WP04-01 — Rule registry, evidence projection, and fingerprint.**

Conditions:

1. **WP04-00** must first record a separate, explicit implementation authorization (C0/AUTH-0).
2. The authorization must name the reviewer and limit scope to the read-only slice.
3. WP04-01 remains pure JavaScript with no database connection.
4. WP04-02 (classifier) follows only after WP04-01 acceptance.
5. WP04-03 (scanner/CLI) follows after WP04-02; WP04-04 completes the DB-free suite.
6. No recovery-plane package (WP04-07…WP04-10) may start while G-IDX-1, G-REC-2, G-AUD-1, or G-GOV-1 is unsigned.

WP04-01 is the smallest independently reviewable unit: it defines the rule vocabulary and the deterministic evidence identity that every later package depends on, without any runtime write surface.

---

## 8. Explicit statement

- **No code was implemented.**
- **No application source, schema, route, API, index, script, test, or runtime configuration was changed.**
- **No database, staging, production, `.env`, `.env.local`, secret, or credential was accessed.**
- **No stock, payment, accounting, or reservation record was mutated.**
- **No worker, queue, lease, cron, scheduler, or recovery record exists.**
- **No gate is signed. G-REC-1 remains unsigned. G-PAY-1 remains blocked.**
- **Inventory V2 remains inactive.**
- **WP-13 and WP-09 were not started.**
- WP-04 remains **design-only**.

---

## 9. Next step

Stop after documentation and planning. Await a separate owner authorization for **WP04-00**, then a separate implementation authorization for **WP04-01**. Do not begin WP-05, WP-06, WP-07, WP-09, WP-11, WP-12, WP-13, WP-14, WP-16, or WP-17 without their own authorization.