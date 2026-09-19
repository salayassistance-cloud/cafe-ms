# BONO INVENTORY — PHASE B MASTER PROMPT
# ARCHITECTURE REVIEW ONLY
# NO CODE CHANGES

You are a senior software architect reviewing the existing
Bono restaurant production system.

Current checkpoint:

phase-a-inventory-complete

Your task is ONLY architecture discovery and planning.

================================================

ABSOLUTE RULES

DO NOT MODIFY ANY FILES.

DO NOT CREATE FILES.

DO NOT WRITE CODE.

DO NOT CHANGE:

- database
- MongoDB models
- API routes
- authentication
- middleware
- menu system
- order system
- payment system
- POS logic
- waiter flow
- kitchen flow
- barista flow
- cashier flow

This is analysis only.

================================================

TASK 1 — EXISTING SYSTEM ANALYSIS

Inspect and document:

1. Current Menu structure

Find:
- menu models
- food/drink structure
- categories
- pricing
- CRUD flow


2. Current Order structure

Find:
- order model
- order items
- status flow
- kitchen/barista routing


3. Current Staff system

Find:
- roles
- permissions
- manager access pattern


4. Current Reporting system

Find:
- sales reports
- analytics structure
- reusable patterns


================================================

TASK 2 — INVENTORY ARCHITECTURE

Design a future inventory module.

Important:

Inventory must be independent.

Existing menu items must continue working.

Propose:

InventoryItem

Possible fields:

- name
- category
- unit
- currentStock
- minimumStock
- cost
- supplier
- status
- timestamps


StockMovement

Possible fields:

- item
- type
- quantity
- reason
- createdBy
- timestamp


Supplier

Possible fields:

- name
- contact
- address
- status


================================================

TASK 3 — MENU AND RECIPE RELATIONSHIP

Analyze:

How should:

Menu Item

connect with:

Recipe

connect with:

Inventory Items


Example:

Cappuccino

Recipe:

Coffee Beans
Milk
Sugar


Explain:

- where recipe data should live
- how deduction should happen
- how to avoid breaking menu CRUD


================================================

TASK 4 — STOCK DEDUCTION DECISION

Analyze these options:

Option A:
Decrease stock when order is created

Option B:
Decrease stock when kitchen/barista completes order

Option C:
Decrease stock after payment


Explain:

- advantages
- disadvantages
- risks


Recommend one.

================================================

TASK 5 — SECURITY DESIGN

Define access:

MANAGER:

- inventory management
- suppliers
- reports


WAITER:

- no inventory editing


KITCHEN:

- future read-only availability


BARISTA:

- future read-only availability


CASHIER:

- no inventory editing


================================================

TASK 6 — IMPLEMENTATION ROADMAP

Create future phases:

Phase C:
Database foundation

Phase D:
Inventory APIs

Phase E:
Connect UI

Phase F:
Recipe system

Phase G:
Automatic stock deduction

Phase H:
Inventory reports


================================================

FINAL REPORT

Return:

A. Current system findings

B. Inventory architecture proposal

C. Data model proposal

D. Integration strategy

E. Security model

F. Risks

G. Implementation order


IMPORTANT:

Do not code.

Do not modify files.

Do not start Phase C.

# END PHASE B
