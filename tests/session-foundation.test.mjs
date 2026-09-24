// AUTH-ARCH-2 session foundation — DB-free unit tests.
// No database connection, no production mutation, no login behavior change.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import mongoose from 'mongoose';
import {
  generateSessionId,
  buildSessionDoc,
  computeTouchUpdate,
  isSessionTimeValid,
  isSessionValid,
  sessionFingerprint,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from '../lib/sessionStore.js';
import { SessionSchema, SESSION_ROLES } from '../lib/models/Session.js';

const STAFF_ID = new mongoose.Types.ObjectId();
const now = Date.now();

function liveSession(over = {}) {
  return {
    sessionId: generateSessionId(),
    staffId: STAFF_ID,
    roleSnapshot: 'WAITER',
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + SESSION_ABSOLUTE_MS),
    idleExpiresAt: new Date(now + SESSION_IDLE_MS),
    version: 1,
    revokedAt: null,
    revokeReason: null,
    ...over,
  };
}

describe('AUTH-ARCH-2 session foundation (DB-free)', () => {
  test('2-01 Session ID has sufficient entropy/length (256-bit base64url)', () => {
    const id = generateSessionId();
    assert.match(id, /^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
  });

  test('2-02 Session ID does not contain staffId', () => {
    const sid = String(STAFF_ID);
    for (let i = 0; i < 25; i++) {
      const id = generateSessionId();
      assert.ok(!id.includes(sid.slice(0, 8)) && !id.includes(sid.slice(-8)));
    }
    const doc = buildSessionDoc({ staffId: STAFF_ID, role: 'WAITER' });
    assert.ok(!doc.sessionId.includes(String(STAFF_ID).slice(0, 8)));
  });

  test('2-03 Session ID does not contain role', () => {
    for (const role of SESSION_ROLES) {
      const doc = buildSessionDoc({ staffId: STAFF_ID, role });
      assert.ok(!doc.sessionId.toUpperCase().includes(role));
    }
  });

  test('2-04 Session ID does not contain username/name', () => {
    for (let i = 0; i < 25; i++) {
      const id = generateSessionId().toLowerCase();
      assert.ok(!id.includes('abel') && !id.includes('waiter') && !id.includes('cashier'));
    }
  });

  test('2-05 Different sessions produce different IDs', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    assert.equal(seen.size, 100);
  });

  test('2-06 Revoked session is invalid', () => {
    const s = liveSession({ revokedAt: new Date(now), revokeReason: 'LOGOUT' });
    assert.equal(isSessionTimeValid(s, now).ok, false);
    assert.equal(isSessionValid(s, { isActive: true, role: 'WAITER' }, now).ok, false);
  });

  test('2-07 Expired session is invalid', () => {
    const s = liveSession({ expiresAt: new Date(now - 1000) });
    assert.equal(isSessionTimeValid(s, now).reason, 'EXPIRED');
  });

  test('2-08 Idle timestamp never invalidates a station session (no idle logout)', () => {
    const s = liveSession({ idleExpiresAt: new Date(now - 1000) });
    assert.equal(isSessionTimeValid(s, now).ok, true);
    assert.equal(isSessionValid(s, { isActive: true, role: 'WAITER' }, now).ok, true);
  });

  test('2-09 Inactive Staff invalidates session', () => {
    const s = liveSession();
    assert.equal(isSessionValid(s, { isActive: false, role: 'WAITER' }, now).reason, 'ACCOUNT_DISABLED');
    assert.equal(isSessionValid(s, null, now).reason, 'STAFF_NOT_FOUND');
  });

  test('2-10 CASHIER is a supported role (no MANAGER mapping)', () => {
    assert.ok(SESSION_ROLES.includes('CASHIER'));
    const doc = buildSessionDoc({ staffId: STAFF_ID, role: 'CASHIER' });
    assert.equal(doc.roleSnapshot, 'CASHIER');
    const docLower = buildSessionDoc({ staffId: STAFF_ID, role: 'cashier' });
    assert.equal(docLower.roleSnapshot, 'CASHIER');
    // Schema enum accepts CASHIER
    const paths = SessionSchema.path('roleSnapshot');
    assert.ok(paths.enumValues.includes('CASHIER'));
  });

  test('2-11 roleSnapshot never overrides live Staff.role', () => {
    const s = liveSession({ roleSnapshot: 'WAITER' });
    const res = isSessionValid(s, { isActive: true, role: 'MANAGER' }, now);
    assert.equal(res.ok, true);
    assert.equal(res.liveRole, 'MANAGER'); // live role wins
    assert.equal(res.roleSnapshot, 'WAITER'); // snapshot reported only
  });

  test('2-12 Absolute expiration cannot be extended by idle refresh', () => {
    const nearEnd = liveSession({
      lastSeenAt: new Date(now - 10 * 60 * 1000),
      expiresAt: new Date(now + 5 * 60 * 1000), // 5 min left absolute
      idleExpiresAt: new Date(now - 1000),
    });
    const update = computeTouchUpdate(nearEnd, now);
    assert.ok(update);
    assert.ok(Number(update.idleExpiresAt) <= Number(nearEnd.expiresAt));
    assert.equal(Number(update.idleExpiresAt), Number(nearEnd.expiresAt)); // clamped
  });

  test('fingerprint is safe (no raw id, stable, short)', () => {
    const id = generateSessionId();
    const fp = sessionFingerprint(id);
    assert.equal(fp.length, 12);
    assert.ok(!fp.includes(id.slice(0, 6)));
    assert.equal(sessionFingerprint(id), fp);
  });

  test('model defines required indexes (model-only, not applied to prod)', () => {
    const idx = SessionSchema.indexes().map(([fields, opts]) => ({ fields, opts }));
    assert.ok(idx.some((i) => i.fields.sessionId === 1 && i.opts?.unique));
    assert.ok(idx.some((i) => i.fields.staffId === 1));
    assert.ok(idx.some((i) => i.fields.expiresAt === 1 && i.opts?.expireAfterSeconds === 0));
  });
});
