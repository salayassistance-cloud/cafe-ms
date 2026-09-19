# BONO INVENTORY — PHASE A MASTER PROMPT
# UI SHELL ONLY — STRICT FILE SCOPE

You are working on the existing Bono restaurant management system
in the current repository: C:\hotelms.

Your task is to implement Phase A: an Inventory UI shell and a
sixth Inventory portal on the homepage.

The existing application is working. Preserve its behavior.

============================================================
1. FIRST: INSPECT BEFORE EDITING
============================================================

Before making changes:

1. Inspect the current Git branch and working tree.
2. Inspect app/page.js and understand the existing five portal cards.
3. Inspect the existing manager page protection/layout pattern.
4. Inspect existing UI components, styles, colors, icons, and
   responsive behavior.
5. Check whether inventory-related files or routes already exist.
6. Identify existing uncommitted changes.

Do not overwrite, discard, reset, stash, or revert user changes.
Do not assume the working tree is clean.

If an existing file conflicts with this task, stop and explain
the conflict instead of overwriting it.

============================================================
2. ABSOLUTE SCOPE RESTRICTION
============================================================

ONLY these files may be created or modified:

- app/page.js
- app/manager/inventory/page.js
- app/components/InventoryUI.jsx

No other files may be changed.

Do not modify:
- API routes or handlers
- Backend services
- Database models, schemas, or connection logic
- Authentication or authorization logic
- Middleware or proxy configuration
- Existing POS/order/payment logic
- Waiter, kitchen, barista, cashier functionality
- Existing menu, reports, staff, or settings logic
- package.json or dependencies
- Global CSS, shared styles, or shared components
- Environment/configuration files
- Tests or scripts

Do not install dependencies.

If the task cannot be completed within the allowed files,
STOP and report why. Do not expand the scope.

============================================================
3. HOMEPAGE — app/page.js
============================================================

Add exactly one new portal card:

Name: Inventory
Destination: /manager/inventory
Role: MANAGER

Requirements:

- Reuse the existing portal card architecture.
- Match existing card dimensions, spacing, typography,
  colors, shadows, hover behavior, and responsive layout.
- Preserve all existing five portal cards unchanged.
- Do not redesign or refactor the homepage.
- Do not change existing portal destinations or permissions.
- Add a suitable filled inventory icon using the existing
  icon library, if available.
- Do not add dependencies or create a new icon system.
- Follow existing role-based access and navigation conventions.
- Do not introduce new authentication logic.

IMPORTANT:
Inspect the existing homepage first. Make the smallest possible
change: append the sixth card using the current implementation.

============================================================
4. INVENTORY PAGE — app/manager/inventory/page.js
============================================================

Create the Inventory page at:

app/manager/inventory/page.js

Requirements:

- Follow the existing manager page protection and layout pattern.
- Reuse existing shared components where appropriate.
- Render the InventoryUI component.
- Do not invent a new authentication mechanism.
- Do not make API or database calls.
- Do not perform server mutations.
- Do not add backend functionality.
- Do not change shared manager protection code.

If the existing manager protection pattern cannot be safely
reused within the allowed files, stop and report the blocker.

============================================================
5. INVENTORY UI — app/components/InventoryUI.jsx
============================================================

Create a presentational InventoryUI component.

Header:
Bono Inventory Management

Tabs:
- Stock
- Suppliers
- Recipes
- Reports

Phase A is a visual shell only. Tabs may be visual placeholders;
do not imply that backend functionality exists.

Stock dashboard cards:
- Total Items
- Low Stock
- Inventory Value
- Today Usage

Inventory table columns:
- Item
- Category
- Unit
- Quantity
- Status

Use clearly identified mock data only.

Suggested example rows:
- Coffee Beans
- Milk
- Flour
- Cooking Oil
- Sugar

Use reasonable placeholder categories, units, quantities,
and statuses. Do not present mock values as real business data.

============================================================
6. DESIGN REQUIREMENTS
============================================================

The new UI must look like it belongs to the existing Bono system.

- Reuse current colors and visual language.
- Match existing typography and card styling.
- Match existing spacing and responsive behavior.
- Support desktop and mobile screens.
- Avoid horizontal overflow on mobile.
- Use existing project conventions and icon library.
- Do not introduce a new design system.
- Do not add external UI libraries.
- Do not redesign unrelated components.
- Keep the UI clear, neat, and production-oriented.

============================================================
7. FUNCTIONALITY BOUNDARY
============================================================

This phase creates only the Inventory UI shell.

Do NOT implement:
- Stock persistence
- Inventory APIs
- Database models
- Stock receiving or adjustments
- Supplier CRUD
- Recipe calculations
- Inventory deduction from orders
- Cost/profit calculations
- Real inventory reports
- Notifications or background jobs

These belong to later phases after the UI shell is reviewed.

============================================================
8. VALIDATION
============================================================

After implementation:

1. Review the complete diff.
2. Confirm the only changed/created source files are:
   - app/page.js
   - app/manager/inventory/page.js
   - app/components/InventoryUI.jsx

3. Do not include unrelated pre-existing user changes in
   your implementation or cleanup.

4. Run:
   git status --short
   git diff --stat
   git diff -- app/page.js

5. Check that all five existing portals remain unchanged and
   Inventory is the sixth portal.

6. Check the new route and component imports.

7. Run npm run build if feasible.

If the build fails:
- Report the exact error.
- Fix only errors directly caused by the allowed files.
- Never modify unrelated files to force a successful build.

Do not claim that the build passed unless it actually passed.

============================================================
9. REQUIRED FINAL REPORT
============================================================

Report:

A. Files created
B. Files modified
C. Confirmation that no other files were changed by you
D. Homepage portal implementation
E. Inventory UI sections implemented
F. Whether API/backend/database files remained untouched
G. Build result, including any failure
H. Any blockers or deviations

Do not begin Phase B.
Do not implement real inventory behavior.

# END PHASE A MASTER PROMPT
