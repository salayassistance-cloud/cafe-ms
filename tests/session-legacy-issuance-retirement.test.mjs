// AUTH-ARCH-8D legacy bono_sess issuance retirement — DB-free tests.
// Proves normal Staff login issues ONLY the canonical session (opaque cookie
// + tab credential), the SystemAuth bootstrap fallback is preserved for 8E,
// and precedence/fail-closed/tab behavior is unchanged. Engine behavior via
// stub connections; wiring via source assertions (repo convention).
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authenticateRequest } from '../lib/serverAuth.js';
import { generateTabCredential, hashTabCredential } from '../lib/sessionStore.js';
import { can } from '../lib/policy.js';

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
async function asRole(staff, allowedRoles, extra = {}) {
  const row = sessionRow(staff);
  const conn = stubConn([row], { [String(staff._id)]: staff });
  return authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles, ...extra });
}

describe('AUTH-ARCH-8D legacy issuance retirement (DB-free)', () => {
  test('1-2. login-staff issues no bono_sess; canonical Session + cookie remain', () => {
    const s = codeOnly('app/api/auth/login-staff/route.js');
    assert.ok(!s.includes('createSessionToken('), 'no HMAC issuance');
    // NOTE: 'SESSION_COOKIE' is a substring of 'NEW_SESSION_COOKIE', so match
    // precise legacy usages instead of the bare identifier.
    assert.ok(!s.includes('store.set(SESSION_COOKIE'), 'legacy cookie never set');
    assert.ok(!s.includes('sessionCrypto'), 'no legacy crypto import remains');
    assert.ok(s.includes('createSession(conn'), 'canonical Session creation preserved');
    assert.ok(s.includes('attachTabCredential'), 'tab credential binding preserved');
  });

  test('3-5. login-staff returns tab credential + sets canonical cookie only', () => {
    const s = src('app/api/auth/login-staff/route.js');
    assert.ok(s.includes('tabCredential'), 'raw tab credential returned once');
    assert.ok(s.includes('store.set(NEW_SESSION_COOKIE'), 'opaque cookie issued');
    assert.ok(!codeOnly('app/api/auth/login-staff/route.js').includes('store.set(SESSION_COOKIE'), 'legacy cookie never set');
  });

  test('6-9. verify-pin: canonical only on every branch (bootstrap retired in 8F)', () => {
    const full = src('app/api/auth/verify-pin/route.js');
    const code = full.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
    assert.ok(!code.includes('createSessionToken('), 'no HMAC issuance on any branch');
    assert.ok(!code.includes('store.set(SESSION_COOKIE'), 'no legacy cookie set on any branch');
    assert.ok(!code.includes('verifyRolePin') && !code.includes('hasStaffForRole'), 'no bootstrap fallback remains');
    assert.ok(code.includes('createSession(conn') && code.includes('attachTabCredential'), 'canonical issuance intact');
  });

  test('10. SystemAuth bootstrap retired in 8F; model file retained for scripts', () => {
    assert.ok(existsSync(join(root, 'lib/models/SystemAuth.js')), 'model file retained (explicit ops scripts import it)');
    assert.ok(!codeOnly('app/api/auth/verify-pin/route.js').includes('verifyRolePin'), 'no bootstrap fallback in login');
  });

  test('11-13. logout revokes canonical session and clears canonical cookie only', () => {
    const s = codeOnly('app/api/auth/logout/route.js');
    assert.ok(s.includes('revokeSession') || s.includes('revokeSessionByTabCredential'), 'canonical revocation preserved');
    assert.ok(s.includes('NEW_SESSION_COOKIE'), 'canonical cookie cleared');
    assert.ok(!s.includes('store.set(SESSION_COOKIE') && !s.includes('store.delete(SESSION_COOKIE'), 'no legacy clearing remains');
    assert.ok(!s.includes('createSessionToken('), 'logout issues nothing');
  });

  test('14. client credential stays memory-only (no new storage/URL/DOM/log paths)', () => {
    for (const f of ['app/components/PinGuard.js', 'app/components/PinLoginModal.js', 'lib/clientFetch.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('localStorage.setItem("tabCredential"') && !code.includes("localStorage.setItem('tabCredential'"), `${f}: no credential in localStorage`);
      assert.ok(!code.includes('sessionStorage.setItem'), `${f}: no credential in sessionStorage`);
    }
    assert.ok(src('lib/clientFetch.js').includes('let tabCredential = null'), 'single memory registry unchanged');
  });

  test('15-19. all five roles keep canonical login (engine, all transports)', async () => {
    for (const [name, role] of [['Abel', 'WAITER'], ['Kitchen', 'KITCHEN'], ['Barista', 'BARISTA'], ['Cash', 'CASHIER'], ['Manager', 'MANAGER']]) {
      const staff = staffRec(name, role);
      const row = sessionRow(staff);
      const conn = stubConn([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: [role] });
      assert.equal(res.ok, true, `${role} canonical login resolves`);
      assert.equal(res.payload.role, role);
    }
  });

  test('20. same-browser tabs stay independent without legacy issuance', async () => {
    const waiter = staffRec('Abel', 'WAITER'), cashier = staffRec('Cash', 'CASHIER');
    const rw = sessionRow(waiter), rc = sessionRow(cashier);
    const staffById = { [String(waiter._id)]: waiter, [String(cashier._id)]: cashier };
    const conn = stubConn([rw, rc], staffById);
    const provider = async () => conn;
    assert.equal((await authenticateRequest({ connectProvider: provider, newSessionId: rw.sessionId })).payload.role, 'WAITER');
    assert.equal((await authenticateRequest({ connectProvider: provider, newSessionId: rc.sessionId })).payload.role, 'CASHIER');
  });

  test('21-23. no mapping, no Bearer, no switched flow reintroduced', () => {
    for (const f of ['app/api/auth/login-staff/route.js', 'app/api/auth/verify-pin/route.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('? "MANAGER"') && !code.includes("? 'MANAGER'"), `${f}: no role conversion`);
    }
    assert.ok(!codeOnly('lib/serverAuth.js').includes('bearerToken'), 'no Bearer fallback reintroduced');
    const waiter = codeOnly('app/components/WaiterUI.js');
    assert.ok(!waiter.includes("'switched'") && !waiter.includes('adoptPendingIdentity'), 'no switched flow reintroduced');
  });

  test('24. revocation intact across transports (cookie row + tab row are one row)', async () => {
    const staff = staffRec('Abel', 'WAITER');
    const raw = generateTabCredential();
    const row = sessionRow(staff, { tabTokenHash: hashTabCredential(raw) });
    const conn = stubConn([row], { [String(staff._id)]: staff });
    const provider = async () => conn;
    assert.equal((await authenticateRequest({ connectProvider: provider, tabCredential: raw })).ok, true, 'tab path valid pre-revocation');
    assert.equal((await authenticateRequest({ connectProvider: provider, newSessionId: row.sessionId })).ok, true, 'cookie path valid pre-revocation');
    row.revokedAt = new Date(NOW); row.revokeReason = 'LOGOUT';
    assert.equal((await authenticateRequest({ connectProvider: provider, tabCredential: raw })).code, 'SESSION_REVOKED', 'tab path revoked');
    assert.equal((await authenticateRequest({ connectProvider: provider, newSessionId: row.sessionId })).code, 'SESSION_REVOKED', 'cookie path revoked');
  });

  test('CASHIER/WAITER/KITCHEN/BARISTA/MANAGER payment + order rules unchanged', async () => {
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(can('WAITER', 'orders:create'), true);
    const cashier = staffRec('Cash', 'CASHIER');
    const row = sessionRow(cashier);
    const conn = stubConn([row], { [String(cashier._id)]: cashier });
    const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: (() => { const r = generateTabCredential(); row.tabTokenHash = hashTabCredential(r); return r; })() });
    assert.equal(res.ok, true);
    assert.equal(can(res.payload.role, 'orders:payment:confirm'), true, 'cashier confirm intact without legacy issuance');
  });
});
