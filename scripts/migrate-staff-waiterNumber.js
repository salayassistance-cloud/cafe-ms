#!/usr/bin/env node
/**
 * Phase 6.5 — Staff waiterNumber migration (idempotent, dry-run default)
 * Assigns canonical waiterNumber 1..10 to WAITER staff, preserving pinHash.
 * - Parses "Waiter N" → N
 * - Otherwise assigns next free 1..10 sequentially by name
 * - Detects duplicates, never overwrites existing waiterNumber
 * - Creates partial unique index {role:1, waiterNumber:1} for WAITER
 * Usage:
 *   node --env-file=.env.local scripts/migrate-staff-waiterNumber.js          # dry-run
 *   node --env-file=.env.local scripts/migrate-staff-waiterNumber.js --apply  # live
 */
import mongoose from "mongoose";
const APPLY = process.argv.includes("--apply");
const DO_WRITE = APPLY;
const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI required"); process.exit(1); }
const host = (uri.match(/@([^\/\?]+)/)||[])[1]||"unknown";
console.log(`Target host: ${host} (redacted)`);
console.log(`Mode: ${DO_WRITE?"APPLY":"DRY RUN"}`);
const conn = await mongoose.createConnection(uri).asPromise();
const col = conn.db.collection("staffs");
const docs = await col.find({ role:"WAITER" }).sort({ name:1 }).toArray();
console.log(`Found ${docs.length} WAITER docs`);
for(const d of docs){ console.log(` - ${d.name} (_id ${d._id}) waiterNumber=${d.waiterNumber ?? "null"} pinHash=${d.pinHash? d.pinHash.slice(0,12)+"...":"none"}`); }
const used = new Set(docs.filter(d=> Number.isInteger(d.waiterNumber) && d.waiterNumber>=1 && d.waiterNumber<=10).map(d=>d.waiterNumber));
console.log(`Used numbers: ${[...used].sort((a,b)=>a-b).join(",")||"none"}`);
let next = 1;
function nextFree(){ while(used.has(next) && next<=10) next++; return next<=10? next : null; }
const plan = [];
// First pass: assign parsed "Waiter N" where N free
const pending = [];
for(const d of docs){
  if (Number.isInteger(d.waiterNumber) && d.waiterNumber>=1 && d.waiterNumber<=10) {
    plan.push({ id:d._id, name:d.name, action:"keep", waiterNumber:d.waiterNumber });
    continue;
  }
  const m = String(d.name).match(/Waiter\s+(\d+)/i);
  if(m){
    const n=Number(m[1]);
    if(n>=1&&n<=10 && !used.has(n)){
      used.add(n);
      plan.push({ id:d._id, name:d.name, action:"assign", waiterNumber:n });
      continue;
    }
  }
  pending.push(d);
}
for(const d of pending){
  let assigned = nextFree();
  if(assigned==null){
    console.warn(`  ! No free number for ${d.name} — all 1..10 occupied, will remain null (manual assignment required)`);
    plan.push({ id:d._id, name:d.name, action:"skip-no-free", waiterNumber:null });
    continue;
  }
  used.add(assigned);
  plan.push({ id:d._id, name:d.name, action:"assign", waiterNumber:assigned });
  while(used.has(next) && next<=10) next++;
}
console.log("\nPlan:");
for(const p of plan){ console.log(`  ${p.action} ${p.name} → ${p.waiterNumber ?? "null"}`); }
const conflicts = [];
const seen = new Map();
for(const p of plan){ if(p.waiterNumber!=null){ if(seen.has(p.waiterNumber)) conflicts.push(`duplicate ${p.waiterNumber}: ${seen.get(p.waiterNumber)} and ${p.name}`); else seen.set(p.waiterNumber, p.name);} }
if(conflicts.length){ console.error("Conflicts:", conflicts); process.exit(1); }
if(!DO_WRITE){
  console.log("\nDRY RUN — no writes. Re-run with --apply to write.");
  // Check index
  const idx = await col.indexes();
  console.log("Existing indexes:", idx.map(i=>i.name).join(", "));
  await conn.close(); process.exit(0);
}
// Apply
for(const p of plan){
  if(p.action==="assign"){
    await col.updateOne({ _id:p.id }, { $set:{ waiterNumber: p.waiterNumber } });
    console.log(`  wrote ${p.name} waiterNumber=${p.waiterNumber}`);
  }
}
 // Ensure indexes
try{
  await col.createIndex({ role:1, waiterNumber:1 }, { unique:true, sparse:true, partialFilterExpression:{ role:"WAITER", waiterNumber:{ $type:"number" } } });
  console.log("Ensured index role_1_waiterNumber_1 partial unique");
}catch(e){ console.log("index ensure:", e.message); }
try{
  await col.createIndex({ name:1, role:1 }, { unique:true });
  console.log("Ensured index name_1_role_1");
}catch(e){}
const after = await col.find({ role:"WAITER" }).toArray();
console.log("\nAfter:");
for(const d of after){ console.log(` - ${d.name} waiterNumber=${d.waiterNumber}`); }
console.log("Migration complete");
await conn.close();
