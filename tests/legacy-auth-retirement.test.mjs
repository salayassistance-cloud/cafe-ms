// AUTH-ARCH-8F final legacy retirement — DB-free tests.
// Proves the production runtime no longer consults SystemAuth, legacy HMAC,
// or shared role PINs anywhere, while explicit ops scripts and the data
// model file remain classified (not silently depended upon). Engine behavior
// via stub connections; wiring via source assertions (repo convention).
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authenticateRequest } from '../lib/serverAuth.js';
import { can } from '../lib/policy.js';
import { STAFF_ROLES } from '../lib/models/Staff.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const codeOnly = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
const NOW = Date.now();

function staffRec(name, role, over = {}) {
  const _id = new mongoose.Types.ObjectId();
  return { _id, name, role, waiterNumber: role === 'WAITER' ? 3 : null, isActive: true, ...over };
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
function prodFiles() {
  const out = [];
  const scan = (dir, rel) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const rp = join(rel, e);
      if (statSync(p).isDirectory()) { if (!p.includes('node_modules') && !p.includes('.next')) scan(p, rp); continue; }
      if (/\.(js|jsx)$/.test(e)) out.push(rp);
    }
  };
  scan(join(root, 'app'), 'app'); scan(join(root, 'lib'), 'lib');
  return out;
}

describe('AUTH-ARCH-8F final legacy retirement (DB-free)', () => {
  test('1-2. SystemAuth bootstrap rejected: missing Staff fails, nothing created', () => {
    const vp = codeOnly('app/api/auth/verify-pin/route.js');
    assert.ok(!vp.includes('verifyRolePin') && !vp.includes('hasStaffForRole'), 'no bootstrap fallback in login');
    assert.ok(!vp.includes('legacyPayload'), 'no legacy session construction');
  });

  test('3. manager re-auth is Staff-only (fail-closed, no fallback)', () => {
    const s = codeOnly('app/api/manager/staff/route.js');
    assert.ok(s.includes('verifyStaffPinById(conn, managerPayload.staffId'), 'canonical Staff re-auth');
    assert.ok(!s.includes('verifyRolePin'), 'no SystemAuth fallback remains');
  });

  test('4. verifyRolePin has zero production callers', () => {
    const hits = prodFiles().filter((f) => codeOnly(f).includes('verifyRolePin'));
    assert.deepEqual(hits, [], `production callers remain: ${hits.join(', ')}`);
    assert.ok(!existsSync(join(root, 'lib/authService.js')), 'defining module removed');
  });

  test('5-6. no production SystemAuth reads or writes', () => {
    const hits = prodFiles().filter((f) => {
      // The model definition itself is retained for explicit ops scripts;
      // its presence is covered by dedicated assertions below, not this scan.
      if (f === join('lib', 'models', 'SystemAuth.js')) return false;
      const code = codeOnly(f);
      return /getSystemAuth\(|SystemAuth\.create|SystemAuth\.update|sysDoc|system_auth/.test(code);
    });
    assert.deepEqual(hits, [], `production SystemAuth references remain: ${hits.join(', ')}`);
    assert.ok(existsSync(join(root, 'lib/models/SystemAuth.js')), 'model file retained for explicit ops scripts only');
  });

  test('7. no production bono_sess authorization (read, refresh, or issuance)', () => {
    const hits = prodFiles().filter((f) => {
      // The sessionCrypto module itself defines (not calls) these symbols;
      // its zero-importer proof is the dedicated test 8 below.
      if (f === join('lib', 'sessionCrypto.js')) return false;
      const code = codeOnly(f);
      return code.includes('verifySessionToken') || code.includes('createSessionToken') || code.includes('store.set(SESSION_COOKIE') || code.includes('store.delete(SESSION_COOKIE');
    });
    assert.deepEqual(hits, [], `legacy HMAC usage remains: ${hits.join(', ')}`);
  });

  test('8. sessionCrypto has zero production importers', () => {
    const hits = prodFiles().filter((f) => /sessionCrypto/.test(codeOnly(f)));
    assert.deepEqual(hits, [], `production sessionCrypto imports remain: ${hits.join(', ')}`);
  });

  test('9-13. all five roles authenticate canonically (engine proof)', async () => {
    for (const [name, role] of [['Abel', 'WAITER'], ['Kitchen', 'KITCHEN'], ['Barista', 'BARISTA'], ['Cash', 'CASHIER'], ['Manager', 'MANAGER']]) {
      assert.ok(STAFF_ROLES.includes(role), `${role} is a Staff role`);
      const staff = staffRec(name, role);
      const row = sessionRow(staff);
      const conn = stubConn([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: [role] });
      assert.equal(res.ok, true, `${role} resolves`);
      assert.equal(res.payload.role, role);
      assert.equal(can(res.payload.role, role === 'CASHIER' ? 'orders:payment:confirm' : role === 'WAITER' ? 'orders:create' : 'orders:read'), true);
    }
  });

  test('14-16. revoked/disabled/live-role enforced without any legacy', async () => {
    const staff = staffRec('Cash', 'CASHIER');
    const row = sessionRow(staff);
    const conn = stubConn([row], { [String(staff._id)]: staff });
    const provider = async () => conn;
    row.revokedAt = new Date(NOW);
    assert.equal((await authenticateRequest({ connectProvider: provider, newSessionId: row.sessionId })).code, 'SESSION_REVOKED');
    row.revokedAt = null;
    const conn2 = stubConn([row], { [String(staff._id)]: { ...staff, isActive: false } });
    assert.equal((await authenticateRequest({ connectProvider: async () => conn2, newSessionId: row.sessionId })).code, 'ACCOUNT_DISABLED');
    const changed = stubConn([row], { [String(staff._id)]: { ...staff, role: 'WAITER' } });
    const res = await authenticateRequest({ connectProvider: async () => changed, newSessionId: row.sessionId });
    assert.equal(res.payload.role, 'WAITER', 'live role wins with no legacy role source');
  });

  test('17-19. heartbeat, logout, tab independence intact', () => {
    assert.ok(src('lib/sessionStore.js').includes('TAB_HEARTBEAT_INTERVAL_MS'), 'heartbeat constants present');
    assert.ok(codeOnly('app/api/auth/logout/route.js').includes('revokeSessionByTabCredential'), 'tab-scoped logout present');
    assert.ok(src('lib/clientFetch.js').includes('X-Bono-Tab-Session') || src('lib/clientFetch.js').includes('TAB_SESSION_HEADER'), 'tab transport present');
  });

  test('20-23. no Bearer, no client cookie handling, no credential storage, no broadcast', () => {
    assert.ok(!codeOnly('lib/serverAuth.js').includes('bearerToken'), 'no Bearer slot');
    for (const f of ['app/components/WaiterUI.js', 'app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx', 'app/components/PinGuard.js', 'app/components/PinLoginModal.js', 'lib/clientFetch.js', 'lib/orderEvents.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('BroadcastChannel'), `${f}: no cross-tab broadcast`);
      assert.ok(!code.includes('document.cookie'), `${f}: no client cookie handling`);
      assert.ok(!/new EventSource\(`/.test(code), `${f}: no dynamic SSE URL`);
    }
  });

  test('24. order/payment/KDS authorization rules unchanged', () => {
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(can('WAITER', 'orders:payment:confirm'), false);
    assert.equal(can('MANAGER', 'settings:clearOrders'), true);
    assert.equal(can('CASHIER', 'settings:clearOrders'), false);
  });
});
