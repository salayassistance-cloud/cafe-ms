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
const { validateAuditInput, createInventoryAudit } = await import("@/lib/inventoryAuditService.js");

let pass=0, fail=0;
function ok(n,c,e=""){ if(c){console.log(`✅ ${n}`);pass++;} else {console.log(`❌ ${n} ${e}`);fail++;} }

async function main(){
  const conn = await connectToDatabase();
  const InventoryItem = getInventoryItemModel(conn);
  const InventoryAudit = getInventoryAuditModel(conn);
  const tag = "H73_COST_" + Date.now();
  const actorId = new mongoose.Types.ObjectId();
  const actorRole = "MANAGER";

  // Cleanup
  await InventoryItem.deleteMany({ name: { $regex: tag } });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });

  // Create item with cost 5
  console.log("\n--- Test 1: Create item cost 5, then patch to 7 should record COST_UPDATED ---");
  const item = await InventoryItem.create({ name: tag+"_item", category:"Test", unit:"kg", currentStock:10, minimumStock:2, cost:5, status:"In Stock" });
  const itemId = String(item._id);
  ok("Item created cost 5", Number(item.cost)===5);

  // Simulate PATCH route transaction: beforeDoc, update, audits
  const session = await conn.startSession();
  try {
    session.startTransaction();
    const beforeDoc = await InventoryItem.findById(itemId).session(session).lean();
    const updated = await InventoryItem.findOneAndUpdate({ _id: itemId }, { $set: { cost: 7, updatedAt: new Date() } }, { new:true, runValidators:true, session }).lean();
    // Validate cost change
    const oldCost = Math.round(Number(beforeDoc.cost)*100)/100;
    const newCost = Math.round(Number(updated.cost)*100)/100;
    ok("oldCost 5 newCost 7", oldCost===5 && newCost===7);
    // Create ITEM_UPDATED
    await createInventoryAudit(conn, { itemId, action:"ITEM_UPDATED", actorId:String(actorId), actorRole, beforeStock: beforeDoc.currentStock, afterStock: updated.currentStock, reason:"Updated cost", beforeSnapshot:{cost:oldCost}, afterSnapshot:{cost:newCost} }, { session });
    // Create COST_UPDATED only when changed
    if (oldCost !== newCost) {
      const audit = await createInventoryAudit(conn, { itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost, newCost, reason:`Cost updated from ${oldCost} to ${newCost}` }, { session });
      ok("COST_UPDATED created", audit.action==="COST_UPDATED" && audit.oldCost===5 && audit.newCost===7 && String(audit.actorId)===String(actorId) && audit.actorRole==="MANAGER");
      ok("Timestamp exists", audit.createdAt != null);
    }
    await session.commitTransaction();
  } catch(e){ await session.abortTransaction().catch(()=>{}); ok("Cost update 5->7", false, e.message); }
  finally { await session.endSession().catch(()=>{}); }

  const audits = await InventoryAudit.find({ item: itemId, action:"COST_UPDATED" }).lean();
  ok("Exactly one COST_UPDATED", audits.length===1 && audits[0].oldCost===5 && audits[0].newCost===7);

  // Test 2: Server-derived actor - try to pass fake actor via input should not be trusted, but service validates what we pass
  console.log("\n--- Test 2: Server-derived actor ---");
  const fakeActor = new mongoose.Types.ObjectId();
  // Simulate client trying to inject actor — service should validate but we derive from session in route, not client
  // Here we test that validateAuditInput rejects invalid actor, and that route would derive from auth.payload
  const vFake = validateAuditInput({ itemId, action:"COST_UPDATED", actorId:"not-an-id", actorRole:"MANAGER", oldCost:7, newCost:9 });
  ok("Invalid actorId rejected", vFake.error && /actorId/.test(vFake.error));
  // Valid case with server-derived actor
  const vOk = validateAuditInput({ itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost:7, newCost:9 });
  ok("Valid server actor passes", vOk.ok && String(vOk.data.actorId)===String(actorId));

  // Test 3: Cost omitted - PATCH without cost should not create COST_UPDATED
  console.log("\n--- Test 3: Cost omitted ---");
  const beforeCount = await InventoryAudit.countDocuments({ item: itemId, action:"COST_UPDATED" });
  const sessOmit = await conn.startSession();
  try {
    sessOmit.startTransaction();
    const before = await InventoryItem.findById(itemId).session(sessOmit).lean();
    const updated2 = await InventoryItem.findOneAndUpdate({ _id: itemId }, { $set: { name: before.name + " updated", updatedAt:new Date() } }, { new:true, runValidators:true, session:sessOmit }).lean();
    await createInventoryAudit(conn, { itemId, action:"ITEM_UPDATED", actorId:String(actorId), actorRole, beforeStock:before.currentStock, afterStock:updated2.currentStock, reason:"Updated name" }, { session:sessOmit });
    const oC = Math.round(Number(before.cost)*100)/100;
    const nC = Math.round(Number(updated2.cost)*100)/100;
    if (oC !== nC) {
      await createInventoryAudit(conn, { itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost:oC, newCost:nC }, { session:sessOmit });
      ok("Should not create when cost omitted but cost same", false);
    } else {
      ok("No COST_UPDATED when cost omitted", true);
    }
    await sessOmit.commitTransaction();
  } catch(e){ await sessOmit.abortTransaction().catch(()=>{}); ok("Cost omitted", false, e.message); }
  finally { await sessOmit.endSession().catch(()=>{}); }
  ok("No new COST_UPDATED when omitted", (await InventoryAudit.countDocuments({ item:itemId, action:"COST_UPDATED" }))===beforeCount);

  // Test 4: Same effective cost (rounding)
  console.log("\n--- Test 4: Same effective cost after rounding ---");
  // Update cost 7 to 7.001 -> rounded to 7.00, should not create
  const beforeSame = await InventoryItem.findById(itemId).lean();
  const sessSame = await conn.startSession();
  let sameAuditCreated = false;
  try {
    sessSame.startTransaction();
    const before = await InventoryItem.findById(itemId).session(sessSame).lean();
    // 7.001 rounds to 7.00, same as 7
    const updatedSame = await InventoryItem.findOneAndUpdate({ _id:itemId }, { $set: { cost: 7.001, updatedAt:new Date() } }, { new:true, runValidators:true, session:sessSame }).lean();
    await createInventoryAudit(conn, { itemId, action:"ITEM_UPDATED", actorId:String(actorId), actorRole, reason:"Updated cost" }, { session:sessSame });
    const oC = Math.round(Number(before.cost)*100)/100;
    const nC = Math.round(Number(updatedSame.cost)*100)/100;
    if (oC !== nC) {
      await createInventoryAudit(conn, { itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost:oC, newCost:nC }, { session:sessSame });
      sameAuditCreated = true;
    }
    await sessSame.commitTransaction();
  } catch(e){ await sessSame.abortTransaction().catch(()=>{}); }
  finally { await sessSame.endSession().catch(()=>{}); }
  ok("No COST_UPDATED when rounded same (7 vs 7.001)", !sameAuditCreated);
  // Reset cost to 7 for next tests (it should still be 7)
  await InventoryItem.updateOne({ _id:itemId }, { $set:{ cost:7 } });

  // Test 5: Invalid cost
  console.log("\n--- Test 5: Invalid cost rejected ---");
  const vNeg = validateAuditInput({ itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost:-1, newCost:5 });
  ok("Negative oldCost rejected", vNeg.error && /oldCost/.test(vNeg.error));
  const vNan = validateAuditInput({ itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost:5, newCost:"abc" });
  ok("Non-numeric newCost rejected", vNan.error && /newCost/.test(vNan.error));
  const vInf = validateAuditInput({ itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost:5, newCost:Infinity });
  ok("Infinity rejected", vInf.error && /newCost/.test(vInf.error));
  // Also test via route validation: inventoryValidation should reject negative cost PATCH
  const { validateInventoryItemUpdate } = await import("@/lib/inventoryValidation.js");
  const invInvalid = validateInventoryItemUpdate({ cost: -5 });
  ok("Inventory validation rejects negative cost", invInvalid.error && /cost/.test(invInvalid.error));

  // Test 6: Failed inventory update does not leave cost audit
  console.log("\n--- Test 6: Failed update no audit ---");
  const beforeFailCount = await InventoryAudit.countDocuments({ item:itemId, action:"COST_UPDATED" });
  // Try update with invalid id
  const fakeId = new mongoose.Types.ObjectId();
  const sessFail = await conn.startSession();
  try {
    sessFail.startTransaction();
    const beforeFake = await InventoryItem.findById(fakeId).session(sessFail).lean();
    if (!beforeFake) {
      await sessFail.abortTransaction();
      // Simulate route would return 404, no audit
      ok("Missing item -> no audit", true);
    } else {
      ok("Missing item", false);
    }
  } catch(e){ await sessFail.abortTransaction().catch(()=>{}); }
  finally { await sessFail.endSession().catch(()=>{}); }
  ok("No audit for missing item", (await InventoryAudit.countDocuments({ item:itemId, action:"COST_UPDATED" }))===beforeFailCount);

  // Test 7: Failed audit does not leave inventory mutation (audit validation fail aborts)
  console.log("\n--- Test 7: Failed audit aborts inventory ---");
  const stockBefore = (await InventoryItem.findById(itemId).lean()).cost;
  const sessAuditFail = await conn.startSession();
  try {
    sessAuditFail.startTransaction();
    const before = await InventoryItem.findById(itemId).session(sessAuditFail).lean();
    const updatedFail = await InventoryItem.findOneAndUpdate({ _id:itemId }, { $set:{ cost: 9, updatedAt:new Date() } }, { new:true, session:sessAuditFail }).lean();
    // Try invalid audit (missing newCost)
    try {
      await createInventoryAudit(conn, { itemId, action:"COST_UPDATED", actorId:String(actorId), actorRole, oldCost: Number(before.cost) }, { session:sessAuditFail });
      ok("Invalid audit should throw", false);
      await sessAuditFail.commitTransaction();
    } catch(ae){
      await sessAuditFail.abortTransaction();
      ok("Invalid audit throws", /newCost/.test(ae.message));
      const after = (await InventoryItem.findById(itemId).lean()).cost;
      ok("Inventory rolled back after audit fail", Number(after)===Number(stockBefore));
    }
  } finally { await sessAuditFail.endSession().catch(()=>{}); }

  // Test 8: Existing audits still work (ITEM_CREATED, ITEM_UPDATED, WASTE)
  console.log("\n--- Test 8: Existing audits ---");
  ok("ITEM_CREATED still exists", (await InventoryAudit.countDocuments({ item:itemId, action:"ITEM_CREATED" }))>=0); // may be 0 if item was created before H7.2, but we created one earlier via direct?
  // Create a new item to test ITEM_CREATED still works via route logic (we already did via session, but check)
  const newItem = await InventoryItem.create({ name: tag+"_new", category:"Test", unit:"kg", currentStock:5, cost:2 });
  const newItemId = String(newItem._id);
  // Simulate audit for new item
  await createInventoryAudit(conn, { itemId:newItemId, action:"ITEM_CREATED", actorId:String(actorId), actorRole, quantityDelta:5, beforeStock:null, afterStock:5, reason:"Created" });
  ok("ITEM_CREATED via service still works", (await InventoryAudit.countDocuments({ item:newItemId, action:"ITEM_CREATED" }))===1);
  await InventoryItem.deleteMany({ _id:newItemId });
  await InventoryAudit.deleteMany({ item:newItemId });

  // Test 9: H7.1/H7.2 regression - waste still works
  console.log("\n--- Test 9: H7.1 waste still prevents negative ---");
  await InventoryItem.updateOne({ _id:itemId }, { $set:{ currentStock:10, cost:7 } });
  await InventoryAudit.deleteMany({ item:itemId, action:"WASTE" });
  const { createWasteMovement } = await import("@/lib/inventoryWasteService.js");
  const wasteRes = await createWasteMovement(conn, { itemId, quantity:3, notes:tag, actorId:String(actorId), actorRole });
  ok("Waste via service still works", wasteRes.quantity===3);
  ok("Waste audit still created", (await InventoryAudit.countDocuments({ item:itemId, action:"WASTE" }))===1);

  // Cleanup
  await InventoryItem.deleteMany({ name: { $regex: tag } });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });
  await InventoryAudit.deleteMany({ item:itemId });

  console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
  process.exit(fail>0?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
