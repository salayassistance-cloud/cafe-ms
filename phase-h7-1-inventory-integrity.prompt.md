# BONO PHASE H7.1 — INVENTORY DATA INTEGRITY HARDENING

You are working in the Bono restaurant management system repository:
C:\hotelms

Act as a senior full-stack engineer, software architect, and application security engineer.

## OBJECTIVE
Safely harden inventory data integrity for H7.1 only.
Use the existing architecture and coding conventions. Do not redesign or refactor unrelated code.

## ABSOLUTE SAFETY RULES
1. Inspect git status and existing diffs BEFORE editing.
2. Never reset, stash, revert, overwrite, or delete existing user changes.
3. Do not modify Order schema, orderService, payment logic, order lifecycle, menu, recipes, waiter, kitchen, barista, cashier, or UI.
4. Do not modify the existing SaleDeduction/order deduction flow in this phase.
5. No database migration, backfill, data deletion, or bulk rewrite.
6. Do not add dependencies.
7. Do not broaden the file scope without stopping and reporting the reason.
8. Preserve current API response conventions and authorization patterns.
9. Do not claim tests passed unless actually run.

## PHASE SCOPE
Focus on validating inventory waste deductions and preventing negative stock safely.

First inspect:
- lib/models/StockMovement.js
- lib/models/InventoryItem.js
- lib/inventoryWasteService.js
- app/api/inventory/waste/route.js
- lib/inventoryValidation.js
- lib/security.js
- lib/policy.js
- Existing inventory item and movement APIs
- Relevant tests/scripts, if present

## REQUIRED INSPECTION
Before editing, report:
- Current validation rules for waste itemId and quantity
- Current stock decrement implementation and whether it is atomic
- Whether concurrent waste requests could reduce stock below zero
- Existing StockMovement schema constraints and compatibility risks
- Exact proposed files to change

If safe implementation requires modifying SaleDeduction, orderService, Order schema, payment, or other forbidden areas, STOP and report. Do not make those changes.

## IMPLEMENTATION REQUIREMENTS
Within the approved inventory-only scope:

A. Waste input validation
- Require a valid ObjectId itemId.
- Require finite numeric quantity > 0.
- Reject missing, null, non-numeric, NaN, Infinity, zero, and negative values.
- Preserve the existing unit/quantity conventions. Do not invent unit conversion.
- Preserve established API error response style.

B. Prevent negative stock for waste
- Use an atomic conditional update that only decrements when sufficient stock is available.
- The stock check and decrement must not be separate non-atomic operations.
- Handle missing item, inactive item, invalid quantity, and insufficient stock distinctly using existing project conventions.
- Ensure a failed stock update does not create a StockMovement record.
- Keep the stock update and StockMovement creation transactionally consistent using the existing transaction pattern.
- Consider concurrent requests; a prior read alone is not sufficient protection.
- Do not silently clamp quantity or stock to zero.

C. StockMovement model
- Inspect whether safe schema-level validation can be added without breaking existing supported movement reasons or legacy records.
- Do not add restrictive enums or required fields unless every existing writer and legacy compatibility case is verified.
- Do not modify existing indexes.
- If model-level changes are unsafe or outside scope, leave the model untouched and report why.

D. Compatibility
- Preserve the H2 cost snapshot fields and behavior.
- Do not alter historical StockMovement records.
- Do not change InventoryItem.cost or cost history.
- Do not add any UI.

## FILE SCOPE
Prefer only:
- lib/inventoryWasteService.js
- app/api/inventory/waste/route.js

Only include lib/models/StockMovement.js if inspection proves a narrowly scoped, backward-compatible validation change is safe. If additional files are required, stop and ask before editing.

## TESTING
Run applicable existing tests if available.
At minimum, verify:
- Valid waste within available stock succeeds.
- Quantity 0 is rejected.
- Negative quantity is rejected.
- NaN/Infinity/non-numeric input is rejected.
- Missing item returns the established not-found response.
- Inactive item is rejected.
- Waste quantity greater than available stock is rejected.
- Failed/insufficient waste does not create a movement.
- Concurrent waste attempts cannot produce negative currentStock.
- Existing SaleDeduction behavior is untouched.

Do not fake a database test. If MongoDB integration tests cannot run, clearly label them NOT RUN and provide a manual test plan.

## VERIFICATION
Run:
git status --short
git diff --name-only
git diff -- lib/models/Order.js
git diff -- lib/orderService.js
npm run build

Inspect the final diff carefully. Confirm no unrelated files changed.

## STOP CONDITIONS
Stop without editing if:
- Existing user changes are present and may conflict.
- The proposed change requires touching forbidden order/payment workflows.
- The current transaction/model pattern cannot be safely preserved.
- A test reveals an unrelated regression.

## FINAL REPORT
Report:
1. Files changed
2. Exact behavior hardened
3. Validation and concurrency strategy
4. Tests actually run and results
5. Build result
6. Confirmation of Order/payment/kitchen/barista/waiter/cashier preservation
7. Any unresolved risks

Do not begin H7.2, audit logs, cost history, indexes, dashboard changes, or other phases.
