# Phase 13 — Post-Audit Blocker Resolution & Release Preparation Report

| Field | Value |
|---|---|
| Repository | `C:\hotelms` (branch `main`) |
| Baseline | `docs/production-readiness/phase-12-final-deployment-readiness-report.md` |
| Phase 12 verdict | **NOT READY FOR DEPLOYMENT** |
| Phase 13 verdict | **STILL NOT READY FOR DEPLOYMENT** — B1–B7 remain open; B8–B10 remain owner decisions |
| Date | 2026-11-21 |
| Mode | Read-only investigation + narrowly scoped local code/test changes. **No deployment, no production DB, no credentials, no migrations, no index changes, no destructive operations, no commits/pushes.** |

## Evidence labels used throughout

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in this phase via a local read-only command, build, or test run. |
| **TEST-VERIFIED** | Behavior demonstrated by executed automated tests against in-memory/disposable code paths, not against a live environment. |
| **SOURCE-INSPECTED** | Established by reading current code/docs at a cited path. Not runtime-proven. |
| **NOT VERIFIED** | No evidence available in this phase; requires owner-provided environment or approval. |
| **BLOCKED** | Cannot proceed without explicit owner decision or infrastructure. |

---

## 1. Executive summary

1. **Hotel PIN change defect — investigated first.** The credential service and route layers are *functionally correct*: 13/13 in-memory service tests and 13/13 real-route-handler tests pass, covering new-PIN persistence, old-PIN rejection, lockout reset, collision rejection, Manager reset of a Receptionist PIN, session revocation, CSRF/Origin protection, and audit. The reproducible defect is **F-23b**: the server revokes *all* Hotel sessions for the identity (including the caller's), but the modal never revalidated the server layout, so a dead authenticated page remained until an unrelated request returned 401. A minimal client fix (call `router.refresh()` after the success toast, clear PIN inputs on success/cancel) was applied. **Locally TEST-VERIFIED; staging behavior NOT VERIFIED.**
2. **B1–B7:** safe, detailed plans, inventories, and procedures were produced from the current repository state. **No external infrastructure was provisioned, no production system was contacted, and no CI/CD files were created.** All infrastructure work is **BLOCKED** on owner approval.
3. **B8–B10:** three decision documents are prepared below. **No policy or code was changed** for public bank-account visibility, optional Manager PIN step-up, or CSP.
4. **Recovery requirements:** reconciled against repository documentation **without** asserting that requirements were never approved. Repo docs are blank approval templates and are not the authoritative record of prior owner decisions. **BLOCKED** on the actual prior approval record and a verified restore drill.
5. **Working tree preserved:** 265 porcelain entries, **0 staged**, three EXTERNAL deletions intact. No git write command was run. `C:\bonosm` was not accessed.
6. **Local verification:** full DB-free suite **2,554 tests / 417 suites, 0 failures**; PIN-focused suites **30/30**; ESLint **0 errors / 3 warnings**; production build **succeeded**.

---

## 2. Hotel PIN change defect — priority investigation

### 2.1 Trace performed (SOURCE-INSPECTED)

| Layer | Component | Result |
|---|---|---|
| UI trigger | `app/components/hotel/HotelTopBar.jsx:50-56,66` — Change PIN button renders `HotelChangePinModal` | Present on Reception, Rooms, Reports and Manager staff pages |
| UI submit | `app/components/hotel/HotelChangePinModal.jsx:34-89` — client-side 4-digit/mismatch/same-PIN checks, `fetch` with `credentials:"include"`, memory-only CSRF header from `useHotelSession()` | Correct |
| Transport | `app/components/hotel/hotelApi.js:46-112` and modal's direct fetch; `HOTEL_CSRF_HEADER` from `lib/hotel/constants.js:15` | Correct |
| Route | `app/api/hotel/auth/change-pin/route.js:34-135` — Origin check, rate limit, `authenticateHotelRequest({requireCsrf:true})`, strict JSON body, validation, current-PIN verify, collision check, `setHotelUserPin`, `revokeAllHotelSessionsForUser`, audit | Correct |
| Auth/CSRF | `lib/hotel/auth/service.js:58-160`, `lib/hotel/auth/csrf.js:46-104`, `lib/hotel/auth/session.js:249-290` — deterministic session-bound CSRF derived from opaque cookie token; fail-closed | Correct |
| Validation | `lib/hotel/validation.js:44-51` — exactly four digits | Correct |
| DB / credential | `lib/hotel/auth/credential.js:63-67,178-207` (`getHotelUserWithPin`, `findHotelPinCollision`, `setHotelUserPin`) and `lib/hotel/auth/pin.js:27-87` (salted scrypt + constant-time verify) | Correct |
| Session revocation | `lib/hotel/auth/session.js:416-436` — `updateMany` revokes all live sessions for the identity | Correct, **including the acting session** |
| Audit | `lib/hotel/audit.js` — `STAFF_SELF_PIN_CHANGED`, best-effort sanitized write | Correct |
| Manager reset | `app/api/hotel/staff/[id]/pin/route.js:23-113`, `lib/hotel/auth/staffService.js` — Receptionist-only target, 403 on Manager target, 409 on collision, compensating restore, audit | Correct |

### 2.2 Reproduction and isolation

**Step 1 — service-layer harness (`tests/hotel-pin-change-behavior.test.mjs`).**
Initial run: 12/13 pass. The single failure was in the *test harness*, not the product: `recordFailedHotelPinAttempt` uses a MongoDB aggregation-pipeline update (`$set` with `$cond`/`$add`/`$ifNull`), which the minimal in-memory model treated as a no-op. A small expression evaluator was added to the harness; **13/13 now pass (TEST-VERIFIED)**. This test proves:

- `hashHotelPin`/`verifyHotelPin` round-trip; salted hashes differ for identical PINs;
- `setHotelUserPin` persists the new PIN, rejects the old one, clears `pinFailedAttempts`/`pinLockedUntil`;
- login verification accepts the new PIN and rejects the old one;
- a locked identity is unlocked by the PIN change;
- collision detection finds another identity's PIN and excludes the acting identity;
- Manager reset changes only the target Receptionist, rejects a Manager target (403) and a collision (409), and preserves Manager/other Receptionist credentials;
- Manager reset revokes sessions for the target only;
- five wrong PINs trigger lockout.

**Step 2 — real route-handler harness (`tests/hotel-pin-change-route.test.mjs`).**
Executes the actual `POST` handlers with real `Request` objects (cookie, exact Origin, CSRF header, JSON body) against in-memory models; the **only** intercepted module is `lib/hotel/db/connection.js`. **13/13 pass (TEST-VERIFIED)**:

- successful change → 200, new PIN persisted, old PIN rejected, session revoked with reason `SECURITY`, `STAFF_SELF_PIN_CHANGED` audit written;
- wrong current PIN → 401, nothing changed; mismatched confirmation and non-4-digit PIN → 422, nothing changed; new == current → 422; collision → 409;
- missing CSRF header → 403 `CSRF_VALIDATION_FAILED`; foreign Origin → 403; missing session cookie → 401 `AUTHENTICATION_REQUIRED`;
- client-supplied `staffId`/`hotelUserId` is ignored — the target is always the session identity;
- Manager reset of a Receptionist → 200, target PIN changed, target session revoked, `STAFF_PIN_RESET` audit; collision → 409; mismatch → 422.

**Conclusion of steps 1–2:** the reported failure is **not** reproducible in the credential, validation, route, auth, or persistence layers. The only reproducible defect in the end-to-end flow is the post-success client behavior recorded by Phase 12 as **F-23b** (`phase-12-final-deployment-readiness-report.md:366`).

### 2.3 Root cause (SOURCE-INSPECTED)

`app/api/hotel/auth/change-pin/route.js:117-120` revokes every session for the identity, deliberately including the session that made the request (same security model as the POS route at `app/api/auth/change-pin/route.js:57-63`). Before this phase, `HotelChangePinModal.jsx` on success only set a 1.2-second toast, cleared inputs, and called `onClose()`. It never called `router.refresh()`, unlike the sibling `HotelLogoutButton.jsx:42-45`.

Effect: the server-layout session snapshot (`lib/hotel/auth/serverSession.js:31-66`) remained in the React tree after the cookie was revoked. The page still looked authenticated; the next API call failed with 401 and only then did `useHotelRequest` force a refresh into the sign-in gate. To a user this reads as "the PIN change broke my session / didn't work," with no explanation that a new sign-in is required. No target-identity selection, validation, or persistence defect was found.

### 2.4 Fix applied (minimal, no policy change)

`app/components/hotel/HotelChangePinModal.jsx`:

1. Import `useRouter` from `next/navigation` and call it in the component.
2. In the success path, after closing the modal, call `router.refresh()` so the server layout re-reads the now-revoked cookie and immediately replaces the stale authenticated page with the sign-in gate — mirroring the established logout pattern.
3. Clear `currentPin`/`newPin`/`confirmPin` on cancel/backdrop close as well as on success, so entered PIN values never persist in component state.

**Deliberately not changed:** session revocation scope (all sessions, including self), PIN hashing parameters, collision policy, rate limits, CSRF/Origin enforcement, or any business rule. Changing the revocation policy would require owner approval.

### 2.5 Verification of the fix

| Check | Command | Result |
|---|---|---|
| Route behavior | `node --import ./tests/helpers/hotel-route-register.mjs --test tests/hotel-pin-change-route.test.mjs` | 13/13 pass |
| Service behavior | `node --test tests/hotel-pin-change-behavior.test.mjs` | 13/13 pass |
| UI regression | `node --test tests/hotel-change-pin-ui-regression.test.mjs` | 4/4 pass |
| Full DB-free suite | `node --test --test-reporter=spec "tests/*.test.mjs"` | 2,554 tests / 417 suites, 0 fail |
| Lint | `npm run lint` | 0 errors, 3 pre-existing warnings |
| Build | `npm run build` (DB URIs blanked) | success |

The UI regression assertions are **SOURCE-INSPECTED** structural guards (no React DOM harness exists in the repo); they pin the `router.refresh()` call, its order after `onClose()`, PIN-field clearing, CSRF forwarding, and absence of target identity / browser storage.

**PIN defect status:** **TEST-VERIFIED locally; F-23b closed in source. Live staging verification is NOT VERIFIED and is required before release sign-off.**

---

## 3. B1 — Staging

**Status: PLANNED — BLOCKED (owner approval required).** Evidence is SOURCE-INSPECTED unless labeled otherwise.

### 3.1 Existing preparation

- `docs/production-readiness/staging-readiness-report.md:3-9,86-128,210-219` — "PREPARATION COMPLETE — STAGING NOT VERIFIED — G-PAY-1 REMAINS BLOCKED"; no approved isolated staging environment.
- `docs/production-readiness/g-pay-1-staging-acceptance-report.md:3-20,99-109` — "BLOCKED — STAGING PREREQUISITE MISSING"; the team explicitly refused to substitute production.
- `docs/production-readiness/g-pay-1-staging-execution-checklist.md:3-9,37-56` — all 15 cases GP1-01…GP1-15 written, **none executed**; gates G0-1…G0-10 require owner approval.

### 3.2 Safe isolation plan

| Area | Requirement | Source |
|---|---|---|
| POS DB | `MONGODB_URI` (legacy alias `CAFEDB_URI`), dedicated staging database, never shared with production or Hotel | `.env.example:5-8`; `lib/config/runtimeEnv.js:7,16-19`; `lib/mongodb.js:32-48,140-145` |
| Hotel DB | Separate `ROOM_MONGODB_URI` forced to database `bono_hotel`; separate `HOTEL_SESSION_SECRET` distinct from `AUTH_SECRET`; optional exact `HOTEL_ALLOWED_ORIGINS` | `.env.example:23-33`; `lib/hotel/constants.js:7-10`; `lib/hotel/config.js:48-76,87-113`; `lib/hotel/db/connection.js:29-40` |
| Connection separation | Separate Mongoose connection, `dbName:"bono_hotel"`, `autoIndex:false`, `autoCreate:false`; POS connection must never be reused for Hotel | `lib/hotel/db/connection.js:12-19,29-34`; `phase-12...report.md:481` |
| secret/config gating | `AUTH_SECRET`, Cloudinary keys, `ALLOWED_ORIGINS`, `HOTEL_SESSION_SECRET`; no production values in staging | `.env.example:10-21`; `phase-12...report.md:480-483` |
| Platform config | `netlify.toml:1-6` currently has only `[build]` and an unpinned plugin — **no staging context, URL, branch, or env block** | VERIFIED |

**Plan:** provision a staging app with its own URL and a separate POS replica set plus a separate standalone Hotel MongoDB; use test-only staff/payment/hotel identities; prove isolation with distinct database names, distinct secrets, and a read-only connectivity assertion that production databases are not reachable from staging configuration. No infrastructure may be provisioned without explicit owner approval.

### 3.3 Acceptance evidence required

- Isolated staging app + DB provisioned and isolation proof recorded (owner + ops).
- G-PAY-1 15/15 executed and signed (`g-pay-1-staging-execution-checklist.md:37-56`).
- Staging smoke: `/api/health?live=1` 200, `/api/health` ready, one authenticated read per POS role, one Hotel sign-in + PIN change + re-sign-in with the new PIN.
- Log capture with redaction verified; cleanup and rollback owner named.

**Not verified:** no staging URL, credentials, DB target, isolation proof, or executed case exists. **BLOCKED.**

---

## 4. B2 — Backup and recovery

**Status: RECONCILED ON PAPER — BLOCKED (owner record + drill evidence missing).**

### 4.1 Owner-approved requirements reconciliation

**Critical caveat (SOURCE-INSPECTED):** repository docs are explicitly read-only proposal templates with **blank approval tables** (`phase-2-4-owner-decisions.md:635-666`; `phase-2-4-production-database-checklist.md:642-658`; `phase-2-5-safety-and-deployment-gates.md:440-455`). Other docs reference approvals recorded elsewhere (e.g. `wp-04-recovery-state-machine.md:17,69,93,610-621` cites approved WP-05/WP-07 schema and OD-24/27-SC/30/33/37). Therefore:

> **Repo documentation is not the authoritative record of owner approvals. Absence of an approval from the repository must not be interpreted as "never approved."** Phase 12's statement (`phase-12-final-deployment-readiness-report.md:28`) is narrowly that no approved backup/recovery requirement exists *anywhere in the repository* — not that the owner never approved one. The prior ChatGPT approval record was not supplied to this phase; it must be attached by the owner.

| Requirement | Owner-approved (repo evidence) | Documented in repo | Implemented infrastructure | Verified evidence / missing evidence |
|---|---|---|---|---|
| Backup mechanism, encryption, offsite copy | Cited as D-9/§11.3; no value in repo (`phase-2-4-production-database-checklist.md:459-473,654`). Prior approval NOT SUPPLIED | `:436-450`; F-07 `phase-12...report.md:171-181` | None in repo | Verified *absence* in repo; provider config/screenshot **missing** |
| PITR window | D-10; "PITR window must match claimed RPO" (`phase-2-5...gates.md:258`); unsigned | `phase-2-3-recovery-and-idempotency-design.md:345-350` | None | Provider evidence **missing** |
| RPO | Proposed ≤15 min, marked "UNVERIFIED — OWNER DECISION" (`phase-2-5...gates.md:255,261`) | `phase-2-4...checklist.md:468`; `phase-2-4-owner-decisions.md:483` | None | Approved value **missing** |
| RTO | Proposed ≤4 h, same marking (`phase-2-5...gates.md:256,261`) | same | None | Approved value **missing** |
| Restore drill + independent verifier | D-11 / gates G15, G17; "No restore has been performed" (`phase-2-4...checklist.md:528,631`) | Full 8-step drill `:490-528`; `phase-2-5...gates.md:263-286` | None | Drill report and verifier signature **missing** |
| Post-restore integrity (counters, unique indexes, reconciliation) | Part of D-5 / drill gate (`phase-2-5...gates.md:272-286`) | `phase-2-3...design.md:345-349`; `phase-2-4...checklist.md:498-512` | Scripts authored, never run against a DB | Source rules VERIFIED; runtime evidence **missing** |
| Backup monitoring / alert / on-call | D-12 (`phase-2-4...checklist.md:543-561,657`); F-09 | `phase-12...report.md:195-205` | Structured logger only, no sink | Alert config/owner **missing** |
| Durable recovery ownership / audit / retention | Decision A/E (`phase-2-4-recovery-readiness.md:675-688`; `phase-2-4-owner-decisions.md:524-614`) | `phase-2-3...design.md:301-321`; `wp-04...state-machine.md:478-517` | Offline writer source only; "no MongoDB contacted" (`wp-04...state-machine.md:19-28`) | DB-free tests SOURCE-INSPECTED; deployed evidence **missing** |

### 4.2 Isolated restore-drill procedure (prepared, NOT executed)

Reuse `phase-2-4-production-database-checklist.md:490-528`, `phase-2-5-safety-and-deployment-gates.md:263-286`, `phase-2-3-recovery-and-idempotency-design.md:343-350`, `phase-12...report.md:499-503` (Gate 3), and `docs/auth-session-index-deployment.md:34-99`. Outline:

1. Owner supplies the prior approval record (mechanism, retention, RPO/RTO, PITR window) and names an independent verifier.
2. Provision an **isolated** target (no production connectivity); confirm distinct URI/database name with the same guard used by integration harnesses.
3. Restore the most recent approved backup to that isolated target (or perform PITR to a test point) — **only after owner authorization**.
4. Verify document counts, order/payment reconciliation invariants, counter collections, and unique-index presence using read-only `getIndexes()`/aggregations.
5. Run the DB-free suite plus the disposable-target integration suites against the restored target; record results.
6. Capture timings, compare to approved RPO/RTO, and have the independent verifier sign the drill report.
7. Destroy only the isolated drill resources, with cleanup approval where required.

**No backup, restore, PITR, or production operation was performed. BLOCKED on owner approval.**

---

## 5. B3 — Database indexes

**Status: INVENTORY PREPARED — DRY-RUN PROCEDURE READY — VERIFICATION BLOCKED.**

### 5.1 Schema declarations vs deployed indexes

- **VERIFIED:** `node scripts/sync-indexes.js --dry-run` runs offline with no DB connection and prints the complete POS schema-derived plan; no files written. It covers 9 POS collections; `paymentinfos` has no schema indexes.
- POS declarations (SOURCE-INSPECTED): `lib/models/Order.js:28,41,57,88,90,163-164,168-174,182,188,199,207,209,225-227,239,243,246,249-254`; `Staff.js:34,44,54,62,69-75`; `InventoryReservation.js:135-147,181,183`; `StockMovement.js:12,64,67,74-83`; `Session.js:52-53,61,68,78-82,87`; plus Category, MenuItem, InventoryAudit, SystemAuth, Recipe, Supplier, ExtraItem; recovery schemas `RecoveryTask.js:450,458-475`, `RecoveryEvent.js:227,235-243`, `RecoveryOperationHistory:561,571`.
- Hotel declarations (separate DB): `lib/hotel/models/guest.js:82-84`, `hotelAuditLog.js:76-78`, `hotelPayment.js:127-132`, `hotelSession.js:84-86`, `hotelUser.js:107,111-118`, `reservation.js:244-253`, `room.js:114,137-140`, `roomBookingLock.js:39`, `roomType.js:61,71-72`, `stay.js:240-244`.
- **Production default is off:** `lib/mongodb.js:50-72,77-108,180-182` uses gated additive `createIndexes()` unless `POS_AUTO_INDEXES=1`; `lib/hotel/db/connection.js:17-19,29-34` sets `autoIndex:false`/`autoCreate:false`. Therefore all indexes are **schema declarations only**; **zero DB-verified indexes** (matches F-08 at `phase-12...report.md:183-193`). Live state **NOT VERIFIED**.

### 5.2 Duplicate / conflicting risks

1. Legacy `StockMovement (refOrderId, reason)` unique index rejects multi-ingredient orders; the intended `(refOrderId, reason, item)` unique partial index cannot replace it via additive creation. `lib/indexDeploymentPlan.js:95-101,129-143` flags `SUPERSEDED_PREFIX`; removal needs a reviewed, owner-gated `dropIndex` in a maintenance window.
2. Same-name/different-options → `IndexOptionsConflict`; handled as `NAME_TAKEN` with fail-closed guidance (`indexDeploymentPlan.js:91-94,113-127,149-161`).
3. Resolved historical conflict: redundant `Session.expiresAt` field index removed in favor of TTL only (`Session.js:78-82`; `docs/auth-session-index-deployment.md:29-32`).
4. Redundant overlaps (e.g. `waiterId_1` + `waiterId_1_createdAt_-1`, `item_1` + `item_1_createdAt_-1`) are write-cost concerns, not functional conflicts; do not create manually.
5. Hotel `(stayId, idempotencyKey)` uniqueness depends on the Hotel deploy script actually being run — state UNVERIFIED.

### 5.3 Safe dry-run and verification plan

1. Capture `node scripts/sync-indexes.js --dry-run` as the schema-derived POS plan (**already VERIFIED locally**).
2. Cross-check `.index()`/field flags in `lib/models/**` and `lib/hotel/models/**`; the Hotel/V2 scripts have no `--dry-run`, so use their documented source plans (`phase-2-4...checklist.md:351-363`).
3. Run duplicate preflight aggregations (`phase-2-4...checklist.md:311-330`) **only on an approved disposable/staging target**; a non-empty result blocks unique-index creation.
4. Take before/after `getIndexes()` snapshots and assert exact key order, `unique`, `partialFilterExpression`, and TTL options per collection (`phase-2-4...checklist.md:569-588`; `phase-2-5...gates.md:319-347`).
5. Any conflict or legacy superseded index → fail closed, owner ticket, separate window; **never** `syncIndexes()`/`dropIndexes()`.
6. Actual deployment (`--confirm`, `--allow-production`, approval reference) is **out of scope** and requires owner/DBA approval.

**No production DB connection or index change was made. BLOCKED.**

---

## 6. B4 — Observability

**Status: PLANS PREPARED — SAFE LOCAL CHANGES Identified but NOT APPLIED — INFRASTRUCTURE BLOCKED.**

### 6.1 Existing surface (SOURCE-INSPECTED; selected tests VERIFIED)

| Surface | Evidence |
|---|---|
| Health | `app/api/health/route.js:6-54` — readiness with env gate then DB connect; `?live=1` liveness only, no DB; 200/503; `no-store`. `lib/health.js:8-23` forbids hosts/URIs/errors. `tests/health-endpoint.test.mjs:20-107` verified passing (20 tests across it and the logger test). |
| Structured logging | `lib/operationalLogger.js:17-45,59-87,93-114` — one redacted JSON line via `console.*`; **no buffering/retry/shipping**. |
| API errors | `lib/withApi.js:37-63` — generic 503/500, but logs `errorMessage` (F-19 gap). |
| UI errors | `app/global-error.js:20-23` renders `error?.message` (F-19-adjacent). |
| Hotel audit | `lib/hotel/audit.js` — structured sanitized audit; fallback uses unstructured `console.warn` (`:210-218`). |
| Headers | `next.config.mjs:28-42` — nosniff, DENY frame, referrer, permissions, prod HSTS; **no CSP** (F-20). |
| Extension point | `instrumentation.js:3-19` — tracing/metrics hook currently only warms MongoDB. |
| Absent | No monitoring, alert sink, log drain, error tracker, dashboard, on-call rotation, or incident runbook (`phase-2-4-production-database-checklist.md:534-561`; `phase-2-3-deferred-risks.md:29,78-80`; `wp-04-recovery-state-machine.md:521-549`; F-09 at `phase-12...report.md:195-205`). |

### 6.2 Safe local implementation plan (not applied in this phase)

1. Close F-19 mechanically: add `errorMessage`/`stack` to redaction handling, log stable `errorCode`/`errorName` instead of raw messages, stop rendering raw errors in `app/global-error.js`, convert route-level `console.error(err.message/stack)` to `logEvent`.
2. Begin F-20 with `Content-Security-Policy-Report-Only` in `next.config.mjs:28-42`, no report endpoint until an owner-approved sink exists.
3. Route the Hotel audit fallback through `logEvent`.
4. Register process-level resilience logging in `instrumentation.js`.

Items 1 and 3 touch cross-cutting files and were **not** applied in this phase to avoid unrelated changes during blocker resolution.

### 6.3 Owner-approved infrastructure required (BLOCKED)

External uptime check on `/api/health`; log drain/shipper with retention and redaction verification; error tracker; alert rules and severity routing; named on-call rotation; published first-response incident runbook; CSP report-collection endpoint. Provider-side monitoring is **NOT VERIFIED** and outside repository scope.

---

## 7. B5 — CI and rollback

**Status: ARCHITECTURE PREPARED — NO CI FILES CREATED — RUNNER/PROVIDER BLOCKED.**

### 7.1 Current state (SOURCE-INSPECTED; VERIFIED where noted)

- `package.json:5-14` — scripts: `dev`, `build`, `start`, `lint`, `db:sync*`, `db:seed-auth`, `db:reset-auth`; **no `test`/`test:integration`/`ci` script**.
- `netlify.toml:1-6` — build only, no staging context. `.github/` absent (VERIFIED). `package-lock.json` v3 present but modified in working tree.
- DB-free suite is the established command and was re-run here: **2,554 tests / 417 suites, 0 fail**.
- Disposable integration harnesses are opt-in and use distinct targets: POS/WP04 replica set on `127.0.0.1:27019` (`tests/integration/phase25-payment-immutability.integration.mjs:1-17,34-46`), Hotel standalone non-27017 with `HOTEL_TEST_TARGET_ACK=I_CONFIRM_DISPOSABLE_MONGODB` and loopback-only validation (`tests/helpers/hotel-integration-guard.mjs:20-33,299-421,510-657`). Phase 12 recorded 32/32 integration passing; **not re-run in this phase** (no DB-related source changes).

### 7.2 Proposed CI architecture (design only)

| Stage | Action | Approval |
|---|---|---|
| A — every change | Pin Node → `npm ci` → `npm run lint` → `node --test --test-reporter=spec "tests/*.test.mjs"` → `npm run build` (DB URIs blanked) → artifact verification (hash `.next` + lockfile, assert pinned Node/plugin, assert no secret values) → local smoke: `/api/health?live=1` 200, `/` 200, `/api/orders` 401, security headers, CSP report-only | Code-only; runner provisioning needs approval |
| B — manual/scheduled | POS/WP04 disposable replica set job + Hotel disposable standalone job with documented ack flags and cleanup | Ephemeral Mongo provisioning approval |
| C — promotion | Tag the exact tested artifact, deploy to staging, execute G-PAY-1 15/15, rehearse rollback, then promote the same tag | Owner/ops |

### 7.3 Rollback runbook and staging rehearsal

Per `phase-12...report.md:523-524,505-514`: redeploy the previous tagged artifact, restore the previous env set, verify `/api/health` and one read path; database rollback is restore-based only and gated on the B2 restore drill. Forward recovery is preferred; rollback must not delete evidence (`phase-2-5-safety-and-deployment-gates.md:212,223-234`). Staging-specific rollback is **NOT VERIFIED** (`staging-readiness-report.md:106-124`).

**Blocking prerequisite (F-11/B6):** the release artifact is not reproducible from VCS until the working tree is committed in reviewed commits and tagged. CI cannot be meaningful before that.

---

## 8. B6 — Release artifact grouping

**Status: PROPOSAL ONLY — NO GIT WRITE COMMANDS.**

### 8.1 Preservation verification (VERIFIED)

| Check | Result |
|---|---|
| `git status --porcelain` | **265 entries**: 88 modified, 3 deleted, 174 untracked |
| `git diff --cached --name-only` | **0 entries** — index unchanged |
| Three EXTERNAL deletions | ` D app/api/external-items/route.js`, ` D app/api/external-sales/route.js`, ` D lib/models/ExternalItemRequest.js` — all still present as deletions, absent on disk, tracked in index |
| Phase 12 baseline | 262 entries at `phase-12...report.md:33-35`; current 265. The delta is accounted for by new untracked test/helper files added in this phase and concurrent user work; **no git write was performed by this phase** |
| `C:\bonosm` | Not accessed or modified |

### 8.2 Proposed review/commit grouping plan

| Group | Scope | Guidance |
|---|---|---|
| G1 — POS inventory/order/payment | `app/api/inventory/**`, `app/api/orders/**`, `app/api/menu/route.js`, `app/api/recipes/**`, `lib/orderService.js`, `lib/inventoryDeductionService.js`, `app/components/InventoryUI.jsx`, `CashierUI.jsx`, `WaiterUI.js`, `KitchenDisplay.js`, `app/pos/`, `app/jebena/` | Preserve existing inventory policies and order/payment architecture; no rework |
| G2 — POS auth/staff | `app/api/auth/**`, `app/api/manager/staff/route.js`, `lib/staffService.js`, `lib/staffPinPolicy.js`, `lib/models/Staff.js`, `Session.js`, PinGuard/PinLoginModal, auth scripts/tests | Keep separate from Hotel auth; do not change B9 policy without owner decision |
| G3 — Hotel subsystem | `app/api/hotel/**`, `app/hotel/**`, `app/components/hotel/**`, `lib/hotel/**`, Hotel scripts/tests/docs | Separate DB/auth/audit; includes the F-23b fix and new PIN tests |
| G4 — tests/docs/config | Split into G4a docs, G4b tests, G4c config/infra (`package.json`, `package-lock.json`, `next.config.mjs`, `netlify.toml`, `proxy.js`, `.env.example`), G4d recovery/offline-export | Cross-cutting files must travel with the group that first depends on them |
| G5 — retired EXTERNAL deletions | The three paths in §8.1 | Commit as deletions together; never restore |

This is a **review grouping proposal only.** No staging, commit, push, stash, reset, clean, checkout, revert, or discard was performed. Owner review, per-group commits, and a release tag are required before CI can operate.

---

## 9. B7 — Version pinning

**Status: REVIEWED — SAFE CHANGES PROPOSED — PLUGIN PIN BLOCKED.**

| Setting | Current | Source | Label |
|---|---|---|---|
| `engines` | **absent** | `package.json:1-31`; `package-lock.json:7-26` | VERIFIED |
| `next`, `eslint-config-next` | `16.3.1` exact | `package.json:19,28` | SOURCE-INSPECTED |
| `react`, `react-dom` | `19.2.8` exact | `package.json:21-22` | SOURCE-INSPECTED |
| Caret ranges | `@tabler/icons-react ^3.46.0`, `cloudinary ^2.10.1`, `mongoose ^9.9.2`, `pdfkit ^0.20.2`, `recharts ^3.10.1`, `@tailwindcss/postcss ^4`, `eslint ^9`, `tailwindcss ^4` | `package.json:16-30` | SOURCE-INSPECTED |
| Netlify plugin | `@netlify/plugin-nextjs` with **no version**; **0** lockfile matches, not in `package.json` | `netlify.toml:5-6` | VERIFIED |
| `NODE_VERSION` | absent | `netlify.toml:1-6` | VERIFIED |
| Node version files | `.nvmrc`, `.node-version`, `.tool-versions` absent | shell check | VERIFIED |
| Local toolchain | Node `v24.14.0`, npm `11.9.0` | shell check | VERIFIED |
| Next requirement | `node >=20.9.0` | `node_modules/next/package.json:136-138` | VERIFIED |

**Proposed safe changes (not applied):** add `"engines": {"node":"24.14.0","npm":"11.9.0"}` to `package.json`; add `.nvmrc` with `24.14.0`; add `[build.environment] NODE_VERSION = "24.14.0"` to `netlify.toml`; pin `@netlify/plugin-nextjs` to the **exact version actually used by Netlify builds**, adding it to `devDependencies` and regenerating the lockfile; add a DB-free source-contract test for all four pins.

**Blocked:** the exact Netlify plugin version must come from owner/Netlify build logs — **do not guess it**. Regenerating the lockfile requires a network install; no dependency installation was performed. Local verification approach: compare `node --version`/`npm --version`, `.nvmrc`, `engines`, `NODE_VERSION`, and lockfile root entry; re-run focused DB-free tests.

---

## 10. B8–B10 — Owner decision documents (no changes made)

### 10.1 B8 — Public bank-account visibility

| Field | Detail |
|---|---|
| Current behavior | `app/api/payment-info/route.js:10-20` serializes full `bankName`, `ownerName`, `accountNumber`, `isActive`. `GET` at `:23-43` has **no** `requireAuth`, applies only rate limiting, and queries `PaymentInfo.find({})` without an active filter. Writes require MANAGER (`:47,83,121`). `next.config.mjs:74-79` sets `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`. `/menu` consumer `app/menu/page.js:261,263,940-979` copies the full account number. |
| Risk | Anonymous callers and CDN caches can enumerate all bank accounts and owner names, including inactive records. HIGH (F-13 at `phase-12...report.md:245-255`). |
| Options | (a) accept as intended public business info — record signed acceptance **and remove the public cache header**; (b) mask to bank + last 4 for unauthenticated callers, full values for authenticated staff; (c) require a session for GET. |
| Recommendation | Option (b) or (c); roadmap prefers minimization/auth (`production-release-roadmap.md:94-96`). Option (a) is acceptable only with written risk acceptance. |
| Reversibility | (a) is a config-only edit + signed memo, fully reversible. (b)/(c) change API serialization and the `/menu` copy flow; git-reversible but need product/UI sign-off. |
| Owner decision | Choose (a)/(b)/(c) and sign. **No recorded owner acceptance found in repo.** Note: decision C-3 in `phase-2-4-owner-decisions.md:372,392,399,654` concerns DELETE/archive policy, **not** public GET visibility. |
| After approval | Implement only the chosen option + tests; commit in G1/G4c. |

### 10.2 B9 — Optional Manager PIN step-up (POS)

| Field | Detail |
|---|---|
| Current behavior | `app/api/manager/staff/route.js:210-212` documents `currentManagerPin?` as optional; parsing at `:232-234` nulls blank values; verification only inside `if (currentManagerPin)` at `:258-266`. Authorization otherwise uses cookie-only `getLiveSessionFromCookies(store,["MANAGER"])` at `:247-254`. UI `app/components/StaffManagement.jsx:381-399` sends it only if non-blank (`:399`). |
| Risk | A stolen Manager session can reset staff/station PINs without the Manager PIN. MEDIUM-HIGH (F-15 at `phase-12...report.md:269-279`; R-06 at `phase-2-2-deferred-risks.md:31,126-136`). `clear-orders` already requires step-up, so this is an inconsistency. |
| Options | (1) Enforce mandatory `currentManagerPin` on every PIN change and accept the tab credential via `requireAuth` instead of cookie-only; update UI to always prompt. (2) Document risk acceptance. |
| Recommendation | Option (1). Closure evidence: UI + route + test proving missing/wrong `currentManagerPin` is rejected (`phase-2-2-deferred-risks.md:136`). |
| Reversibility | Git-reversible, but enforcing before UX communication can block manager workflows; the `clear-orders` precedent shows it is operationally feasible. |
| Owner decision | "Mandatory Manager step-up for PIN changes — yes or no?" (`phase-2-2-deferred-risks.md:267`). R-06 remains **DEFERRED**; no approval record filled. |
| Scope guard | This is the **POS** route. The separate Hotel manager reset (`app/api/hotel/staff/[id]/pin/route.js:23-113`) already requires `pin`/`confirmPin`, Receptionist-only targets, full session revocation with compensating restore, and durable audit. **Do not conflate the two.** |

### 10.3 B10 — Content-Security-Policy

| Field | Detail |
|---|---|
| Current behavior | `next.config.mjs:28-42` has nosniff, DENY frame, referrer, permissions, prod HSTS — **no CSP**. F-20 at `phase-12...report.md:329-339`; smoke observed headers with "No CSP" at `:442-447`. The working-tree change to `next.config.mjs` adds only a `/hotel/:path*` no-store block; no CSP was added. |
| Risk | Reduced XSS containment. LOW. |
| Options / recommendation | Ship `Content-Security-Policy-Report-Only` first, observe violations, then enforce (`phase-12...report.md:339`, B10 `:469`). |
| Reversibility | Report-only is observation-only, zero functional impact, fully reversible. Enforcement can break inline scripts/styles/fonts (note inline styles and untracked `app/fonts/`) and needs staged rollout. |
| Owner decision | Engineering must approve the directive set and observation window. **No CSP directive set or report-only config found in docs; no decision recorded.** |
| After approval | Add report-only header in `next.config.mjs:28-42` with owner-approved report sink; review violations; then enforce. Commit in G4c. |

---

## 11. Remaining blockers

| ID | Blocker | Phase 13 progress | Status | Owner |
|---|---|---|---|---|
| PIN | Hotel self-service PIN change post-success stale session (F-23b) | Root cause identified, minimal client fix applied, 30 focused tests + full suite pass | **TEST-VERIFIED locally; staging verification required** | Eng + ops |
| B1 | No verified staging environment | Isolation/config/acceptance plan prepared; G-PAY-1 cases remain prepared-not-executed | **BLOCKED** — no staging app/DB | Owner + ops |
| B2 | No backup/PITR/restore/RPO/RTO | Requirements reconciled; isolated drill procedure prepared | **BLOCKED** — approval record + drill evidence | Owner + finance |
| B3 | Zero DB-verified indexes | Inventory + dry-run VERIFIED; duplicate risks documented | **BLOCKED** — no approved target/deployment | Owner + DBA |
| B4 | No monitoring/alerting/on-call | Surface inventoried; safe code changes + infra plan prepared | **BLOCKED** — external sink/on-call | Ops |
| B5 | No CI/promotion/rollback | CI architecture + rollback runbook + rehearsal plan prepared | **BLOCKED** — runner, disposable DB, VCS artifact | Eng |
| B6 | Artifact not reproducible from VCS | Grouping proposal; preservation VERIFIED (265 entries, 0 staged, 3 deletions) | **BLOCKED** — reviewed commits + tag | Owner |
| B7 | Unpinned Node + plugin | Exact current values established; changes proposed | **BLOCKED** — plugin version from owner | Eng |
| B8 | Public bank-account disclosure | Decision document prepared | **BLOCKED** — owner choice/signature | Owner |
| B9 | Optional Manager step-up | Decision document prepared | **BLOCKED** — owner choice/signature | Owner |
| B10 | No CSP | Decision document prepared | **BLOCKED** — Eng directive approval | Eng |

Phase 12's rule is unchanged: **B1–B7 are non-negotiable for any production release; B8–B10 may be explicitly risk-accepted in writing but cannot be silently ignored** (`phase-12...report.md:471-472`).

---

## 12. Exact files changed in Phase 13

**Modified (production source, 1 file):**

| File | Change |
|---|---|
| `app/components/hotel/HotelChangePinModal.jsx` | Added `useRouter`; `router.refresh()` after successful PIN change (closes F-23b); clear PIN inputs on success and cancel. No server/policy change. |

**Created (tests/harnesses, 6 files):**

| File | Purpose |
|---|---|
| `tests/hotel-pin-change-behavior.test.mjs` | 13 DB-free service-behavior tests for credential lifecycle, Manager reset, collision, revocation, lockout |
| `tests/hotel-pin-change-route.test.mjs` | 13 real-route-handler tests with real `Request` objects; self-registering resolver so it runs in the default suite |
| `tests/hotel-change-pin-ui-regression.test.mjs` | 4 structural guards pinning the post-success refresh and PIN clearing |
| `tests/helpers/hotel-route-loader.mjs` | Test-only resolver for `@/` aliases and extensionless imports; redirects only the Hotel DB connection |
| `tests/helpers/hotel-route-register.mjs` | Registers the resolver (CLI form remains supported) |
| `tests/helpers/hotel-route-fake-db.mjs` | In-memory connection provider used by the route harness |

**Created (report, 1 file):** `docs/production-readiness/phase-13-blocker-resolution-report.md` (this document).

**Not changed:** any database/index/migration, `package.json`, `netlify.toml`, `next.config.mjs`, POS auth/staff policy, inventory policies, order/payment architecture, POS/Hotel auth separation, or any file under `C:\bonosm`. No git state changes.

---

## 13. Tests, build and verification results

| Command | Result | Label |
|---|---|---|
| `node --test tests/hotel-pin-change-behavior.test.mjs` | 13 tests, 13 pass, 0 fail | TEST-VERIFIED |
| `node --import ./tests/helpers/hotel-route-register.mjs --test tests/hotel-pin-change-route.test.mjs` | 13 tests, 13 pass, 0 fail | TEST-VERIFIED |
| `node --test tests/hotel-change-pin-ui-regression.test.mjs` | 4 tests, 4 pass, 0 fail | SOURCE-INSPECTED guards, executed |
| `node --test --test-reporter=spec "tests/*.test.mjs"` | **2,554 tests / 417 suites, 0 fail** (was 2,524/409 in Phase 12; increase from new Hotel/PIN coverage and ongoing user work) | VERIFIED |
| `npm run lint` | 0 errors, 3 pre-existing warnings (`MenuCrudClient.jsx:161`, `app/menu/page.js:385`, `lib/ethiopianCalendar.js:622`) | VERIFIED |
| `npm run build` with DB URIs blanked | success; all routes compiled | VERIFIED |
| `node scripts/sync-indexes.js --dry-run` | offline, no connection, schema-derived POS index plan captured | VERIFIED |
| Disposable integration suites (POS 32/32 in Phase 12) | Not re-run this phase — no DB-related source changes | SOURCE-INSPECTED (Phase 12) |
| Health/operational-logger focused tests | 20 tests, 20 pass | VERIFIED |

Known harness note: the `MODULE_TYPELESS_PACKAGE_JSON` warnings are Node reparsing ESM source without `"type":"module"`; they are performance warnings, not failures, and adding `type` was avoided as an unnecessary repo-wide change.

---

## 14. Infrastructure work requiring owner approval

1. **B1** — staging app/URL, isolated POS replica set and standalone Hotel MongoDB, test identities, isolation proof, staging cleanup/rollback owner.
2. **B2** — attach the actual prior owner approval record; approve backup mechanism, retention, RPO/RTO, PITR window; authorize and independently verify an isolated restore drill.
3. **B3** — approve target environment and DBA window for index preflight/deployment; separately approve removal of the legacy superseded `StockMovement` index.
4. **B4** — log drain/shipper, error tracker, alert rules and routing, on-call rotation, incident runbook, CSP report sink.
5. **B5** — CI runner and secret store, ephemeral MongoDB for integration jobs, deploy hooks/token, protected branch checks, artifact registry, staging rehearsal sign-off.
6. **B6** — owner review and commit of the working tree in the proposed groupings, EXTERNAL deletions preserved, release tag.
7. **B7** — authoritative Netlify plugin version and approval for lockfile regeneration; Node/npm pin sign-off.
8. **B8–B10** — signed decisions for public bank-account visibility, Manager PIN step-up, and CSP directive set/rollout.
9. **PIN defect** — staging execution of the PIN-change scenario: change PIN → verify old PIN fails/new PIN works → confirm immediate sign-in gate → sign in with new PIN and confirm Manager reset path.

---

## 15. Next required owner decisions

1. **PIN defect staging acceptance** — approve the staging scenario in §14.9 and accept the F-23b fix (or direct a different UX, e.g. keeping the acting session alive, which would change the current revoke-all security policy).
2. **B2 approval record** — supply the prior ChatGPT-approved backup/recovery requirements (mechanism, retention, RPO, RTO, PITR, drill cadence). Without it, B2 cannot be reconciled beyond what is in this report, and no drill may be executed.
3. **B1 staging provisioning** — authorize or decline isolated staging infrastructure; G-PAY-1 remains blocked until then.
4. **B8** — choose (a) signed acceptance + remove public cache header, (b) mask for unauthenticated callers, or (c) require a session.
5. **B9** — mandatory Manager PIN step-up (yes/no) for POS PIN changes.
6. **B10** — approve report-only CSP directive set and observation window.
7. **B6/B5** — approve the proposed commit grouping and release tag so CI and artifact promotion can be implemented.
8. **B7** — provide the exact Netlify plugin version and approve toolchain pins.

**No deployment was performed. Phase 13 stops here pending these owner decisions.**
