// Phase 2.2 — health endpoint and runtime env contract (DB-free).
// Pure helpers are exercised directly; the route is checked by source assertion
// so no database connection or Next.js runtime is required.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHealthPayload, healthStatusCode } from '../lib/health.js';
import {
  REQUIRED_SERVER_ENV,
  validateRuntimeEnv,
  assertRuntimeEnv,
} from '../lib/config/runtimeEnv.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

describe('Phase 2.2 health payload', () => {
  test('ready payload exposes only coarse state', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const payload = buildHealthPayload({ dbReady: true, now, uptimeSeconds: 12.9 });
    assert.deepEqual(payload, {
      service: 'bono-pos',
      status: 'ready',
      checks: { database: 'up' },
      uptimeSeconds: 12,
      timestamp: '2026-01-02T03:04:05.000Z',
    });
    assert.equal(healthStatusCode(payload), 200);
    for (const banned of ['MONGODB_URI', 'mongodb://', 'host', 'error', 'stack', 'env']) {
      assert.ok(!JSON.stringify(payload).toLowerCase().includes(banned.toLowerCase()), `no ${banned} in payload`);
    }
  });

  test('not-ready payload is a 503 without diagnostics', () => {
    const payload = buildHealthPayload({ dbReady: false, uptimeSeconds: -5 });
    assert.equal(payload.status, 'not_ready');
    assert.equal(payload.checks.database, 'down');
    assert.equal(payload.uptimeSeconds, 0, 'negative uptime is clamped');
    assert.equal(healthStatusCode(payload), 503);
    assert.equal(healthStatusCode({ status: 'alive' }), 503, 'only explicit ready is 200');
  });

  test('an invalid date still yields a valid ISO timestamp', () => {
    const payload = buildHealthPayload({ dbReady: true, now: new Date('not-a-date') });
    assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('Phase 2.2 runtime env validation', () => {
  test('MONGODB_URI is the required server variable', () => {
    assert.deepEqual([...REQUIRED_SERVER_ENV], ['MONGODB_URI']);
  });

  test('reports missing and present variables without exposing values', () => {
    const missing = validateRuntimeEnv({});
    assert.deepEqual(missing, { ok: false, missing: ['MONGODB_URI'] });
    assert.ok(!JSON.stringify(missing).includes('mongodb://'), 'no value echoed');

    const present = validateRuntimeEnv({ MONGODB_URI: 'mongodb://example' });
    assert.deepEqual(present, { ok: true, missing: [] });
  });

  test('blank and whitespace values count as missing', () => {
    for (const value of ['', '   ', null, undefined]) {
      assert.equal(validateRuntimeEnv({ MONGODB_URI: value }).ok, false, String(value));
    }
  });

  test('assertRuntimeEnv throws only the variable names', () => {
    assert.throws(() => assertRuntimeEnv({}), /Missing required environment variables: MONGODB_URI/);
    assert.doesNotThrow(() => assertRuntimeEnv({ MONGODB_URI: 'mongodb://example' }));
  });
});

describe('Phase 2.2 health route disclosure and behavior', () => {
  const route = () => src('app/api/health/route.js');

  test('supports cheap liveness and DB-backed readiness', () => {
    const s = route();
    assert.ok(s.includes('searchParams.get("live")'), 'liveness switch');
    assert.ok(s.includes('status: "alive"'), 'liveness payload never touches the DB');
    assert.ok(s.includes('connectToDatabase()'), 'readiness probes the DB');
    assert.ok(s.includes('conn?.readyState === 1'), 'readiness uses the connection state');
  });

  test('never exposes driver errors, stack traces, or configuration', () => {
    const s = route();
    assert.ok(s.includes('catch {'), 'errors are swallowed');
    assert.ok(!s.includes('err.stack') && !s.includes('error.stack'), 'no stack trace');
    assert.ok(!s.includes('err.message') && !s.includes('error.message'), 'no driver message');
    assert.ok(!s.includes('MONGODB_URI'), 'no connection variable');
    assert.ok(!s.includes('console.'), 'no unstructured logging');
    assert.ok(s.includes('Cache-Control'), 'health is not cached');
    assert.ok(s.includes('no-store'), 'no-store enforced');
  });

  test('missing runtime env is a 503 before any connection', () => {
    const s = route();
    const envCheck = s.indexOf('validateRuntimeEnv()');
    const connect = s.indexOf('connectToDatabase()');
    assert.ok(envCheck > 0 && connect > envCheck, 'env gate precedes connection');
    assert.ok(s.includes('if (!env.ok)'), 'fails closed');
  });
});
