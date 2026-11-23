// Phase 2.2 — authentication / Manager security hardening (DB-free).
// Proves the new pure policy helpers and the wiring of each auth-path change.
// No database, no .env read, no production process.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_DEFAULT_PINS,
  isKnownDefaultPin,
  isProductionRuntime,
  isRejectedDefaultCredential,
} from '../lib/config/security.js';
import {
  ROLE_WIDE_PIN_ROLES,
  PERSONAL_PIN_ROLES,
  pinResetScope,
  isRoleWidePinRole,
} from '../lib/staffPinPolicy.js';
import {
  parsePosProvisionArgs,
  validateProvisionInput,
} from '../scripts/pos-provision-manager.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const codeOnly = (p) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.split('//')[0])
    .join('\n');

const PROD = { NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };
const TEST = { NODE_ENV: 'test' };

describe('Phase 2.2 default-credential policy (pure)', () => {
  test('every documented default PIN is recognised', () => {
    assert.deepEqual(
      Object.keys(KNOWN_DEFAULT_PINS).sort(),
      ['BARISTA', 'HOT_DRINK', 'KITCHEN', 'MANAGER', 'WAITER']
    );
    for (const value of Object.values(KNOWN_DEFAULT_PINS)) {
      assert.equal(isKnownDefaultPin(value), true, `${value} is a known default`);
    }
    assert.equal(isKnownDefaultPin('9182'), false);
    assert.equal(isKnownDefaultPin(null), false);
    assert.equal(isKnownDefaultPin(undefined), false);
  });

  test('production detection is case/whitespace tolerant; non-production is not', () => {
    assert.equal(isProductionRuntime(PROD), true);
    assert.equal(isProductionRuntime({ NODE_ENV: ' PRODUCTION ' }), true);
    assert.equal(isProductionRuntime(DEV), false);
    assert.equal(isProductionRuntime(TEST), false);
    assert.equal(isProductionRuntime({}), false);
  });

  test('default credential guard is retired (always returns false across all environments)', () => {
    for (const value of Object.values(KNOWN_DEFAULT_PINS)) {
      assert.equal(isRejectedDefaultCredential(value, PROD), false, `${value} allowed in production`);
      assert.equal(isRejectedDefaultCredential(value, DEV), false, `${value} allowed in development`);
      assert.equal(isRejectedDefaultCredential(value, TEST), false, `${value} allowed in tests`);
    }
    assert.equal(isRejectedDefaultCredential('9182', PROD), false, 'non-default PIN is not blocked');
  });
});

describe('Phase 2.2 PIN reset scope policy (pure)', () => {
  test('station roles remain role-wide; personal roles do not', () => {
    assert.deepEqual([...ROLE_WIDE_PIN_ROLES], ['KITCHEN', 'BARISTA', 'HOT_DRINK']);
    assert.deepEqual([...PERSONAL_PIN_ROLES], ['WAITER', 'CASHIER', 'MANAGER']);
    for (const role of ROLE_WIDE_PIN_ROLES) {
      assert.equal(pinResetScope(role), 'ROLE', role);
      assert.equal(isRoleWidePinRole(role), true, role);
    }
    for (const role of PERSONAL_PIN_ROLES) {
      assert.equal(pinResetScope(role), 'PERSONAL', role);
      assert.equal(isRoleWidePinRole(role), false, role);
    }
  });

  test('MANAGER is explicitly personal (Phase 2.2 regression guard)', () => {
    assert.equal(isRoleWidePinRole('MANAGER'), false, 'one Manager reset must never rotate every Manager');
    assert.equal(pinResetScope('manager'), 'PERSONAL', 'case-insensitive');
  });

  test('unknown roles default to the narrow personal scope', () => {
    assert.equal(pinResetScope('UNKNOWN'), 'PERSONAL');
    assert.equal(isRoleWidePinRole(undefined), false);
  });
});

describe('Phase 2.2 auth wiring (source assertions)', () => {
  test('staff login verifies credentials strictly via cryptographic hash and inactive guard', () => {
    const svc = codeOnly('lib/staffService.js');
    assert.ok(svc.includes('verifyPin(pin, stored)'), 'cryptographic verification on login');
    assert.ok(svc.includes('Invalid Name or PIN'), 'generic error text (no account enumeration)');
    assert.ok(svc.includes('ACCOUNT_DISABLED'), 'inactive accounts blocked');
    assert.ok(!svc.includes('isRejectedDefaultCredential'), 'arbitrary default PIN rejection removed');
  });

  test('role PIN login excludes inactive staff and validates via cryptographic hash', () => {
    const route = codeOnly('app/api/auth/verify-pin/route.js');
    assert.ok(route.includes('Staff.find({ role, isActive: { $ne: false } })'), 'inactive staff cannot authenticate');
    assert.ok(!route.includes('isRejectedDefaultCredential'), 'arbitrary default rejection removed from verify loop');
  });

  test('manager staff writes allow setting any 4-digit PIN', () => {
    const route = codeOnly('app/api/manager/staff/route.js');
    assert.ok(!route.includes('isRejectedDefaultCredential'), 'arbitrary default PIN restriction removed from manager reset');
  });

  test('waiter creation allows any 4-digit PIN without arbitrary restriction', () => {
    const route = codeOnly('app/api/manager/waiters/route.js');
    assert.ok(!route.includes('isRejectedDefaultCredential'), 'arbitrary default PIN restriction removed from waiter creation');
  });

  test('legacy seed/reset scripts refuse production and never print PIN values', () => {
    for (const file of ['scripts/seed-auth.js', 'scripts/reset-auth.js']) {
      const code = codeOnly(file);
      assert.ok(code.includes('toLowerCase() === "production"'), `${file}: production refusal`);
      assert.ok(code.includes('process.exit(1)'), `${file}: exits before connecting`);
      assert.ok(!/\$\{DEFAULT_PINS\.[A-Z]+\}/.test(code), `${file}: no PIN interpolation into output`);
    }
    const seed = codeOnly('scripts/seed-auth.js');
    assert.ok(seed.includes('Values are not printed'), 'seed output is redacted by design');
  });

  test('hot-drink seed refuses a known default PIN in production', () => {
    const code = codeOnly('scripts/seed-hot-drink-staff.mjs');
    assert.ok(code.includes('isProductionRuntime() && isKnownDefaultPin(DEFAULT_HOT_DRINK_PIN)'), 'production default guard');
    assert.ok(code.includes('process.exit(1)'), 'fails closed');
  });

  test('first-Manager provisioning is explicit, guarded, and secret-free', () => {
    const code = codeOnly('scripts/pos-provision-manager.mjs');
    assert.ok(code.includes('--confirm'), 'explicit confirmation required');
    assert.ok(code.includes('Refusing to write without --confirm'), 'refuses before DB access');
    assert.ok(code.includes('Staff.exists({ role: "MANAGER" })'), 'refuses a second bootstrap Manager');
    assert.ok(code.includes('isKnownDefaultPin(cleanPin)'), 'refuses known defaults even in development');
    assert.ok(code.includes('POS_PROVISION_MANAGER_PIN'), 'PIN comes from env or hidden prompt');
    assert.ok(!/First POS Manager provisioned:[^\n]*\$\{[^}]*pin/i.test(code), 'success line never interpolates the PIN');
    assert.ok(code.includes('readline'), 'uses a hidden interactive prompt');
    assert.ok(code.includes('Unknown argument'), 'unknown args are not echoed (may contain a PIN)');
  });
});

describe('Phase 2.2 first-Manager CLI argument validation (pure)', () => {
  test('parses name/username/confirm', () => {
    const parsed = parsePosProvisionArgs(['--name', 'Manager', '--username', 'mgr', '--confirm']);
    assert.deepEqual(parsed, { name: 'Manager', username: 'mgr', confirm: true, help: false });
  });

  test('supports --flag=value form', () => {
    const parsed = parsePosProvisionArgs(['--name=Manager', '--username=mgr', '--confirm']);
    assert.equal(parsed.name, 'Manager');
    assert.equal(parsed.username, 'mgr');
    assert.equal(parsed.confirm, true);
  });

  test('rejects missing values and unknown arguments without echoing them', () => {
    assert.throws(() => parsePosProvisionArgs(['--name']), /requires a value/);
    assert.throws(() => parsePosProvisionArgs(['--pin', '1234']), /Unknown argument/);
    try {
      parsePosProvisionArgs(['--pin', '9876']);
    } catch (error) {
      assert.ok(!error.message.includes('9876'), 'value is not echoed');
    }
  });

  test('validates name, username, PIN format, and default PINs', () => {
    assert.deepEqual(validateProvisionInput({ name: ' Manager ', username: 'MGR', pin: '9182' }), {
      name: 'Manager',
      username: 'mgr',
      pin: '9182',
    });
    assert.throws(() => validateProvisionInput({ name: '', pin: '9182' }), /--name is required/);
    assert.throws(() => validateProvisionInput({ name: 'M', username: 'a', pin: '9182' }), /--username/);
    assert.throws(() => validateProvisionInput({ name: 'M', pin: '123' }), /4 digits/);
    for (const value of Object.values(KNOWN_DEFAULT_PINS)) {
      assert.throws(() => validateProvisionInput({ name: 'M', pin: value }), /known default PIN/);
    }
  });
});
