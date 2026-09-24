// AUTH-ARCH-8B default-credential/bootstrap cleanup — DB-free tests.
// Proves normal login resolves EXISTING Staff only: no auto-creation, no
// repair, no well-known fallback. Engine behavior via stub connections;
// wiring via explicit source assertions (repo convention). No database.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authenticateRequest } from '../lib/serverAuth.js';
import { hashPin, verifyPin } from '../lib/pinCrypto.js';
import { validatePin } from '../lib/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const codeOnly = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
const NOW = Date.now();

function staffRec(name, role, over = {}) {
  const _id = new mongoose.Types.ObjectId();
  return { _id, name, role, waiterNumber: role === 'WAITER' ? 3 : null, username: name.toLowerCase(), pinHash: hashPin('1234'), isActive: true, ...over };
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

const LOGIN_FILES = ['app/api/auth/login-staff/route.js', 'app/api/auth/verify-pin/route.js'];

describe('AUTH-ARCH-8B default-credential cleanup (DB-free)', () => {
  test('1. existing Staff authenticates normally through the canonical engine', async () => {
    const mgr = staffRec('Manager', 'MANAGER');
    const row = sessionRow(mgr);
    const conn = stubConn([row], { [String(mgr._id)]: mgr });
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.ok, true);
    assert.equal(res.payload.staffId, String(mgr._id));
    assert.ok(src('app/api/auth/login-staff/route.js').includes('verifyStaffPin(conn, name, pin, role)'), 'login verifies existing Staff');
  });

  test('2-3. missing Staff is never auto-created; authentication fails', () => {
    for (const f of [...LOGIN_FILES, 'lib/staffService.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('ensureDefaultStaff'), `${f}: no bootstrap call`);
      assert.ok(!code.includes('DEFAULT_STAFF'), `${f}: no default-Staff factory`);
      assert.ok(!code.includes('insertMany'), `${f}: no bulk creation`);
    }
    assert.ok(!codeOnly('lib/staffService.js').includes('export async function ensureDefaultStaff'), 'factory deleted, not merely unused');
  });

  test('4. wrong PIN triggers no creation/repair path', () => {
    const stored = hashPin('1234');
    assert.equal(verifyPin('9999', stored), false, 'wrong PIN fails cleanly (same primitive login uses)');
    for (const f of LOGIN_FILES) {
      const code = codeOnly(f);
      assert.ok(!code.includes('Staff.create') && !code.includes('.save()'), `${f}: failure path writes nothing`);
    }
  });

  test('5-6. disabled Staff is neither recreated nor re-enabled; access denied', async () => {
    const mgr = staffRec('Manager', 'MANAGER', { isActive: false });
    const row = sessionRow(mgr);
    const conn = stubConn([row], { [String(mgr._id)]: mgr });
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ACCOUNT_DISABLED');
    for (const f of LOGIN_FILES) {
      const code = codeOnly(f);
      assert.ok(!code.includes('isActive: true') && !code.includes('isActive:true'), `${f}: never re-enables accounts`);
    }
  });

  test('7-8. no DEFAULT_PINS / DEFAULT_STAFF in the normal login path', () => {
    for (const f of LOGIN_FILES) assert.ok(!codeOnly(f).includes('DEFAULT_PINS'), `${f}: no default-PIN constant`);
    // AUTH-ARCH-8F: the SystemAuth bootstrap fallback is retired — missing
    // Staff fails authentication instead of consulting a shared role PIN.
    assert.ok(!codeOnly('app/api/auth/verify-pin/route.js').includes('verifyRolePin'), 'no bootstrap fallback in login');
  });

  test('9. ensureDefaultStaff is called by no normal login', () => {
    const hits = [];
    for (const f of [...LOGIN_FILES, 'app/api/auth/change-pin/route.js', 'app/api/auth/logout/route.js', 'app/api/auth/me/route.js']) {
      if (codeOnly(f).includes('ensureDefaultStaff')) hits.push(f);
    }
    assert.deepEqual(hits, [], 'zero login-path callers');
  });

  test('10. WAITER remains Staff username + personal PIN', () => {
    const s = src('app/api/auth/login-staff/route.js');
    assert.ok(s.includes('validateLoginStaffPayload'), 'strict body validation preserved');
    assert.ok(s.includes('verifyStaffPin(conn, name, pin, role)'), 'name+PIN Staff verification preserved');
    assert.ok(s.includes('waiterNumber'), 'waiter identity binding preserved');
    assert.ok(src('app/api/auth/verify-pin/route.js').includes('USE_LOGIN_STAFF'), 'WAITER kept on the username+PIN path');
  });

  test('11-12. CASHIER stays an independent Staff role, never mapped', () => {
    const vp = codeOnly('app/api/auth/verify-pin/route.js');
    assert.ok(!vp.includes('? "MANAGER"') && !vp.includes("? 'MANAGER'"), 'no CASHIER→MANAGER conversion');
    assert.ok(src('app/components/PinLoginModal.js').includes('const authRole = portal.role;'), 'modal passes CASHIER through');
  });

  test('13-15. KITCHEN/BARISTA/MANAGER resolve through existing Staff identity', async () => {
    const vp = codeOnly('app/api/auth/verify-pin/route.js');
    assert.ok(vp.includes('Staff.find({ role })'), 'per-role Staff lookup preserved');
    for (const role of ['KITCHEN', 'BARISTA', 'MANAGER']) {
      const staff = staffRec(role === 'KITCHEN' ? 'Kitchen' : role === 'BARISTA' ? 'Barista' : 'Manager', role);
      const row = sessionRow(staff);
      const conn = stubConn([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: [role] });
      assert.equal(res.ok, true, role);
      assert.equal(res.payload.role, role);
    }
  });

  test('16-17. tab credential behavior intact; tabs stay independent', () => {
    for (const f of LOGIN_FILES) {
      assert.ok(src(f).includes('attachTabCredential'), `${f}: tab issuance preserved`);
      assert.ok(src(f).includes('tabCredential'), `${f}: credential returned to issuing tab`);
    }
    assert.ok(src('lib/sessionStore.js').includes('TAB_HEARTBEAT_INTERVAL_MS'), 'heartbeat constants preserved');
  });

  test('18. no switched/adopt identity behavior returns', () => {
    const code = codeOnly('app/components/WaiterUI.js');
    for (const banned of ["'switched'", '"switched"', 'adoptPendingIdentity', 'pendingIdentityRef']) {
      assert.ok(!code.includes(banned), `WaiterUI has no ${banned}`);
    }
  });

  test('19-21. no PIN/credential in browser storage, URLs, or logs', () => {
    for (const f of ['app/components/PinGuard.js', 'app/components/PinLoginModal.js']) {
      for (const line of codeOnly(f).split('\n')) {
        if (line.includes('localStorage.setItem') || line.includes('sessionStorage.setItem')) {
          assert.ok(!/pin|credential|token|secret|passwd/i.test(line), `${f}: display-only storage — ${line.trim()}`);
        }
      }
    }
    for (const f of LOGIN_FILES) {
      const code = codeOnly(f);
      assert.ok(!code.includes('?pin=') && !code.includes('&pin='), `${f}: no PIN in URL`);
    }
    for (const f of [...LOGIN_FILES, 'lib/staffService.js']) {
      for (const line of codeOnly(f).split('\n')) {
        if (/console\.(log|info|debug|warn|error)/.test(line)) {
          assert.ok(!/pin|secret|passwd|credential|token/i.test(line), `${f}: ${line.trim()}`);
        }
      }
    }
  });

  test('22-25. regression surface intact (migrated suites reference current contracts)', () => {
    assert.ok(src('tests/clear-orders-auth.test.mjs').includes('verifyStaffPinById'), 'clear-orders suite tracks canonical re-auth');
    assert.ok(!src('tests/session-retirement-readiness.test.mjs').includes('blocker: default-credential bootstrap still active'), 'retirement suite tracks bootstrap removal');
    assert.ok(src('app/api/auth/login-staff/route.js').includes('verifyStaffPin(conn, name, pin, role)'), 'login contract unchanged');
    assert.ok(validatePin('1234') && !validatePin('12345'), '4-digit PIN contract unchanged');
  });
});
