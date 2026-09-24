# Session Collection — Production Index Deployment Procedure (ARCH-7)

Status: **PREPARED ONLY — NOT EXECUTED.**

No index operation in this document has been run. Do not run any step
against production until the ARCH-8 entry criteria (see final section of
`lib/models/Session.js` header and the AUTH-ARCH-7 report) are satisfied
and a maintenance window with a verified backup is scheduled.

## 1. Intended index set (defined in `lib/models/Session.js` ONLY)

| # | Key | Options | Purpose |
|---|-----|---------|---------|
| 1 | `{ sessionId: 1 }` | `unique: true` | Primary hot-path lookup for every authenticated request |
| 2 | `{ staffId: 1, revokedAt: 1 }` | — | Per-staff session listing + revocation sweeps (`revokeAllStaffSessions`) |
| 3 | `{ expiresAt: 1 }` | `expireAfterSeconds: 0` | TTL: MongoDB auto-deletes expired sessions; no app deletes needed |
| 4 | `{ tabTokenHash: 1 }` | `unique: true, sparse: true` | AUTH-ARCH-11 tab-credential lookup (only tab-bound rows indexed) |

Expected MongoDB index names (default naming): `sessionId_1`,
`staffId_1_revokedAt_1`, `expiresAt_1`, `tabTokenHash_1`. Create #4 with the
same procedure (§4 adds one `createIndex` statement below); still
PREPARED ONLY — NOT EXECUTED.

Additional single-field indexes Mongoose derives from field-level flags
(`staffId_1`, `roleSnapshot_1`, `revokedAt_1`, `idleExpiresAt_1`) are
acceptable if created; they are NOT required. Do NOT create duplicates
manually — one `createIndex` per key/options pair.

Known past conflict (fixed in code, ARCH-7): a field-level `index: true`
on `expiresAt` previously duplicated the TTL definition with different
options (same name, `IndexOptionsConflict` on deploy). The field-level
flag was removed; the schema-level TTL definition is the single source.

## 2. Pre-deployment requirements

1. **Verified backup/snapshot** of the production database (Atlas snapshot
   or `mongodump`), with restore tested or recently proven.
2. Confirm the `sessions` collection exists and note its document count:
   `db.sessions.countDocuments({})`. Empty is expected pre-rollout.
3. Record the current index state: `db.sessions.getIndexes()`. Any
   pre-existing `expiresAt_1` WITHOUT `expireAfterSeconds` must be dropped
   **only** with explicit approval (see §5).
4. Confirm application version deployed includes the ARCH-7 model file
   (TTL definition present, no field-level `expiresAt` flag).

## 3. Deployment window

- Indexes 1 and 2 are small-key builds; TTL (3) is likewise cheap on an
  empty/small collection. Any non-trivial collection size requires a
  low-traffic window; monitor build progress (`db.currentOp()`).
- The application MUST NOT depend on the TTL for correctness during
  rollout: expiry is always enforced in application code
  (`isSessionTimeValid`), TTL is garbage collection only. The app runs
  correctly with zero Session indexes (slower lookups), so index creation
  order is not load-bearing.

## 4. Create ONLY the required indexes (example, `mongosh`)

```js
db.sessions.createIndex({ sessionId: 1 }, { unique: true, name: "sessionId_1" });
db.sessions.createIndex({ staffId: 1, revokedAt: 1 }, { name: "staffId_1_revokedAt_1" });
db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "expiresAt_1" });
db.sessions.createIndex({ tabTokenHash: 1 }, { unique: true, sparse: true, name: "tabTokenHash_1" });
```

Do NOT run `syncIndexes()` from the application against production in this
procedure (it may drop unknown-but-intentional indexes). Prefer the three
explicit statements above.

## 5. Destructive operations — explicit approval only

- Never `dropDatabase`, never drop the `sessions` collection.
- Never drop an index unless it blocks creation (name conflict with
  different options) AND the conflicting index is proven redundant by
  comparing `getIndexes()` output key-by-key.
- If a conflicting `expiresAt_1` (non-TTL) exists: after backup, run
  `db.sessions.dropIndex("expiresAt_1")`, then re-run the TTL statement
  from §4, then verify `getIndexes()` shows `expireAfterSeconds: 0`.

## 6. Post-deployment verification

1. `db.sessions.getIndexes()` shows exactly the §1 set (plus any
   pre-approved extras — record them).
2. `db.sessions.find({ sessionId: "<test-id>" }).explain("executionStats")`
   uses `sessionId_1` (`IXSCAN`, not `COLLSCAN`) on a staging-equivalent
   dataset. Never use production PII/session IDs for this check.
3. Application login/logout/revocation smoke-tested in staging first;
   production smoke test is one login + one logout only.
4. Monitor slow-query logs for `sessions` `COLLSCAN` for 24h.

## 7. Rollback / mitigation

- Index creation is additive and reversible: `db.sessions.dropIndex(name)`
  per index. Dropping all three returns the app to pre-deployment behavior
  (correct, slower) — application code needs NO rollback for an index-only
  revert because expiry/revocation are enforced in code, not by indexes.
- If the TTL was misconfigured (wrong field/seconds), drop and recreate
  per §4–§5; already-expired documents that were NOT yet TTL-deleted are
  still rejected by `isSessionTimeValid` — no auth bypass at any point.
- Code rollback (if the deployment rides with a release) follows the
  standard release rollback; cookie compatibility is preserved because
  legacy `bono_sess` issuance/verification remains until ARCH-8.

## 8. Application compatibility during rollout

- Old app versions do not know the `sessions` collection: creating indexes
  on it affects nothing they do.
- New app versions work with or without the indexes (fail-closed reads,
  code-enforced expiry). There is no flag day.
