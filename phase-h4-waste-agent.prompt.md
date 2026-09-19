# BONO INVENTORY — PHASE H4 WASTE TRACKING
# Implementation Task — Service + API Only

## Objective

Implement inventory waste tracking foundation.

STRICT RULES:
- Do NOT modify Order schema
- Do NOT modify payment flow
- Do NOT modify kitchen/barista/waiter/cashier flows
- Do NOT modify Recipe schema
- Do NOT modify existing SaleDeduction logic
- Only create:
  1. lib/inventoryWasteService.js
  2. app/api/inventory/waste/route.js


## Existing Architecture To Follow

Use existing patterns:

Database:
- connectToDatabase from "@/lib/mongodb"
- getInventoryItemModel
- getStockMovementModel

Security:
- requireAuth(request, ["MANAGER"])
- can(role, "inventory:mutate")

API:
- withApi()
- ok()
- fail()
- isDbError()

Transaction pattern:
- startSession()
- startTransaction()
- InventoryItem update
- StockMovement insert
- commitTransaction()
- abort on error


# File 1

Create:

lib/inventoryWasteService.js


Export:

createWasteMovement(conn, {
  itemId,
  quantity,
  notes,
  actorId
})


Requirements:

1. Validate ObjectId
2. Validate quantity > 0
3. Load InventoryItem
4. Reject missing item
5. Reject inactive item if status exists
6. Start Mongo transaction

Update:

InventoryItem:

$inc:
{
 currentStock: -quantity
}


Create StockMovement:

{
 item,
 type:"OUT",
 quantity,
 reason:"Waste",
 notes,
 createdBy
}


createdBy:
- use actorId
- convert valid ObjectId
- otherwise null


Return serializable:

{
 itemId,
 quantity,
 reason:"Waste"
}


No writes outside transaction.


# File 2

Create:

app/api/inventory/waste/route.js


POST only.

Input:

{
 itemId,
 quantity,
 notes
}


Flow:

require MANAGER

check:

can(role,"inventory:mutate")


connect DB

call createWasteMovement()


Return:

ok(result,201)


Errors:

400 validation
403 permission
404 missing item
503 database


# Verification Requirements

Before finishing:

Run:

git diff --name-only

Expected:

ONLY:

lib/inventoryWasteService.js
app/api/inventory/waste/route.js


Run:

git diff -- lib/models/Order.js

Must be empty.


Run:

npm run build


Do not add UI.
Do not add reports.
Do not add dashboard.
Do not add schema migration.

END PHASE H4 FOUNDATION
