// Phase 2.2 — POS index lifecycle hardening (source-level, DB-free).
//
// Proves the connection path no longer calls syncIndexes() (which can DROP
// indexes), production auto-indexing is off by default, and the deployment
// script is additive and requires explicit confirmation/approval.
//
// No database connection is made and no deployment script is executed.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
// Remove block comments and whole-line comments only; keep inline `//` that may
// appear inside string literals (connection-string redaction).
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
const connectionLib = () => stripComments(src('lib/mongodb.js'));
const deployScript = () => stripComments(src('scripts/sync-indexes.js'));

describe('Phase 2.2 connection-path index safety', () => {
  test('syncIndexes() is gone from the connection path', () => {
    const code = connectionLib();
    assert.ok(!/\bsyncIndexes\s*\(/.test(code), 'no syncIndexes call can drop production indexes');
    assert.ok(!code.includes('syncIndexesInBackground'), 'old sync function removed');
    assert.ok(!/\bdropIndex(es)?\s*\(/.test(code), 'connection path never drops indexes');
  });

  test('background provisioning is additive createIndexes only', () => {
    const code = connectionLib();
    assert.ok(code.includes('async function ensureIndexesInBackground'), 'replacement function exists');
    const fn = code.slice(
      code.indexOf('async function ensureIndexesInBackground'),
      code.indexOf('// Fire-and-forget ADDITIVE')
    );
    assert.ok(fn.includes('getOrderModel(conn).createIndexes()'));
    assert.ok(fn.includes('getStaffModel(conn).createIndexes()'));
    assert.ok(fn.includes('getCategoryModel(conn).createIndexes()'));
    assert.ok(fn.includes('getMenuItemModel(conn).createIndexes()'));
    assert.ok(fn.includes('getInventoryAuditModel(conn).createIndexes()'));
    assert.ok(fn.includes('autoIndexProvisioningEnabled()'), 'guarded by the runtime policy');
  });

  test('production auto-indexing defaults to OFF with an explicit opt-in', () => {
    const code = connectionLib();
    const fn = code.slice(
      code.indexOf('function autoIndexProvisioningEnabled'),
      code.indexOf('// One-time, NON-BLOCKING')
    );
    assert.ok(fn.includes('POS_AUTO_INDEXES'), 'explicit override exists');
    assert.ok(fn.includes('["0", "false", "off", "no"].includes(raw)'), 'falsey override disables');
    assert.ok(fn.includes('["1", "true", "on", "yes"].includes(raw)'), 'truthy override enables');
    assert.ok(
      fn.includes('return String(process.env.NODE_ENV ?? "").trim().toLowerCase() !== "production";'),
      'default is on outside production, off in production'
    );
  });

  test('a failed additive build is alertable, not retried or destructive', () => {
    const code = connectionLib();
    assert.ok(code.includes('logEvent("warn", "pos_index_provision_failed"'), 'structured failure event');
    assert.ok(code.includes('cached.indexSyncStarted = true;'), 'single attempt per process');
    assert.ok(!code.includes('deleteMany'), 'index path touches no documents');
  });
});

describe('Phase 2.2 index deployment script is additive and guarded', () => {
  test('uses createIndexes only and never sync/drop', () => {
    const script = deployScript();
    assert.ok(script.includes('createIndexes()'), 'additive build');
    assert.ok(!/\bsyncIndexes\s*\(/.test(script), 'no syncIndexes');
    assert.ok(!/\bdropIndex(es)?\s*\(/.test(script), 'never drops');
    assert.ok(script.includes('No index was dropped or rebuilt'), 'operator-visible guarantee');
  });

  test('refuses without --confirm before any database access', () => {
    const script = deployScript();
    const confirmGate = script.indexOf('if (!hasFlag("--confirm"))');
    const connectCall = script.indexOf('mongoose.connect');
    assert.ok(confirmGate > 0, 'confirmation gate exists');
    assert.ok(connectCall > confirmGate, 'confirmation is checked before connecting');
    assert.ok(script.includes('No database operation was performed'), 'dry refusal message');
  });

  test('production requires --allow-production and a ticket approval', () => {
    const script = deployScript();
    assert.ok(script.includes('--allow-production'), 'production flag required');
    assert.ok(script.includes('POS_INDEX_DEPLOY_APPROVAL'), 'change/ticket reference required');
    assert.ok(script.includes('Refusing production index deployment without --allow-production'));
    assert.ok(script.includes('Refusing production index deployment without a non-empty POS_INDEX_DEPLOY_APPROVAL'));
    assert.ok(!script.includes('console.log(process.env.POS_INDEX_DEPLOY_APPROVAL'), 'approval value is never printed');
  });

  test('connection strings are redacted from failures', () => {
    const raw = src('scripts/sync-indexes.js');
    assert.ok(raw.includes('mongodb://[redacted]'), 'redaction present');
    assert.ok(raw.includes('credentials redacted'), 'connect message is redacted');
    assert.ok(!raw.includes('console.log(MONGODB_URI)'), 'never prints the URI');
  });

  test('script enumerates the same five models as the connection path', () => {
    const script = deployScript();
    for (const model of ['getOrderModel', 'getStaffModel', 'getCategoryModel', 'getMenuItemModel', 'getInventoryAuditModel']) {
      assert.ok(script.includes(model), `${model} included`);
    }
    assert.ok(script.includes('await model.createIndexes()'), 'per-model additive call');
  });
});
