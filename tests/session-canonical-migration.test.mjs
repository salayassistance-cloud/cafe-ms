// AUTH-ARCH-6 canonical migration — DB-free tests.
// Verifies app-wide code propagation, dead-auth cleanup, Bearer removal,
// getAuthorizedSession removal, and station/cashier session-ended UX.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { can } from '../lib/policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

function apiRouteFiles(dir = join(root, 'app', 'api')) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...apiRouteFiles(p));
    else if (e === 'route.js') out.push(p);
  }
  return out;
}

describe('AUTH-ARCH-6 canonical migration (DB-free)', () => {
  test('1-4. canonical SESSION codes propagate from every auth-guarded API route', () => {
    const files = apiRouteFiles();
    assert.ok(files.length > 20, `enumerated API routes (found ${files.length})`);
    let propagated = 0;
    for (const f of files) {
      const rel = f.slice(root.length + 1);
      const content = readFileSync(f, 'utf8');
      assert.ok(!content.includes('fail(auth.error, auth.status)'), `${rel}: no code-less auth failure remains`);
      if (content.includes('fail(auth.error, auth.status, auth.code)')) propagated += 1;
    }
    assert.ok(propagated >= 25, `auth.code propagated widely (found ${propagated} sites)`);
  });

  test('5-6. unrelated 503/403 shapes unchanged (no session-code invention)', () => {
    const api = src('lib/apiResponse.js');
    assert.ok(api.includes('if (typeof code === "string" && code) envelope.code = code'), 'code omitted when absent');
    const orders = src('app/api/orders/route.js');
    assert.ok(orders.includes('return fail("Forbidden: requires WAITER or MANAGER", 403)'), 'permission errors untouched');
  });

  test('7. no sensitive route relies on direct legacy HMAC verification', () => {
    for (const f of ['app/api/orders/route.js', 'app/api/orders/[id]/route.js', 'app/cashier/layout.js', 'app/manager/menu-crud/actions.js', 'app/api/manager/staff/route.js']) {
      assert.ok(!src(f).includes('verifySessionToken'), `${f}: no direct HMAC verification`);
    }
    // Remaining verifySessionToken homes: canonical engine only. AUTH-ARCH-8D
    // removed login-staff entirely; AUTH-ARCH-8F removed the verify-pin
    // bootstrap fallback — both now have zero direct HMAC usage.
    assert.ok(!src('app/api/auth/login-staff/route.js').includes('verifySessionToken'), 'login-staff: no direct HMAC verification at all');
    assert.ok(!src('app/api/auth/login-staff/route.js').includes('createSessionToken'), 'login-staff: no HMAC issuance at all');
    assert.ok(!src('app/api/auth/verify-pin/route.js').includes('verifySessionToken'), 'verify-pin: no direct HMAC verification at all');
    assert.ok(!src('app/api/auth/verify-pin/route.js').includes('createSessionToken'), 'verify-pin: no HMAC issuance at all');
    assert.ok(src('lib/serverAuth.js').includes('authenticateViaTabSession'), 'canonical engine documented');
  });

  test('8. Bearer removed: resolver ignores it, sole script migrated', () => {
    const engine = src('lib/serverAuth.js');
    assert.ok(!engine.includes('bearerToken') && !engine.includes('Bearer `'), 'no bearer slot in resolver');
    assert.ok(!engine.includes('authorizationHeader'), 'no Authorization parsing');
    assert.ok(!src('lib/security.js').includes('authorization'), 'requireAuth sends no Authorization header');
    const h74 = src('scripts/test-h74-get.mjs');
    assert.ok(h74.includes('headers["cookie"] = `bono_sess=${token}`'), 'dev script uses Cookie transport');
    assert.ok(!h74.includes('headers["authorization"]'), 'no Authorization header sender remains in repo scripts');
  });

  test('9-10. getAuthorizedSession removed; no callers remain', () => {
    assert.ok(!src('lib/policy.js').includes('getAuthorizedSession(requiredRoles)'), 'engine deleted');
    const hits = [];
    const selfRel = join('tests', 'session-canonical-migration.test.mjs');
    const scan = (dir) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { if (!p.includes('node_modules') && !p.includes('.next')) scan(p); }
        else if (/\.(js|jsx|mjs)$/.test(e)) {
          const rel = p.slice(root.length + 1);
          if (rel === selfRel) continue; // this audit test names the subject
          const c = readFileSync(p, 'utf8');
          if (/getAuthorizedSession\s*\(/.test(c)) hits.push(rel);
        }
      }
    };
    scan(join(root, 'app')); scan(join(root, 'lib')); scan(join(root, 'scripts')); scan(join(root, 'tests'));
    assert.deepEqual(hits, [], 'zero callers repo-wide');
  });

  test('11-12. Kitchen + Barista (shared board) stop on session end', () => {
    const s = src('app/components/KitchenDisplay.js');
    assert.ok(s.includes('getSessionErrorKind'), 'shared helper used');
    assert.ok(s.includes('enterSessionEnded'), 'explicit ended state');
    assert.ok(s.includes('if (sessionEndedRef.current) return;'), 'poll/mutation guards present');
    assert.ok(s.includes('useOrderEvents(') && s.includes(', !sessionEnded);'), 'SSE suspended while ended');
    assert.ok(s.includes('gen !== authGenRef.current'), 'stale results discarded');
    assert.ok(s.includes('role="alertdialog"') && (s.includes('/api/auth/logout') || s.includes('tabLogout()')), 're-login overlay without credentials');
    assert.ok(src('app/barista/page.js').includes('KitchenDisplay'), 'Barista shares the hardened board');
  });

  test('13. Cashier stops on session end (generic identity wording)', () => {
    const s = src('app/components/CashierUI.jsx');
    assert.ok(s.includes('enterSessionEnded') && s.includes('getSessionErrorKind'), 'helper-driven ended state');
    assert.ok(s.includes('if (sessionEndedRef.current) return;'), 'fetch/confirm/reject guards present');
    assert.ok(s.includes(', !sessionEnded);'), 'SSE suspended while ended');
    assert.ok(s.includes('role="alertdialog"'), 're-login overlay present');
    assert.ok(!s.includes('re-login as Manager'), 'no role-presuming re-login copy');
  });

  test('14. SSE never reconnects while ended; stale success applies nothing', () => {
    for (const f of ['app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx', 'app/components/WaiterUI.js']) {
      const s = src(f);
      assert.ok(s.includes('!sessionEnded)'), `${f}: SSE bound to session state`);
      assert.ok(s.includes('gen !== authGenRef.current'), `${f}: generation guard present`);
    }
  });

  test('15-16. re-login never auto-submits credentials; overlays only navigate', () => {
    for (const f of ['app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx']) {
      const s = src(f);
      assert.ok(!s.includes('login-staff') && !s.includes('/api/auth/verify-pin'), `${f}: no credential endpoints`);
      assert.ok(!/type="password"/.test(s), `${f}: no password fields added`);
    }
  });

  test('17-21. role identities unchanged (CASHIER/MANAGER/KITCHEN/BARISTA/WAITER)', () => {
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(can('KITCHEN', 'orders:transition:READY'), true);
    assert.equal(can('BARISTA', 'orders:transition:READY'), true);
    assert.equal(can('WAITER', 'orders:create'), true);
    assert.equal(can('CASHIER', 'staff:mutate'), false);
    assert.equal(can('KITCHEN', 'orders:payment:confirm'), false);
  });

  test('22-23. session ending mutates no order/payment state', () => {
    for (const f of ['app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx']) {
      const s = src(f);
      const i = s.indexOf('const enterSessionEnded = useCallback');
      assert.ok(i !== -1, `${f}: ended handler found`);
      const body = s.slice(i, s.indexOf('}, []);', i));
      assert.ok(!body.includes('safeFetchJson') && !body.includes('updateOrderStatusClient'), `${f}: ended handler is network-free`);
    }
  });
});
