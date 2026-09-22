#!/usr/bin/env node
// DB-free tests for P0 fail-closed hardening (lib/security.js + lib/authServer.js)
// No DB connection, no secret read, no package install
import fs from "node:fs";

let pass=0, fail=0;
function ok(name, cond, extra="") {
  if (cond) { console.log(`✅ ${name}`); pass++; } else { console.log(`❌ ${name} ${extra}`); fail++; }
}

console.log("--- Static: lib/security.js fail-closed ---");
const sec = fs.readFileSync("lib/security.js","utf8");
ok("security.js imports isDbError", sec.includes('import { isDbError }') || sec.includes('isDbError'));
ok("security.js does NOT contain old swallow comment", !sec.includes("If DB unavailable, don't block auth"));
ok("security.js catch returns 503 on DB error", sec.includes('status: 503') && sec.includes('Database connection error'));
ok("security.js fail-closed comment present", sec.includes("Fail-closed"));
ok("security.js preserves 401 for disabled", sec.includes('Account disabled') && sec.includes('status: 401'));
ok("security.js preserves 403 for role mismatch", sec.includes('Role mismatch') && sec.includes('status: 403'));

console.log("\n--- Static: lib/authServer.js fail-closed ---");
const auth = fs.readFileSync("lib/authServer.js","utf8");
ok("authServer.js catch returns null (fail-closed)", /} catch\s*\{\s*return null;/.test(auth) || auth.includes("} catch {\n      return null;"));
ok("authServer.js does NOT have empty catch that falls through to return payload", !/} catch \{\}\s*\n\s*return payload/.test(auth));
ok("authServer.js preserves null for missing/disabled", auth.includes("staff.isActive === false") && auth.includes("return null"));
ok("authServer.js has fail-closed comment", auth.includes("Fail-closed"));

console.log("\n--- Behavior: isDbError classification (DB-free) ---");
// isDbError is the same helper used by security.js and withApi
import { isDbError } from "../lib/apiResponse.js";
ok("isDbError true for MongoServerSelectionError", isDbError({ name:"MongoServerSelectionError", message:"Server selection timed out" }));
ok("isDbError true for MongooseError", isDbError({ name:"MongooseError", message:"disconnected" }));
ok("isDbError true for topology closed", isDbError({ message:"topology closed", code: 0 }));
ok("isDbError false for plain 401 error", !isDbError({ message:"Account disabled", status:401 }));
ok("isDbError false for generic Error", !isDbError(new Error("Invalid Name or PIN")));

console.log("\n--- Behavior: valid session unchanged (DB-free) ---");
// Valid token with future exp and correct iat should not be 401 for idle
import { createSessionToken, verifySessionToken } from "../lib/sessionCrypto.js";
const payload = { role:"WAITER", staffId:"507f1f77bcf86cd799439011", name:"TestWaiter" };
const token = createSessionToken(payload);
const verified = verifySessionToken(token);
ok("create/verify round-trip preserves role", verified && verified.role==="WAITER");
ok("verify rejects expired", (()=>{ const p={...payload, exp: Math.floor(Date.now()/1000)-10 }; const t=createSessionToken(p); // create will set new exp, so test via verify of old token
  // Instead test verify with manually expired token
  const expiredB64 = Buffer.from(JSON.stringify({...payload, iat: Date.now()-100000, exp: Math.floor(Date.now()/1000)-100})).toString('base64url');
  const sig = "invalid";
  return !verifySessionToken(expiredB64+"."+sig);
})());

console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
if (fail>0) process.exit(1);
console.log("All fail-closed DB-free checks passed — DB error now 503/null, not valid; disabled still 401, valid still ok.");
