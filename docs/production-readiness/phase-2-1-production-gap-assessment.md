# BONO POS / Hotel - Phase 2.1 Production Gap Assessment

**Status:** READ-ONLY REVIEW - awaiting owner approval
**Date:** 2026-11-07
**Branch:** `main`
**HEAD:** `69650435a6587d4577bc126f719fa1392bb934b3`
**Working tree at review start:** 105 dirty/untracked entries
**Implementation authorization:** None. No runtime behavior was changed.

---

## 1. Executive assessment

BONO is **not production-ready** in the sense required for a controlled release. The application has substantial working functionality and a large DB-free regression suite (1291 tests, 223 suites, 0 failures), but the release evidence does not yet cover the conditions that decide production safety: real MongoDB topology and transactions, backups and restore, monitoring and alerting, CI, secret provisioning, and a rollback path.

The most serious findings are:

1. **Shared default role PINs**, including a default Manager PIN of `4444`, are still the reset/seed behavior (`lib/config/security.js:6-10`, `scripts/seed-auth.js:15-46`). A Manager reset is role-wide (`app/api/manager/staff/route.js:280`).
2. **The payment-info read endpoint is public** and returns bank name, account owner, and account number without authentication (`app/api/payment-info/route.js:23-37`).
3. **The application calls `syncIndexes()` in the background on every new connection** for five core models (`lib/mongodb.js:53-71,149`). That can create or drop indexes outside the explicit deployment process.
4. **V1 inventory already depends on multi-document transactions**, but the MongoDB topology and real transaction behavior are unverified (`lib/inventoryDeductionService.js:258-330`, `lib/inventoryWasteService.js:51-165`).
5. **There is no evidence of backup/restore, CI, health checks, or production monitoring** in the repository.
6. **`clear-orders` is a destructive global reset** that deletes all orders, deletes non-consumed reservations, and zeroes `reservedStock` (`app/api/manager/settings/clear-orders/route.js:55-91`).
7. **Inventory failures are swallowed by best-effort hooks** (`lib/orderService.js:235-246`), so a failed reservation or consumption can leave stock silently inconsistent.

The Hotel module is explicitly documented as **not production-ready** (`docs/hotel-foundation.md:11-14`): no Hotel indexes have been deployed, no live-database integration test has been run, and there is no Hotel UI beyond Reception. It should be treated as a separate release track, not bundled into the POS release.

**Overall release verdict: NOT READY.** The POS can be piloted only after the critical items in Section 3 are closed and the approval gates in `production-release-roadmap.md` are satisfied. Inventory V2 is **not** a release candidate; no V2 code path is wired to a live route.

---

## 2. Scope and method

This assessment covers the 18 areas named in the Phase 2.1 brief. Evidence comes from source, tests, git state, and project documentation. No database was contacted, no environment file was read, and no deployment was performed.

Labels:

- **VERIFIED** - directly observed in source, tests, git state, or documentation.
- **INFERRED** - reasoned from verified facts; not directly executed.
- **UNVERIFIED** - not established; requires a disposable environment or independent review.

A finding is only marked VERIFIED when the underlying file or command output was inspected. "No evidence found" means a repository search found no implementation or document; it does not prove the control is absent from the hosting provider.

---

## 3. Critical risks

Critical means: a realistic path to data loss, unauthorized access, financial misstatement, or a release that cannot be safely rolled back. These must be closed or explicitly accepted by the owner before any production release.

### C1 - Shared default role PINs, including Manager `4444`

- **Evidence (VERIFIED):** `lib/config/security.js:6-10` defines `DEFAULT_WAITER_PIN=1111`, `DEFAULT_KITCHEN_PIN=2222`, `DEFAULT_BARISTA_PIN=3333`, `DEFAULT_HOT_DRINK_PIN=5555`, and `DEFAULT_MANAGER_PIN=4444`, each overridable only by an environment variable. `scripts/seed-auth.js:15-46` seeds the same values and prints them to the console. `app/api/manager/staff/route.js:280` resets **all staff with the target role** via `Staff.updateMany({ role: targetRole }, ...)`.
- **Why critical:** If the environment variables are not set, every deployment starts with known Manager credentials. A role-wide reset means one Manager action changes every Manager's PIN and revokes their sessions. The seed script writes the plaintext PINs to logs.
- **Gap:** No forced first-login rotation, no per-user Manager PIN, no lockout, and no deployment check that default PINs were overridden.
- **Label:** VERIFIED for the code and seed behavior; the actual production values are UNVERIFIED because no environment was read.

### C2 - Public payment account exposure

- **Evidence (VERIFIED):** `app/api/payment-info/route.js:23-37` handles `GET` with no `requireAuth` call and serializes `bankName`, `ownerName`, and `accountNumber`. The comment at line 24 says "Public read." Write operations (`POST`/`PUT`/`DELETE`) do require `MANAGER` (`route.js:47`, `83`, and following).
- **Why critical:** Bank account numbers and account-owner names are exposed to any unauthenticated caller. Even if the business intends customers to see transfer details, the endpoint returns **all** records, including inactive ones, and the response is not scoped to a single order or payment session.
- **Gap:** No authentication, no field minimization, no per-order scoping, and no documented decision that public exposure is intended.
- **Label:** VERIFIED.

### C3 - Background `syncIndexes()` on connection

- **Evidence (VERIFIED):** `lib/mongodb.js:53-71` defines `syncIndexesInBackground(conn)`, which calls `syncIndexes()` for Order, Staff, Category, MenuItem, and InventoryAudit; line 149 invokes it after connection. `scripts/sync-indexes.js:19` also calls `Order.syncIndexes()`.
- **Why critical:** Mongoose `syncIndexes()` creates missing indexes and **drops indexes that are not in the schema**. On a production database, a schema change or a connection during a deployment can silently remove an index that operations added, or create an index during peak traffic. This bypasses the explicit, guarded deployment process that Phase 2.0 built.
- **Gap:** No environment gate, no dry run, no audit record, and no owner approval before index changes.
- **Label:** VERIFIED for the code path; the actual production impact is INFERRED (depends on the live index set, which was not inspected).

### C4 - No backup or restore evidence

- **Evidence (VERIFIED absence):** A repository-wide search for `mongodump`, `mongorestore`, `backup`, `restore`, `snapshot`, and `retention` found no backup script, runbook, or documented restore test. The only matches were unrelated field names such as `beforeSnapshot`.
- **Why critical:** Without a tested restore, any data-loss incident (bad migration, destructive reset, index failure, operator error) is unrecoverable within a known RTO/RPO. Atlas may provide automated backups, but that is **UNVERIFIED** and does not replace a restore test.
- **Gap:** No RTO/RPO, no restore drill, no backup verification, no retention schedule.
- **Label:** VERIFIED absence in the repository; the hosting provider's actual backup configuration is UNVERIFIED.

### C5 - No CI and no real-database integration tests

- **Evidence (VERIFIED):** There is no `.github/` directory and no CI configuration in the repository. `netlify.toml:1-6` only runs `npm run build`. The 1291-test suite is DB-free; transaction tests use stub sessions (`docs/inventory-v2-phase2-foundations.md:296-300`). No test connects to a real MongoDB (VERIFIED by searching `tests/*.test.mjs` for `mongoose.connect`/`createConnection`; only a guarded Hotel test uses a test URI variable).
- **Why critical:** The build gate does not run the regression suite, and the most failure-prone behavior (transactions, unique indexes, concurrency) has never been exercised against a real server. A green local run does not prove a deployable artifact.
- **Gap:** No CI pipeline, no disposable MongoDB service, no migration/index test job, no artifact promotion.
- **Label:** VERIFIED.

### C6 - No health endpoint, monitoring, or operational alerts

- **Evidence (VERIFIED):** No `app/**/health` route exists. `instrumentation.js:9-19` only warms the database connection and notes that tracing/metrics are a future extension. There is no metrics exporter, alert rule, dashboard, or error tracker in the repository. Operational signals are `console.log`/`console.warn`/`console.error` calls.
- **Why critical:** The team cannot detect a failed inventory deduction, a transaction outage, a 503 storm, or a background index failure except by user report. There is no readiness/liveness probe for a platform or load balancer.
- **Gap:** No `/api/health`, no structured logs, no metrics, no alert routing, no on-call ownership.
- **Label:** VERIFIED absence; the hosting provider's platform metrics are UNVERIFIED.

### C7 - Destructive `clear-orders` reset

- **Evidence (VERIFIED):** `app/api/manager/settings/clear-orders/route.js:55-91` deletes every order, deletes all reservations except `CONSUMED`/`CONSUMING`, sets `reservedStock: 0` on every item when no `CONSUMING` reservation exists, and resets the order counter. It requires a Manager session and the requesting Manager's own PIN (`route.js:22-53`).
- **Why critical:** This is an irreversible global data reset. The PIN step-up is good, but there is no second approver, no export/backup step, no dry-run count, and no V2 awareness. In a V2 environment it would erase V2 holds without releasing allocations.
- **Gap:** No dual control, no pre-reset snapshot, no V2 guard, no audit record of what was deleted.
- **Label:** VERIFIED.

### C8 - Best-effort inventory hooks swallow failures

- **Evidence (VERIFIED):** `lib/orderService.js:235-246` wraps inventory calls in `runInventoryHook`, catches every error, logs a warning, and returns `null`. Callers include reservation creation (`orderService.js:437-438`), release after archive/cancel (`1149`, `1192`, `1220`), and post-payment consumption (`1000-1018`). `applyPaidInventory` attempts a release if consumption failed, but that release is itself best-effort.
- **Why critical:** An order can be created, cancelled, or paid while its inventory reservation, consumption, or release silently fails. The order flow stays green; stock drifts. `assertOrderInventoryReady` blocks preparation when a reservation is missing (`inventoryReservationService.js:620-631`), which mitigates one path, but it does not cover payment or release failures.
- **Gap:** No durable retry queue, no reconciliation alarm, no operator-visible "inventory out of sync" state.
- **Label:** VERIFIED.

### C9 - Unverified MongoDB topology against a transaction-dependent V1

- **Evidence (VERIFIED):** V1 deduction and waste use sessions and transactions (`lib/inventoryDeductionService.js:258-330`, `lib/inventoryWasteService.js:51-165`). The V2 transaction helper maps an unsupported topology to a 503 (`lib/inventory-v2/server/transaction.js:108-129,302`). No topology evidence, replica-set status, or failover test exists in the repository (VERIFIED absence).
- **Why critical:** A standalone MongoDB will accept `startSession()` and then reject the first transactional write. That means payment deduction and waste recording can fail in production even though every DB-free test passes. The transaction budget is also not tied to the platform's request timeout.
- **Gap:** Topology confirmation, failover test, timeout budget, and unknown-commit drill are all missing.
- **Label:** VERIFIED for the dependency; UNVERIFIED for the live topology.

---

## 4. High risks

High means: a serious correctness, security, or operational gap that should be closed before a broad release, but a controlled pilot may proceed with compensating controls.

### H1 - No separation of duties in Manager approval

- **Evidence (VERIFIED):** `approveInventoryShortage` validates `managerRole === "MANAGER"`, a reason of 3-500 characters, and a 64-hex shortage fingerprint (`lib/inventoryReservationService.js:691-715`). It does not check that the approving Manager is different from the order creator/owner.
- **Risk:** A Manager can approve a shortage on their own order, weakening the control the approval is meant to provide.
- **Gap:** No `approver != requester` rule, no second approver for high-value shortages, no approval amount threshold.
- **Label:** VERIFIED for the absence of the check; the practical exposure is INFERRED.

### H2 - Hotel module is explicitly not production-ready

- **Evidence (VERIFIED):** `docs/hotel-foundation.md:11-14` states the module is "not production-ready and not a complete Hotel system: no Hotel UI beyond the Reception screen, guest requests, seed/migration has not been implemented," and that no indexes have been deployed and no live-database integration test has been run. The Hotel connection uses a separate `ROOM_MONGODB_URI` and `HOTEL_SESSION_SECRET` (`hotel-foundation.md:39-51`). The index deployment script is documented but unexecuted (`hotel-foundation.md:1043-1065`).
- **Risk:** Treating Hotel as part of the POS release would ship an unverified, incomplete subsystem.
- **Gap:** Hotel provisioning, indexes, integration tests, UI, and operational runbook.
- **Label:** VERIFIED (the documentation says so).

### H3 - No room-service / POS integration

- **Evidence (VERIFIED absence):** A repository search for `roomService`, `room service`, hotel-order linkage, and folio-order linkage found no integration between Hotel stays/folios and POS orders. The Hotel folio and the POS order pipeline are separate.
- **Risk:** If the release scope promises room charges or room-service ordering, that behavior does not exist and cannot be tested.
- **Gap:** Product decision and, if required, a separate integration project.
- **Label:** VERIFIED absence; the intended scope is UNVERIFIED.

### H4 - No data retention or privacy policy

- **Evidence (VERIFIED absence):** No retention schedule, archive policy, privacy notice, or deletion procedure exists for orders, payments, audit events, sessions, or Hotel guest data.
- **Risk:** Unbounded growth, unclear legal obligations, and accidental retention of personal data beyond policy.
- **Gap:** Owner-approved retention matrix per collection, including `inventory_v2_*` when introduced.
- **Label:** VERIFIED absence.

### H5 - In-memory rate limiting and single-instance SSE

- **Evidence (VERIFIED):** `lib/rateLimit.js:3-11` uses a process-local `Map` and states that multi-instance needs Redis. `proxy.js:12-15` uses a separate in-memory map with different limits. `lib/eventHub.js` is an in-process pub/sub hub; README documents that multi-instance needs Redis.
- **Risk:** On more than one instance, limits are per-instance and real-time events do not reach clients connected to another instance. A restart clears all limits.
- **Gap:** Shared limiter and event bus (for example Redis), or an explicit single-instance deployment constraint.
- **Label:** VERIFIED.

### H6 - No boot-time environment validation

- **Evidence (VERIFIED):** `lib/mongodb.js:4` reads `MONGODB_URI`; `lib/sessionCrypto.js:9` reads `AUTH_SECRET`; no module validates required keys or rejects a missing/weak secret at startup. `.env.example` lists the keys, and `.gitignore` excludes `.env*` (VERIFIED).
- **Risk:** A missing or short `AUTH_SECRET` can fail at first request or, worse, run with an unintended value. A missing `MONGODB_URI` produces a runtime 503 instead of a failed deploy.
- **Gap:** Fail-fast configuration validation with a clear error and no secret logging.
- **Label:** VERIFIED absence.

### H7 - No staging or rollback runbook

- **Evidence (VERIFIED):** `netlify.toml:1-6` defines a build and publish target. No staging environment, release checklist, rollback procedure, or database rollback plan exists in the repository.
- **Risk:** A bad deploy has no documented recovery path, and there is no environment where a release candidate can be exercised against production-like data.
- **Gap:** Staging environment, artifact promotion, rollback drill, and database restore procedure.
- **Label:** VERIFIED absence; the provider's deploy history is UNVERIFIED.

### H8 - Incomplete audit coverage

- **Evidence (VERIFIED):** Hotel audit is explicitly best-effort and non-transactional (`docs/hotel-foundation.md:1282-1287`). Inventory audit records exist for inventory mutations (`lib/inventoryAuditService.js`), but there is no unified audit log covering every order, payment, auth, and settings mutation. Order lifecycle changes are not written to a dedicated audit collection.
- **Risk:** Disputes and incident reviews cannot reconstruct who changed what, when, and from which order version.
- **Gap:** A durable, append-only audit event for every state transition, with actor, order version, before/after, and correlation ID.
- **Label:** VERIFIED for the Hotel limitation; the broader coverage gap is INFERRED from the absence of a unified audit module.

### H9 - No per-account PIN lockout

- **Evidence (VERIFIED absence):** A search for `lockout`, `failedAttempts`, `accountLock`, and `tooManyAttempts` found nothing. `app/api/auth/verify-pin/route.js` uses `RATE_LIMITS.AUTH` (5 requests/minute per IP) but no per-account counter.
- **Risk:** An attacker with a valid username/role can spread attempts across IPs; a four-digit PIN space is small.
- **Gap:** Per-account exponential backoff or temporary lock, plus alerting.
- **Label:** VERIFIED absence; exploitability depends on network controls (UNVERIFIED).

### H10 - No dependency or container security scanning

- **Evidence (VERIFIED absence):** No Dependabot/Renovate config, no `npm audit` gate, no SBOM, and no image scan. `package.json` pins Next `16.3.1`, React `19.2.8`, and Mongoose `9.9.2`.
- **Risk:** A known vulnerability can reach production without a gate.
- **Gap:** Automated dependency review and a documented patch SLA.
- **Label:** VERIFIED absence.

### H11 - Order concurrency has no version token outside line cancellation

- **Evidence (VERIFIED):** `lib/models/Order.js` has no `orderVersion` (Phase 2.0 verified). `lib/orderService.js` uses `updatedAt` only in `cancelOrderItem`; the broader mutation inventory documents that every concurrency-sensitive writer should eventually carry `orderVersion` (`lib/inventory-v2/server/orderMutationInventory.js`). No optimistic concurrency check exists on status transitions or payment.
- **Risk:** Two concurrent writers (for example, two stations or a Manager cancel racing a payment) can overwrite each other or produce a state that does not match the stock ledger.
- **Gap:** `orderVersion` plus conditional filters on every mutation.
- **Label:** VERIFIED for the absence; the race window is INFERRED.

### H12 - V1/V2 ownership is documented but not enforced in live code

- **Evidence (VERIFIED):** `lib/inventory-v2/server/ownership.js` defines the ownership model and error codes, but no live route imports it. `inventoryMode` is not on the Order (`lib/models/Order.js`), and V1 services do not reject V2-owned orders because no V2 order exists yet.
- **Risk:** When V2 is introduced without the ownership check, V1 and V2 can both mutate the same order's stock.
- **Gap:** D7 and D8 must be implemented before V2 wiring.
- **Label:** VERIFIED; this is a V2-activation risk, not a current V1 production blocker.

---

## 5. Medium risks

### M1 - Report cache staleness and missing hot-drink performance

- **Evidence (VERIFIED):** `lib/reportService.js:48-84` caches reports for 30s. `lib/analytics.js:592-619` builds `kitchenPerf` and `baristaPerf` but not `hotDrinkPerf`; `hotDrinkRevenue` is present (`analytics.js:730`). The Jebena Buna station writes `hotDrinkStaffId`/timestamps, but analytics does not aggregate them.
- **Risk:** A Manager can see a stale total for up to 30s, and hot-drink staff performance is missing from analytics even though revenue is counted.
- **Gap:** Cache invalidation on mutation or an explicit "as of" timestamp; add `hotDrinkPerf` enrichment.
- **Label:** VERIFIED.

### M2 - Generic error handling without request correlation

- **Evidence (VERIFIED):** `lib/withApi.js:40-52` maps DB errors to 503 and other errors to a generic 500, and never leaks a stack trace. It logs server-side but does not attach a request ID or structured context.
- **Risk:** Incident triage requires correlating free-text logs; a user cannot report a traceable ID.
- **Gap:** Request/correlation IDs in logs and responses, structured JSON logs.
- **Label:** VERIFIED.

### M3 - Index deployment scripts are unexecuted

- **Evidence (VERIFIED):** `scripts/inventory-v2-deploy-indexes.mjs` and the Hotel index script exist but have never been run (`docs/inventory-v2-phase2-foundations.md:360-362`; `docs/hotel-foundation.md:13-14`). `scripts/sync-indexes.js` is a separate, less guarded path.
- **Risk:** The scripts may fail on a real cluster (permissions, duplicates, index option conflicts) on the first production attempt.
- **Gap:** Dry run on a disposable database, then staging.
- **Label:** VERIFIED.

### M4 - Session policy is defined but not operationally approved

- **Evidence (VERIFIED):** `lib/models/Session.js:42-87` defines absolute (~8h) and idle (~30min) expirations and a TTL index on `expiresAt`; `lib/serverAuth.js` resolves a live Staff identity and treats `roleSnapshot` as audit-only.
- **Risk:** The values are reasonable but have not been reviewed against the hotel/POS shift model; a shared terminal with a long idle window is a risk.
- **Gap:** Owner-approved session policy and a test for idle/absolute expiry and revocation.
- **Label:** VERIFIED for the implementation; policy approval is UNVERIFIED.

### M5 - Duplicate rate-limit definitions with different limits

- **Evidence (VERIFIED):** `lib/rateLimit.js:74-84` defines `AUTH` 5/min, `MANAGER` 10/min, `ORDER_CREATE` 30/min, `GENERAL` 100/min, `MENU` 60/min. `proxy.js:6-10` defines `/api/auth/` 10/min, `/api/manager/` 20/min, `/api/orders` 60/min. Both are in-memory and independent.
- **Risk:** A request can be limited twice with different thresholds, or bypass one layer depending on the route; operators cannot reason about a single limit.
- **Gap:** One authoritative limiter or a documented composition.
- **Label:** VERIFIED.

### M6 - No incident response or on-call ownership

- **Evidence (VERIFIED absence):** No incident runbook, severity matrix, escalation path, or on-call rotation exists in the repository.
- **Risk:** A production failure has no defined first responder or communication path.
- **Gap:** Incident response plan and ownership.
- **Label:** VERIFIED absence.

### M7 - Unbounded audit and evidence growth

- **Evidence (VERIFIED):** `InventoryAudit`, `StockMovement`, `Session`, and the proposed `inventory_v2_audit_events`/`inventory_v2_payment_evidence` collections have no retention or archival policy. `Session` has a TTL (`Session.js:75-87`), but the others do not.
- **Risk:** Storage growth and slower queries over time.
- **Gap:** Retention/archival per collection.
- **Label:** VERIFIED absence.

### M8 - Documentation claims exceed evidence

- **Evidence (VERIFIED):** `README.md:3` describes the system as "Production-ready," while `docs/hotel-foundation.md:11-14` says the Hotel module is not production-ready, and this assessment finds no backup/CI/monitoring evidence.
- **Risk:** Stakeholders may treat an aspirational README statement as an audit result.
- **Gap:** Align README status with the evidence and link to this assessment.
- **Label:** VERIFIED.

---

## 6. Low risks

| ID | Finding | Evidence | Label |
|---|---|---|---|
| L1 | Node emits `MODULE_TYPELESS_PACKAGE_JSON` because `package.json` has no `"type": "module"` | Recorded in `docs/inventory-v2-phase2-foundations.md:320-322`; observed in the test run | VERIFIED |
| L2 | Documentation set contains overlapping Phase A/B and foundation documents with no index | `docs/` file listing | VERIFIED |
| L3 | Some manifest/translation strings render with encoding artifacts in shell output | `app/manifest.js:8`, `app/page.js:199` | VERIFIED for output; source encoding is INFERRED |
| L4 | No changelog or release notes process | Repository search | VERIFIED absence |

---

## 7. Area-by-area assessment

### 7.1 Authentication and authorization - **CRITICAL**

- Server-side session authority is well designed: `lib/serverAuth.js` resolves a live Staff identity, treats `roleSnapshot` as audit-only, and fails closed on revoked/expired/malformed sessions (VERIFIED).
- PINs are scrypt-hashed with a random salt and constant-time comparison (`docs/hotel-foundation.md:120-127`; `lib/pinCrypto.js`).
- **Gap:** shared default role PINs (C1), role-wide Manager reset, no per-account lockout (H9), and no boot-time secret validation (H6).
- **Label:** VERIFIED for the session design; the credential lifecycle is the critical gap.

### 7.2 Manager approvals and evidence validation - **HIGH**

- Approval requires a Manager session, the Manager's own PIN, a reason, and a shortage fingerprint (`app/api/orders/[id]/inventory-approval/route.js:38-53,105-118`; `inventoryReservationService.js:691-715`).
- The fingerprint prevents approval of a changed shortage snapshot (VERIFIED).
- **Gap:** no separation of duties (H1), no high-value threshold, no dual approval, and no V2 evidence validation path (V2 is not wired).
- **Label:** VERIFIED.

### 7.3 Order lifecycle and concurrency - **HIGH**

- The lifecycle is centralized in `lib/orderService.js` and covers create, status, serve, pay, cancel, archive, and line-level cancellation (VERIFIED).
- Inventory reservation is asserted before preparation (`orderService.js:538`; `inventoryReservationService.js:620-631`).
- **Gap:** no `orderVersion` on the Order; `updatedAt` is used only for line cancellation (H11); best-effort hooks (C8).
- **Label:** VERIFIED for the lifecycle; concurrency safety is INFERRED and incomplete.

### 7.4 Payment idempotency and accounting consistency - **HIGH**

- `payOrder` returns the existing order if already `PAID` and supports a payment-method update on retry (`lib/orderService.js:984-1061`) (VERIFIED).
- `StockMovement` has a unique partial index on `{ refOrderId, reason, item }` for `SaleDeduction`, which protects against duplicate deduction rows (`lib/models/StockMovement.js:69-77`) (VERIFIED).
- Transfer payments validate an active account and snapshot it (`orderService.js:1622-1638`) (VERIFIED).
- **Gap:** no idempotency key on the order-payment endpoint, no `orderVersion` binding for evidence, and no independent reconciliation of cash vs. stock vs. ledger. V2 payment readiness is not wired (D10).
- **Label:** VERIFIED for the existing safeguards; end-to-end accounting consistency is UNVERIFIED.

### 7.5 Inventory reservation, deduction, release, reconciliation - **CRITICAL**

- V1 reservation lifecycle is documented and implemented (`lib/models/InventoryReservation.js`; `lib/inventoryReservationService.js`).
- Consumption and waste use transactions (VERIFIED).
- `availableStock = currentStock - reservedStock` is used by alerts and waste (`inventoryAlertService.js:7-15`; `inventoryWasteService.js:60-97`) (VERIFIED).
- **Gap:** best-effort hooks (C8), no reconciliation job (D6), no drain procedure (D5), destructive clear-orders (C7), and no real-DB transaction test (C9).
- **Label:** VERIFIED for the logic; production consistency is UNVERIFIED.

### 7.6 Kitchen, Barista, and Jebena Buna station workflows - **MEDIUM**

- Phase A/B documents describe a peer-station design with a shared `KitchenDisplay`, `stationStatus`, and additive `HOT_DRINK` fields (`docs/phase-a-jebena-buna-station-architecture.md`, `docs/phase-b-jebena-buna-station-implementation.md`) (VERIFIED).
- The 1291-test suite includes KDS separation, action precision, and station tests, all passing (VERIFIED).
- **Gap:** station workflows depend on in-memory SSE and rate limiting (H5); analytics lacks `hotDrinkPerf` (M1); no production load test.
- **Label:** VERIFIED by test and source; production load behavior is UNVERIFIED.

### 7.7 Hotel rooms and room service - **HIGH (separate track)**

- Hotel has room types, rooms, guests, reservations, check-in/out, stays, folio, and payments (`app/api/hotel/**`; `docs/hotel-foundation.md`) (VERIFIED).
- The module is explicitly not production-ready, has no deployed indexes, no live integration test, and no UI beyond Reception (`hotel-foundation.md:11-14`) (VERIFIED).
- No room-service/POS integration exists (H3).
- **Label:** VERIFIED.

### 7.8 Reports and financial totals - **MEDIUM**

- Revenue breakdown covers kitchen, barista, hot drink, and total paid, with cancelled lines excluded (`lib/reportRevenueBreakdown.js:46-95`) (VERIFIED).
- Reports are cached for 30s (`lib/reportService.js:48-84`) (VERIFIED).
- **Gap:** missing `hotDrinkPerf` (M1), no dual-read parity (D9), no finance reconciliation sign-off.
- **Label:** VERIFIED for the calculation; financial certification is UNVERIFIED.

### 7.9 Audit logging and traceability - **HIGH**

- Inventory audit records validate inputs and capture before/after snapshots (`lib/inventoryAuditService.js`) (VERIFIED).
- Hotel audit is best-effort and non-transactional (`hotel-foundation.md:1282-1287`) (VERIFIED).
- **Gap:** no unified audit for order/payment/auth/settings mutations (H8), no correlation ID (M2).
- **Label:** VERIFIED for the existing audit modules; coverage is incomplete.

### 7.10 Database indexes and migrations - **CRITICAL**

- Indexes are defined in schemas; explicit deployment scripts exist for V2 and Hotel but were never run (VERIFIED).
- Background `syncIndexes()` runs on connect for five models (C3) (VERIFIED).
- `scripts/sync-indexes.js` calls `Order.syncIndexes()` (VERIFIED).
- **Gap:** no migration runner, no schema-version table, no index drift check, no production index inventory.
- **Label:** VERIFIED for the code; production index state is UNVERIFIED.

### 7.11 Error handling and recovery - **MEDIUM**

- `withApi` maps DB errors to 503 and hides stack traces (`lib/withApi.js:40-52`) (VERIFIED).
- Transaction helpers classify transient vs. unknown commit (V2) and V1 services have some retry handling (VERIFIED).
- **Gap:** no dead-letter/retry queue for failed inventory hooks (C8), no request correlation (M2), no recovery runbook.
- **Label:** VERIFIED for the handlers; recovery is incomplete.

### 7.12 Backups and restore testing - **CRITICAL**

- No backup/restore script or runbook in the repository (C4) (VERIFIED absence).
- Hosting-provider backups are UNVERIFIED.
- **Label:** VERIFIED absence.

### 7.13 Secrets and environment configuration - **HIGH**

- `.env*` is gitignored and `.env.example` lists required keys (VERIFIED).
- No boot-time validation of `MONGODB_URI`, `AUTH_SECRET`, `ROOM_MONGODB_URI`, or `HOTEL_SESSION_SECRET` (H6) (VERIFIED absence).
- Hotel requires a separate `HOTEL_SESSION_SECRET` of at least 32 characters and a separate `ROOM_MONGODB_URI` (`hotel-foundation.md:39-51`) (VERIFIED).
- **Label:** VERIFIED for the documentation; actual secret provisioning is UNVERIFIED.

### 7.14 Rate limiting and session security - **HIGH**

- Session cookies use the `__Host-` prefix and server-side sessions (VERIFIED).
- Rate limiting is in-memory and duplicated (H5, M5) (VERIFIED).
- No per-account lockout (H9) (VERIFIED absence).
- **Label:** VERIFIED.

### 7.15 Monitoring and operational alerts - **CRITICAL**

- No health endpoint, metrics, dashboards, or alerting (C6) (VERIFIED absence).
- `instrumentation.js` only warms the DB (VERIFIED).
- **Label:** VERIFIED absence.

### 7.16 Deployment and rollback strategy - **HIGH**

- Netlify build configuration exists (`netlify.toml`) (VERIFIED).
- No staging, release checklist, rollback runbook, or database rollback plan (H7) (VERIFIED absence).
- **Label:** VERIFIED absence; actual deploy behavior is UNVERIFIED.

### 7.17 Data retention and privacy - **HIGH**

- No retention or privacy policy for orders, payments, audit, sessions, or guest data (H4) (VERIFIED absence).
- Session has a TTL; other collections do not (M7) (VERIFIED).
- **Label:** VERIFIED absence.

### 7.18 Automated test coverage and CI - **CRITICAL**

- 1291 tests, 223 suites, 0 failures, DB-free (VERIFIED).
- No CI and no real-database integration test (C5) (VERIFIED absence).
- Transaction tests use stub sessions (VERIFIED).
- **Label:** VERIFIED.

---

## 8. Verified / inferred / unverified register

### VERIFIED FROM SOURCE

- Shared default PINs including Manager `4444`; seed script prints them (`lib/config/security.js:6-10`; `scripts/seed-auth.js:15-46`).
- Manager PIN reset is role-wide (`app/api/manager/staff/route.js:280`).
- Public unauthenticated payment-info GET returning bank/account data (`app/api/payment-info/route.js:23-37`).
- Background `syncIndexes()` on connection (`lib/mongodb.js:53-71,149`).
- Best-effort inventory hooks (`lib/orderService.js:235-246`).
- Destructive `clear-orders` behavior (`clear-orders/route.js:55-91`).
- V1 inventory uses transactions (`inventoryDeductionService.js:258-330`; `inventoryWasteService.js:51-165`).
- V2 index plan and guarded deployment script, never executed (`indexPlan.js`; `scripts/inventory-v2-deploy-indexes.mjs`).
- No `.github/` CI, no health route, no backup script, no monitoring module (repository searches).
- Hotel module documented as not production-ready (`docs/hotel-foundation.md:11-14`).
- 1291/1291 DB-free tests pass.

### INFERRED

- The background `syncIndexes()` can drop or create production indexes and change query plans.
- The absence of a reconciliation job allows `reservedStock` to drift silently when hooks fail.
- A single-instance deployment is the only configuration in which the in-memory rate limiter and SSE hub are correct.
- The public payment-info endpoint exposes account data to anyone who can reach the origin.
- The current approval flow permits self-approval because no separation check exists.

### UNVERIFIED

- Actual MongoDB topology (replica set, mongos, or standalone) in every environment.
- Real transaction commit, timeout, failover, and unknown-commit behavior.
- Whether V2 or Hotel indexes can be created on the live database without conflicts.
- Whether the guarded deployment scripts run correctly against a real cluster.
- Backup configuration, retention, RTO, and restore success at the hosting provider.
- Actual secret values, strength, rotation, and provisioning.
- Production load, latency, and SSE fan-out behavior.
- Complete order-writer coverage (external integrations, ad-hoc scripts, direct database access).
- `orderVersion` compatibility with legacy orders and every writer.
- `inventoryMode` representation and legacy backfill.
- `inventoryreservations` retention/archive obligations.
- `reservedStock` reconciliation correctness on live data.
- Independent security and financial audit results.
- Hotel provisioning, first-Manager creation, and PIN login in a live environment.

---

## 9. Production blockers

The following must be closed, or explicitly accepted in writing by the owner, before a production release:

1. **C1** - Replace default/shared role PINs with per-user credentials; force rotation; remove plaintext PIN logging; define Manager reset scope.
2. **C2** - Authenticate and minimize the payment-info read, or document and scope an intentional public view.
3. **C3** - Remove `syncIndexes()` from the request/connection path; use explicit, approved index deployment only.
4. **C4** - Document RTO/RPO, configure backups, and complete a restore drill.
5. **C5** - Add CI that runs the regression suite and a disposable-MongoDB integration job.
6. **C6** - Add `/api/health` (liveness/readiness), structured logs, and at least one alert path.
7. **C7** - Add dual control and a pre-reset export/snapshot to `clear-orders`; add the V2 guard before V2 exists.
8. **C8** - Make inventory failures durable and visible; add a retry/reconciliation path.
9. **C9** - Confirm replica-set/mongos topology and prove transactions, failover, and the timeout budget against a real server.
10. **H6** - Validate required environment variables at boot.
11. **H7** - Establish staging and a rollback runbook.

V2 activation additionally requires D1-D10 from the owner decision matrix. Hotel release additionally requires its own provisioning, index deployment, integration tests, UI, and operational runbook.

---

## 10. What this assessment does not prove

- It does not prove the absence of controls at the hosting provider (backups, WAF, DDoS protection, platform monitoring).
- It does not prove the live database schema, index set, or data quality.
- It does not prove that the 1291 DB-free tests reflect real MongoDB behavior.
- It does not prove that the deployment pipeline produces the tested artifact.
- It does not certify financial totals or regulatory compliance.
- It does not audit third-party dependencies for vulnerabilities.

Any statement that BONO is "production-ready" must be backed by the missing evidence above, not by the README claim.

---

## 11. Recommended immediate owner actions

1. Approve or reject the ten decisions in `phase-2-1-owner-decision-matrix.md`.
2. Authorize a **security hardening sprint** covering C1, C2, C3, H6, and H9 before any production release.
3. Authorize a **reliability sprint** covering C4, C5, C6, C7, C8, C9, and H7.
4. Keep Hotel on a separate release track; do not bundle it with the POS release.
5. Treat Inventory V2 as design-complete but not activatable until D1-D10 are approved and the V2 gates in `production-release-roadmap.md` are met.
6. Correct the README status claim (M8) so it does not conflict with this assessment.
