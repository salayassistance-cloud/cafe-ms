import fs from "fs";
import mongoose from "mongoose";
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
const { getStockMovementModel } = await import("@/lib/models/StockMovement.js");
const { getInventoryAuditModel } = await import("@/lib/models/InventoryAudit.js");
const { createWasteMovement } = await import("@/lib/inventoryWasteService.js");

let pass=0, fail=0;
function ok(n,c,e=""){ if(c){console.log(`✅ ${n}`);pass++;} else {console.log(`❌ ${n} ${e}`);fail++;} }

async function main(){
  const conn = await connectToDatabase();
  console.log("connected", conn.readyState);
  const InventoryItem = getInventoryItemModel(conn);
  const StockMovement = getStockMovementModel(conn);
  const InventoryAudit = getInventoryAuditModel(conn);
  const tag = "H72_DIRECT_SVC_" + Date.now();
  const actorId = new mongoose.Types.ObjectId();
  const actorRole = "MANAGER";

  await InventoryItem.deleteMany({ name: { $regex: tag } });
  await StockMovement.deleteMany({ notes: { $regex: tag } });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });

  // Create item via direct model (to have item for waste)
  const item = await InventoryItem.create({ name: tag+"_item", category:"Test", unit:"kg", currentStock:10, minimumStock:2, cost:5, status:"In Stock" });
  console.log("created item", String(item._id), "stock", item.currentStock);

  // Test 1: Waste via direct service
  console.log("\n--- Direct service waste 3 ---");
  try {
    const res = await createWasteMovement(conn, { itemId: String(item._id), quantity: 3, notes: tag+" waste", actorId: String(actorId), actorRole });
    ok("Direct service waste 3 succeeds", res.quantity===3 && String(res.itemId)===String(item._id));
    const fresh = await InventoryItem.findById(item._id).lean();
    ok("Stock 7 after direct", fresh.currentStock===7);
    const aud = await InventoryAudit.find({ item: item._id, action:"WASTE" }).lean();
    ok("Direct audit created", aud.length===1 && aud[0].quantityDelta===3 && String(aud[0].actorId)===String(actorId) && aud[0].actorRole==="MANAGER");
    const mov = await StockMovement.find({ item: item._id, reason:"Waste" }).lean();
    ok("Direct movement created", mov.length===1);
    ok("Audit correlation matches movement", String(aud[0].correlationId)===String(mov[0]._id));
    ok("Audit before/after", aud[0].beforeStock===10 && aud[0].afterStock===7);
  } catch(e){ ok("Direct service waste", false, e.message + " " + e.stack); }

  // Test 2: Concurrent via direct service
  console.log("\n--- Direct concurrent 6+6 ---");
  await InventoryItem.updateOne({ _id: item._id }, { $set: { currentStock: 10 } });
  await InventoryAudit.deleteMany({ item: item._id, action:"WASTE" });
  await StockMovement.deleteMany({ item: item._id, reason:"Waste" });
  const conc = await Promise.allSettled([
    createWasteMovement(conn, { itemId: String(item._id), quantity: 6, notes: tag+" c1", actorId: String(actorId), actorRole }),
    createWasteMovement(conn, { itemId: String(item._id), quantity: 6, notes: tag+" c2", actorId: String(actorId), actorRole }),
  ]);
  ok("Direct concurrent one success", conc.filter(r=>r.status==="fulfilled").length===1);
  ok("Direct final stock 4", (await InventoryItem.findById(item._id).lean()).currentStock===4);
  ok("Direct one audit after concurrent", (await InventoryAudit.countDocuments({ item: item._id, action:"WASTE" }))===1);
  ok("Direct one movement after concurrent", (await StockMovement.countDocuments({ item: item._id, reason:"Waste" }))===1);
  const losing = conc.find(r=>r.status==="rejected");
  if (losing) console.log("losing reason:", losing.reason.message, "status", losing.reason.status, "code", losing.reason.code, "labels", losing.reason.errorLabels);
  ok("Direct losing is Insufficient 400", losing && losing.reason.status===400);

  // Cleanup
  await InventoryItem.deleteMany({ name: { $regex: tag } });
  await StockMovement.deleteMany({ notes: { $regex: tag } });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });
  console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
  await conn.close();
  process.exit(fail>0?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
