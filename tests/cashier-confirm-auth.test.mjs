// CASHIER payment-confirm authorization root-cause regression — DB-free.
// Proves the exact reported failure ("Forbidden. Confirm requires Cashier or
// Manager." on a legitimate CASHIER confirm) cannot recur: the canonical
// engine authorizes live CASHIER/MANAGER on both payment endpoints, the UI
// verifies tab identity before mutating, and no legacy/duplicate path can
// reject a true CASHIER. Stub connections + source assertions (repo
// convention). No database, no production.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { authenticateRequest } from '../lib/serverAuth.js';
import { refreshTabSession } from '../lib/sessionStore.js';
import { can, canTransition } from '../lib/policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const codeOnly = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
const NOW = Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function staffRec(name, role, over = {}) {
  const _id = new mongoose.Types.ObjectId();
  return { _id, name, role, waiterNumber: null, isActive: true, ...over };
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
    Session: { findOne: (q) => query(q), updateOne: (f, u) => { const r = pick(f); if (r) Object.assign(r, u.$set || {}); return { modifiedCount: r ? 1 : 0 }; }, findOneAndUpdate: (f, u) => query(f) },
    Staff: { findById: (id) => ({ select: () => ({ lean: async () => staffById[String(id)] || null }) }) },
  } };
}

describe('Cashier confirm authorization root-cause regression (DB-free)', () => {
  test('1-2. CASHIER and MANAGER canonical sessions can confirm payment', async () => {
    for (const role of ['CASHIER', 'MANAGER']) {
      const staff = staffRec(role === 'CASHIER' ? 'Cash' : 'Manager', role);
      const row = sessionRow(staff);
      const conn = stubConn([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId });
      assert.equal(res.ok, true);
      assert.equal(can(res.payload.role, 'orders:payment:confirm'), true, `${role} confirm allowed`);
      assert.equal(canTransition(res.payload.role, 'PAID'), true, `${role} PAID transition allowed`);
    }
  });

  test('3-5. WAITER/KITCHEN/BARISTA cannot confirm payment', async () => {
    for (const role of ['WAITER', 'KITCHEN', 'BARISTA']) {
      assert.equal(can(role, 'orders:payment:confirm'), false, `${role} denied by policy`);
      assert.equal(canTransition(role, 'PAID'), false, `${role} denied PAID transition`);
      const staff = staffRec(`${role}-op`, role);
      const row = sessionRow(staff);
      const conn = stubConn([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId, allowedRoles: ['CASHIER', 'MANAGER'] });
      assert.equal(res.ok, false);
      assert.equal(res.status, 403, `${role} rejected at the gate`);
    }
  });

  test('6. disabled CASHIER cannot confirm', async () => {
    const staff = staffRec('Cash', 'CASHIER', { isActive: false });
    const row = sessionRow(staff);
    const conn = stubConn([row], { [String(staff._id)]: staff });
    const res = await authenticateRequest({ connectProvider: async () => conn, newSessionId: row.sessionId });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ACCOUNT_DISABLED');
  });

  test('7. cashier tab credential resolves as CASHIER (not cookie identity)', async () => {
    const cashier = staffRec('Cash', 'CASHIER');
    const waiter = staffRec('Abel', 'WAITER');
    const rowC = sessionRow(cashier), rowW = sessionRow(waiter);
    rowC.tabTokenHash = sha('c'.repeat(43));
    const staffById = { [String(cashier._id)]: cashier, [String(waiter._id)]: waiter };
    const conn = stubConn([rowC, rowW], staffById);
    // Tab header present (cashier) + foreign cookie (waiter row id): tab wins.
    const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: 'c'.repeat(43), newSessionId: rowW.sessionId });
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'CASHIER', 'tab credential takes precedence over cookie');
    assert.equal(can(res.payload.role, 'orders:payment:confirm'), true);
  });

  test('8. legacy/cross-tab cookie identity cannot override a valid tab credential', async () => {
    const cashier = staffRec('Cash', 'CASHIER');
    const row = sessionRow(cashier);
    row.tabTokenHash = sha('c'.repeat(43));
    const conn = stubConn([row], { [String(cashier._id)]: cashier });
    const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: 'c'.repeat(43), legacyToken: 'forged-or-stale-legacy' });
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'CASHIER');
  });

  test('9-10. WAITER tab stays WAITER while CASHIER tab confirms', async () => {
    const cashier = staffRec('Cash', 'CASHIER');
    const waiter = staffRec('Abel', 'WAITER');
    const rowC = sessionRow(cashier), rowW = sessionRow(waiter);
    rowC.tabTokenHash = sha('c'.repeat(43)); rowW.tabTokenHash = sha('w'.repeat(43));
    const staffById = { [String(cashier._id)]: cashier, [String(waiter._id)]: waiter };
    const conn = stubConn([rowC, rowW], staffById);
    const provider = async () => conn;
    const cash = await authenticateRequest({ connectProvider: provider, tabCredential: 'c'.repeat(43) });
    const wait = await authenticateRequest({ connectProvider: provider, tabCredential: 'w'.repeat(43) });
    assert.equal(cash.payload.role, 'CASHIER');
    assert.equal(wait.payload.role, 'WAITER');
    assert.equal(can(wait.payload.role, 'orders:payment:confirm'), false, 'waiter tab still cannot confirm');
  });

  test('11. cashier heartbeat preserves CASHIER identity', async () => {
    const cashier = staffRec('Cash', 'CASHIER');
    const row = sessionRow(cashier);
    row.tabTokenHash = sha('c'.repeat(43));
    const conn = stubConn([row], { [String(cashier._id)]: cashier });
    const res = await refreshTabSession(conn, 'c'.repeat(43), NOW + 60000);
    assert.equal(res.ok, true);
    const again = await authenticateRequest({ connectProvider: async () => conn, tabCredential: 'c'.repeat(43) });
    assert.equal(again.payload.role, 'CASHIER');
  });

  test('12. navigation-safe login: credential stored, soft nav preserves it', () => {
    for (const f of ['app/components/PinGuard.js', 'app/components/PinLoginModal.js']) {
      const s = src(f);
      assert.ok(s.includes('setTabCredential(data.tabCredential'), `${f}: stores issued credential`);
    }
    // Single navigation helper: cross-route push, same-route refresh (no reload wiping memory).
    assert.ok(src('app/components/PinGuard.js').includes('navigateAfterAuth(router, target)'), 'PinGuard soft-navigates (no reload wiping memory)');
    assert.ok(src('lib/clientFetch.js').includes('router.refresh()'), 'same-route case refreshes instead of reloading');
    assert.ok(!src('app/components/PinGuard.js').includes('window.location.reload'), 'no reload in the login path');
  });

  test('13. confirm request carries the canonical tab credential', () => {
    const s = src('app/components/CashierUI.jsx');
    assert.ok(s.includes('safeFetchJson(`/api/orders/${selected._id}`'), 'confirm uses canonical fetch helper');
    assert.ok(src('lib/clientFetch.js').includes('withTabHeaders('), 'helper attaches the tab header centrally');
    assert.ok(s.includes('verifyCashierIdentity(gen)'), 'confirm pre-verifies tab identity');
  });

  test('14. no client role is trusted on the confirm path', () => {
    const route = codeOnly('app/api/orders/[id]/route.js');
    assert.ok(!route.includes('body.role'), 'route reads no client role');
    const ui = codeOnly('app/components/CashierUI.jsx');
    assert.ok(ui.includes("body: JSON.stringify({ status: 'PAID' })"), 'confirm body carries status only, no role');
  });

  test('15. no CASHIER→MANAGER mapping anywhere on the path', () => {
    for (const f of ['app/components/CashierUI.jsx', 'app/api/orders/[id]/route.js', 'app/api/orders/[id]/status/route.js', 'lib/serverAuth.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('? "MANAGER"') && !code.includes("? 'MANAGER'"), `${f}: no MANAGER substitution`);
    }
  });

  test('16. no duplicate/obsolete payment auth path can reject a true CASHIER', () => {
    const status = codeOnly('app/api/orders/[id]/status/route.js');
    assert.ok(status.includes('"orders:payment:confirm"'), 'status route uses canonical confirm permission');
    const hasBareGate = status.includes('"orders:payment"') && !status.includes('"orders:payment:confirm"');
    assert.ok(!hasBareGate, 'no bare payment gate remains on PAID path');
    const single = codeOnly('app/api/orders/[id]/route.js');
    assert.ok(single.includes('"orders:payment:confirm"'), 'single route uses canonical confirm permission');
  });
});
