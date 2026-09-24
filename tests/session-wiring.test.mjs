// AUTH-ARCH-3 server-side session wiring — DB-free tests.
// No database connection, no production mutation, no login behavior change
// beyond additive server-session creation/revocation (legacy HMAC intact).
// Route wiring is verified via explicit source assertions (repo convention:
// tests assert on route content) plus pure unit tests of the new helpers.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEW_SESSION_COOKIE,
  NEW_SESSION_COOKIE_OPTS,
  NEW_SESSION_COOKIE_DELETE_OPTS,
  isOpaqueSessionValue,
  parseSessionIdFromCookieHeader,
  resolveSessionPrecedence,
  getRequestMeta,
} from '../lib/serverSessionCookies.js';
import { generateSessionId } from '../lib/sessionStore.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

const loginStaff = () => src('app/api/auth/login-staff/route.js');
const verifyPin = () => src('app/api/auth/verify-pin/route.js');
const logout = () => src('app/api/auth/logout/route.js');
const pinModal = () => src('app/components/PinLoginModal.js');
const changePin = () => src('app/api/auth/change-pin/route.js');
const managerStaff = () => src('app/api/manager/staff/route.js');
const managerWaiters = () => src('app/api/manager/waiters/route.js');

const LEGACY_HMAC_LIKE = 'eyJyb2xlIjoiV0FJVEVSIn0.9f2c4a6b8d0e1f2a3b4c5d6e7f809102132435465768798a9b0c1d2e3f40516';
const JWT_LIKE = 'aaa.bbb.ccc';

describe('AUTH-ARCH-3 session wiring (DB-free)', () => {
  test('1. login-staff creates a server-side session (no legacy issuance)', () => {
    const s = loginStaff();
    assert.ok(s.includes('createSession(conn'), 'must call createSession');
    assert.ok(s.includes('NEW_SESSION_COOKIE'), 'must set the canonical opaque cookie');
    assert.ok(!s.includes('createSessionToken('), 'no legacy HMAC issuance on normal Staff login');
    assert.ok(!s.includes('SESSION_COOKIE, token'), 'no bono_sess set on normal Staff login');
  });

  test('2. verify-pin creates a server-side session only (no legacy issuance anywhere)', () => {
    const s = verifyPin();
    assert.ok(s.includes('createSession(conn'), 'must call createSession');
    assert.ok(s.includes('NEW_SESSION_COOKIE'), 'must set the canonical opaque cookie');
    // AUTH-ARCH-8F: the SystemAuth bootstrap branch is retired — missing Staff
    // fails authentication instead of issuing a legacy session.
    assert.ok(!s.includes('createSessionToken('), 'no legacy issuance on any branch');
    assert.ok(!s.includes('verifyRolePin'), 'no SystemAuth fallback remains');
  });

  test('3. CASHIER remains CASHIER in verify-pin (no MANAGER substitution)', () => {
    const s = verifyPin();
    assert.ok(!s.includes('CASHIER" ? "MANAGER') && !s.includes("CASHIER' ? 'MANAGER"), 'no CASHIER->MANAGER ternary');
    assert.ok(s.includes('createSession(conn'), 'CASHIER success path creates a session like other roles');
  });

  test('4. CASHIER never maps to MANAGER in the login modal', () => {
    const s = pinModal();
    assert.ok(!s.includes('? "MANAGER"'), 'CASHIER->MANAGER mapping must be gone');
    assert.ok(s.includes('const authRole = portal.role;'), 'role passes through unchanged');
    assert.ok(s.includes('payload = { role: authRole, pin: p }'), 'verify-pin receives the true role');
  });

  test('5. new cookie value is opaque (no identity, no JWT/HMAC/JSON)', () => {
    assert.equal(NEW_SESSION_COOKIE, '__Host-bono_session');
    assert.ok(isOpaqueSessionValue(generateSessionId()));
    assert.equal(isOpaqueSessionValue(LEGACY_HMAC_LIKE), false, 'HMAC token must not qualify');
    assert.equal(isOpaqueSessionValue(JWT_LIKE), false, 'JWT shape must not qualify');
    assert.equal(isOpaqueSessionValue('{"staffId":"abc"}'), false, 'JSON must not qualify');
    assert.equal(isOpaqueSessionValue(''), false);
    assert.equal(isOpaqueSessionValue(null), false);
    assert.equal(isOpaqueSessionValue('short'), false);
  });

  test('6. new cookie has secure attributes and no Domain', () => {
    for (const opts of [NEW_SESSION_COOKIE_OPTS, NEW_SESSION_COOKIE_DELETE_OPTS]) {
      assert.equal(opts.httpOnly, true);
      assert.equal(opts.sameSite, 'strict');
      assert.equal(opts.path, '/');
      assert.ok(!('domain' in opts) && !('Domain' in opts), 'no Domain attribute (__Host- semantics)');
    }
    assert.equal(NEW_SESSION_COOKIE_OPTS.maxAge, 8 * 60 * 60, 'maxAge matches 8h absolute session');
    assert.equal(NEW_SESSION_COOKIE_DELETE_OPTS.maxAge, 0);
  });

  test('7. logout revokes the server-side session with LOGOUT (canonical only)', () => {
    const s = logout();
    assert.ok(s.includes('revokeSession(conn, outgoing, "LOGOUT")'), 'must revoke presented session');
    assert.ok(s.includes('NEW_SESSION_COOKIE'), 'must clear the canonical cookie');
    // AUTH-ARCH-8F: legacy bono_sess is neither issued nor authorized anymore,
    // so logout no longer clears it. (Match with '(' — NEW_SESSION_COOKIE is
    // a superstring of SESSION_COOKIE and must not trip this check.)
    assert.ok(!s.includes('store.set(SESSION_COOKIE') && !s.includes('store.delete(SESSION_COOKIE'), 'no legacy clearing remains');
  });

  test('8. logout is idempotent (missing session still succeeds)', () => {
    const s = logout();
    assert.ok(s.includes('if (outgoing && !hasTab)'), 'cookie revocation only for cookie-only flows (never another tab\'s row)');
    assert.ok(s.includes('ok({ loggedOut: true })'), 'always returns success');
    assert.equal(parseSessionIdFromCookieHeader(''), null);
    assert.equal(parseSessionIdFromCookieHeader(null), null);
    assert.equal(parseSessionIdFromCookieHeader('bono_sess=abc; other=1'), null);
  });

  test('9. login never revokes the presented cookie session (tab isolation)', () => {
    for (const s of [loginStaff(), verifyPin()]) {
      assert.ok(!s.includes('"ROTATED"'), 'must not revoke another tab\'s live session on login');
      assert.ok(!s.includes('revokeSession('), 'login mints an independent row; stale rows expire via TTL');
      assert.ok(!s.includes('revokeAllStaffSessions'), 'login must not mass-revoke other sessions');
    }
  });

  test('10. PIN change revokes the affected staff sessions', () => {
    const s = changePin();
    assert.ok(s.includes('revokeAllStaffSessions(conn, sessionStaffId, "PIN_CHANGED")'));
  });

  test('11. manager PIN reset + disable revoke affected sessions (canonical paths only)', () => {
    assert.ok(managerStaff().includes('"PIN_RESET"'), 'manager/staff reset revokes');
    // AUTH-ARCH-8C: the obsolete shared-role update-pins route was retired;
    // per-person revocation lives in POST /api/manager/staff (scoped, no
    // SystemAuth writes). The route file must be gone, not merely unused.
    assert.ok(!existsSync(join(root, 'app/api/manager/settings/update-pins/route.js')), 'update-pins route retired');
    assert.ok(managerStaff().includes('"DISABLED"'), 'manager/staff disable revokes');
    assert.ok(managerWaiters().includes('"DISABLED"'), 'manager/waiters disable revokes');
  });

  test('12. legacy HMAC cookie is never stored as a Session', () => {
    assert.equal(parseSessionIdFromCookieHeader(`bono_sess=${LEGACY_HMAC_LIKE}`), null);
    assert.equal(parseSessionIdFromCookieHeader(`${NEW_SESSION_COOKIE}=${LEGACY_HMAC_LIKE}`), null);
    const id = generateSessionId();
    assert.equal(parseSessionIdFromCookieHeader(`${NEW_SESSION_COOKIE}=${id}`), id);
    for (const s of [loginStaff(), verifyPin()]) {
      assert.ok(!s.includes('createSession(conn,') || s.includes('staffId'), 'sessions bind staffId, never a legacy token');
    }
  });

  test('13. new session takes precedence when both cookies exist', () => {
    const id = generateSessionId();
    assert.equal(resolveSessionPrecedence({ newSessionId: id, legacyToken: LEGACY_HMAC_LIKE }), 'server');
    assert.equal(resolveSessionPrecedence({ newSessionId: null, legacyToken: LEGACY_HMAC_LIKE }), 'legacy');
    assert.equal(resolveSessionPrecedence({ newSessionId: 'bad', legacyToken: LEGACY_HMAC_LIKE }), 'legacy');
    assert.equal(resolveSessionPrecedence({}), 'none');
  });

  test('14. new code logs no raw session ID / cookie / PIN', () => {
    const files = [
      'lib/serverSessionCookies.js',
      'lib/sessionStore.js',
      'app/api/auth/login-staff/route.js',
      'app/api/auth/verify-pin/route.js',
      'app/api/auth/logout/route.js',
      'app/api/auth/change-pin/route.js',
    ];
    for (const f of files) {
      const lines = src(f).split('\n');
      for (const line of lines) {
        assert.ok(!/console\.(log|info|debug)/.test(line), `${f} must not console.log/info/debug: ${line.trim()}`);
        if (/console\.(warn|error)/.test(line)) {
          assert.ok(!/sessionId|cookie|pin|secret/i.test(line), `${f} must not log secrets: ${line.trim()}`);
        }
      }
    }
  });

  test('request metadata helper never throws and hashes downstream only', () => {
    assert.deepEqual(getRequestMeta(null), { userAgent: null, ip: null });
    assert.deepEqual(getRequestMeta({}), { userAgent: null, ip: null });
  });
});
