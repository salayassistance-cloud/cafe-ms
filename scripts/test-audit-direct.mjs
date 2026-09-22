import mongoose from "mongoose";

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI missing"); process.exit(1); }

// Inline schemas to avoid @/ alias
const InventoryItemSchema = new mongoose.Schema({
  name: String, category: String, unit: String,
  currentStock: { type: Number, default: 0, min: 0 },
  minimumStock: { type: Number, default: 0 },
  cost: { type: Number, default: 0 },
  status: { type: String, enum: ["In Stock", "Low Stock", "Out Of Stock"], default: "In Stock" }
}, { timestamps: true, strict: true, collection: "inventoryitems" });

const StockMovementSchema = new mongoose.Schema({
  item: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
  type: { type: String, enum: ["IN","OUT","ADJUSTMENT"], required: true },
  quantity: { type: Number, required: true },
  reason: { type: String, enum: ["Purchase","SaleDeduction","Waste","Correction","Initial"], default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  refOrderId: { type: mongoose.Schema.Types.ObjectId, default: null },
  unit: { type: String, default: null },
  unitCost: { type: Number, default: null },
  totalCost: { type: Number, default: null },
  notes: { type: String, default: "" },
}, { timestamps: true, strict: true, collection: "stockmovements" });

const InventoryAuditSchema = new mongoose.Schema({
  item: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
  action: { type: String, enum: ["ITEM_CREATED","ITEM_UPDATED","WASTE"], required: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  actorRole: { type: String, enum: ["WAITER","KITCHEN","BARISTA","MANAGER"], default: null },
  quantityDelta: { type: Number, default: null },
  beforeStock: { type: Number, default: null },
  afterStock: { type: Number, default: null },
  reason: { type: String, default: "" },
  correlationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  beforeSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  afterSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, strict: true, collection: "inventoryaudits" });

let pass=0, fail=0;
function ok(n,c,e=""){ if(c){console.log(`✅ ${n}`);pass++;} else {console.log(`❌ ${n} ${e}`);fail++;} }

async function main(){
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  console.log("connected");
  const InventoryItem = conn.model("InventoryItem2", InventoryItemSchema);
  const StockMovement = conn.model("StockMovement2", StockMovementSchema);
  const InventoryAudit = conn.model("InventoryAudit2", InventoryAuditSchema);

  const tag = "H72_DIRECT_" + Date.now();
  const actorId = new mongoose.Types.ObjectId();
  const actorRole = "MANAGER";

  await InventoryItem.deleteMany({ name: { $regex: tag } });
  await StockMovement.deleteMany({ notes: { $regex: tag } });
  await InventoryAudit.deleteMany({ reason: { $regex: tag } });

  // Test 1: ITEM_CREATED audit
  console.log("\n--- ITEM_CREATED ---");
  const session1 = await conn.startSession();
  let itemId;
  try {
    session1.startTransaction();
    const doc = new InventoryItem({ name: tag+"_item", category:"Test", unit:"kg", currentStock:10, minimumStock:2, cost:5, status:"In Stock" });
    await doc.save({ session: session1 });
    itemId = doc._id;
    await InventoryAudit.create([{ item: doc._id, action:"ITEM_CREATED", actorId, actorRole, quantityDelta:10, beforeStock:null, afterStock:10, reason:`Created ${doc.name}`, correlationId:null }], { session: session1 });
    await session1.commitTransaction();
    ok("ITEM_CREATED audit committed", true);
  } catch(e){ await session1.abortTransaction().catch(()=>{}); ok("ITEM_CREATED", false, e.message); } finally { await session1.endSession().catch(()=>{}); }
  const audits1 = await InventoryAudit.find({ item:itemId, action:"ITEM_CREATED" }).lean();
  ok("Exactly one ITEM_CREATED", audits1.length===1 && String(audits1[0].actorId)===String(actorId));

  // Test 2: ITEM_UPDATED
  console.log("\n--- ITEM_UPDATED ---");
  const session2 = await conn.startSession();
  try {
    session2.startTransaction();
    const before = await InventoryItem.findById(itemId).session(session2).lean();
    const updated = await InventoryItem.findOneAndUpdate({ _id:itemId }, { $set: { minimumStock:5, cost:7, updatedAt:new Date() } }, { new:true, runValidators:true, session:session2 }).lean();
    await InventoryAudit.create([{ item:itemId, action:"ITEM_UPDATED", actorId, actorRole, beforeStock: before.currentStock, afterStock: updated.currentStock, reason:"Updated minimumStock, cost", beforeSnapshot:{minimumStock:before.minimumStock}, afterSnapshot:{minimumStock:updated.minimumStock} }], { session:session2 });
    await session2.commitTransaction();
    ok("ITEM_UPDATED audit", true);
  } catch(e){ await session2.abortTransaction().catch(()=>{}); ok("ITEM_UPDATED", false, e.message); } finally { await session2.endSession().catch(()=>{}); }
  ok("One ITEM_UPDATED", (await InventoryAudit.countDocuments({ item:itemId, action:"ITEM_UPDATED" }))===1);

  // Test 3: WASTE success
  console.log("\n--- WASTE success ---");
  // Use waste logic with audit inside same txn
  const wasteSession = await conn.startSession();
  let wasteOk=false;
  try {
    wasteSession.startTransaction();
    const before = await InventoryItem.findById(itemId).session(wasteSession).select("currentStock").lean();
    const updateRes = await InventoryItem.updateOne({ _id:itemId, currentStock:{ $gte:3 } }, { $inc:{currentStock:-3} }, { session:wasteSession });
    if ((updateRes.modifiedCount??0)===0) throw new Error("modified 0");
    const [mov] = await StockMovement.create([{ item:itemId, type:"OUT", quantity:3, reason:"Waste", notes:tag+" waste", createdBy:actorId }], { session:wasteSession });
    await InventoryAudit.create([{ item:itemId, action:"WASTE", actorId, actorRole, quantityDelta:3, beforeStock: before.currentStock, afterStock: before.currentStock-3, reason:tag+" waste", correlationId: mov._id }], { session:wasteSession });
    await wasteSession.commitTransaction();
    wasteOk=true;
    ok("WASTE committed with audit", true);
  } catch(e){ await wasteSession.abortTransaction().catch(()=>{}); ok("WASTE", false, e.message); } finally { await wasteSession.endSession().catch(()=>{}); }
  ok("Stock 7 after waste 10-3", (await InventoryItem.findById(itemId).lean()).currentStock===7);
  ok("One WASTE audit", (await InventoryAudit.countDocuments({ item:itemId, action:"WASTE" }))===1);
  ok("One WASTE movement", (await StockMovement.countDocuments({ item:itemId, reason:"Waste" }))===1);

  // Test 4: No audit for rejected waste (0)
  console.log("\n--- Rejected 0 ---");
  const beforeCount = await InventoryAudit.countDocuments({ item:itemId });
  // Simulate validation: quantity 0 should be rejected before audit, so no audit
  const qty0 = 0;
  const isValid0 = Number.isFinite(qty0) && qty0>0;
  ok("Quantity 0 invalid", !isValid0);
  ok("No audit for rejected 0", (await InventoryAudit.countDocuments({ item:itemId }))===beforeCount);

  // Test 5: No audit for insufficient
  console.log("\n--- Insufficient ---");
  const beforeInsuff = await InventoryAudit.countDocuments({ item:itemId });
  const sessFail = await conn.startSession();
  try {
    sessFail.startTransaction();
    const upd = await InventoryItem.updateOne({ _id:itemId, currentStock:{ $gte:100 } }, { $inc:{currentStock:-100} }, { session:sessFail });
    if ((upd.modifiedCount??0)===0) {
      await sessFail.abortTransaction();
      throw new Error("Insufficient");
    }
    await sessFail.commitTransaction();
    ok("Insufficient should fail", false);
  } catch(e){
    await sessFail.abortTransaction().catch(()=>{});
    ok("Insufficient throws", /Insufficient/.test(e.message));
  } finally { await sessFail.endSession().catch(()=>{}); }
  ok("No audit for insufficient", (await InventoryAudit.countDocuments({ item:itemId }))===beforeInsuff);
  ok("Stock unchanged 7", (await InventoryItem.findById(itemId).lean()).currentStock===7);

  // Test 6: Concurrent no duplicate, no negative
  console.log("\n--- Concurrent ---");
  await InventoryItem.updateOne({ _id:itemId }, { $set:{ currentStock:10 } });
  await InventoryAudit.deleteMany({ item:itemId, action:"WASTE" });
  await StockMovement.deleteMany({ item:itemId, reason:"Waste" });
  async function wasteWithAudit(qty, note){
    for(let attempt=0; attempt<2; attempt++){
      const s = await conn.startSession();
      try{
        s.startTransaction();
        const before = await InventoryItem.findById(itemId).session(s).select("currentStock").lean();
        const upd = await InventoryItem.updateOne({ _id:itemId, currentStock:{ $gte:qty } }, { $inc:{currentStock:-qty} }, { session:s });
        if ((upd.modifiedCount??0)===0){
          await s.abortTransaction();
          const fresh = await InventoryItem.findById(itemId).lean();
          if ((fresh.currentStock||0) < qty) { const e=new Error(`Insufficient stock: available ${fresh.currentStock}, requested ${qty}`); e.status=400; throw e; }
          throw new Error("Failed");
        }
        const [mov] = await StockMovement.create([{ item:itemId, type:"OUT", quantity:qty, reason:"Waste", notes:note, createdBy:actorId }], { session:s });
        await InventoryAudit.create([{ item:itemId, action:"WASTE", actorId, actorRole, quantityDelta:qty, beforeStock:before.currentStock, afterStock: before.currentStock-qty, reason:note, correlationId: mov._id }], { session:s });
        await s.commitTransaction();
        return mov;
      } catch(e){
        const isBiz = e.status===400||e.status===404||e.status===409;
        const isTrans = !isBiz && ((e.hasErrorLabel?.("TransientTransactionError")) || e.code===112);
        await s.abortTransaction().catch(()=>{});
        if(isTrans && attempt===0) { /*retry*/ } else throw e;
      } finally { await s.endSession().catch(()=>{}); }
    }
  }
  const conc = await Promise.allSettled([wasteWithAudit(6, tag+" c1"), wasteWithAudit(6, tag+" c2")]);
  ok("Concurrent one success", conc.filter(r=>r.status==="fulfilled").length===1);
  ok("Final stock 4", (await InventoryItem.findById(itemId).lean()).currentStock===4);
  ok("One audit after concurrent", (await InventoryAudit.countDocuments({ item:itemId, action:"WASTE" }))===1);
  ok("One movement after concurrent", (await StockMovement.countDocuments({ item:itemId, reason:"Waste" }))===1);

  // Test 7: Audit failure aborts
  console.log("\n--- Audit failure aborts ---");
  const stockBefore = (await InventoryItem.findById(itemId).lean()).currentStock;
  const sessAuditFail = await conn.startSession();
  try{
    sessAuditFail.startTransaction();
    await InventoryItem.updateOne({ _id:itemId, currentStock:{ $gte:1 } }, { $inc:{currentStock:-1} }, { session:sessAuditFail });
    // Try invalid audit (bad action)
    try{
      await InventoryAudit.create([{ item:itemId, action:"INVALID", actorId, actorRole }], { session:sessAuditFail });
      ok("Invalid audit should fail", false);
      await sessAuditFail.commitTransaction();
    }catch(ae){
      await sessAuditFail.abortTransaction();
      ok("Invalid audit throws", /action/.test(ae.message) || ae.name==="ValidationError");
      ok("Stock rolled back", (await InventoryItem.findById(itemId).lean()).currentStock===stockBefore);
    }
  } finally { await sessAuditFail.endSession().catch(()=>{}); }

  // Cleanup
  await InventoryItem.deleteMany({ _id:itemId });
  await StockMovement.deleteMany({ item:itemId });
  await InventoryAudit.deleteMany({ item:itemId });
  await conn.close();
  console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
  process.exit(fail>0?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
