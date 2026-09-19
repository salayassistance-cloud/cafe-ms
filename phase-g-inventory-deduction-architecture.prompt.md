# BONO INVENTORY — PHASE G INVENTORY DEDUCTION
# ARCHITECTURE REVIEW ONLY
# NO CODE CHANGES

You are a senior software architect reviewing
the existing Bono restaurant production system.

Current checkpoint:

phase-f-recipe-system-complete

Your task is ONLY architecture discovery and planning.

================================================

ABSOLUTE RULES

DO NOT MODIFY FILES.

DO NOT CREATE FILES.

DO NOT WRITE CODE.

DO NOT COMMIT.

DO NOT CHANGE:

- Menu system
- MenuItem model
- Category model
- Order schema
- Payment UI
- Kitchen flow
- Barista flow
- Waiter flow
- Cashier flow
- Authentication
- Middleware

This is analysis only.

================================================

TASK 1 — PAYMENT FLOW ANALYSIS

Inspect and document:

Find:

- payOrder implementation
- payment status transition
- order completion lifecycle
- existing transaction patterns
- duplicate payment protection

Document:

- exact files
- functions
- current behavior


================================================

TASK 2 — ORDER ITEM ANALYSIS

Analyze:

Order.items structure.

Find:

- menu item reference
- quantity handling
- food/drink separation
- external item handling
- cancelled order behavior

Explain:

How inventory deduction can safely read order data
without modifying order schema.


================================================

TASK 3 — RECIPE DEDUCTION DESIGN

Analyze:

Menu Item
        |
        |
      Recipe
        |
        |
 Inventory Items


Example:

Cappuccino x2

Recipe:

Coffee Beans 20g
Milk 200ml
Sugar 10g


Calculate:

Required deduction:

Coffee Beans:
40g

Milk:
400ml

Sugar:
20g


Explain:

- calculation location
- service responsibility
- error handling


================================================

TASK 4 — INVENTORY TRANSACTION DESIGN

Design:

inventoryDeductionService


Responsibilities:

- receive paid order
- check recipe
- calculate ingredients
- update stock
- create StockMovement


Analyze:

MongoDB transaction requirement.

Explain:

How to prevent:

- partial deduction
- duplicate deduction
- negative stock


================================================

TASK 5 — IDEMPOTENCY DESIGN

Analyze:

How to guarantee:

One PAID order
=
One inventory deduction


Possible methods:

A.

StockMovement.refOrderId check


B.

Order field:

inventoryDeducted:true


C.

Both


Compare:

advantages
disadvantages


Recommend one.


================================================

TASK 6 — FAILURE HANDLING

Define behavior:

Case 1:

Order paid but recipe missing


Case 2:

Ingredient stock insufficient


Case 3:

Database transaction failure


Case 4:

External menu item


Case 5:

Cancelled order after payment


================================================

TASK 7 — REPORTING IMPACT

Analyze:

How inventory affects:

- sales reports
- profit calculation
- item cost
- inventory reports


Explain:

What must remain separate.


================================================

TASK 8 — SECURITY REVIEW

Define:

Who can trigger deduction?

Expected:

Only payment completion flow.

Nobody manually reduces stock.


Analyze:

Manager adjustment possibility.


================================================

TASK 9 — IMPLEMENTATION PLAN

Create future steps:

Phase G1:
Create deduction service

Phase G2:
Connect payOrder

Phase G3:
Testing

Phase G4:
Monitoring

Phase G5:
Inventory reports integration


================================================

FINAL REPORT

Return:

A. Payment flow findings

B. Deduction architecture

C. Transaction strategy

D. Idempotency strategy

E. Failure handling

F. Security model

G. Implementation roadmap


IMPORTANT:

Do not code.

Do not modify files.

Do not start implementation.

# END PHASE G ARCHITECTURE
