import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { navigateAfterAuth } from '../lib/clientFetch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');

function fakeRouter() {
  const calls = [];
  return {
    calls,
    push: (t) => { calls.push(['push', t]); },
    refresh: () => { calls.push(['refresh']); },
  };
}

describe('PIN-LOGIN-UX - portal navigation completes without refresh', () => {
  test('1. same-route target refreshes instead of pushing (PinGuard-at-destination case)', () => {
    const g = globalThis;
    const prevWindow = g.window;
    g.window = { location: { pathname: '/cashier', assign: () => {} } };
    try {
      const router = fakeRouter();
      assert.equal(navigateAfterAuth(router, '/cashier'), 'refresh');
      assert.deepEqual(router.calls, [['refresh']]);
    } finally {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
    }
  });

  test('2. cross-route target keeps router.push', () => {
    const g = globalThis;
    const prevWindow = g.window;
    g.window = { location: { pathname: '/', assign: () => {} } };
    try {
      const router = fakeRouter();
      assert.equal(navigateAfterAuth(router, '/cashier'), 'push');
      assert.deepEqual(router.calls, [['push', '/cashier']]);
    } finally {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
    }
  });

  test('3. all login success paths use the single navigation helper', () => {
    for (const f of ['app/components/PinGuard.js', 'app/components/PinLoginModal.js']) {
      assert.ok(existsSync(join(root, f)), `${f} exists`);
      const s = src(f);
      assert.ok(s.includes('navigateAfterAuth'), `${f} navigates via navigateAfterAuth`);
    }
    assert.ok(!src('app/components/PinGuard.js').includes('router.push(target)'), 'PinGuard has no bare same-route push');
    assert.ok(!src('app/components/PinLoginModal.js').includes('router.push(portal.route)'), 'PinLoginModal has no bare push');
  });

  test('4. no old identity adoption or forced reload in the login path', () => {
    for (const f of ['app/components/PinGuard.js', 'app/components/PinLoginModal.js']) {
      const s = src(f);
      assert.ok(!s.includes('window.location.reload'), `${f}: no forced reload`);
      assert.ok(!s.includes('setTimeout'), `${f}: no setTimeout navigation hack`);
    }
  });
});

describe('PIN-LOGIN-UX - Enter key submits the same canonical action', () => {
  test('5. keypad wires Enter to the canonical onSubmit (single handler)', () => {
    const s = src('app/components/PinKeypad.js');
    assert.ok(s.includes('"keydown"') || s.includes("'keydown'"), 'listens for keydown');
    assert.ok(s.includes('"Enter"') || s.includes("'Enter'"), 'handles the Enter key');
    assert.ok(s.includes('onSubmit(digits)'), 'Enter invokes the same onSubmit as the Verify button');
  });

  test('6. Enter guards match the Verify button (4 digits, disabled, focused controls)', () => {
    const s = src('app/components/PinKeypad.js');
    assert.ok(s.includes('digits.length !== 4'), 'requires a complete 4-digit PIN like the button');
    assert.ok(s.includes('button,input,select,textarea'), 'focused native controls keep their own Enter behavior (no double submit)');
  });

  test('7. both login components share the one keypad (no contradictory login UI)', () => {
    assert.ok(src('app/components/PinGuard.js').includes('PinKeypad'), 'PinGuard uses PinKeypad');
    assert.ok(src('app/components/PinLoginModal.js').includes('PinKeypad'), 'PinLoginModal uses PinKeypad');
  });
});
