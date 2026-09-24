import mongoose from "mongoose";
import fs from "fs";
if (!process.env.MONGODB_URI) {
  try {
    const env = fs.readFileSync("C:\\hotelms\\.env.local", "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*MONGODB_URI\s*=\s*(.+)\s*$/);
      if (m) process.env.MONGODB_URI = m[1].trim();
    }
  } catch {}
}
const { connectToDatabase } = await import("@/lib/mongodb.js");
const { getInventoryItemModel } = await import("@/lib/models/InventoryItem.js");
const { getInventoryAuditModel } = await import("@/lib/models/InventoryAudit.js");
const { getStaffModel } = await import("@/lib/models/Staff.js");
const { createSessionToken } = await import("@/lib/sessionCrypto.js");
const { createInventoryAudit } = await import("@/lib/inventoryAuditService.js");
const { GET } = await import("@/app/api/inventory/audits/route.js");

let pass=0, fail=0;
function ok(n,c,e=""){ if(c){console.log(`✅ ${n}`);pass++;} else {console.log(`❌ ${n} ${e}`);fail++;} }

async function makeGetRequest(url, token) {
  const headers = {};
  // ARCH-6: Bearer transport removed from the canonical resolver (no
  // legitimate caller remained). Cookie transport, like test-h73-route.mjs.
  if (token) headers["cookie"] = `bono_sess=${token}`;
  const req = new Request(url, { method: "GET", headers });
  const res = await GET(req);
  const json = await res.json().catch(()=>null);
  return { res, json, status: res.status };
}

async function main(){
  const conn = await connectToDatabase();
  const InventoryItem = getInventoryItemModel(conn);
  const InventoryAudit = getInventoryAuditModel(conn);
  const Staff = getStaffModel(conn);
  const tag = "H74_GET_" + Date.now();

  let manager = await Staff.findOne({ role:"MANAGER", isActive:true }).lean();
  if (!manager) manager = await Staff.findOne({ isActive:true }).lean();
  if (!manager) { console.log("No staff"); process.exit(1); }
  console.log(`Manager ${manager.name} ${manager._id}`);
  const managerToken = createSessionToken({ staffId: String(manager._id), role: manager.role });
  const waiter = await Staff.findOne({ role:"WAITER", isActive:true }).lean();
  const waiterToken = waiter ? createSessionToken({ staffId: String(waiter._id), role: waiter.role }) : null;

  // Create isolated test item and audits for each action
  const item = await InventoryItem.create({ name: tag+"_item", category:"Test", unit:"kg", currentStock:5, cost:5, status:"In Stock" });
  const itemId = String(item._id);
  console.log(`Item ${itemId}`);

  // Create isolated audits for each action with tag in reason
  const actorId = String(manager._id);
  await createInventoryAudit(conn, { itemId, action:"ITEM_CREATED", actorId, actorRole:"MANAGER", quantityDelta:5, beforeStock:null, afterStock:5, reason: tag+" ITEM_CREATED" });
  await createInventoryAudit(conn, { itemId, action:"ITEM_UPDATED", actorId, actorRole:"MANAGER", reason: tag+" ITEM_UPDATED", beforeSnapshot:{name:"old"}, afterSnapshot:{name:"new"} });
  await createInventoryAudit(conn, { itemId, action:"WASTE", actorId, actorRole:"MANAGER", quantityDelta:2, beforeStock:5, afterStock:3, reason: tag+" WASTE" });
  await createInventoryAudit(conn, { itemId, action:"COST_UPDATED", actorId, actorRole:"MANAGER", oldCost:5, newCost:7, reason: tag+" COST_UPDATED" });

  // 1. COST_UPDATED filter returns 200 and includes oldCost=5 newCost=7
  console.log("\n--- Test 1: COST_UPDATED filter ---");
  const res1 = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}&action=COST_UPDATED`, managerToken);
  console.log(`Status ${res1.status}`, JSON.stringify(res1.json).slice(0,300));
  ok("COST_UPDATED filter 200", res1.status===200 && res1.json.success);
  const costAudits = res1.json.data.audits.filter(a => String(a.item)===itemId && a.action==="COST_UPDATED");
  ok("COST_UPDATED includes oldCost 5 newCost 7", costAudits.length===1 && Number(costAudits[0].oldCost)===5 && Number(costAudits[0].newCost)===7);
  ok("COST_UPDATED actor correct", costAudits[0] && String(costAudits[0].actorId)===actorId);
  ok("COST_UPDATED has no secrets", costAudits.length===0 || !JSON.stringify(costAudits[0]).toLowerCase().includes("pin") );

  // Verify response includes oldCost/newCost and existing fields, no extra
  if (costAudits[0]) {
    ok("Response includes oldCost/newCost", "oldCost" in costAudits[0] && "newCost" in costAudits[0]);
    ok("Existing fields intact: quantityDelta", "quantityDelta" in costAudits[0]);
    ok("Existing fields intact: beforeSnapshot", "beforeSnapshot" in costAudits[0]);
    ok("No pin/token in COST_UPDATED", !("pinHash" in costAudits[0]) && !("token" in costAudits[0]));
  }

  // 2. Existing filters still work
  console.log("\n--- Test 2: Existing filters ---");
  const res2a = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}&action=ITEM_CREATED`, managerToken);
  ok("ITEM_CREATED filter 200", res2a.status===200 && res2a.json.data.audits.some(a=>a.action==="ITEM_CREATED"));
  const res2b = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}&action=ITEM_UPDATED`, managerToken);
  ok("ITEM_UPDATED filter 200", res2b.status===200 && res2b.json.data.audits.some(a=>a.action==="ITEM_UPDATED"));
  const res2c = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}&action=WASTE`, managerToken);
  ok("WASTE filter 200", res2c.status===200 && res2c.json.data.audits.some(a=>a.action==="WASTE"));

  // 3. Invalid action -> 400
  console.log("\n--- Test 3: Invalid action ---");
  const res3 = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}&action=INVALID`, managerToken);
  console.log(`Status ${res3.status}`, res3.json);
  ok("Invalid action 400", res3.status===400 && /Invalid action/.test(res3.json.error));

  // 4. Existing validations: item, actor, date, limit
  console.log("\n--- Test 4: Item/actor/date/limit validation ---");
  const res4a = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=not-an-id`, managerToken);
  ok("Invalid item 400", res4a.status===400);
  const res4b = await makeGetRequest(`http://localhost:3000/api/inventory/audits?actor=not-an-id`, managerToken);
  ok("Invalid actor 400", res4b.status===400);
  const res4c = await makeGetRequest(`http://localhost:3000/api/inventory/audits?from=bad-date`, managerToken);
  ok("Invalid from 400", res4c.status===400);
  const res4d = await makeGetRequest(`http://localhost:3000/api/inventory/audits?from=2026-13-01`, managerToken);
  ok("Invalid from date value 400", res4d.status===400);
  const res4e = await makeGetRequest(`http://localhost:3000/api/inventory/audits?from=2026-09-20&to=2026-09-10`, managerToken);
  ok("from > to 400", res4e.status===400);
  const res4f = await makeGetRequest(`http://localhost:3000/api/inventory/audits?limit=0`, managerToken);
  ok("limit 0 400", res4f.status===400);
  const res4g = await makeGetRequest(`http://localhost:3000/api/inventory/audits?limit=201`, managerToken);
  ok("limit 201 400", res4g.status===400);
  const res4h = await makeGetRequest(`http://localhost:3000/api/inventory/audits?limit=abc`, managerToken);
  ok("limit abc 400", res4h.status===400);

  // 5. Missing auth -> 401
  console.log("\n--- Test 5: Missing auth ---");
  const res5 = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}`, null);
  ok("Missing auth 401", res5.status===401);

  // 6. WAITER -> 403
  console.log("\n--- Test 6: WAITER 403 ---");
  if (waiterToken) {
    const res6 = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}`, waiterToken);
    ok("WAITER 403", res6.status===403);
  } else {
    ok("WAITER 403 skipped - no waiter", true);
  }

  // 7. No secrets
  console.log("\n--- Test 7: No secrets ---");
  const res7 = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${itemId}`, managerToken);
  const hasSecret = JSON.stringify(res7.json).toLowerCase().includes("pin") || JSON.stringify(res7.json).toLowerCase().includes("password") || JSON.stringify(res7.json).toLowerCase().includes("token") || res7.json.data.audits.some(a=> "pinHash" in a);
  ok("No PIN/token/password in response", !hasSecret);

  // 8. Null handling and existing fields
  console.log("\n--- Test 8: Null handling ---");
  // Create audit with null quantityDelta etc. and see it returns null not undefined
  const nullItem = await InventoryItem.create({ name: tag+"_null", category:"Test", unit:"kg", currentStock:1, cost:1 });
  await createInventoryAudit(conn, { itemId: String(nullItem._id), action:"ITEM_UPDATED", actorId, actorRole:"MANAGER", reason: tag+" null test" });
  const res8 = await makeGetRequest(`http://localhost:3000/api/inventory/audits?item=${String(nullItem._id)}`, managerToken);
  const nullAudit = res8.json.data.audits.find(a=> String(a.item)===String(nullItem._id));
  ok("Null handling quantityDelta null", nullAudit && nullAudit.quantityDelta===null);
  ok("Null handling beforeSnapshot null", nullAudit && nullAudit.beforeSnapshot===null);
  await InventoryItem.deleteMany({ _id: nullItem._id });
  await InventoryAudit.deleteMany({ item: nullItem._id });

  // Cleanup
  await InventoryItem.deleteMany({ _id: itemId });
  await InventoryAudit.deleteMany({ item: itemId });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });
  console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
  // Verify cleanup
  const remaining = await InventoryAudit.countDocuments({ reason: { $regex: tag } });
  ok("Cleanup verified 0 remaining", remaining===0);
  console.log(`Final pass ${pass} fail ${fail}`);
  await conn.close();
  process.exit(fail>0?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
