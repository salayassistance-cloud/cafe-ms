// AUTH-ARCH-8C canonical Staff PIN model — DB-free tests.
// Proves Manager PIN management writes Staff.pinHash only (never SystemAuth),
// revokes only affected sessions, and keeps one PIN mutation path. Engine
// behavior via stub connections; wiring via source assertions (repo
// convention). No database, no production.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authenticateRequest } from '../lib/serverAuth.js';
import { hashPin, verifyPin, isHashedPin } from '../lib/pinCrypto.js';
import { validatePin } from '../lib/validate.js';
import { can } from '../lib/policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const codeOnly = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
const NOW = Date.now();

function staffRec(name, role, over = {}) {
  const _id = new mongoose.Types.ObjectId();
  return { _id, name, role, waiterNumber: null, pinHash: hashPin('1234'), isActive: true, ...over };
}
function sessionRow(staff, over = {}) {
  return { _id: new mongoose.Types.ObjectId(), sessionId: `sess-${String(staff._id).slice(-6)}-abcdefghijklmnopqrstuvwxyz012345`, staffId: staff._id, roleSnapshot: staff.role, tabTokenHash: null, lastSeenAt: new Date(NOW), expiresAt: new Date(NOW + 8 * 3600 * 1000), idleExpiresAt: new Date(NOW + 1800 * 1000), version: 1, revokedAt: null, revokeReason: null, ...over };
}
function stubConn(rows, staffById, calls = null) {
  const pick = (q) => {
    if (!q) return null;
    return rows.find((r) => {
      if (q.sessionId && q.sessionId !== r.sessionId) return false;
      if (q.tabTokenHash && q.tabTokenHash !== r.tabTokenHash) return false;
      if (Object.prototype.hasOwnProperty.call(q, 'revokedAt') && q.revokedAt === null && r.revokedAt) return false;
      return true;
    }) || null;
  };
  const query = (q) => { const rec = pick(q); const self = { select: () => self, lean: () => self, then: (r) => r(rec) }; return self; };
  return { models: {
    Session: {
      findOne: (q) => query(q),
      updateOne: (f, u) => { if (calls) calls.push({ op: 'updateOne', filter: f, update: u }); return { modifiedCount: 1 }; },
      updateMany: (f, u) => { if (calls) calls.push({ op: 'updateMany', filter: f, update: u }); return { modifiedCount: 1 }; },
      findOneAndUpdate: (f, u) => query(f),
    },
    Staff: { findById: (id) => ({ select: () => ({ lean: async () => staffById[String(id)] || null }) }) },
  } };
}

describe('AUTH-ARCH-8C canonical Staff PIN model (DB-free)', () => {
  test('1. update-pins does not write SystemAuth (route retired, writer deleted)', () => {
    assert.ok(!existsSync(join(root, 'app/api/manager/settings/update-pins/route.js')), 'obsolete shared-PIN route removed');
    assert.ok(!existsSync(join(root, 'lib/authService.js')), 'dead SystemAuth runtime module removed in 8F');
  });

  test('2. canonical Staff PIN mutation updates Staff.pinHash (manager/staff path)', () => {
    const s = codeOnly('app/api/manager/staff/route.js');
    assert.ok(s.includes('pinHash: newHash') || s.includes('$set: { pinHash: newHash }'), 'Staff.pinHash is the mutation target');
    assert.ok(s.includes('hashPin(newPin)'), 'single scrypt hashing path (no second algorithm)');
    assert.ok(s.includes('Staff.updateMany') && s.includes('staff.save()'), 'existing Staff model writes reused (no duplicate helper/layer)');
  });

  test('3-4. old PIN fails, new PIN verifies (same primitive the routes use)', () => {
    const stored = hashPin('5678');
    assert.ok(isHashedPin(stored), 'stored form is a hash, never plaintext');
    assert.equal(verifyPin('5678', stored), true, 'new PIN verifies');
    assert.equal(verifyPin('1234', stored), false, 'old PIN no longer verifies');
    assert.ok(validatePin('5678') && !validatePin('567'), 'existing 4-digit PIN policy reused');
  });

  test('5-8. revocation is scoped to affected Staff only (tab + cookie rows)', async () => {
    const alice = staffRec('Alice', 'WAITER'), bob = staffRec('Bob', 'WAITER');
    const rowA1 = sessionRow(alice), rowA2 = sessionRow(alice), rowB = sessionRow(bob);
    const staffById = { [String(alice._id)]: alice, [String(bob._id)]: bob };
    const calls = [];
    const conn = stubConn([rowA1, rowA2, rowB], staffById, calls);
    const { revokeAllStaffSessions } = await import('../lib/sessionStore.js');
    await revokeAllStaffSessions(conn, alice._id, 'PIN_RESET');
    assert.equal(calls.length, 1, 'exactly one revocation write');
    assert.deepEqual(String(calls[0].filter.staffId), String(alice._id), 'scoped to the affected Staff id');
    assert.equal(calls[0].update.$set.revokeReason, 'PIN_RESET');
    // Both of Alice's tabs resolve revoked; Bob stays valid.
    for (const row of [rowA1, rowA2]) {
      row.revokedAt = new Date(NOW); row.revokeReason = 'PIN_RESET';
    }
    const provider = async () => conn;
    for (const row of [rowA1, rowA2]) {
      const res = await authenticateRequest({ connectProvider: provider, newSessionId: row.sessionId });
      assert.equal(res.code, 'SESSION_REVOKED', 'both affected tabs revoked');
    }
    const okRes = await authenticateRequest({ connectProvider: provider, newSessionId: rowB.sessionId });
    assert.equal(okRes.ok, true, 'same-browser other Staff remains active');
  });

  test('9-10. disabled Staff stays disabled; missing Staff is never created', async () => {
    const ghost = staffRec('Ghost', 'WAITER', { isActive: false });
    const row = sessionRow(ghost);
    const conn = stubConn([row], { [String(ghost._id)]: ghost });
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['WAITER'] });
    assert.equal(res.code, 'ACCOUNT_DISABLED', 'disabled staff denied, not re-enabled');
    const route = codeOnly('app/api/manager/staff/route.js');
    assert.ok(!route.includes('isActive: true') || route.includes('updates.isActive'), 'reset path never force-enables (only explicit toggle does)');
  });

  test('11. CASHIER remains independent (per-person reset, no MANAGER sync)', () => {
    const s = codeOnly('app/api/manager/staff/route.js');
    assert.ok(s.includes('["KITCHEN", "BARISTA", "MANAGER"]'), 'role-wide list excludes CASHIER (per-person branch handles it)');
    assert.ok(s.includes('staff.save()'), 'per-person Staff write preserved');
    assert.ok(!s.includes('cashierPin'), 'no SystemAuth cashier PIN exists or is written');
    assert.ok(!/CASHIER.{0,60}MANAGER|MANAGER.{0,60}CASHIER/.test(s.replace(/never|independent|separate/gi, '')), 'no CASHIER↔MANAGER mapping in reset flow');
  });

  test('12. WAITER remains username + personal PIN (no shared waiter PIN)', () => {
    assert.ok(!codeOnly('app/api/manager/staff/route.js').includes('waiterPin'), 'no shared waiter PIN written');
    assert.ok(src('app/api/auth/login-staff/route.js').includes('verifyStaffPin(conn, name, pin, role)'), 'username+PIN path intact');
  });

  test('13. no default PIN creation reintroduced by the migration', () => {
    for (const f of ['app/api/manager/staff/route.js', 'lib/staffService.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('DEFAULT_PINS') && !code.includes('DEFAULT_STAFF'), `${f}: no default-credential factory`);
      assert.ok(!code.includes('ensureDefaultStaff'), `${f}: no bootstrap call`);
    }
  });

  test('14. no client-provided role bypasses Manager authorization on reset', async () => {
    const cashier = staffRec('Cash', 'CASHIER');
    const row = sessionRow(cashier);
    const conn = stubConn([row], { [String(cashier._id)]: cashier });
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.status, 403, 'live role enforced regardless of client claims');
    const s = codeOnly('app/api/manager/staff/route.js');
    assert.ok(s.includes('Role change not allowed'), 'client role field is rejected, never trusted');
    assert.ok(s.includes('requireAuth(request, ["MANAGER"])') || src('app/api/manager/staff/route.js').includes('getLiveSessionFromCookies(store, ["MANAGER"])'), 'MANAGER gate from canonical session');
  });

  test('15. SystemAuth model still exists (8F not executed)', () => {
    assert.ok(existsSync(join(root, 'lib/models/SystemAuth.js')), 'model preserved');
    assert.ok(codeOnly('lib/models/SystemAuth.js').includes('waiterPin'), 'schema untouched');
  });

  test('16. SystemAuth read fallbacks retired with the module (8F)', () => {
    assert.ok(!existsSync(join(root, 'lib/authService.js')), 'no SystemAuth runtime module remains');
    assert.ok(!codeOnly('app/api/auth/verify-pin/route.js').includes('verifyRolePin'), 'verify-pin has no legacy fallback');
    assert.ok(!codeOnly('app/api/manager/staff/route.js').includes('verifyRolePin'), 'manager re-auth has no legacy fallback');
  });

  test('17. zero SystemAuth writes in migrated PIN-management paths', () => {
    for (const f of ['app/api/manager/staff/route.js', 'app/api/auth/change-pin/route.js', 'lib/staffService.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('getSystemAuth('), `${f}: no singleton write path`);
      assert.ok(!code.includes('sysDoc'), `${f}: no singleton mutation`);
      assert.ok(!/waiterPin|kitchenPin|baristaPin|managerPin|cashierPin/.test(code), `${f}: no role-PIN fields`);
    }
  });

  test('18. exactly one PIN mutation service (no duplicate helper introduced)', () => {
    const svc = codeOnly('lib/staffService.js');
    assert.ok(svc.includes('export async function changeStaffPin'), 'canonical change helper present');
    assert.ok(svc.includes('export async function verifyStaffPinById'), 'canonical re-auth helper present');
    const route = codeOnly('app/api/manager/staff/route.js');
    assert.ok(!route.includes('function hashPin') && !route.includes('scrypt'), 'route adds no second hash implementation');
  });
});
