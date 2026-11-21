// Phase 2.2 — structured operational logging + sensitive-data redaction.
// Pure module: no database, no Next.js runtime, no .env read.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  redactForLog,
  logEvent,
  logger,
  isSensitiveLogKey,
  SENSITIVE_LOG_TERMS,
} from '../lib/operationalLogger.js';

function captureConsole(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const lines = [];
  console.log = (line) => lines.push({ level: 'log', line: String(line) });
  console.warn = (line) => lines.push({ level: 'warn', line: String(line) });
  console.error = (line) => lines.push({ level: 'error', line: String(line) });
  console.debug = (line) => lines.push({ level: 'debug', line: String(line) });
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  }
}

describe('Phase 2.2 sensitive key detection', () => {
  test('covers camelCase, snake_case, and kebab-case credential fields', () => {
    const sensitive = [
      'pin',
      'pins',
      'pinHash',
      'currentManagerPin',
      'newPin',
      'confirmPin',
      'password',
      'passwd',
      'clientSecret',
      'accessToken',
      'refresh_token',
      'credentials',
      'authorization',
      'cookie',
      'sessionId',
      'apiKey',
      'api_key',
      'connectionString',
      'MONGODB_URI',
    ];
    for (const key of sensitive) {
      assert.equal(isSensitiveLogKey(key), true, `${key} must be redacted`);
    }
  });

  test('does not redact ordinary operational fields', () => {
    for (const key of ['orderId', 'event', 'level', 'status', 'durationMs', 'staffId', 'trigger']) {
      assert.equal(isSensitiveLogKey(key), false, `${key} is safe`);
    }
    assert.equal(isSensitiveLogKey(''), false);
    assert.equal(isSensitiveLogKey(undefined), false);
  });

  test('term list is exported and non-empty for audit', () => {
    assert.ok(SENSITIVE_LOG_TERMS.length > 0);
    assert.ok(SENSITIVE_LOG_TERMS.includes('pin'));
  });
});

describe('Phase 2.2 redactForLog', () => {
  test('redacts sensitive keys at every depth, including arrays', () => {
    const safe = redactForLog({
      pin: '1234',
      currentManagerPin: '4444',
      newPin: '9999',
      pinHash: 'salt:derived',
      password: 'pw',
      token: 'tok',
      authorization: 'Bearer abc.def.ghi',
      cookie: 'bono_session=secret',
      MONGODB_URI: 'mongodb+srv://user:pass@cluster.example/db',
      connectionString: 'mongodb://u:p@h/d',
      sessionId: 'sess-abcdefghijklmnopqrstuvwxyz',
      safeField: 'visible',
      count: 3,
      nested: { clientSecret: 's', ok: 1 },
      arr: [{ password: 'p' }, 'mongodb://u:p@h/d'],
      error: new Error('Authorization: Bearer topsecret'),
    });

    for (const key of [
      'pin',
      'currentManagerPin',
      'newPin',
      'pinHash',
      'password',
      'token',
      'authorization',
      'cookie',
      'MONGODB_URI',
      'connectionString',
      'sessionId',
    ]) {
      assert.equal(safe[key], '[redacted]', `${key} redacted`);
    }
    assert.equal(safe.safeField, 'visible');
    assert.equal(safe.count, 3);
    assert.equal(safe.nested.clientSecret, '[redacted]');
    assert.equal(safe.nested.ok, 1);
    assert.equal(safe.arr[0].password, '[redacted]');
    assert.match(String(safe.arr[1]), /mongodb:\/\/\[redacted\]@h\/d/);
    assert.match(safe.error.message, /Bearer \[redacted\]/);
    assert.ok(!JSON.stringify(safe).includes('pass@cluster'), 'no credentials survive serialization');
  });

  test('redacts MongoDB credentials embedded in free-text strings', () => {
    const out = redactForLog('connect failed: mongodb+srv://alice:hunter2@db.example.net/pos');
    assert.match(out, /mongodb\+srv:\/\/\[redacted\]@db\.example\.net\/pos/);
    assert.ok(!out.includes('hunter2'));
  });

  test('handles null, undefined, primitives, dates, and oversized strings safely', () => {
    assert.equal(redactForLog(null), null);
    assert.equal(redactForLog(undefined), undefined);
    assert.equal(redactForLog(true), true);
    assert.equal(redactForLog(42), 42);
    assert.equal(redactForLog(7n), '7');
    assert.equal(redactForLog(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
    assert.equal(redactForLog('x'.repeat(5000)).length, 2000);
    assert.equal(redactForLog({ a: { b: { c: { d: { e: { f: 'deep' } } } } } }).a.b.c.d.e.f, '[max-depth]');
  });
});

describe('Phase 2.2 logEvent / logger', () => {
  test('emits one JSON line with level, event, timestamp, and redacted fields', () => {
    const { result, lines } = captureConsole(() =>
      logEvent('warn', 'unit_test_event', { pin: '1234', orderId: 'ORD-1001' })
    );
    assert.equal(result.level, 'warn');
    assert.equal(result.event, 'unit_test_event');
    assert.equal(result.pin, '[redacted]');
    assert.equal(result.orderId, 'ORD-1001');
    assert.match(result.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'warn');
    const parsed = JSON.parse(lines[0].line);
    assert.equal(parsed.event, 'unit_test_event');
    assert.equal(parsed.pin, '[redacted]');
    assert.ok(!lines[0].line.includes('1234'));
  });

  test('routes each level to the matching console method', () => {
    for (const [level, method] of [
      ['debug', 'debug'],
      ['info', 'log'],
      ['warn', 'warn'],
      ['error', 'error'],
    ]) {
      const { lines } = captureConsole(() => logger[level]('lvl_test', { ok: true }));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].level, method, `${level} uses console.${method}`);
    }
  });

  test('unknown levels fall back to info and never throw', () => {
    const { result, lines } = captureConsole(() => logEvent('verbose', 'fallback_event', {}));
    assert.equal(result.level, 'info');
    assert.equal(lines[0].level, 'log');
  });

  test('circular objects cannot break the log line', () => {
    const circular = { name: 'node' };
    circular.self = circular;
    const { result, lines } = captureConsole(() => logEvent('error', 'circular_event', circular));
    assert.equal(result.event, 'circular_event');
    assert.doesNotThrow(() => JSON.parse(lines[0].line));
  });
});
