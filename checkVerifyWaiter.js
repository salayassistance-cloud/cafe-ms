const fs = require('fs');
const env = fs.readFileSync('C:\\hotelmanag\\.env.local','utf8').split('\n').reduce((acc,line)=>{const m=line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/); if(m)acc[m[1].trim()]=m[2].trim(); return acc;},{});
process.env.MONGODB_URI = env.MONGODB_URI;
const mongoose = require('mongoose');
const crypto = require('crypto');
function verifyPin(pin, stored){
 if(!stored||typeof stored!=='string'||!stored.includes(':')) return false;
 const [salt,key]=stored.split(':');
 const derived=crypto.scryptSync(String(pin), salt,32).toString('hex');
 const a=Buffer.from(derived,'hex'); const b=Buffer.from(key||'','hex');
 if(a.length!==b.length) return false;
 return crypto.timingSafeEqual(a,b);
}
(async () => {
  const conn = await mongoose.createConnection(process.env.MONGODB_URI, {serverSelectionTimeoutMS:5000}).asPromise();
  const docs = await conn.db.collection('staffs').find({name:'Manager'}).toArray();
  for(const d of docs){ console.log(d.name, d.pinHash, '4444', verifyPin('4444', d.pinHash)); }
  const sys = await conn.db.collection('system_auth').findOne({_id:'system'});
  console.log('sys manager', sys.managerPin, verifyPin('4444', sys.managerPin));
  await conn.close();
})();
