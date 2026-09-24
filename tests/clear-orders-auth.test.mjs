// AUTH-ARCH-8A clear-orders canonical auth — DB-free tests.
// Proves the destructive reset is gated by Session -> live Staff (MANAGER)
// plus the requesting manager's OWN Staff PIN, with no SystemAuth role-PIN
// involvement. Engine behavior via stub connections; route wiring via source
// assertions (repo convention). No database, no production.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { authenticateRequest } from '../lib/serverAuth.js';
import { hashPin, verifyPin } from '../lib/pinCrypto.js';
import { can } from '../lib/policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const route = () => src('app/api/manager/settings/clear-orders/route.js');
const NOW = Date.now();

function staffRec(name, role, over = {}) {
  const _id = new mongoose.Types.ObjectId();
  return { _id, name, role, waiterNumber: null, isActive: true, pinHash: hashPin('1234'), ...over };
}
function sessionRow(staff, over = {}) {
  return { _id: new mongoose.Types.ObjectId(), sessionId: `sess-${String(staff._id).slice(-6)}-abcdefghijklmnopqrstuvwxyz012345`, staffId: staff._id, roleSnapshot: staff.role, tabTokenHash: null, lastSeenAt: new Date(NOW), expiresAt: new Date(NOW + 8 * 3600 * 1000), idleExpiresAt: new Date(NOW + 1800 * 1000), version: 1, revokedAt: null, revokeReason: null, ...over };
}
function stubConn(rows, staffById) {
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
    Session: { findOne: (q) => query(q), updateOne: () => ({ modifiedCount: 1 }), findOneAndUpdate: (f, u) => query(f) },
    Staff: { findById: (id) => ({ select: () => ({ lean: async () => staffById[String(id)] || null }) }) },
  } };
}

describe('AUTH-ARCH-8A clear-orders canonical auth (DB-free)', () => {
  test('1. MANAGER authenticates through the canonical session system', async () => {
    const mgr = staffRec('Manager', 'MANAGER');
    const row = sessionRow(mgr);
    const { conn } = { conn: stubConn([row], { [String(mgr._id)]: mgr }) };
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'MANAGER');
    assert.equal(res.payload.staffId, String(mgr._id), 'identity is the session staff, not client input');
  });

  test('2. authorized MANAGER reaches clear-orders (single canonical gate + intact operation)', () => {
    const s = route();
    assert.ok(s.includes('requireAuth(request, ["MANAGER"])'), 'one canonical MANAGER gate');
    assert.ok(s.includes('verifyStaffPinById(conn, auth.payload.staffId, currentManagerPin)'), 'own-PIN step-up on session staff');
    assert.ok(s.includes('await Order.deleteMany({})'), 'business operation intact');
    assert.ok(s.includes('{ _id: "order_seq" }'), 'counter reset intact');
    assert.ok(s.includes('ok({ clearedOrders:'), 'response contract intact');
  });

  test('3-6. non-MANAGER roles are denied by the MANAGER-only rule', async () => {
    for (const role of ['WAITER', 'KITCHEN', 'BARISTA', 'CASHIER']) {
      assert.equal(can(role, 'settings:clearOrders'), false, `${role} denied by policy`);
      const staff = staffRec(`${role}-op`, role);
      const row = sessionRow(staff);
      const conn = stubConn([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['MANAGER'] });
      assert.equal(res.ok, false);
      assert.equal(res.status, 403, `${role} rejected at the gate`);
    }
    assert.equal(can('MANAGER', 'settings:clearOrders'), true);
  });

  test('7. disabled Manager cannot clear orders', async () => {
    const mgr = staffRec('Manager', 'MANAGER', { isActive: false });
    const row = sessionRow(mgr);
    const conn = stubConn([row], { [String(mgr._id)]: mgr });
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ACCOUNT_DISABLED');
  });

  test('8-9. missing/invalid/revoked authentication is rejected', async () => {
    const mgr = staffRec('Manager', 'MANAGER');
    const row = sessionRow(mgr);
    const live = stubConn([row], { [String(mgr._id)]: mgr });
    const missing = await authenticateRequest({ connectProvider: async () => live });
    assert.equal(missing.status, 401);
    const revoked = stubConn([{ ...row, revokedAt: new Date(NOW), revokeReason: 'LOGOUT' }], { [String(mgr._id)]: mgr });
    const gone = await authenticateRequest({ connectProvider: async () => revoked, newSessionId: row.sessionId });
    assert.equal(gone.code, 'SESSION_REVOKED');
  });

  test('10-11. tab credential resolves the MANAGER tab; other tabs unaffected', async () => {
    const mgr = staffRec('Manager', 'MANAGER');
    const kitchen = staffRec('Kitchen', 'KITCHEN');
    const rm = sessionRow(mgr), rk = sessionRow(kitchen);
    rm.tabTokenHash = crypto.createHash('sha256').update('m'.repeat(43)).digest('hex');
    rk.tabTokenHash = crypto.createHash('sha256').update('k'.repeat(43)).digest('hex');
    const staffById = { [String(mgr._id)]: mgr, [String(kitchen._id)]: kitchen };
    const conn = stubConn([rm, rk], staffById);
    const provider = async () => conn;
    const okRes = await authenticateRequest({ connectProvider: provider, tabCredential: 'm'.repeat(43), allowedRoles: ['MANAGER'] });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.payload.staffId, String(mgr._id));
    const other = await authenticateRequest({ connectProvider: provider, tabCredential: 'k'.repeat(43), allowedRoles: ['MANAGER'] });
    assert.equal(other.status, 403, 'kitchen tab cannot clear orders');
  });

  test('12-13. no SystemAuth PIN verification and no DEFAULT_PINS fallback', () => {
    const s = route();
    assert.ok(!s.includes('verifyRolePin'), 'no SystemAuth role-PIN check');
    // Comments may document the removal; only executable references count.
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
    assert.ok(!code.includes('SystemAuth') && !code.includes('system_auth'), 'no SystemAuth reference in code');
    assert.ok(!code.includes('DEFAULT_PINS'), 'no default-PIN fallback');
    assert.ok(!code.includes('authService'), 'no legacy auth service import');
  });

  test('own-PIN semantics: personal Staff PIN verifies, wrong PIN fails', () => {
    const stored = hashPin('5678');
    assert.equal(verifyPin('5678', stored), true, 'own PIN verifies (same primitive the route uses)');
    assert.equal(verifyPin('0000', stored), false, 'wrong PIN fails');
  });

  test('14-15. no client-supplied role/staffId can bypass authorization', () => {
    const s = route();
    assert.ok(!s.includes('body.role') && !s.includes('body.staffId'), 'no client identity fields read');
    assert.ok(!s.includes('body.username') && !s.includes('isManager'), 'no client authority flags read');
    assert.ok(s.includes('auth.payload.staffId'), 'identity comes from the canonical session only');
  });

  test('16. clear-orders business behavior unchanged (destructive op intact)', () => {
    const s = route();
    assert.ok(s.includes('await Order.deleteMany({})'), 'wipes orders');
    assert.ok(s.includes('upsert: true'), 'counter upsert preserved');
    assert.ok(s.includes('RateLimit') || s.includes('checkRateLimit(request'), 'rate limit preserved');
    assert.ok(s.includes('Payload too large'), 'size guard preserved');
  });

  test('20. no switched/adopt conflict logic in the flow', () => {
    const code = route().replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
    for (const banned of ["'switched'", '"switched"', 'adoptPending', 'pendingIdentity', 'continueBtn']) {
      assert.ok(!code.includes(banned), `route has no ${banned}`);
    }
  });
});
