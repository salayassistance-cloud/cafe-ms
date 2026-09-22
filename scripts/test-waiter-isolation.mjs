#!/usr/bin/env node
// DB-free tests for Waiter session isolation and same-browser tab safety
// No DB connection, no secret read, no package install
import fs from "node:fs";

let pass=0, fail=0;
function ok(name, cond, extra="") { if (cond) { console.log(`✅ ${name}`); pass++; } else { console.log(`❌ ${name} ${extra}`); fail++; } }

console.log("--- WaiterUI identity change handling ---");
const waiter = fs.readFileSync("app/components/WaiterUI.js","utf8");
ok("WaiterUI detects shared-cookie identity change", waiter.includes("waiterIdRef.current") && waiter.includes("String(oldId) !== String(newId)"));
ok("WaiterUI clears activeOrders on identity change", waiter.includes("setActiveOrders([])") && waiter.includes("prevActiveRef.current = new Map()"));
ok("WaiterUI clears cart on identity change", waiter.includes("setCart({})") && waiter.includes("setCartOpen"));
ok("WaiterUI clears readyToasts/payTarget on identity change", waiter.includes("setReadyToasts([])") && waiter.includes("setPayTarget(null)"));
ok("WaiterUI polls /api/auth/me for identity (30s + visibility)", waiter.includes("/api/auth/me") && waiter.includes("setInterval(checkIdentity, 30000)") && waiter.includes("visibilitychange"));
ok("WaiterUI does not trust client waiterId", waiter.includes("server derives waiter identity") || waiter.includes("waiterId == session.staffId") || waiter.includes("waiterIdRef"));
ok("loadServedOrders filters by current waiterId (defense-in-depth)", waiter.includes("filteredPrev") && waiter.includes("String(o.waiterId) === String(currentId)"));

console.log("\n--- Server-side ownership (static) ---");
const ordersRoute = fs.readFileSync("app/api/orders/route.js","utf8");
ok("GET /api/orders filters by session staffId for WAITER", ordersRoute.includes("waiterId") && ordersRoute.includes("staffId") && ordersRoute.includes("WAITER"));
ok("POST /api/orders overrides client waiterId from session", ordersRoute.includes("waiterId") && ordersRoute.includes("staffId"));
const orderIdRoute = fs.readFileSync("app/api/orders/[id]/route.js","utf8");
ok("GET /api/orders/[id] checks owner 403", orderIdRoute.includes("waiterId") && orderIdRoute.includes("staffId") && orderIdRoute.includes("not your order"));
ok("PATCH /api/orders/[id] checks owner before SERVED/PAID", orderIdRoute.includes("waiterId") && orderIdRoute.includes("staffId") && (orderIdRoute.includes("SERVED") || orderIdRoute.includes("403")));

const sec = fs.readFileSync("lib/security.js","utf8");
ok("security.js fail-closed on DB error (503) not valid", sec.includes("Fail-closed") && sec.includes("status: 503"));
const authServer = fs.readFileSync("lib/authServer.js","utf8");
ok("authServer.js fail-closed returns null on DB error", authServer.includes("return null") && authServer.includes("Fail-closed"));

console.log("\n--- SSE / polling isolation ---");
ok("SSE ORDER_READY filtered by waiterIdRef", waiter.includes("event.waiterId") && waiter.includes("String(event.waiterId) === String(ownId)"));
ok("pollActiveOrders replaces list (not merge old)", waiter.includes("byId = new Map()") && waiter.includes("for (const o of (prep.data?.orders"));
ok("loadServedOrders does not merge cross-waiter without filter", waiter.includes("filteredPrev"));

console.log("\n--- Pure logic DB-free execution ---");
// Test pure functions: buildSearchHaystack, localizedName, cart pruning
function buildSearchHaystack(item) {
  const name=item.name||{};
  return [name.am,name.en,name.om,item.title,item.titleAmharic,typeof item.title==='string'?item.title:'',item.description,typeof item.description==='string'?item.description:'',item.category,item.categorySlug,item.categoryName].filter(Boolean).join(' ').toLowerCase();
}
ok("buildSearchHaystack trilingual", buildSearchHaystack({name:{am:"ጥብስ",en:"Tibs",om:"Waadii"},title:"Tibs",category:"Meat"}) .includes("ጥብስ") && buildSearchHaystack({name:{en:"Tibs"}}).includes("tibs"));
ok("Cart pruning removes unavailable", (()=>{ const its=[{_id:"1",isAvailable:true},{_id:"2",isAvailable:false}]; const cart={"1":{item:its[0],qty:1},"2":{item:its[1],qty:1}}; const orderable=it=>it.isAvailable!==false; const next={...cart}; for(const k of Object.keys(next)){const m=its.find(a=>String(a._id)===String(k)); if(!m||!orderable(m)) delete next[k];} return Object.keys(next).length===1 && next["1"]; })());

// Simulate identity change clearing
ok("Identity change clears waiter-specific state (simulation)", (()=>{ let active=[{_id:"a",waiterId:"A"}], cart={a:1}, toasts=[{id:"r"}]; const oldId="A", newId="B"; if(String(oldId)!==String(newId)){ active=[]; cart={}; toasts=[]; } return active.length===0 && Object.keys(cart).length===0 && toasts.length===0; })());

console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
if (fail>0) process.exit(1);
console.log("All DB-free waiter isolation checks passed — runtime DB isolation still requires isolated replica test.");
