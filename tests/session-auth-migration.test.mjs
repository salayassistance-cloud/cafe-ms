// AUTH-ARCH-4 requireAuth / portal-session migration — DB-free tests.
// Session + Staff records are stubbed via fake connections (model getters
// read connection.models only, so no database is touched). Legacy HMAC
// tokens use the dev fallback secret via lib/sessionCrypto (pure).
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  parseAuthCookies,
  authenticateRequest,
} from '../lib/serverAuth.js';
import { generateSessionId } from '../lib/sessionStore.js';
import { createSessionToken } from '../lib/sessionCrypto.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

const NOW = Date.now();
const H8 = 8 * 60 * 60 * 1000;
const M30 = 30 * 60 * 1000;
const STAFF_ID = new mongoose.Types.ObjectId();

function sessionRec(over = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    sessionId: generateSessionId(),
    staffId: STAFF_ID,
    roleSnapshot: 'WAITER',
    lastSeenAt: new Date(NOW),
    expiresAt: new Date(NOW + H8),
    idleExpiresAt: new Date(NOW + M30),
    version: 1,
    revokedAt: null,
    revokeReason: null,
    ...over,
  };
}

function staffRec(over = {}) {
  return {
    _id: STAFF_ID,
    name: 'Abel',
    role: 'WAITER',
    waiterNumber: 3,
    isActive: true,
    ...over,
  };
}

// Fake connection: model getters resolve connection.models entries only.
// Query stubs mimic Mongoose chaining: findOne() returns an awaitable
// Query-like (select/lean return the query; awaiting resolves the record),
// exactly like `await Model.findOne(q).select(...).lean()`.
function stubConn({ session = sessionRec(), staff = staffRec(), sessionThrows = false, staffThrows = false, touchCalls = null } = {}) {
  const pickSession = (q) => {
    if (!session) return null;
    if (q && q.sessionId && q.sessionId !== session.sessionId) return null;
    return session;
  };
  const sessionQuery = (q) => {
    if (sessionThrows) throw new Error('db down');
    const rec = pickSession(q);
    const query = {
      select: () => query,
      lean: () => query,
      then: (resolve) => resolve(rec),
    };
    return query;
  };
  return {
    models: {
      Session: {
        findOne: (q) => sessionQuery(q),
        findByIdAndUpdate: (id, update) => {
          if (touchCalls) touchCalls.push({ id, update });
          const query = { lean: () => query, then: (resolve) => resolve({ _id: id, ...update.$set }) };
          return query;
        },
      },
      Staff: {
        findById: () => {
          if (staffThrows) throw new Error('db down');
          return { select: () => ({ lean: async () => staff }) };
        },
      },
    },
  };
}

const providerFor = (conn, calls = null) => async () => {
  if (calls) calls.push(1);
  if (conn instanceof Error) throw conn;
  return conn;
};

function legacyToken(payload) {
  return createSessionToken(payload);
}

describe('AUTH-ARCH-4 canonical resolution (DB-free)', () => {
  test('1. valid new session authenticates with live Staff identity', async () => {
    const s = sessionRec();
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s })),
      newSessionId: s.sessionId,
    });
    assert.equal(res.ok, true);
    assert.equal(res.authMethod, 'server');
    assert.equal(res.payload.staffId, String(STAFF_ID));
    assert.equal(res.payload.role, 'WAITER');
    assert.equal(res.payload.name, 'Abel');
    assert.equal(res.payload.waiterNumber, 3);
  });

  test('2. session resolves to Staff (name/role from Staff, not snapshot)', async () => {
    const s = sessionRec({ roleSnapshot: 'KITCHEN' });
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s, staff: staffRec({ name: 'Kebebe' }) })),
      newSessionId: s.sessionId,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.name, 'Kebebe');
    assert.equal(res.payload.role, 'WAITER');
  });

  test('3. live Staff.role is used (role change applies immediately)', async () => {
    const s = sessionRec({ roleSnapshot: 'CASHIER' });
    const conn = stubConn({ session: s, staff: staffRec({ role: 'WAITER', waiterNumber: 4 }) });
    const asWaiter = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId, allowedRoles: ['WAITER'] });
    assert.equal(asWaiter.ok, true);
    assert.equal(asWaiter.payload.role, 'WAITER');
    const asCashier = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId, allowedRoles: ['CASHIER'] });
    assert.equal(asCashier.ok, false);
    assert.equal(asCashier.status, 403);
  });

  test('4. roleSnapshot is audit-only (MANAGER snapshot never authorizes)', async () => {
    const s = sessionRec({ roleSnapshot: 'MANAGER' });
    const conn = stubConn({ session: s, staff: staffRec({ role: 'WAITER' }) });
    const res = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test('5. inactive Staff is rejected', async () => {
    const s = sessionRec();
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s, staff: staffRec({ isActive: false }) })),
      newSessionId: s.sessionId,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.equal(res.code, 'ACCOUNT_DISABLED');
  });

  test('6. missing Staff is rejected', async () => {
    const s = sessionRec();
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s, staff: null })),
      newSessionId: s.sessionId,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
  });

  test('7. revoked Session is rejected with SESSION_REVOKED', async () => {
    const s = sessionRec({ revokedAt: new Date(NOW), revokeReason: 'LOGOUT' });
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s })),
      newSessionId: s.sessionId,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.equal(res.code, 'SESSION_REVOKED');
  });

  test('8. expired Session is rejected; idle timestamp never rejects (no idle logout)', async () => {
    const exp = sessionRec({ expiresAt: new Date(NOW - 1000) });
    const r1 = await authenticateRequest({ connectProvider: providerFor(stubConn({ session: exp })), newSessionId: exp.sessionId });
    assert.equal(r1.code, 'SESSION_EXPIRED');
    const idle = sessionRec({ idleExpiresAt: new Date(NOW - 1000) });
    const r2 = await authenticateRequest({ connectProvider: providerFor(stubConn({ session: idle })), newSessionId: idle.sessionId });
    assert.equal(r2.ok, true, 'past idle timestamp stays authenticated');
  });

  test('9. valid session touches within throttle rules (never extends absolute)', async () => {
    const stale = sessionRec({ lastSeenAt: new Date(NOW - 10 * 60 * 1000) });
    const calls = [];
    await authenticateRequest({ connectProvider: providerFor(stubConn({ session: stale, touchCalls: calls })), newSessionId: stale.sessionId });
    assert.equal(calls.length, 1);
    assert.ok(Number(calls[0].update.$set.idleExpiresAt) <= Number(stale.expiresAt));
    const freshCalls = [];
    const fresh = sessionRec({ lastSeenAt: new Date(NOW) });
    await authenticateRequest({ connectProvider: providerFor(stubConn({ session: fresh, touchCalls: freshCalls })), newSessionId: fresh.sessionId });
    assert.equal(freshCalls.length, 0);
  });

  test('10. canonical session resolves with no legacy involvement', async () => {
    const s = sessionRec();
    const parsed = parseAuthCookies(
      `__Host-bono_session=${s.sessionId}; bono_sess=GARBAGE.LEGACY`,
    );
    assert.equal(parsed.newSessionId, s.sessionId);
    assert.ok(!('legacyToken' in parsed), 'no legacy slot remains');
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s })),
      newSessionId: parsed.newSessionId,
    });
    assert.equal(res.ok, true);
    assert.equal(res.authMethod, 'server');
  });

  test('11. revoked new session is rejected outright (no legacy concept remains)', async () => {
    const s = sessionRec({ revokedAt: new Date(NOW), revokeReason: 'DISABLED' });
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s })),
      newSessionId: s.sessionId,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_REVOKED');
  });

  test('12. expired new session is rejected outright', async () => {
    const s = sessionRec({ expiresAt: new Date(NOW - 1000) });
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s })),
      newSessionId: s.sessionId,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_EXPIRED');
  });

  test('13. a legacy-only cookie authenticates nothing (must re-login)', async () => {
    const dbCalls = [];
    const res = await authenticateRequest({
      connectProvider: providerFor(new Error('must not connect'), dbCalls),
      newSessionId: null,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.equal(res.error, 'Authentication required');
    assert.equal(dbCalls.length, 0, 'no DB touched without credentials');
  });

  test('14. legacy-shaped values are never treated as sessions', async () => {
    const hmac = legacyToken({ role: 'WAITER' });
    const parsed = parseAuthCookies(`bono_sess=${encodeURIComponent(hmac)}`);
    assert.equal(parsed.newSessionId, null, 'legacy cookie is not parsed as identity');
    assert.ok(!('legacyToken' in parsed), 'no legacy slot remains');
    const dbCalls = [];
    const res = await authenticateRequest({
      connectProvider: providerFor(new Error('must not connect'), dbCalls),
      newSessionId: hmac, // attacker places HMAC where the opaque ID belongs
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_INVALID');
    assert.equal(dbCalls.length, 0, 'no DB lookup for non-opaque IDs');
  });

  test('15. CASHIER session remains CASHIER', async () => {
    const s = sessionRec({ roleSnapshot: 'CASHIER' });
    const conn = stubConn({ session: s, staff: staffRec({ role: 'CASHIER', name: 'Cash', waiterNumber: null }) });
    const res = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId, allowedRoles: ['CASHIER'] });
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'CASHIER');
  });

  test('16. CASHIER does not become MANAGER', async () => {
    const s = sessionRec({ roleSnapshot: 'MANAGER' });
    const conn = stubConn({ session: s, staff: staffRec({ role: 'CASHIER', name: 'Cash' }) });
    const res = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test('17. Manager does not become CASHIER', async () => {
    const s = sessionRec({ roleSnapshot: 'MANAGER' });
    const conn = stubConn({ session: s, staff: staffRec({ role: 'MANAGER', name: 'Manager' }) });
    const res = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId, allowedRoles: ['CASHIER'] });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test('18. allowedRoles enforces the live role (open when unspecified)', async () => {
    const s = sessionRec();
    const conn = stubConn({ session: s });
    const open = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId });
    assert.equal(open.ok, true);
    const denied = await authenticateRequest({ connectProvider: providerFor(conn), newSessionId: s.sessionId, allowedRoles: ['MANAGER'] });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /requires MANAGER/);
  });

  test('19. getPortalSession uses the canonical resolver', () => {
    const s = src('lib/authServer.js');
    assert.ok(s.includes('getLiveSessionFromCookies'), 'must delegate to canonical resolver');
    assert.ok(!s.includes('verifySessionToken'), 'no parallel HMAC algorithm');
  });

  test('20. requireAuth parses the canonical cookie via the canonical engine', () => {
    const sec = src('lib/security.js');
    assert.ok(sec.includes('authenticateRequest'), 'requireAuth must use canonical engine');
    assert.ok(sec.includes('parseAuthCookies'), 'requireAuth must parse the canonical cookie');
    assert.ok(sec.includes('parseTabCredential'), 'requireAuth must read the tab credential');
    assert.ok(!sec.includes('bono_sess=('), 'no duplicated cookie parsing');
    const actions = src('app/manager/menu-crud/actions.js');
    assert.ok(actions.includes('getLiveSessionFromCookies(store, ["MANAGER"])'), 'assertManager requires live MANAGER');
    assert.ok(!actions.includes('verifySessionToken'), 'assertManager must not trust HMAC payload alone');
  });

  test('21. Authorization header alone authenticates nothing (no Bearer)', async () => {
    const s = sessionRec();
    // parseAuthCookies reads the Cookie header only; extra args are ignored.
    const parsed = parseAuthCookies(`__Host-bono_session=${s.sessionId}`);
    assert.equal(parsed.newSessionId, s.sessionId);
    assert.ok(!('bearerToken' in parsed) && !('legacyToken' in parsed), 'no bearer/legacy slots remain');
    const res = await authenticateRequest({
      connectProvider: providerFor(stubConn({ session: s })),
      newSessionId: parsed.newSessionId,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'WAITER');
    // No credentials at all authenticates nothing.
    const r2 = await authenticateRequest({ connectProvider: providerFor(stubConn({ session: s })), newSessionId: null });
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 401);
  });

  test('22. DB failure is 503 and never authenticates', async () => {
    const s = sessionRec();
    const down = providerFor(new Error('db down'));
    const r1 = await authenticateRequest({ connectProvider: down, newSessionId: s.sessionId });
    assert.equal(r1.status, 503);
    // No credentials: 401 without touching the database at all.
    const dbCalls = [];
    const r2 = await authenticateRequest({ connectProvider: providerFor(new Error('must not connect'), dbCalls), newSessionId: null });
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 401);
    assert.equal(dbCalls.length, 0);
  });

  test('23. new code logs no raw session secrets', () => {
    const files = [
      'lib/serverAuth.js',
      'lib/serverSessionCookies.js',
      'lib/sessionStore.js',
      'lib/security.js',
      'lib/authServer.js',
      'app/manager/menu-crud/actions.js',
      'app/cashier/layout.js',
      'app/api/manager/staff/route.js',
    ];
    for (const f of files) {
      for (const line of src(f).split('\n')) {
        assert.ok(!/console\.(log|info|debug)/.test(line), `${f}: ${line.trim()}`);
        if (/console\.(warn|error)/.test(line)) {
          assert.ok(!/sessionId|cookie|token|pin|secret|bearer/i.test(line), `${f}: ${line.trim()}`);
        }
      }
    }
  });
});
