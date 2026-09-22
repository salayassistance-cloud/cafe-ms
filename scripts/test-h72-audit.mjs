import path from "path";
import { fileURLToPath } from "url";
import Module from "module";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Patch @/ alias BEFORE dynamic imports
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...args) {
  if (request.startsWith("@/")) {
    request = path.join("C:\\hotelms", request.slice(2));
  }
  return originalResolve.call(this, request, parent, ...args);
};

import mongoose from "mongoose";
const { connectToDatabase } = await import("@/lib/mongodb.js");
const { getInventoryItemModel } = await import("@/lib/models/InventoryItem.js");
const { getStockMovementModel } = await import("@/lib/models/StockMovement.js");
const { getInventoryAuditModel, AUDIT_ACTIONS } = await import("@/lib/models/InventoryAudit.js");
const { createWasteMovement } = await import("@/lib/inventoryWasteService.js");
const { validateAuditInput, createInventoryAudit } = await import("@/lib/inventoryAuditService.js");

let pass=0, fail=0;
function ok(name, cond, extra="") { if(cond){ console.log(`✅ ${name}`); pass++; } else { console.log(`❌ ${name} ${extra}`); fail++; } }

async function main(){
  const conn = await connectToDatabase();
  console.log("connected", conn.readyState, "mongoose", mongoose.version);
  const InventoryItem = getInventoryItemModel(conn);
  const StockMovement = getStockMovementModel(conn);
  const InventoryAudit = getInventoryAuditModel(conn);

  const tag = "H72_TEST_" + Date.now();
  const testActorId = new mongoose.Types.ObjectId();
  const testActorRole = "MANAGER";

  // Clean
  await InventoryItem.deleteMany({ name: { $regex: tag } });
  await StockMovement.deleteMany({ notes: { $regex: tag } });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });

  // 1. Create item via direct model + audit (simulate POST route)
  console.log("\n--- Test 1: ITEM_CREATED audit ---");
  const session1 = await conn.startSession();
  let createdItemId;
  try {
    session1.startTransaction();
    const InventoryItemModel = getInventoryItemModel(conn);
    const doc = new InventoryItemModel({ name: tag+"_item", category:"TestCat", unit:"kg", currentStock:10, minimumStock:2, cost:5, status:"In Stock" });
    await doc.save({ session: session1 });
    createdItemId = doc._id;
    const audit = await createInventoryAudit(conn, {
      itemId: String(doc._id),
      action: "ITEM_CREATED",
      actorId: String(testActorId),
      actorRole: testActorRole,
      quantityDelta: Number(doc.currentStock),
      beforeStock: null,
      afterStock: Number(doc.currentStock),
      reason: `Created ${doc.name}`,
      beforeSnapshot: null,
      afterSnapshot: { name: doc.name, currentStock: doc.currentStock },
    }, { session: session1 });
    ok("Audit created for ITEM_CREATED", audit && String(audit.item)===String(doc._id) && audit.action==="ITEM_CREATED");
    ok("Actor attribution correct", String(audit.actorId)===String(testActorId) && audit.actorRole==="MANAGER");
    ok("Timestamp exists", audit.createdAt != null);
    await session1.commitTransaction();
  } catch(e){ console.log("create item audit fail", e); ok("ITEM_CREATED audit", false, e.message); await session1.abortTransaction().catch(()=>{}); }
  finally { await session1.endSession().catch(()=>{}); }

  const item = await InventoryItem.findOne({ name: tag+"_item" }).lean();
  ok("Item exists after audit commit", item != null);
  const audits1 = await InventoryAudit.find({ item: item._id, action:"ITEM_CREATED" }).lean();
  ok("Exactly one ITEM_CREATED audit", audits1.length===1);
  // Verify no secrets stored
  ok("No PIN/token in audit", !JSON.stringify(audits1[0]).includes("pin") && !JSON.stringify(audits1[0]).includes("token"));

  // 2. ITEM_UPDATED audit
  console.log("\n--- Test 2: ITEM_UPDATED audit with before/after ---");
  const session2 = await conn.startSession();
  try {
    session2.startTransaction();
    const before = await InventoryItem.findById(item._id).session(session2).lean();
    const updated = await InventoryItem.findOneAndUpdate({ _id: item._id }, { $set: { minimumStock: 5, cost: 7 } }, { new:true, runValidators:true, session: session2 }).lean();
    const audit = await createInventoryAudit(conn, {
      itemId: String(updated._id),
      action: "ITEM_UPDATED",
      actorId: String(testActorId),
      actorRole: testActorRole,
      beforeStock: Number(before.currentStock),
      afterStock: Number(updated.currentStock),
      reason: "Updated minimumStock, cost",
      beforeSnapshot: { minimumStock: before.minimumStock, cost: before.cost },
      afterSnapshot: { minimumStock: updated.minimumStock, cost: updated.cost },
    }, { session: session2 });
    ok("ITEM_UPDATED audit created", audit.action==="ITEM_UPDATED" && String(audit.actorId)===String(testActorId));
    ok("Before/after snapshots captured", audit.beforeSnapshot.minimumStock===2 && audit.afterSnapshot.minimumStock===5);
    await session2.commitTransaction();
  } catch(e){ ok("ITEM_UPDATED audit", false, e.message); await session2.abortTransaction().catch(()=>{}); }
  finally { await session2.endSession().catch(()=>{}); }
  const audits2 = await InventoryAudit.find({ item: item._id, action:"ITEM_UPDATED" }).lean();
  ok("Exactly one ITEM_UPDATED audit", audits2.length===1);

  // 3. WASTE audit - successful
  console.log("\n--- Test 3: WASTE audit success ---");
  const wasteItem = await InventoryItem.findById(item._id).lean();
  ok("Stock before waste 10", wasteItem.currentStock===10);
  try {
    const res = await createWasteMovement(conn, { itemId: String(item._id), quantity: 3, notes: tag+" waste", actorId: String(testActorId), actorRole: testActorRole });
    ok("Waste 3 succeeds", res.quantity===3);
    const fresh = await InventoryItem.findById(item._id).lean();
    ok("Stock after waste 7", fresh.currentStock===7);
    const wasteAudits = await InventoryAudit.find({ item: item._id, action:"WASTE" }).lean();
    ok("WASTE audit created", wasteAudits.length===1 && wasteAudits[0].quantityDelta===3);
    ok("Waste audit actor correct", String(wasteAudits[0].actorId)===String(testActorId) && wasteAudits[0].actorRole==="MANAGER");
    ok("Waste before/after stock", wasteAudits[0].beforeStock===10 && wasteAudits[0].afterStock===7);
    ok("Waste reason stored", wasteAudits[0].reason.includes(tag));
    ok("Waste correlationId (StockMovement)", wasteAudits[0].correlationId != null);
    const movement = await StockMovement.findOne({ item: item._id, reason:"Waste" }).lean();
    ok("StockMovement correlation matches", String(wasteAudits[0].correlationId)===String(movement._id));
  } catch(e){ ok("WASTE audit", false, e.message + " " + e.stack); }

  // 4. No audit for rejected waste (quantity 0)
  console.log("\n--- Test 4: No audit for rejected waste ---");
  const beforeAudits = await InventoryAudit.countDocuments({ item: item._id });
  try { await createWasteMovement(conn, { itemId: String(item._id), quantity: 0, notes: tag, actorId: String(testActorId), actorRole: testActorRole }); ok("Rejected 0 should throw", false); } catch(e){ ok("Rejected 0 throws 400", e.status===400); }
  const afterAudits = await InventoryAudit.countDocuments({ item: item._id });
  ok("No audit for rejected 0", beforeAudits===afterAudits);
  const beforeStock = (await InventoryItem.findById(item._id).lean()).currentStock;
  ok("Stock unchanged after rejected", beforeStock===7);

  // 5. No audit for insufficient stock
  console.log("\n--- Test 5: No audit for insufficient ---");
  const beforeInsuff = await InventoryAudit.countDocuments({ item: item._id });
  try { await createWasteMovement(conn, { itemId: String(item._id), quantity: 100, notes: tag, actorId: String(testActorId), actorRole: testActorRole }); ok("Insufficient should throw", false); } catch(e){ ok("Insufficient throws 400", e.status===400 && /Insufficient/.test(e.message)); }
  const afterInsuff = await InventoryAudit.countDocuments({ item: item._id });
  ok("No audit for insufficient", beforeInsuff===afterInsuff);
  ok("No movement for insufficient", (await StockMovement.countDocuments({ item: item._id, reason:"Waste" }))===1);

  // 6. No duplicate on retry - concurrent waste
  console.log("\n--- Test 6: Concurrent waste no duplicate audit, no negative ---");
  await InventoryItem.updateOne({ _id: item._id }, { $set: { currentStock: 10 } });
  await InventoryAudit.deleteMany({ item: item._id, action:"WASTE" });
  await StockMovement.deleteMany({ item: item._id, reason:"Waste" });
  const beforeConcurrentAudits = await InventoryAudit.countDocuments({ item: item._id });
  const concurrent = await Promise.allSettled([
    createWasteMovement(conn, { itemId: String(item._id), quantity: 6, notes: tag+" conc1", actorId: String(testActorId), actorRole: testActorRole }),
    createWasteMovement(conn, { itemId: String(item._id), quantity: 6, notes: tag+" conc2", actorId: String(testActorId), actorRole: testActorRole }),
  ]);
  const succ = concurrent.filter(r=>r.status==="fulfilled").length;
  const failC = concurrent.filter(r=>r.status==="rejected").length;
  ok("Concurrent one success one fail", succ===1 && failC===1);
  const finalStock = (await InventoryItem.findById(item._id).lean()).currentStock;
  ok("Final stock 4", finalStock===4);
  ok("Never negative", finalStock>=0);
  const finalAudits = await InventoryAudit.countDocuments({ item: item._id, action:"WASTE" });
  ok("Exactly one audit after concurrent", finalAudits===1);
  const finalMoves = await StockMovement.countDocuments({ item: item._id, reason:"Waste" });
  ok("Exactly one movement after concurrent", finalMoves===1);
  const losing = concurrent.find(r=>r.status==="rejected");
  ok("Losing is Insufficient 400", losing && losing.reason.status===400 && /Insufficient|Failed/.test(losing.reason.message));

  // 7. Actor validation - missing actor should not fabricate, should store null
  console.log("\n--- Test 7: Actor validation ---");
  const v1 = validateAuditInput({ itemId: String(item._id), action:"WASTE", actorId:"invalid", actorRole:"MANAGER", quantityDelta:1 });
  ok("Invalid actorId rejected", v1.error && /actorId/.test(v1.error));
  const v2 = validateAuditInput({ itemId: String(item._id), action:"WASTE", actorId: String(testActorId), actorRole:"FAKE", quantityDelta:1 });
  ok("Invalid role rejected", v2.error && /actorRole/.test(v2.error));
  const v3 = validateAuditInput({ itemId: String(item._id), action:"WASTE", quantityDelta:1 });
  ok("Missing actor allowed (null) but not fabricated", v3.ok && v3.data.actorId===null);
  const v4 = validateAuditInput({ itemId: String(item._id), action:"WASTE", actorId: String(testActorId), actorRole: testActorRole, quantityDelta: "Infinity" });
  ok("Infinity quantityDelta rejected", v4.error && /quantityDelta/.test(v4.error));
  const v5 = validateAuditInput({ itemId: "not-an-id", action:"WASTE" });
  ok("Invalid itemId rejected", v5.error && /itemId/.test(v5.error));

  // 8. Audit failure aborts transaction - try to create audit with invalid action should abort waste
  console.log("\n--- Test 8: Audit failure aborts stock change ---");
  // We test that validateAuditInput would reject, but actual waste service should abort if audit create fails
  // Simulate by trying to create audit with invalid action inside transaction and ensuring stock not changed
  const stockBeforeFail = (await InventoryItem.findById(item._id).lean()).currentStock;
  try {
    const sess = await conn.startSession();
    sess.startTransaction();
    await InventoryItem.updateOne({ _id: item._id, currentStock: { $gte: 1 } }, { $inc: { currentStock: -1 } }, { session: sess });
    // Try invalid audit (bad action)
    try {
      await createInventoryAudit(conn, { itemId: String(item._id), action:"INVALID", actorId: String(testActorId), quantityDelta:1 }, { session: sess });
      ok("Invalid audit should throw", false);
      await sess.commitTransaction();
    } catch(ae){
      await sess.abortTransaction();
      ok("Invalid audit throws 400", ae.status===400 || /action/.test(ae.message));
      // Check stock rolled back
      const after = (await InventoryItem.findById(item._id).lean()).currentStock;
      ok("Stock rolled back after audit fail", after===stockBeforeFail);
    }
    await sess.endSession();
  } catch(e){ ok("Audit failure abort", false, e.message); }

  // 9. API response compatibility - waste still returns 201 shape
  console.log("\n--- Test 9: API response shape ---");
  try {
    const res = await createWasteMovement(conn, { itemId: String(item._id), quantity: 1, notes: tag, actorId: String(testActorId), actorRole: testActorRole });
    ok("Waste returns {itemId, quantity, reason}", res.itemId && res.quantity===1 && res.reason==="Waste");
  } catch(e){ ok("API shape", false, e.message); }

  // Cleanup
  await InventoryItem.deleteMany({ name: { $regex: tag } });
  await StockMovement.deleteMany({ notes: { $regex: tag } });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });
  await InventoryAudit.deleteMany({ item: item._id });

  console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
  await conn.close();
  process.exit(fail>0?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
