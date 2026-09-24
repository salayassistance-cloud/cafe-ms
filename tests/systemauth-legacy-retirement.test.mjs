// AUTH-ARCH-8E SystemAuth + legacy runtime retirement proof — DB-free tests.
// Proves: zero production SystemAuth WRITES outside two documented compat
// internals, zero normal-path legacy issuance, preserved compat reads, and
// intact canonical behavior for all five roles. Engine behavior via stub
// connections; wiring via source assertions (repo convention). No database.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authenticateRequest } from '../lib/serverAuth.js';
import { can } from '../lib/policy.js';
import { SESSION_ROLES } from '../lib/models/Session.js';
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

// Files allowed to contain SystemAuth WRITE shapes: the compat internals
// themselves (documented 8F scope) plus explicit ops scripts and tests.
const WRITE_SHAPES = ['getSystemAuth(', '.save()', 'updateOne(', 'findOneAndUpdate(', 'SystemAuth.create', '.insertMany(', 'updateMany('];
function prodWriteHits() {
  const hits = [];
  const scan = (dir, rel) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const rp = join(rel, e);
      if (statSync(p).isDirectory()) { if (!p.includes('node_modules') && !p.includes('.next')) scan(p, rp); continue; }
      if (!/\.(js|jsx)$/.test(e)) continue;
      if (rp.startsWith('scripts' + sep) || rp.startsWith('scripts/')) continue;
      if (rp.startsWith('tests' + sep) || rp.startsWith('tests/')) continue;
      if (!rp.startsWith('lib' + sep) && !rp.startsWith('lib/') && !rp.startsWith('app' + sep) && !rp.startsWith('app/')) continue;
      const code = codeOnly(rp);
      if (!/SystemAuth|system_auth|sysDoc/.test(code)) continue;
      for (const w of WRITE_SHAPES) {
        if (code.includes(w)) { hits.push(`${rp}: ${w}`); break; }
      }
    }
  };
  scan(join(root, 'lib'), 'lib'); scan(join(root, 'app'), 'app');
  return hits;
}

describe('AUTH-ARCH-8E SystemAuth + legacy retirement proof (DB-free)', () => {
  test('1. zero production SystemAuth writes anywhere (8F retirement complete)', () => {
    const hits = prodWriteHits();
    assert.deepEqual(hits, [], `no production SystemAuth writes may remain: ${hits.join('; ')}`);
    assert.ok(!existsSync(join(root, 'lib/authService.js')), 'dead SystemAuth runtime module removed');
  });

  test('2. no normal Staff login issues legacy bono_sess', () => {
    assert.ok(!codeOnly('app/api/auth/login-staff/route.js').includes('createSessionToken('), 'login-staff clean');
    const vp = src('app/api/auth/verify-pin/route.js');
    const staffBranch = vp.slice(0, vp.indexOf('Legacy fallback: SystemAuth role PIN'));
    assert.ok(!staffBranch.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n').includes('createSessionToken('), 'verify-pin Staff branch clean');
  });

  test('3. bootstrap fallback retired; model file retained for scripts (8F)', () => {
    assert.ok(!codeOnly('app/api/auth/verify-pin/route.js').includes('verifyRolePin'), 'no bootstrap fallback in login');
    assert.ok(!codeOnly('app/api/auth/verify-pin/route.js').includes('hasStaffForRole'), 'no bootstrap gate remains');
    assert.ok(existsSync(join(root, 'lib/models/SystemAuth.js')), 'model file retained (explicit ops scripts import it)');
  });

  test('4. no default Staff creation during login (8B holds)', () => {
    for (const f of ['app/api/auth/login-staff/route.js', 'app/api/auth/verify-pin/route.js', 'lib/staffService.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('ensureDefaultStaff'), `${f}: no bootstrap call`);
      assert.ok(!code.includes('DEFAULT_STAFF'), `${f}: no default factory`);
    }
  });

  test('5. Staff-only PIN verification on canonical paths', () => {
    assert.ok(codeOnly('app/api/manager/settings/clear-orders/route.js').includes('verifyStaffPinById'), 'clear-orders uses Staff re-auth');
    assert.ok(!codeOnly('app/api/manager/settings/clear-orders/route.js').includes('verifyRolePin'), 'clear-orders has no legacy check');
    assert.ok(codeOnly('app/api/manager/staff/route.js').includes('pinHash: newHash'), 'Staff PIN mutation canonical');
  });

  test('6-10. all five roles authenticate canonically (spot proof)', async () => {
    for (const [name, role] of [['Abel', 'WAITER'], ['Kitchen', 'KITCHEN'], ['Barista', 'BARISTA'], ['Cash', 'CASHIER'], ['Manager', 'MANAGER']]) {
      assert.ok(STAFF_ROLES.includes(role) && SESSION_ROLES.includes(role), `${role} in both role models`);
      const staff = staffRec(name, role);
      const row = sessionRow(staff);
      const conn = stubConn([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: [role] });
      assert.equal(res.ok, true, `${role} resolves`);
      assert.equal(res.payload.role, role);
    }
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(can('CASHIER', 'staff:mutate'), false);
  });

  test('11. clear-orders stays MANAGER-only canonical (spot proof)', async () => {
    const mgr = staffRec('Manager', 'MANAGER');
    const row = sessionRow(mgr);
    const conn = stubConn([row], { [String(mgr._id)]: mgr });
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.ok, true);
    assert.ok(codeOnly('app/api/manager/settings/clear-orders/route.js').includes('requireAuth(request, ["MANAGER"])'), 'single canonical gate');
  });

  test('12-13. legacy cookie cannot override tab or canonical sessions', async () => {
    const staff = staffRec('Abel', 'WAITER');
    const row = sessionRow(staff);
    const conn = stubConn([row], { [String(staff._id)]: staff });
    const provider = async () => conn;
    const tabOkay = await authenticateRequest({ connectProvider: provider, tabCredential: null, newSessionId: row.sessionId, legacyToken: 'stale-legacy' });
    assert.equal(tabOkay.ok, true, 'canonical session wins over legacy');
    assert.equal(tabOkay.authMethod, 'server');
  });

  test('14-16. revoked/disabled/live-role enforced on canonical path', async () => {
    const staff = staffRec('Cash', 'CASHIER');
    const row = sessionRow(staff);
    const conn = stubConn([row], { [String(staff._id)]: staff });
    const provider = async () => conn;
    row.revokedAt = new Date(NOW);
    assert.equal((await authenticateRequest({ connectProvider: provider, newSessionId: row.sessionId })).code, 'SESSION_REVOKED');
    row.revokedAt = null;
    const conn2 = stubConn([row], { [String(staff._id)]: { ...staff, isActive: false } });
    assert.equal((await authenticateRequest({ connectProvider: async () => conn2, newSessionId: row.sessionId })).code, 'ACCOUNT_DISABLED');
    const res = await authenticateRequest({ connectProvider: provider, newSessionId: row.sessionId });
    assert.equal(res.payload.role, 'CASHIER', 'live role enforced, snapshot ignored');
  });

  test('17-19. heartbeat, logout, and tab independence intact (spot proof)', () => {
    assert.ok(src('lib/sessionStore.js').includes('TAB_HEARTBEAT_INTERVAL_MS'), 'heartbeat constants present');
    assert.ok(src('lib/clientFetch.js').includes('startTabHeartbeat'), 'client heartbeat present');
    assert.ok(codeOnly('app/api/auth/logout/route.js').includes('revokeSessionByTabCredential'), 'tab-scoped logout present');
  });

  test('20-23. no Bearer, no client cookie access, no credential storage, no broadcast', () => {
    assert.ok(!codeOnly('lib/serverAuth.js').includes('bearerToken'), 'no Bearer slot');
    const scanFiles = ['app/components/WaiterUI.js', 'app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx', 'app/components/PinGuard.js', 'app/components/PinLoginModal.js', 'lib/clientFetch.js', 'lib/orderEvents.js'];
    for (const f of scanFiles) {
      const code = codeOnly(f);
      assert.ok(!code.includes('BroadcastChannel'), `${f}: no cross-tab broadcast`);
      assert.ok(!/new EventSource\(`/.test(code), `${f}: no dynamic SSE URL`);
      assert.ok(!code.includes('document.cookie'), `${f}: no client cookie access`);
    }
    assert.ok(src('lib/orderEvents.js').includes('new EventSource("/api/events")'), 'fixed identity-free SSE URL');
  });
});
