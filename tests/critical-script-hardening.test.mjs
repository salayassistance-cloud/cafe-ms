// C2 + C4 critical safety corrections — DB-free regression tests.
//
// C2: scripts/clean-order-history.js (destructive order-history reset)
// C4: scripts/migrate-phase3-canonical.js (index sync -> additive createIndexes)
//
// Nothing here connects to MongoDB, executes either script against a database,
// or changes any state. The CLI cases always run with authorization failing
// closed (or with an invalid/fake URI that aborts before connection), and the
// child processes are spawned with a minimal environment so no ambient
// MONGODB_URI, NODE_ENV, or approval variable can leak in.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

// Remove block comments and whole-line comments only; keep inline `//`.
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

const requireCjs = createRequire(import.meta.url);
// Safe to require: the destructive script only runs under require.main === module.
const cleanup = requireCjs(join(root, 'scripts/clean-order-history.js'));

const cleanOrderSource = () => stripComments(src('scripts/clean-order-history.js'));
const migrationSource = () => stripComments(src('scripts/migrate-phase3-canonical.js'));

// Child environment is built from scratch: PATH/SystemRoot only, so tests never
// inherit a real MONGODB_URI or environment classification.
const baseEnv = () => {
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  return env;
};

const runNode = (relPath, args = [], env = {}) =>
  spawnSync(process.execPath, [join(root, relPath), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...baseEnv(), ...env },
  });

const combined = (result) => `${result.stdout || ''}\n${result.stderr || ''}`;

const FULL_C2_ARGS = [
  '--execute',
  '--confirm',
  cleanup.CONFIRMATION_TOKEN,
  '--backup-ref',
  'backup-test-ref',
  '--approval-ref',
  'CHG-TEST-1',
];

// ===========================================================================
// C2 — scripts/clean-order-history.js
// ===========================================================================
describe('C2 clean-order-history: argument and confirmation contract', () => {
  test('default invocation is inspection only and cannot write', () => {
    const parsed = cleanup.parseInvocation([], {});
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'inspect');
    assert.equal(parsed.execute, false);
    assert.equal(parsed.dryRun, false);
    // Inspection requests are always authorized; only execution is gated.
    const auth = cleanup.assertExecutionAuthorized(parsed, {});
    assert.equal(auth.ok, true);
    assert.equal(auth.execute, false);
  });

  test('--dry-run and DRY_RUN=1 stay non-destructive', () => {
    const explicit = cleanup.parseInvocation(['--dry-run'], {});
    assert.equal(explicit.ok, true);
    assert.equal(explicit.mode, 'inspect');
    assert.equal(explicit.dryRun, true);

    const fromEnv = cleanup.parseInvocation([], { DRY_RUN: '1' });
    assert.equal(fromEnv.ok, true);
    assert.equal(fromEnv.mode, 'inspect');
    const auth = cleanup.assertExecutionAuthorized(fromEnv, { DRY_RUN: '1' });
    assert.equal(auth.ok, true);
    assert.equal(auth.execute, false);
  });

  test('execution flags without --execute are refused', () => {
    const parsed = cleanup.parseInvocation(
      ['--confirm', cleanup.CONFIRMATION_TOKEN, '--backup-ref', 'b', '--approval-ref', 'a'],
      {}
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--execute is required/i);
  });

  test('missing confirmation is refused', () => {
    const parsed = cleanup.parseInvocation(
      ['--execute', '--backup-ref', 'b', '--approval-ref', 'a'],
      { BONO_OPERATION_ENV: 'staging' }
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--confirm/);
  });

  test('wrong confirmation token is refused', () => {
    for (const token of ['delete-all-order-history', 'DELETE_ALL_ORDER_HISTORY', 'DELETE-ALL-ORDER-HISTORY ']) {
      const parsed = cleanup.parseInvocation(
        ['--execute', '--confirm', token, '--backup-ref', 'b', '--approval-ref', 'a'],
        { BONO_OPERATION_ENV: 'staging' }
      );
      assert.equal(parsed.ok, false, `token should be refused: ${JSON.stringify(token)}`);
      assert.match(parsed.error, /--confirm must exactly equal/);
    }
  });

  test('missing backup reference is refused', () => {
    const parsed = cleanup.parseInvocation(
      ['--execute', '--confirm', cleanup.CONFIRMATION_TOKEN, '--approval-ref', 'a'],
      { BONO_OPERATION_ENV: 'staging' }
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--backup-ref is required/);
  });

  test('empty or whitespace backup reference is refused', () => {
    for (const value of ['', '   ', '\t']) {
      const parsed = cleanup.parseInvocation(
        ['--execute', '--confirm', cleanup.CONFIRMATION_TOKEN, '--backup-ref', value, '--approval-ref', 'a'],
        { BONO_OPERATION_ENV: 'staging' }
      );
      assert.equal(parsed.ok, false, `backup ref should be refused: ${JSON.stringify(value)}`);
    }
  });

  test('missing approval reference is refused', () => {
    const parsed = cleanup.parseInvocation(
      ['--execute', '--confirm', cleanup.CONFIRMATION_TOKEN, '--backup-ref', 'b'],
      { BONO_OPERATION_ENV: 'staging' }
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--approval-ref is required/);
  });

  test('malformed, duplicated, and unknown flags fail closed', () => {
    const env = { BONO_OPERATION_ENV: 'staging' };
    const cases = [
      ['--execute', '--execute', '--confirm', cleanup.CONFIRMATION_TOKEN, '--backup-ref', 'b', '--approval-ref', 'a'],
      ['--execute', '--confirm', cleanup.CONFIRMATION_TOKEN, '--confirm', cleanup.CONFIRMATION_TOKEN, '--backup-ref', 'b', '--approval-ref', 'a'],
      ['--execute', '--confirm', cleanup.CONFIRMATION_TOKEN, '--backup-ref', 'b', '--approval-ref', 'a', '--bogus'],
      ['--execute', '--confirm'],
      ['--execute', '--backup-ref', '--approval-ref', 'a'],
    ];
    for (const argv of cases) {
      const parsed = cleanup.parseInvocation(argv, env);
      assert.equal(parsed.ok, false, `argv should be refused: ${argv.join(' ')}`);
    }
  });

  test('--execute combined with a dry-run request is a conflict', () => {
    const viaFlag = cleanup.parseInvocation([...FULL_C2_ARGS, '--dry-run'], { BONO_OPERATION_ENV: 'staging' });
    assert.equal(viaFlag.ok, false);
    assert.match(viaFlag.error, /conflicting arguments/i);

    const viaEnv = cleanup.parseInvocation(FULL_C2_ARGS, { BONO_OPERATION_ENV: 'staging', DRY_RUN: '1' });
    assert.equal(viaEnv.ok, false);
    assert.match(viaEnv.error, /conflicting arguments/i);
  });
});

describe('C2 clean-order-history: fail-closed environment authorization', () => {
  const authorized = () => cleanup.parseInvocation(FULL_C2_ARGS, { BONO_OPERATION_ENV: 'staging' });

  test('unset environment classification refuses execution', () => {
    const parsed = authorized();
    assert.equal(parsed.ok, true);
    const auth = cleanup.assertExecutionAuthorized(parsed, {});
    assert.equal(auth.ok, false);
    assert.equal(auth.environment.production, true);
    assert.equal(auth.environment.ambiguous, true);
    assert.match(auth.errors[0], /refusing destructive execution/i);
  });

  test('unrecognized/ambiguous environment classification refuses execution', () => {
    for (const env of [
      { NODE_ENV: 'qa' },
      { APP_ENV: 'somewhere' },
      { DEPLOY_ENV: 'prod-ish' },
      { CONTEXT: 'deployment' },
    ]) {
      const auth = cleanup.assertExecutionAuthorized(authorized(), env);
      assert.equal(auth.ok, false, `env should be refused: ${JSON.stringify(env)}`);
      assert.equal(auth.environment.production, true);
    }
  });

  test('production refuses execution even with every execution flag', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { BONO_OPERATION_ENV: 'prod' },
      { ENVIRONMENT: 'live' },
      { BONO_OPERATION_ENV: 'staging', NODE_ENV: 'production' },
      { VERCEL_ENV: 'production' },
    ]) {
      const auth = cleanup.assertExecutionAuthorized(authorized(), env);
      assert.equal(auth.ok, false, `env should be refused: ${JSON.stringify(env)}`);
      assert.equal(auth.environment.production, true);
      assert.match(auth.errors[0], /refused unconditionally/i);
    }
  });

  test('explicit non-production classification authorizes execution', () => {
    for (const value of ['development', 'test', 'staging', 'preview', 'local', 'ci']) {
      const auth = cleanup.assertExecutionAuthorized(authorized(), { BONO_OPERATION_ENV: value });
      assert.equal(auth.ok, true, `env should authorize: ${value}`);
      assert.equal(auth.execute, true);
      assert.equal(auth.environment.production, false);
    }
  });
});

describe('C2 clean-order-history: source-level ordering and redaction', () => {
  test('all argument and environment checks run before the driver loads', () => {
    const code = cleanOrderSource();
    const parseIdx = code.indexOf('parseInvocation(process.argv.slice(2), env)');
    const authIdx = code.indexOf('assertExecutionAuthorized(parsed, env)');
    const driverIdx = code.search(/require\(\s*['"]mongoose['"]\s*\)/);
    const connectIdx = code.indexOf('mongoose.connect(');
    assert.ok(parseIdx > -1, 'parseInvocation call exists');
    assert.ok(authIdx > -1, 'authorization call exists');
    assert.ok(driverIdx > -1, 'mongoose require exists');
    assert.ok(connectIdx > -1, 'mongoose.connect exists');
    assert.ok(parseIdx < driverIdx, 'parse runs before the driver is loaded');
    assert.ok(authIdx < driverIdx, 'authorization runs before the driver is loaded');
    assert.ok(driverIdx < connectIdx, 'driver loads before connect');
  });

  test('the script never prints a URI, host, or credential', () => {
    const code = cleanOrderSource();
    assert.ok(!/console\.\w+\([^)\n]*\bmongoUri\b/i.test(code), 'no console output of the URI variable');
    assert.ok(!/console\.\w+\([^)\n]*MONGODB_URI\s*\)/i.test(code), 'no console output of process.env.MONGODB_URI');
    assert.ok(!/conn\.host|connection\.host|\.hostname/i.test(code), 'no host printing');
    assert.ok(!/console\.\w+\([^)\n]*\$\{[^}]*password/i.test(code), 'no credential printing');
    assert.ok(code.includes('[redacted]'), 'redaction helper is present');
    assert.ok(/redact\(err\?\.message \|\| err\)/.test(code), 'runtime errors are redacted');
  });

  test('help documents the unchanged destructive scope and all four gates', () => {
    const help = cleanup.USAGE_TEXT;
    for (const required of [
      '--execute',
      'DELETE-ALL-ORDER-HISTORY',
      '--backup-ref',
      '--approval-ref',
      'deletes EVERY order, including PAID and ARCHIVED',
      'resets order_seq',
      'activeWaiters',
      'NOT transactional',
    ]) {
      assert.ok(help.includes(required), `help must document: ${required}`);
    }
  });
});

describe('C2 clean-order-history: CLI refusal behavior (no database)', () => {
  const SECRET_URI = 'mongodb+srv://svc-user:super-secret-value@cluster0.9yut545.mongodb.net/hotel_management';

  test('default invocation without MONGODB_URI exits non-zero without connecting', () => {
    const result = runNode('scripts/clean-order-history.js');
    assert.equal(result.status, 1);
    assert.match(combined(result), /MONGODB_URI is not set/);
    assert.doesNotMatch(combined(result), /Connected/i);
  });

  test('production execution with every flag refuses before connecting', () => {
    const result = runNode('scripts/clean-order-history.js', FULL_C2_ARGS, {
      NODE_ENV: 'production',
      MONGODB_URI: SECRET_URI,
    });
    assert.equal(result.status, 2);
    const output = combined(result);
    assert.match(output, /REFUSED/);
    assert.match(output, /refused unconditionally/i);
    assert.doesNotMatch(output, /Connected/i);
    assert.ok(!output.includes('super-secret-value'), 'URI credentials must never be printed');
    assert.ok(!output.includes('9yut545'), 'database host must never be printed');
  });

  test('missing environment classification refuses before connecting', () => {
    const result = runNode('scripts/clean-order-history.js', FULL_C2_ARGS, { MONGODB_URI: SECRET_URI });
    assert.equal(result.status, 2);
    const output = combined(result);
    assert.match(output, /no explicit non-production environment classification/i);
    assert.doesNotMatch(output, /Connected/i);
    assert.ok(!output.includes('super-secret-value'));
    assert.ok(!output.includes('9yut545'));
  });

  test('dry-run request combined with --execute refuses before connecting', () => {
    const result = runNode('scripts/clean-order-history.js', [...FULL_C2_ARGS, '--dry-run'], {
      BONO_OPERATION_ENV: 'staging',
      MONGODB_URI: SECRET_URI,
    });
    assert.equal(result.status, 2);
    assert.match(combined(result), /conflicting arguments/i);
    assert.doesNotMatch(combined(result), /Connected/i);
    assert.ok(!combined(result).includes('super-secret-value'));
  });

  test('malformed flags refuse before connecting', () => {
    const result = runNode('scripts/clean-order-history.js', ['--execute', '--bogus'], {
      BONO_OPERATION_ENV: 'staging',
      MONGODB_URI: SECRET_URI,
    });
    assert.equal(result.status, 2);
    assert.match(combined(result), /unknown argument/i);
    assert.doesNotMatch(combined(result), /Connected/i);
  });

  test('--help documents the destructive contract and exits 0', () => {
    const result = runNode('scripts/clean-order-history.js', ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /DESTRUCTIVE/);
    assert.match(result.stdout, /--approval-ref/);
  });
});

// ===========================================================================
// C4 — scripts/migrate-phase3-canonical.js
// ===========================================================================
describe('C4 phase3 migration: additive index operations only', () => {
  test('no executable syncIndexes() call remains', () => {
    const code = migrationSource();
    assert.ok(!/\bsyncIndexes\s*\(/.test(code), 'syncIndexes() can drop undeclared indexes and must be gone');
  });

  test('no index/collection/database drop behavior is present', () => {
    const code = migrationSource();
    assert.ok(!/\bdropIndex(es)?\s*\(/.test(code), 'no dropIndex call');
    assert.ok(!/\bdropCollection\s*\(/.test(code), 'no dropCollection call');
    assert.ok(!/\bdropDatabase\s*\(/.test(code), 'no dropDatabase call');
  });

  test('the six intended models use additive createIndexes()', () => {
    const code = migrationSource();
    for (const model of [
      'getCategoryModel',
      'getMenuItemModel',
      'getOrderModel',
      'getStaffModel',
      'getBrandConfigModel',
      'getPaymentInfoModel',
    ]) {
      assert.ok(
        new RegExp(`${model}\\(conn\\)\\.createIndexes\\(\\)`).test(code),
        `${model} must use createIndexes()`
      );
    }
    assert.ok(!/\.syncIndexes\s*\(/.test(code), 'no model syncIndexes remains');
  });

  test('production approval gate is evaluated before the connection', () => {
    const code = migrationSource();
    const gateIdx = code.indexOf('classifyMigrationEnvironment(process.env)');
    const connectIdx = code.indexOf('mongoose.createConnection');
    const approvalIdx = code.indexOf("process.env[APPROVAL_ENV]");
    assert.ok(gateIdx > -1, 'environment classifier is invoked');
    assert.ok(approvalIdx > -1, 'approval reference is read from the environment');
    assert.ok(connectIdx > -1, 'connection call exists');
    assert.ok(gateIdx < connectIdx, 'classification happens before connecting');
    assert.ok(approvalIdx < connectIdx, 'approval check happens before connecting');
    // The refusal path between the gate and the connection must exit non-zero.
    assert.ok(code.slice(gateIdx, connectIdx).includes('process.exit(2)'), 'gate refuses with a non-zero exit');
    // Even the mongoose driver is loaded only after the gate has passed.
    const importIdx = code.indexOf('import("mongoose")');
    assert.ok(importIdx > -1, 'driver is loaded dynamically');
    assert.ok(!/^import\s+mongoose/m.test(code), 'no static mongoose import before the gate');
    assert.ok(gateIdx < importIdx && importIdx < connectIdx, 'driver loads after the gate and before connect');
  });

  test('existing database-name and target-host checks are retained', () => {
    const code = migrationSource();
    assert.ok(code.includes('DB_NAME !== "hotel_management"'), 'database-name restriction retained');
    assert.ok(code.includes('9yut545.mongodb.net'), 'target-host restriction retained');
    assert.ok(code.includes('host mismatch in APPLY mode'), 'host mismatch still aborts APPLY');
  });
});

describe('C4 phase3 migration: CLI gate behavior (no database)', () => {
  const FAKE_URI = 'mongodb://127.0.0.1:1/hotel_management';

  test('missing environment classification fails closed as production', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--apply'], { MONGODB_URI: FAKE_URI });
    assert.equal(result.status, 2);
    const output = combined(result);
    assert.match(output, /treated as production/i);
    assert.match(output, /--allow-production/);
    assert.doesNotMatch(output, /Connected/i);
  });

  test('ambiguous environment classification fails closed as production', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--apply'], {
      PHASE3_MIGRATION_ENV: 'qa-ish',
      MONGODB_URI: FAKE_URI,
    });
    assert.equal(result.status, 2);
    assert.match(combined(result), /unrecognized/i);
    assert.doesNotMatch(combined(result), /Connected/i);
  });

  test('production without any approval refuses', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--apply'], {
      PHASE3_MIGRATION_ENV: 'production',
      MONGODB_URI: FAKE_URI,
    });
    assert.equal(result.status, 2);
    const output = combined(result);
    assert.match(output, /--allow-production flag is missing/i);
    assert.match(output, /PHASE3_MIGRATION_APPROVAL ticket reference is missing or empty/i);
    assert.doesNotMatch(output, /Connected/i);
  });

  test('--allow-production without a ticket reference refuses', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--apply', '--allow-production'], {
      PHASE3_MIGRATION_ENV: 'production',
      PHASE3_MIGRATION_APPROVAL: '   ',
      MONGODB_URI: FAKE_URI,
    });
    assert.equal(result.status, 2);
    assert.match(combined(result), /PHASE3_MIGRATION_APPROVAL ticket reference is missing or empty/i);
    assert.doesNotMatch(combined(result), /Connected/i);
  });

  test('ticket reference without --allow-production refuses', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--apply'], {
      PHASE3_MIGRATION_ENV: 'production',
      PHASE3_MIGRATION_APPROVAL: 'CHG-1234',
      MONGODB_URI: FAKE_URI,
    });
    assert.equal(result.status, 2);
    assert.match(combined(result), /--allow-production flag is missing/i);
    assert.doesNotMatch(combined(result), /Connected/i);
  });

  test('approved production still aborts on an unexpected database name', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--apply', '--allow-production'], {
      PHASE3_MIGRATION_ENV: 'production',
      PHASE3_MIGRATION_APPROVAL: 'CHG-1234',
      MONGODB_URI: 'not-a-valid-uri',
    });
    assert.equal(result.status, 2);
    assert.match(combined(result), /expected "hotel_management"/);
    assert.doesNotMatch(combined(result), /Connected/i);
  });

  test('non-production APPLY still aborts on a host mismatch before connecting', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--apply'], {
      PHASE3_MIGRATION_ENV: 'test',
      MONGODB_URI: FAKE_URI,
    });
    assert.equal(result.status, 2);
    assert.match(combined(result), /host mismatch in APPLY mode/i);
    assert.doesNotMatch(combined(result), /Connected/i);
  });

  test('unknown and duplicated flags fail closed', () => {
    for (const argv of [['--bogus'], ['--apply', '--apply'], ['--allow-production', '--allow-production']]) {
      const result = runNode('scripts/migrate-phase3-canonical.js', argv, {
        PHASE3_MIGRATION_ENV: 'test',
        MONGODB_URI: FAKE_URI,
      });
      assert.equal(result.status, 2, `argv should be refused: ${argv.join(' ')}`);
      assert.match(combined(result), /REFUSED/);
      assert.doesNotMatch(combined(result), /Connected/i);
    }
  });

  test('--help documents additive-only index handling and exits 0', () => {
    const result = runNode('scripts/migrate-phase3-canonical.js', ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ADDITIVE ONLY/);
    assert.match(result.stdout, /--allow-production/);
    assert.match(result.stdout, /PHASE3_MIGRATION_APPROVAL/);
  });
});
