# BONO POS / Hotel - Production Release Roadmap

**Status:** PROPOSED - requires owner approval
**Date:** 2026-11-07
**Branch:** `main`
**HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3`
**Basis:** `phase-2-1-owner-decision-matrix.md` and `phase-2-1-production-gap-assessment.md`
**Implementation authorization:** None. This roadmap proposes sequencing only.

---

## 1. Executive summary

BONO is not ready for a production release today. The codebase has strong domain logic and a large DB-free regression suite, but the release controls that decide production safety are missing or unverified: real MongoDB topology and transactions, backups and restore, CI, health checks, monitoring, secret provisioning, and rollback.

This roadmap separates three release tracks so they cannot accidentally ship together:

1. **POS V1** - the current order/payment/station/reporting system. This is the first release candidate, and it needs security and reliability hardening.
2. **Inventory V2** - design-complete, not wired. It activates only after the ten owner decisions are approved and a shadow/dual-read period passes.
3. **Hotel** - explicitly not production-ready. It runs as a separate track with its own provisioning, index deployment, integration tests, UI, and operations.

The proposed next phase, **Phase 2.2**, is a POS V1 hardening phase. It does **not** wire V2, does **not** add `orderVersion` or `inventoryMode`, and does **not** change station, payment, or stock-deduction behavior. V2 work starts only after Phase 2.2 and Phase 2.3 pass their gates.

**Proposed first production release:** POS V1 only, after Gates 0-5. Hotel and Inventory V2 remain out of scope for that release.

---

## 2. Current state

| Area | State | Evidence |
|---|---|---|
| POS order lifecycle, stations, reports | Working; 1291 DB-free tests pass | Test run; `lib/orderService.js`; `lib/reportRevenueBreakdown.js` |
| V1 inventory | Working logic; transaction-dependent; best-effort failure handling | `lib/inventoryReservationService.js`; `lib/orderService.js:235-246` |
| Inventory V2 | Domain + server foundations only; no live route | `lib/inventory-v2/**`; Phase 2.0 doc |
| Hotel | Backend foundation; not production-ready; indexes not deployed | `docs/hotel-foundation.md:11-14` |
| CI | Absent | No `.github/` |
| Backups/restore | No evidence in repo | Repository search |
| Monitoring/health | Absent | No health route; `instrumentation.js` warms DB only |
| Staging/rollback | No documented environment or runbook | Repository search |
| Secrets validation | No boot-time check | `lib/mongodb.js:4`; `lib/sessionCrypto.js:9` |

---

## 3. Release tracks and dependency graph

```
Track A - POS V1 (first release)
  Phase 2.1  Decision closure + gap assessment        [DONE - awaiting owner]
      |
  Phase 2.2  Security + reliability hardening          [PROPOSED NEXT]
      |
  Phase 2.3  Staging validation + release rehearsal
      |
  Phase 2.4  Production release (POS V1) + post-release review

Track B - Inventory V2 (after POS V1 is stable)
  Phase 2.4  V2 activation prerequisites (D1-D9)
      |
  Phase 2.5  V2 shadow / dual-read pilot
      |
  Phase 2.6  V2 cutover (D9, D10) - only if parity and audit pass

Track C - Hotel (independent)
  Phase H1   Provisioning + index deployment + integration tests
      |
  Phase H2   UI completion + operational runbook
      |
  Phase H3   Hotel production release
```

Tracks may run in parallel only where they do not share mutable code paths. Track B must not start until Track A's Phase 2.2 and Phase 2.3 are complete, because V2 depends on the same auth, index, transaction, and monitoring controls.

---

## 4. Phase 2.2 - POS V1 security and reliability hardening (proposed)

**Goal:** close the critical and high gaps that do not require V2 wiring, and make the system observable and recoverable.

**Entry criteria:**

- Owner has reviewed and recorded decisions D1-D10 (approve, approve with conditions, reject, or defer).
- Baseline `main` / `69650435a6587d4577bc126f719fa1392bb934b3` is confirmed and existing user work is preserved.
- A disposable MongoDB replica set (or mongos) is available for integration tests.
- A staging environment exists or is scheduled.

**In scope:**

1. **Credential hardening**
   - Remove shared/default role PIN fallbacks from the production path.
   - Require per-user Manager credentials; define the scope of a Manager reset.
   - Remove plaintext PIN logging from seed/reset scripts.
   - Add per-account lockout/backoff for PIN verification.
   - Force rotation for any account still using a default PIN.
2. **Payment-info access control**
   - Require authentication for the full payment-info read, or expose only the fields needed for a specific payment flow.
   - Do not return inactive accounts to unauthenticated callers.
3. **Index safety**
   - Remove `syncIndexes()` from the connection/request path.
   - Make index deployment an explicit, guarded operation with a dry run and an audit record.
   - Document the current production index inventory.
4. **Configuration validation**
   - Fail fast at boot when `MONGODB_URI`, `AUTH_SECRET`, or required Hotel keys are missing or invalid.
   - Never log secret values.
5. **CI and integration tests**
   - CI runs the full DB-free suite on every change.
   - A disposable MongoDB replica-set job runs transaction, index, concurrency, idempotency, and clear-orders tests.
   - Build artifact is the artifact that is promoted.
6. **Observability**
   - Add `/api/health` with liveness and readiness (DB reachability).
   - Add structured logs with request/correlation IDs.
   - Add at least one alert path for 5xx rate, DB 503s, inventory-hook failures, and transaction failures.
7. **Backup and restore**
   - Document RTO/RPO and the backup schedule.
   - Complete a restore drill into a disposable environment.
   - Record the restore evidence.
8. **Destructive reset safety**
   - Add dual control (second approver) and a pre-reset export/snapshot to `clear-orders`.
   - Add a dry-run count and an audit record.
   - Do not add V2 awareness yet; instead, document that `clear-orders` is V1-only and must be disabled before V2 activation.
9. **Inventory failure visibility**
   - Replace silent best-effort swallowing with a durable failure record and an operator-visible status.
   - Add a read-only `reservedStock` reconciliation report (no repair yet).
10. **Documentation**
    - Correct the README "production-ready" claim.
    - Publish the release checklist, rollback runbook, and incident response owner.

**Out of scope (explicit):**

- Adding `orderVersion` or `inventoryMode`.
- Wiring V2 into any live route, POS flow, or station flow.
- Changing payment or stock-deduction semantics.
- Executing V2 or Hotel index deployment.
- Connecting to production or development MongoDB.
- Changing Hotel, POS, or station workflows.
- Installing `server-only` (deferred to Phase 2.4, before V2 wiring).
- Data migration of any kind.

**Exit criteria (Gate 2):**

- All in-scope items merged and reviewed.
- CI green, including the disposable-MongoDB integration job.
- Staging deploy succeeds and `/api/health` reports ready.
- Restore drill evidence recorded.
- Rollback drill evidence recorded.
- No change to V1 payment, stock-deduction, or station behavior beyond the safety controls above.
- Owner signs the Phase 2.2 exit review.

---

## 5. Phase 2.3 - Staging validation and release rehearsal

**Goal:** prove the release candidate behaves correctly in a production-like environment before touching production.

**Entry criteria:** Gate 2 passed.

**Work:**

1. Deploy the release candidate to staging with production-like configuration and a disposable database.
2. Run the full functional matrix:
   - Waiter order creation, line cancellation, whole-order cancellation.
   - Kitchen, Barista, and Jebena Buna preparation, ready, and serve.
   - Cashier payment, transfer payment, payment verification, void/refund path.
   - Manager approval queue, shortage approval, reason/fingerprint validation.
   - Reports and revenue totals, including hot drink.
   - Inventory reservation, consumption, release, waste, receive, low-stock alerts.
   - Auth: login, logout, session expiry, revocation, PIN reset, role permissions.
   - Hotel smoke test only if the Hotel track is included (it is not, by default).
3. Run the security matrix:
   - Unauthenticated and wrong-role access to every mutating route.
   - Origin/CSRF checks.
   - Rate-limit behavior.
   - Session fixation/revocation.
   - Payment-info exposure.
4. Run the load test:
   - Concurrent order creation and station updates.
   - SSE fan-out and reconnect.
   - Report query latency.
5. Run the failure drills:
   - Database failover during a transaction.
   - Unknown commit result.
   - Index deployment failure.
   - Restore from backup.
   - Rollback to the previous release.
6. Record all evidence (commands, timestamps, results, screenshots where appropriate).

**Exit criteria (Gate 3):**

- Every matrix item passes or has an owner-accepted exception.
- No critical/high defect remains open.
- Restore and rollback drills pass within the documented RTO.
- Owner and operations sign the release rehearsal.

---

## 6. Phase 2.4 - POS V1 production release

**Entry criteria:** Gate 3 passed; change ticket approved; maintenance window scheduled if needed.

**Release steps:**

1. Freeze code and tag the release candidate.
2. Verify the production environment configuration by key name only (never print values).
3. Confirm the production MongoDB topology is a replica set or mongos.
4. Confirm backups are current and the restore path is known.
5. Deploy the artifact that passed staging.
6. Run post-deploy smoke tests:
   - `/api/health` ready.
   - Login/logout for each role.
   - One order through each station.
   - One payment and one report.
   - One inventory reservation/consumption.
7. Monitor the alert path for the agreed observation window.
8. Record the release evidence and the exact artifact/commit.

**Rollback criteria:**

- Health check fails for more than the agreed threshold.
- 5xx or DB 503 rate exceeds the agreed threshold.
- A payment or stock-deduction defect is observed.
- A security regression is observed.

**Rollback procedure:**

- Re-deploy the previous known-good artifact.
- Do not run destructive database rollback unless the release included a migration; if it did, follow the migration-specific rollback plan.
- Preserve logs and the failure state for review.
- Open an incident record and schedule a post-incident review.

**Exit criteria (Gate 4):**

- Smoke tests pass.
- No rollback trigger occurred during the observation window.
- Owner signs the production release.
- Post-release review scheduled.

---

## 7. Phase 2.4 (Track B) - Inventory V2 activation prerequisites

This phase starts only after POS V1 is stable. It implements the owner-approved decisions D1-D9. It does not yet cut over payments or reporting.

**Work packages:**

| WP | Scope | Depends on |
|---|---|---|
| B1 | Adopt `server-only` and add build-time boundary checks (D1) | Gate 2 |
| B2 | Verify replica-set/mongos topology and transaction budget (D3) | Gate 2 |
| B3 | Deploy V2 indexes to disposable, then staging, then production (D2) | B2 |
| B4 | Add `inventoryMode` (server-assigned, immutable, default `V1`) and backfill (D7) | B3 |
| B5 | Add `orderVersion` to every order writer, with conditional filters (D10 prerequisite) | B4 |
| B6 | Implement the V2-aware `clear-orders` guard/refusal (D8) | B4 |
| B7 | Build the read-only `reservedStock` reconciliation report and repair runbook (D6) | B4 |
| B8 | Define and rehearse the V1 drain procedure (D5) | B3, B7 |
| B9 | Define retention/archive for `inventoryreservations` (D4) | Owner policy |
| B10 | Define dual-read reporting and cutover criteria (D9) | B5, B7 |

**Exit criteria (Gate 5):**

- All V2 indexes match the plan on staging.
- `inventoryMode` and `orderVersion` are present on new and legacy orders with a verified backfill.
- The `clear-orders` guard refuses correctly.
- The reconciliation report shows zero unexplained variance on staging.
- The drain procedure is rehearsed and signed.
- Dual-read parity is defined and instrumented.
- No V2 route is wired to live payment or stock deduction.

---

## 8. Phase 2.5 - V2 shadow / dual-read pilot

**Goal:** run V2 logic alongside V1 without letting it mutate live financial or stock state.

**Work:**

1. Shadow-compute V2 allocations and approvals for a sample of orders.
2. Compare V1 and V2 reservation, consumption, and revenue outcomes.
3. Run the dual-read report for the approved window (proposed 30 days or two monthly closes).
4. Track every variance by order, item, and stage.
5. Resolve or explain every variance; no unexplained variance may remain.

**Exit criteria (Gate 6):**

- Zero unexplained variance for the full window.
- Reconciliation clean for the full window.
- Audit events complete for every shadow decision.
- Independent audit (D10) scheduled or complete.
- Owner and finance sign the pilot review.

---

## 9. Phase 2.6 - V2 cutover (conditional)

**Entry criteria:** Gate 6 passed; D10 prerequisites and independent audit complete.

**Work:**

1. Drain V1 holds using the approved procedure.
2. Switch `inventoryMode` assignment for new orders.
3. Enable V2 payment/inventory integration behind the approved flag.
4. Keep V1 read-only reporting available for dispute resolution.
5. Monitor reconciliation, revenue parity, and audit completeness.
6. Roll back to V1 if any rollback criterion is met.

**Rollback criteria:**

- Any unexplained revenue or stock variance.
- Any double charge or double deduction.
- Any approval/evidence integrity failure.
- Any reconciliation drift above zero tolerance.

---

## 10. Track C - Hotel release (independent)

Hotel must not be bundled with the POS release. Its minimum path is:

1. Provision `ROOM_MONGODB_URI` and `HOTEL_SESSION_SECRET` with least-privilege credentials.
2. Create the first Manager with the documented provisioning command; never transmit a plaintext PIN.
3. Deploy Hotel indexes with `scripts/hotel-deploy-indexes.mjs` under its own approval gate.
4. Run live integration tests against a disposable Hotel database.
5. Complete the Hotel UI beyond Reception, or explicitly scope it out.
6. Document guest/reservation/payment operations and retention.
7. Run a Hotel-only release rehearsal and rollback drill.

Hotel is production-ready only when those steps are evidenced, not when the POS release passes.

---

## 11. Test requirements by gate

| Gate | Required tests | Environment |
|---|---|---|
| Gate 0 (decisions) | Document review; no code test | N/A |
| Gate 2 (hardening) | Full DB-free suite; CI build; authz matrix; secret-validation tests; payment-info auth tests; index-deployment dry run; health endpoint tests | CI + disposable DB |
| Gate 3 (staging) | Functional matrix; security matrix; load test; failover; unknown commit; restore; rollback | Staging + disposable DB |
| Gate 4 (POS release) | Post-deploy smoke; observation-window checks | Production |
| Gate 5 (V2 prerequisites) | Index plan; `inventoryMode`; `orderVersion`; clear-orders guard; reconciliation; drain rehearsal | Disposable + staging |
| Gate 6 (V2 pilot) | Dual-read parity; shadow allocation; audit completeness; independent audit | Staging + production shadow |
| Hotel gates | Hotel auth; provisioning; index deployment; reservation/check-in/out/folio; restore | Disposable Hotel DB + staging |

**Mandatory real-database tests (currently missing):**

- Transaction commit, abort, retry, and unknown-commit resolution.
- Unique index enforcement and duplicate preflight.
- Concurrent order mutation and stock deduction.
- `clear-orders` guard behavior.
- `reservedStock` reconciliation under mixed V1/V2 holds.
- Backup restore and point-in-time recovery (within provider capability).

---

## 12. Migration requirements

1. **No destructive migration without a verified backup and a rollback plan.**
2. Every migration must be:
   - idempotent,
   - dry-runnable,
   - guarded by an explicit confirmation and environment marker,
   - audited (who, when, target, result),
   - reversible or paired with a restore procedure.
3. **`inventoryMode`**: additive field, default `V1`, backfill legacy orders, immutable after creation. No client input.
4. **`orderVersion`**: additive field, initialised in the same write that creates the order, incremented atomically by every mutation, and used in conditional filters.
5. **V2 indexes**: deployed only through the guarded script, after a duplicate preflight, in the order disposable -> staging -> production.
6. **Hotel indexes**: deployed only through the Hotel script, with its own approval reference and `bono_hotel` database check.
7. **`inventoryreservations`**: retained as historical/audit data; archive only under an approved retention policy; never rewritten into V2 allocations.
8. **No `syncIndexes()` in the request/connection path** after Phase 2.2.

---

## 13. Approval gates

| Gate | Name | Approver(s) | Required artifact | Blocks |
|---|---|---|---|---|
| G0 | Decision closure | Owner | Signed D1-D10 record | Phase 2.2 start |
| G1 | Hardening scope | Owner + engineering | Approved Phase 2.2 scope and change ticket | Implementation |
| G2 | Hardening exit | Owner + engineering + operations | CI/staging/restore/rollback evidence | Phase 2.3 |
| G3 | Release rehearsal | Owner + operations + finance | Staging matrix, load, failover, restore evidence | Production release |
| G4 | POS production release | Owner | Signed release record and observation-window result | Post-release review |
| G5 | V2 prerequisites | Owner + architecture + DBA | Index, `inventoryMode`, `orderVersion`, reconciliation, drain evidence | V2 pilot |
| G6 | V2 pilot exit | Owner + finance + independent auditor | Zero-variance parity report and audit report | V2 cutover |
| G7 | V2 cutover | Owner + finance | Signed cutover and rollback plan | V2 production |
| GH1 | Hotel provisioning | Owner + operations | Provisioning and index evidence | Hotel staging |
| GH2 | Hotel release | Owner + operations | Hotel integration and rollback evidence | Hotel production |

No gate may be self-approved by the implementer. Financial gates (G3, G6, G7) require finance review. The V2 payment gate (G6/G7) requires an independent auditor who did not implement the feature.

---

## 14. Proposed Phase 2.2 scope (decision requested)

**Recommendation:** authorize Phase 2.2 as a **POS V1 hardening phase only**.

**Deliverables:**

1. Owner decision record for D1-D10.
2. Credential hardening (C1, H9).
3. Payment-info access control (C2).
4. Index-safety change (C3).
5. Boot-time configuration validation (H6).
6. CI + disposable-MongoDB integration job (C5).
7. Health endpoint + structured logs + basic alerts (C6).
8. Backup/restore runbook and drill (C4).
9. `clear-orders` dual control and pre-reset snapshot (C7).
10. Inventory-failure visibility and read-only reconciliation report (C8, D6 partial).
11. Release checklist, rollback runbook, incident owner (H7, M6).
12. Documentation correction (M8).

**Explicitly excluded from Phase 2.2:**

- `server-only` adoption (D1) - Phase 2.4, before V2 wiring.
- V2 index deployment (D2) - Phase 2.4.
- `inventoryMode` (D7) and `orderVersion` - Phase 2.4.
- V2-aware `clear-orders` (D8) - Phase 2.4.
- V1 drain (D5) and V2 reconciliation repair (D6) - Phase 2.4.
- V1/V2 dual-read (D9) - Phase 2.5.
- Payment/inventory integration and independent audit (D10) - Phase 2.6.
- Any Hotel, POS, or station workflow change.
- Any production database access or deployment.

**Why this scope:** it closes the gaps that block the current POS release without touching the V1 behavior the owner asked to protect. It also creates the controls (CI, health, backups, topology evidence, index safety) that every later V2 and Hotel gate depends on.

---

## 15. Definition of production-ready (POS V1)

POS V1 may be called production-ready only when all of the following are evidenced:

- [ ] Owner-signed decision record for D1-D10.
- [ ] No default/shared production credentials; per-user Manager PIN; lockout active.
- [ ] Payment-info access is authenticated or intentionally scoped.
- [ ] No `syncIndexes()` on the connection path; index inventory documented.
- [ ] Boot-time configuration validation passes in staging and production.
- [ ] CI runs the full suite and a disposable-MongoDB integration job.
- [ ] `/api/health` is live and monitored.
- [ ] Backups are configured and a restore drill has passed.
- [ ] Rollback drill has passed.
- [ ] `clear-orders` has dual control and a pre-reset snapshot.
- [ ] Inventory failures are visible and reconcilable.
- [ ] Staging functional, security, and load matrices pass.
- [ ] No open critical/high defect.
- [ ] Release and rollback evidence is recorded.

Inventory V2 and Hotel are **not** covered by this definition and require their own gates.

---

## 16. Risks to the roadmap

| Risk | Impact | Mitigation |
|---|---|---|
| Owner defers decisions | Phase 2.2 cannot start | Schedule a decision review; use the matrix as the agenda |
| No disposable replica set | Integration tests cannot run | Provision one before Gate 2; treat as a hard prerequisite |
| Default PINs remain in production | Credential compromise | Make C1 the first Phase 2.2 work package |
| `syncIndexes` drops an index | Query outage or data integrity issue | Remove it in Phase 2.2; capture the index inventory first |
| No backup restore evidence | Unrecoverable data loss | Block release until the drill passes |
| Hotel scope creeps into POS | Unverified subsystem ships | Keep Track C separate; require GH gates |
| V2 cutover pressure | Premature financial integration | Enforce G6/G7 and the independent audit |
| Single-instance assumptions | Rate-limit/SSE failures at scale | Document the single-instance constraint or add Redis |

---

## 17. Safety confirmation

- This roadmap is a proposal. No implementation, database access, deployment, or production integration was performed in Phase 2.1.
- Branch `main`, HEAD `69650435a6587d4577bc126f719fa1392bb934b3` at review start.
- Existing user work under `lib/inventory-v2/`, `lib/hotel/`, `tests/`, `scripts/`, and `docs/` was preserved.
- No `.env`/`.env.local` content was read.
- No MongoDB connection was opened.
- The next action is owner review of the three Phase 2.1 documents. Phase 2.2 does not begin until the owner approves this scope.
