const fs = require('fs');
const env = fs.readFileSync('C:\\hotelmanag\\.env.local','utf8').split('\n').reduce((acc,line)=>{const m=line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/); if(m)acc[m[1].trim()]=m[2].trim(); return acc;},{});
process.env.MONGODB_URI = env.MONGODB_URI;
const mongoose = require('mongoose');
const crypto = require('crypto');
function hashPin(pin){ const s=crypto.randomBytes(16).toString('hex'); const d=crypto.scryptSync(String(pin), s,32).toString('hex'); return `${s}:${d}`;}
(async()=>{
  const conn=await mongoose.createConnection(process.env.MONGODB_URI,{serverSelectionTimeoutMS:5000}).asPromise();
  const Staff=conn.db.collection('staffs');
  const sys=conn.db.collection('system_auth');
  const hM=hashPin('4444'), hK=hashPin('2222'), hB=hashPin('3333');
  await Staff.updateOne({name:'Manager',role:'MANAGER'},{$set:{pinHash:hM}});
  await Staff.updateOne({name:'Kitchen',role:'KITCHEN'},{$set:{pinHash:hK}});
  await Staff.updateOne({name:'Barista',role:'BARISTA'},{$set:{pinHash:hB}});
  await sys.updateOne({_id:'system'},{$set:{managerPin:hM, kitchenPin:hK, baristaPin:hB}});
  console.log('reset done');
  const m=await Staff.findOne({name:'Manager'});
  console.log(m.pinHash.slice(0,20));
  await conn.close();
})();
