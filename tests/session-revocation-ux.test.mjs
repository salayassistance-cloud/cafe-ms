// AUTH-ARCH-5 revocation UX — DB-free tests.
// Pure helper behavior + explicit source assertions on the client wiring
// (repo convention). No database, no production, no order mutation.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionErrorKind, isSessionEndedError } from '../lib/clientFetch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const waiterUI = () => src('app/components/WaiterUI.js');

function region(s, start, end) {
  const i = s.indexOf(start);
  const j = s.indexOf(end, i);
  assert.ok(i !== -1 && j !== -1, `region ${start}..${end} found`);
  return s.slice(i, j);
}

describe('AUTH-ARCH-5 revocation UX (DB-free)', () => {
  test('1. SESSION_REVOKED/EXPIRED/INVALID/DISABLED codes detected by helper', () => {
    const mk = (code, status = 401) => { const e = new Error(code); e.status = status; e.data = { success: false, data: null, error: code, message: code, code }; return e; };
    assert.equal(getSessionErrorKind(mk('SESSION_REVOKED')), 'revoked');
    assert.equal(getSessionErrorKind(mk('SESSION_EXPIRED')), 'expired');
    assert.equal(getSessionErrorKind(mk('SESSION_INVALID')), 'invalid');
    assert.equal(getSessionErrorKind(mk('ACCOUNT_DISABLED')), 'disabled');
    assert.equal(isSessionEndedError(mk('SESSION_REVOKED')), true);
  });

  test('2. legacy 401 without code still ends session; 503/network never do', () => {
    const e401 = new Error('Invalid or expired session'); e401.status = 401;
    assert.equal(getSessionErrorKind(e401), 'expired');
    const eRev = new Error('Your session is no longer valid. Please sign in again.'); eRev.status = 401;
    assert.equal(getSessionErrorKind(eRev), 'revoked');
    const eDis = new Error('Account disabled. Please contact manager.'); eDis.status = 401;
    assert.equal(getSessionErrorKind(eDis), 'disabled');
    const e503 = new Error('Database connection error. Please retry shortly.'); e503.status = 503;
    assert.equal(getSessionErrorKind(e503), null);
    assert.equal(getSessionErrorKind(new TypeError('Failed to fetch')), null);
    assert.equal(getSessionErrorKind(null), null);
    const e403 = new Error('Forbidden'); e403.status = 403;
    assert.equal(getSessionErrorKind(e403), null);
  });

  test('3. WaiterUI routes failures through the shared helper (no string parsing per call)', () => {
    const s = waiterUI();
    assert.ok(s.includes('getSessionErrorKind'), 'shared helper imported and used');
    const uses = (s.match(/getSessionErrorKind\(/g) || []).length;
    assert.ok(uses >= 5, `helper used at all failure points (found ${uses})`);
  });

  test('4. revoked state stops authenticated polling (no storm, cadence unchanged)', () => {
    const s = waiterUI();
    assert.ok(s.includes('if (sessionEndedRef.current) return;'), 'poll guards present');
    assert.ok(s.includes('setInterval(checkIdentity, 30000)'), 'identity cadence unchanged');
    assert.ok(s.includes('ORDERS_FALLBACK_POLL_MS') && s.includes('MENU_FALLBACK_POLL_MS'), 'fallback cadence unchanged');
  });

  test('5. SSE suspends on revocation and resumes on re-auth', () => {
    const hook = src('lib/orderEvents.js');
    assert.ok(hook.includes('onEvent, enabled = true'), 'hook accepts enabled flag');
    assert.ok(hook.includes('if (!enabled) return;'), 'no connection while disabled');
    assert.ok(hook.includes('}, [enabled]);'), 're-subscribes when re-enabled');
    assert.ok(waiterUI().includes('useOrderEvents(handleOrderEvent, !sessionEnded)'), 'WaiterUI binds SSE to session state');
  });

  test('6. stale in-flight successes cannot restore authenticated state', () => {
    const s = waiterUI();
    assert.ok(s.includes('authGenRef'), 'generation guard exists');
    assert.ok(s.includes('gen !== authGenRef.current'), 'stale responses discarded');
    assert.ok(s.includes('authGenRef.current += 1'), 'generation bumps on session end');
  });

  test('7. explicit re-login overlay, no auto credential submission', () => {
    const s = waiterUI();
    assert.ok(s.includes('role="alertdialog"'), 'explicit modal state');
    assert.ok(s.includes("t('signInAgain')") && s.includes("t('sessionEnded')"), 'localized re-login copy');
    const overlay = region(s, 'AUTH-ARCH-12: explicit session-ended state', '{/* HEADER');
    assert.ok((overlay.includes('/api/auth/logout') || overlay.includes('tabLogout()')) && overlay.includes("router.push('/waiter')"), 're-login clears the tab session then navigates');
    assert.ok(!overlay.includes('login-staff') && !overlay.includes('verify-pin'), 'no credential submission from overlay');
    assert.ok(!/type="password"|PinKeypad|setPin/.test(overlay), 'no PIN handling in overlay');
  });

  test('8. auth-sensitive state cleared; safe preferences and LS keys preserved', () => {
    const s = waiterUI();
    const enter = region(s, 'const enterSessionEnded = useCallback', 'const signInAgain');
    for (const stmt of ['setWaiterId(null)', 'setCart({})', 'setActiveOrders([])', 'setFavorites(new Set())']) {
      assert.ok(enter.includes(stmt), `clears: ${stmt}`);
    }
    assert.ok(!s.includes('dismissedCancelled'), 'no dismissal state remains (fully-cancelled orders auto-filter)');
    assert.ok(!s.includes('localStorage.removeItem'), 'no localStorage deletion anywhere in WaiterUI');
    assert.ok(!enter.includes('setLang') && !enter.includes('hotel_theme'), 'language/theme untouched');
  });

  test('9. AUTH-ARCH-12: no switched-identity flow exists (another tab never affects this tab)', () => {
    const raw = waiterUI();
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
    for (const banned of ["'switched'", '"switched"', 'adoptPendingIdentity', 'pendingIdentityRef', 'continueBtn', 'signOutBtn', 'sessionSwitched']) {
      assert.ok(!code.includes(banned), `no switched machinery: ${banned}`);
    }
    // An identity mismatch can now only end the tab's own session (re-login):
    // the mismatch branch enters 'expired' and returns before any state write.
    const check = region(raw, 'async function checkIdentity()', 'intervalId = setInterval');
    const mismatchAt = check.indexOf('String(oldId) !== String(newId)');
    assert.ok(mismatchAt !== -1, 'mismatch branch present');
    const block = check.slice(mismatchAt, check.indexOf('if (!newId && oldId)'));
    assert.ok(block.includes("enterSessionEnded('expired')"), 'mismatch ends own session');
    assert.ok(block.includes('return;'), 'mismatch returns without adopting');
    assert.ok(!block.includes('setWaiterId') && !block.includes('setWaiterName'), 'mismatch writes no identity state');
  });

  test('10. revoked paths never mutate order state or auto-submit', () => {
    const s = waiterUI();
    const enter = region(s, 'const enterSessionEnded = useCallback', 'const signInAgain');
    assert.ok(!enter.includes('sendOrder') && !enter.includes('updateOrderStatusClient'), 'no order writes on revocation');
    assert.ok(!enter.includes('safeFetchJson'), 'no network at all on revocation');
    const submit = region(s, 'async function submitOrder()', 'const serveActiveOrder');
    assert.ok(submit.includes('if (sessionEndedRef.current) return;'), 'no submit while ended');
  });

  test('11. API envelope carries machine-readable session codes', () => {
    const api = src('lib/apiResponse.js');
    assert.ok(api.includes('envelope.code = code'), 'fail() propagates optional code');
    for (const f of ['app/api/auth/me/route.js', 'app/api/orders/route.js', 'app/api/orders/[id]/route.js', 'app/api/orders/[id]/status/route.js']) {
      assert.ok(src(f).includes('fail(auth.error, auth.status, auth.code)'), `${f} propagates auth code`);
    }
  });
});
