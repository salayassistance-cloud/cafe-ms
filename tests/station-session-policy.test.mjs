import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  SESSION_ABSOLUTE_MS,
  buildSessionDoc,
  isSessionTimeValid,
  isSessionValid,
  attachTabCredential,
  revokeSessionByTabCredential,
  refreshTabSession,
} from '../lib/sessionStore.js';
import { authenticateRequest } from '../lib/serverAuth.js';
import { getSessionErrorKind } from '../lib/clientFetch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const H8 = 8 * 3600 * 1000;

// ---- Minimal stub world (DB-free): rows + staff addressed in memory ----
function makeWorld(rows = [], staffById = {}) {
  const calls = [];
  const pick = (q) => {
    if (!q) return null;
    return rows.find((r) => {
      if (q.sessionId && q.sessionId !== r.sessionId) return false;
      if (q.tabTokenHash && q.tabTokenHash !== r.tabTokenHash) return false;
      if (Object.prototype.hasOwnProperty.call(q, 'revokedAt') && q.revokedAt === null && r.revokedAt) return false;
      if (q._id && String(q._id) !== String(r._id)) return false;
      return true;
    }) || null;
  };
  const chain = (rec) => {
    const self = { select: () => self, lean: async () => rec };
    return self;
  };
  const conn = { models: {
    Session: {
      findOne: (q) => chain(pick(q)),
      updateOne: (filter, update) => { calls.push({ op: 'updateOne', filter, update }); const rec = pick(filter); if (rec) Object.assign(rec, update.$set || {}); return { modifiedCount: rec ? 1 : 0 }; },
      findOneAndUpdate: (filter, update) => { calls.push({ op: 'findOneAndUpdate', filter, update }); const rec = pick(filter); if (!rec) return chain(null); const out = { ...rec, ...(update.$set || {}) }; Object.assign(rec, update.$set || {}); return chain(out); },
      findByIdAndUpdate: (id, update) => { calls.push({ op: 'findByIdAndUpdate', update }); const rec = rows.find((r) => String(r._id) === String(id)); if (rec) Object.assign(rec, update.$set || {}); return chain(rec || null); },
    },
    Staff: { findById: (id) => ({ select: () => ({ lean: async () => staffById[String(id)] || null }) }) },
  } };
  return { conn, calls };
}

const staffRec = (name, role, over = {}) => ({ _id: `staff-${role}-1`, name, role, waiterNumber: role === 'WAITER' ? 3 : null, isActive: true, ...over });
const sessionRow = (staff, over = {}) => ({
  _id: `sessrow-${staff.role}`, sessionId: `sid-${staff.role}-abcdefghijklmnopqrstuvwxyz0123456789`,
  staffId: staff._id, roleSnapshot: staff.role, tabTokenHash: null,
  lastSeenAt: new Date(), expiresAt: new Date(Date.now() + H8), idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
  version: 1, revokedAt: null, revokeReason: null, ...over,
});
const providerFor = (conn) => async () => conn;

describe('STATION-SESSION-POLICY - 8h absolute, no idle logout, tab isolation', () => {
  test('1. session lifetime is exactly 8 hours', () => {
    assert.equal(SESSION_ABSOLUTE_MS, H8);
    const t = Date.now();
    const doc = buildSessionDoc({ staffId: 's1', role: 'WAITER', now: t });
    assert.equal(Number(doc.expiresAt) - t, H8);
  });

  test('2. idle timestamp is never an expiry decision', () => {
    const now = Date.now();
    const s = { revokedAt: null, expiresAt: new Date(now + H8), idleExpiresAt: new Date(now - 3600000) };
    assert.equal(isSessionTimeValid(s, now).ok, true);
    assert.ok(!src('lib/sessionStore.js').includes("reason: 'IDLE_EXPIRED'"), 'no idle-expiry decision remains');
  });

  test('3. valid session after hours of inactivity', () => {
    const now = Date.now();
    const s = { revokedAt: null, lastSeenAt: new Date(now - 7 * 3600 * 1000), expiresAt: new Date(now + 3600000), idleExpiresAt: new Date(now - 6 * 3600 * 1000) };
    assert.equal(isSessionTimeValid(s, now).ok, true);
    assert.equal(isSessionValid(s, { isActive: true, role: 'KITCHEN' }, now).ok, true);
  });

  test('4. valid session before 8 hours', () => {
    const now = Date.now();
    assert.equal(isSessionTimeValid({ revokedAt: null, expiresAt: new Date(now + 1000) }, now).ok, true);
  });

  test('5. absolute boundary is exact (no second-vs-ms drift)', () => {
    const t = 1700000000000;
    const doc = buildSessionDoc({ staffId: 's1', role: 'BARISTA', now: t });
    assert.equal(isSessionTimeValid(doc, t + H8 - 1).ok, true);
    assert.equal(isSessionTimeValid(doc, t + H8 + 1).ok, false);
    assert.equal(isSessionTimeValid(doc, t + H8 + 1).reason, 'EXPIRED');
  });

  test('6. expired session after 8 hours stays expired', () => {
    const now = Date.now();
    assert.equal(isSessionTimeValid({ revokedAt: null, expiresAt: new Date(now - 1) }, now).reason, 'EXPIRED');
  });

  test('7-9. Tab A and Tab B logins are independent rows', async () => {
    const waiter = staffRec('Abel', 'WAITER');
    const kitchen = staffRec('Keb', 'KITCHEN');
    const rowA = sessionRow(waiter); const rowB = sessionRow(kitchen);
    rowA.tabTokenHash = sha('a'.repeat(43)); rowB.tabTokenHash = sha('b'.repeat(43));
    const { conn } = makeWorld([rowA, rowB], { [waiter._id]: waiter, [kitchen._id]: kitchen });
    const a = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'a'.repeat(43) });
    const b = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'b'.repeat(43) });
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(a.payload.staffId, waiter._id);
    assert.equal(b.payload.staffId, kitchen._id);
  });

  test('8b. login mints rows without revoking the presented session (source)', () => {
    for (const f of ['app/api/auth/login-staff/route.js', 'app/api/auth/verify-pin/route.js']) {
      const s = src(f);
      assert.ok(!s.includes('"ROTATED"'), `${f}: no cross-tab revocation on login`);
      assert.ok(!s.includes('revokeSession('), `${f}: login never revokes`);
    }
  });

  test('10. logout Tab A does not invalidate Tab B', async () => {
    const waiter = staffRec('Abel', 'WAITER');
    const kitchen = staffRec('Keb', 'KITCHEN');
    const rowA = sessionRow(waiter); const rowB = sessionRow(kitchen);
    rowA.tabTokenHash = sha('a'.repeat(43)); rowB.tabTokenHash = sha('b'.repeat(43));
    const { conn } = makeWorld([rowA, rowB], { [waiter._id]: waiter, [kitchen._id]: kitchen });
    await revokeSessionByTabCredential(conn, 'a'.repeat(43), 'LOGOUT');
    const b = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'b'.repeat(43) });
    assert.equal(b.ok, true, 'Tab B survives Tab A logout');
    const a = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'a'.repeat(43) });
    assert.equal(a.code, 'SESSION_REVOKED', 'Tab A itself is ended');
  });

  test('10b. logout scopes cookie revocation to cookie-only flows (source)', () => {
    const s = src('app/api/auth/logout/route.js');
    assert.ok(s.includes('!hasTab'), 'cookie row revoked only without a tab credential');
  });

  test('11-12. disabling Staff A ends A only; B stays valid', async () => {
    const cashier = staffRec('Cash', 'CASHIER');
    const manager = staffRec('Mara', 'MANAGER');
    const rowA = sessionRow(cashier); const rowB = sessionRow(manager);
    rowA.tabTokenHash = sha('c'.repeat(43)); rowB.tabTokenHash = sha('m'.repeat(43));
    const byId = { [cashier._id]: { ...cashier, isActive: false }, [manager._id]: manager };
    const { conn } = makeWorld([rowA, rowB], byId);
    const a = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'c'.repeat(43) });
    assert.equal(a.code, 'ACCOUNT_DISABLED');
    const b = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'm'.repeat(43) });
    assert.equal(b.ok, true);
  });

  test('13-14. heartbeat writes only its own row and cannot switch identity', async () => {
    const waiter = staffRec('Abel', 'WAITER');
    const kitchen = staffRec('Keb', 'KITCHEN');
    const rowA = sessionRow(waiter, { lastSeenAt: new Date(1000) });
    const rowB = sessionRow(kitchen, { lastSeenAt: new Date(1000) });
    rowA.tabTokenHash = sha('a'.repeat(43)); rowB.tabTokenHash = sha('b'.repeat(43));
    const { conn, calls } = makeWorld([rowA, rowB], { [waiter._id]: waiter, [kitchen._id]: kitchen });
    const t = Date.now();
    assert.equal((await refreshTabSession(conn, 'a'.repeat(43), t)).ok, true);
    assert.equal(Number(rowA.lastSeenAt), t);
    assert.equal(Number(rowB.lastSeenAt), 1000, 'other tab untouched');
    assert.ok(!calls.some((c) => c.update && c.update.$set && 'expiresAt' in c.update.$set), 'absolute never extended');
    const b = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'b'.repeat(43) });
    assert.equal(b.payload.staffId, kitchen._id, 'identity never switches');
  });

  test('15. temporary 503 never becomes a session end', () => {
    assert.equal(getSessionErrorKind({ status: 503, message: 'Database connection error. Please retry shortly.' }), null);
    assert.equal(getSessionErrorKind({ status: 503, data: { success: false, data: null, error: 'Database connection error. Please retry shortly.' } }), null);
    assert.equal(getSessionErrorKind(new Error('Failed to fetch')), null);
    assert.equal(getSessionErrorKind({ status: 429 }), null);
  });

  test('16. invalid/revoked sessions still end correctly', async () => {
    const waiter = staffRec('Abel', 'WAITER');
    const row = sessionRow(waiter, { revokedAt: new Date(), revokeReason: 'LOGOUT' });
    row.tabTokenHash = sha('a'.repeat(43));
    const { conn } = makeWorld([row], { [waiter._id]: waiter });
    assert.equal((await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'a'.repeat(43) })).code, 'SESSION_REVOKED');
    assert.equal((await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'z'.repeat(43) })).code, 'SESSION_EXPIRED');
    assert.equal((await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'not-opaque!' })).code, 'SESSION_INVALID');
  });

  test('17. disabled staff ends with ACCOUNT_DISABLED', async () => {
    const waiter = staffRec('Abel', 'WAITER', { isActive: false });
    const row = sessionRow(waiter);
    const { conn } = makeWorld([row], { [waiter._id]: waiter });
    const res = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: row.sessionId });
    assert.equal(res.code, 'ACCOUNT_DISABLED');
  });

  test('18. live Staff role wins over the snapshot', async () => {
    const manager = staffRec('Mara', 'MANAGER');
    const row = sessionRow({ ...manager, role: 'WAITER' }, {});
    row.roleSnapshot = 'WAITER';
    const { conn } = makeWorld([row], { [manager._id]: manager });
    const res = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: row.sessionId });
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'MANAGER');
  });

  test('19. CASHIER remains strictly CASHIER', async () => {
    const cashier = staffRec('Cash', 'CASHIER');
    const row = sessionRow(cashier);
    row.tabTokenHash = sha('c'.repeat(43));
    const { conn } = makeWorld([row], { [cashier._id]: cashier });
    const okRes = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'c'.repeat(43), allowedRoles: ['CASHIER'] });
    assert.equal(okRes.ok, true);
    const denied = await authenticateRequest({ connectProvider: providerFor(conn), tabCredential: 'c'.repeat(43), allowedRoles: ['MANAGER'] });
    assert.equal(denied.status, 403);
  });

  test('20. WAITER session carries server-derived identity for order scoping', async () => {
    const waiter = staffRec('Abel', 'WAITER');
    const row = sessionRow(waiter);
    const { conn } = makeWorld([row], { [waiter._id]: waiter });
    const res = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: row.sessionId });
    assert.equal(res.ok, true);
    assert.equal(res.payload.staffId, waiter._id);
    assert.equal(res.payload.role, 'WAITER');
    assert.equal(res.payload.waiterNumber, 3);
  });

  test('attach binds a fresh credential without touching sibling rows', async () => {
    const waiter = staffRec('Abel', 'WAITER');
    const kitchen = staffRec('Keb', 'KITCHEN');
    const rowA = sessionRow(waiter); const rowB = sessionRow(kitchen);
    const before = rowB.tabTokenHash;
    const { conn } = makeWorld([rowA, rowB], { [waiter._id]: waiter, [kitchen._id]: kitchen });
    const raw = await attachTabCredential(conn, rowA.sessionId);
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(rowB.tabTokenHash, before, 'sibling row untouched');
  });
});
