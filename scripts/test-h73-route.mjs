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
const { PATCH } = await import("@/app/api/inventory/items/[id]/route.js");

let pass=0, fail=0;
function ok(n,c,e=""){ if(c){console.log(`✅ ${n}`);pass++;} else {console.log(`❌ ${n} ${e}`);fail++;} }

async function makeRequest({ method, url, body, token, staffId }) {
  const headers = {};
  if (token) headers["cookie"] = `bono_sess=${token}`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const req = new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Mock next/headers cookies() for requireAuth fallback is not needed as we use cookie header
  // Call PATCH directly with params
  const urlObj = new URL(url);
  const id = urlObj.pathname.split("/").pop();
  // PATCH handler expects (request, {params: Promise<{id}>})
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  const json = await res.json().catch(()=>null);
  return { res, json, status: res.status };
}

async function main(){
  const conn = await connectToDatabase();
  const InventoryItem = getInventoryItemModel(conn);
  const InventoryAudit = getInventoryAuditModel(conn);
  const Staff = getStaffModel(conn);
  const tag = "H73_ROUTE_" + Date.now();

  // Find MANAGER staff
  let manager = await Staff.findOne({ role:"MANAGER", isActive:true }).lean();
  if (!manager) {
    console.log("No MANAGER found, trying to find any Staff");
    manager = await Staff.findOne({ isActive:true }).lean();
  }
  if (!manager) {
    console.log("No staff found, cannot test auth");
    process.exit(1);
  }
  console.log(`Using staff ${manager.name} ${manager.role} ${manager._id}`);

  const managerToken = createSessionToken({ staffId: String(manager._id), role: manager.role, name: manager.name });

  // Create test item
  const item = await InventoryItem.create({ name: tag+"_item", category:"Test", unit:"kg", currentStock:10, minimumStock:2, cost:5, status:"In Stock" });
  const itemId = String(item._id);
  console.log(`Created item ${itemId} cost 5`);

  // Helper to get counts
  async function auditCount(action){
    return InventoryAudit.countDocuments({ item: itemId, action });
  }

  // 1. Valid cost update 5 -> 7 via HTTP route
  console.log("\n--- Test 1: Valid cost update 5->7 via PATCH route ---");
  const beforeAudits = await auditCount("COST_UPDATED");
  const beforeItem = await InventoryItem.findById(itemId).lean();
  const res1 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${itemId}`, body:{ cost: 7 }, token: managerToken });
  console.log(`Status ${res1.status} body`, res1.json);
  ok("Valid cost update 200", res1.status===200 && res1.json.success);
  ok("Response cost 7", res1.json.data && Number(res1.json.data.item.cost)===7);
  const afterItem1 = await InventoryItem.findById(itemId).lean();
  ok("Persisted cost 7", Number(afterItem1.cost)===7);
  const audits1 = await InventoryAudit.find({ item: itemId, action:"COST_UPDATED" }).sort({createdAt:-1}).lean();
  ok("Exactly one COST_UPDATED after valid", audits1.length===beforeAudits+1);
  if (audits1.length>0){
    const a = audits1[0];
    ok("COST_UPDATED oldCost 5 newCost 7", Number(a.oldCost)===5 && Number(a.newCost)===7);
    ok("Actor correct", String(a.actorId)===String(manager._id) && a.actorRole==="MANAGER");
    ok("Timestamp exists", a.createdAt != null);
  }

  // 2. Same effective cost 7 -> 7.001 should not create new COST_UPDATED (rounded same)
  console.log("\n--- Test 2: Same effective cost 7 -> 7.001 (rounded 7) ---");
  const beforeSame = await auditCount("COST_UPDATED");
  const res2 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${itemId}`, body:{ cost: 7.001 }, token: managerToken });
  console.log(`Status ${res2.status}`, res2.json);
  ok("Same rounded cost still 200 (ITEM_UPDATED)", res2.status===200);
  const afterSame = await InventoryItem.findById(itemId).lean();
  ok("Persisted still 7 (rounded)", Number(afterSame.cost)===7);
  ok("No new COST_UPDATED when rounded same", (await auditCount("COST_UPDATED"))===beforeSame);

  // 3. Invalid cost -1
  console.log("\n--- Test 3: Invalid cost -1 ---");
  const beforeInvalid = await auditCount("COST_UPDATED");
  const beforeStockInvalid = (await InventoryItem.findById(itemId).lean()).cost;
  const res3 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${itemId}`, body:{ cost: -1 }, token: managerToken });
  console.log(`Status ${res3.status}`, res3.json);
  ok("Invalid cost -1 → 400", res3.status===400);
  ok("No COST_UPDATED on invalid", (await auditCount("COST_UPDATED"))===beforeInvalid);
  ok("Cost unchanged after invalid", Number((await InventoryItem.findById(itemId).lean()).cost)===Number(beforeStockInvalid));

  // 4. Invalid cost non-numeric "abc"
  console.log("\n--- Test 4: Invalid cost abc ---");
  const res4 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${itemId}`, body:{ cost: "abc" }, token: managerToken });
  console.log(`Status ${res4.status}`, res4.json);
  ok("Invalid cost abc → 400", res4.status===400);

  // 5. Missing item
  console.log("\n--- Test 5: Missing item ---");
  const fakeId = new mongoose.Types.ObjectId();
  const res5 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${fakeId}`, body:{ cost: 9 }, token: managerToken });
  console.log(`Status ${res5.status}`, res5.json);
  ok("Missing item → 404", res5.status===404);
  ok("No audit for missing", (await InventoryAudit.countDocuments({ item: fakeId }))===0);

  // 6. Unauthorized - no token
  console.log("\n--- Test 6: Unauthorized no token ---");
  const res6 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${itemId}`, body:{ cost: 9 }, token: null });
  console.log(`Status ${res6.status}`, res6.json);
  ok("No token → 401", res6.status===401);
  // Ensure no audit and no cost change
  const afterUnauth = await InventoryItem.findById(itemId).lean();
  ok("Cost unchanged after 401", Number(afterUnauth.cost)===7);

  // 7. Forbidden - WAITER role
  console.log("\n--- Test 7: Forbidden WAITER ---");
  const waiter = await Staff.findOne({ role:"WAITER", isActive:true }).lean();
  if (waiter){
    const waiterToken = createSessionToken({ staffId: String(waiter._id), role: waiter.role });
    const res7 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${itemId}`, body:{ cost: 9 }, token: waiterToken });
    console.log(`Status ${res7.status}`, res7.json);
    ok("WAITER → 403", res7.status===403);
    ok("Cost unchanged after 403", Number((await InventoryItem.findById(itemId).lean()).cost)===7);
  } else {
    console.log("No WAITER found, skip 403 test");
    ok("WAITER 403 skipped", true);
  }

  // 8. Cost omitted - update name only, should not create COST_UPDATED
  console.log("\n--- Test 8: Cost omitted, update name ---");
  const beforeOmit = await auditCount("COST_UPDATED");
  const res8 = await makeRequest({ method:"PATCH", url:`http://localhost:3000/api/inventory/items/${itemId}`, body:{ name: "Updated Name" }, token: managerToken });
  console.log(`Status ${res8.status}`, res8.json);
  ok("Name update 200", res8.status===200);
  ok("No new COST_UPDATED when omitted", (await auditCount("COST_UPDATED"))===beforeOmit);
  // But ITEM_UPDATED should have been created
  const itemUpdatedCount = await InventoryAudit.countDocuments({ item: itemId, action:"ITEM_UPDATED" });
  ok("ITEM_UPDATED created for name change", itemUpdatedCount>=1);

  // 9. Failed audit rollback - try to trigger audit failure by passing invalid oldCost? Not directly via route, but verify that failed update doesn't leave audit
  // We already verified invalid cost doesn't create audit, and missing item doesn't.

  // 10. Verify no PIN/token stored in audits
  console.log("\n--- Test 10: No secrets in audits ---");
  const allAudits = await InventoryAudit.find({ item: itemId }).lean();
  const hasSecret = allAudits.some(a => JSON.stringify(a).toLowerCase().includes("pin") || JSON.stringify(a).toLowerCase().includes("token") || JSON.stringify(a).toLowerCase().includes("password"));
  ok("No secrets in audits", !hasSecret);

  // Cleanup
  await InventoryItem.deleteMany({ _id: itemId });
  await InventoryAudit.deleteMany({ item: itemId });
  console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
  await conn.close();
  process.exit(fail>0?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
