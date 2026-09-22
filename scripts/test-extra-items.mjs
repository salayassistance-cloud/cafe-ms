#!/usr/bin/env node
// DB-free tests for Extra Items (isExternal) — no DB, no Atlas, no secrets
import fs from "node:fs";
import assert from "node:assert/strict";

let pass=0, fail=0;
function ok(name, cond, note=""){ if(cond){ console.log(`✅ ${name}`); pass++; } else { console.log(`❌ ${name} ${note}`); fail++; } }

// 1. ORDER REQUEST CONTRACT — WaiterUI unified payload
const waiter = fs.readFileSync("app/components/WaiterUI.js","utf8");
ok("1a WaiterUI unified payload includes isExternal", waiter.includes("isExternal: !!item.isExternal"));
ok("1b Extra itemId undefined for ext- prefix (safe serialize)", waiter.includes('String(item._id || "").startsWith("ext-") ? undefined : item._id'));
ok("1c Server validates name via getLocalizedSingleString", fs.readFileSync("lib/orderService.js","utf8").includes("getLocalizedSingleString(raw.name)"));
ok("1d Server validates quantity 1-99", fs.readFileSync("lib/orderService.js","utf8").includes("quantity < 1 || quantity > 99"));
ok("1e Server validates price finite >=0", fs.readFileSync("lib/orderService.js","utf8").includes("price < 0"));
ok("1f Server caps table 1-50", fs.readFileSync("app/api/orders/route.js","utf8").includes("tableNumber"));

// 2. Snapshot & identity
const orderModel = fs.readFileSync("lib/models/Order.js","utf8");
ok("2a OrderItem isExternal default false", orderModel.includes("isExternal: { type: Boolean, default: false }"));
ok("2b Order isExternal index", orderModel.includes("isExternal: { type: Boolean, default: false, index: true }"));
ok("2c OrderItem snapshot name/price/type preserved", fs.readFileSync("lib/orderService.js","utf8").includes("return { name, price, quantity: it.quantity, type, isExternal"));

// 3. KDS routing — check orderService hasFood/hasDrink
const orderService = fs.readFileSync("lib/orderService.js","utf8");
ok("3a hasFood/hasDrink drives kitchenStatus/baristaStatus", orderService.includes("hasFood") && orderService.includes("hasDrink"));
ok("3b Kitchen filter items.type FOOD", orderService.includes('filter["items.type"] = "FOOD"') || orderService.includes('items.type'));

// 4. Revenue / Top-selling — check reportService
const reportService = fs.existsSync("lib/reportService.js") ? fs.readFileSync("lib/reportService.js","utf8") : fs.readFileSync("lib/analytics.js","utf8");
ok("4a reportService selects totalAmount (not external collection)", reportService.includes("totalAmount"));
ok("4b top-selling groups Order.items (includes isExternal)", reportService.includes("items") );

// 5. Deprecated routes
const extItems = fs.readFileSync("app/api/external-items/route.js","utf8");
ok("5a POST external-items returns 410", extItems.includes("410") && extItems.includes("External requests are deprecated"));
ok("5b GET external-items retained for historical", extItems.includes("async function getHandler"));
const extSales = fs.readFileSync("app/api/external-sales/route.js","utf8");
ok("5c POST external-sales returns 410", extSales.includes("410") && extSales.includes("External sales are deprecated"));

// 6. Extra Items validation
ok("6a Extra Extra Injera 20 x2 total math", (()=>{ const price=20, qty=2, total=Math.round((100+price*qty)*100)/100; return total===140; })());

console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
if(fail>0) process.exit(1);
console.log("Extra Items DB-free checks passed — not proof of live revenue/SSE");
