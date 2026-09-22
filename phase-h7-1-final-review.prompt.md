# BONO H7.1 — FINAL SAFETY REVIEW (NO EDITS YET)

Repository: C:\hotelms

Act as a senior MongoDB/Mongoose engineer and application security reviewer.

OBJECTIVE:
Review current uncommitted H7.1 changes for correctness, transaction safety, and strict input validation. REVIEW ONLY. Do not edit files.

RULES:
- Inspect git status and diffs first.
- Never reset, stash, revert, overwrite, or delete user changes.
- Do not touch Order, orderService, SaleDeduction, payment, menu, recipes, waiter, kitchen, barista, cashier, or UI.
- No dependencies, migrations, indexes, commit, or push.
- Scope only: lib/inventoryWasteService.js and app/api/inventory/waste/route.js.
- Do not edit StockMovement.js or additional files.
- Do not claim tests passed unless actually run.

REVIEW:
1. Check installed Mongoose version and whether mongoose.isValidObjectId() strictly enforces a 24-character hexadecimal string. Test valid/invalid 24-hex, 12-character strings, empty strings, and non-string service inputs. Propose the smallest fix if needed; do not apply it.
2. Verify route and service reject missing/null/empty, zero/negative, NaN/Infinity, nonnumeric strings, booleans, arrays, and objects. Assess numeric-string compatibility without inventing unit conversion.
3. Inspect conditional decrement: {_id, currentStock: {$gte: qty}} with $inc in the same operation. Verify update result compatibility with installed driver.
4. Verify no StockMovement is created after failed decrement and both stock update and movement creation commit/abort together.
5. Analyze real concurrent requests, transaction write conflicts, transient transaction errors, and whether the follow-up findById(...).session(session) is valid after failed update in the transaction. Do not assume mock tests prove MongoDB behavior.
6. Check initial item read outside transaction for stale-state risks; classify missing/inactive/insufficient/unexpected failures accurately; ensure no partial commit.
7. Confirm H2 cost snapshot and StockMovement schema remain unchanged; SaleDeduction/order flow, auth, and API conventions remain untouched.
8. Inspect actual test scripts/results. Separate real tests, static/mock checks, and tests not run.

REQUIRED REPORT:
- Findings by Critical/Important/Minor/No issue.
- ObjectId conclusion with evidence.
- Transaction/concurrency conclusion with evidence and limitations.
- Minimal correction needed, exact file/area, and tests required.
- Confirm changed-file list and forbidden-workflow preservation.
- Stop after reporting. Do not edit until explicit approval.
