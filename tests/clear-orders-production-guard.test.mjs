// C3-02 — clear-orders production hard-deny (DB-free regression tests).
//
// These tests execute the real route module under plain Node with a test-only
// resolver for the Next.js "@/..." alias. Every call either returns the
// production 403 before touching auth/DB, or stops at the auth gate (401) in a
// non-production environment. No database, provider, or destructive operation
// is ever reached, and no environment file is read.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routeFile = join(root, 'app/api/manager/settings/clear-orders/route.js');
const rootUrl = pathToFileURL(root).href + '/';

// Test-only module resolution: Next resolves "@/..." and extensionless imports
// through its bundler; plain Node does not. This hook mirrors that resolution so
// the real route source can be imported without a build step.
const RESOLVE_HOOKS = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = ${JSON.stringify(rootUrl)};
function existing(base) {
  for (const candidate of [base, base + ".js", base + ".mjs", base + "/index.js"]) {
    try {
      if (existsSync(fileURLToPath(candidate))) return candidate;
    } catch {}
  }
  return null;
}
export async function resolve(specifier, context, nextResolve) {
  const mapped = specifier.startsWith("@/") ? ROOT + specifier.slice(2) : specifier;
  if (mapped.startsWith("file:") || mapped.startsWith(".") || mapped.startsWith("/")) {
    const absolute = mapped.startsWith("file:") ? mapped : new URL(mapped, context.parentURL).href;
    const found = existing(absolute);
    if (found) return { url: found, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(RESOLVE_HOOKS));

const { POST } = await import(pathToFileURL(routeFile).href);

const source = () => readFileSync(routeFile, 'utf8');
const executableSource = () =>
  source()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');

const PRODUCTION_MARKERS = [
  'NODE_ENV',
  'VERCEL_ENV',
  'CONTEXT',
  'DEPLOY_ENV',
  'APP_ENV',
  'ENVIRONMENT',
  'BONO_OPERATION_ENV',
];
const PRODUCTION_CODE = 'DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION';

// Run a case with an exactly-controlled environment so ambient markers (e.g. a
// developer shell or CI variable) can never change the outcome.
async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const marker of PRODUCTION_MARKERS) {
    saved.set(marker, process.env[marker]);
    delete process.env[marker];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeRequest({ headers = {}, body = JSON.stringify({ currentManagerPin: '1234', confirm: 'CLEAR-ORDERS' }) } = {}) {
  return new Request('http://localhost/api/manager/settings/clear-orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

async function readBody(response) {
  return JSON.parse(await response.text());
}

async function expectProductionDenial(overrides, request = makeRequest()) {
  return withEnv(overrides, async () => {
    const response = await POST(request);
    const body = await readBody(response);
    assert.equal(response.status, 403, `expected 403 for ${JSON.stringify(overrides)}`);
    assert.equal(body.success, false);
    assert.equal(body.data, null);
    assert.equal(body.code, PRODUCTION_CODE, 'stable machine-readable code');
    assert.match(body.error, /disabled in production/i);
    // No secret, host, URI, stack, or destructive result may be exposed.
    const serialized = JSON.stringify(body);
    assert.ok(!/mongodb|stack|at Object|password|secret|clearedOrders|clearedReservations/i.test(serialized));
    return { response, body };
  });
}

describe('C3-02 clear-orders production hard-deny', () => {
  test('NODE_ENV=production returns 403 DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION', async () => {
    const { body } = await expectProductionDenial({ NODE_ENV: 'production' });
    assert.equal(body.code, 'DESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION');
  });

  test('each supported production marker independently returns 403', async () => {
    for (const marker of PRODUCTION_MARKERS) {
      await expectProductionDenial({ [marker]: 'production' });
    }
  });

  test('production-like aliases are also treated as production', async () => {
    for (const value of ['prod', 'live']) {
      await expectProductionDenial({ BONO_OPERATION_ENV: value });
    }
  });

  test('a production marker cannot be overridden by development/test markers', async () => {
    await expectProductionDenial({
      NODE_ENV: 'production',
      VERCEL_ENV: 'preview',
      CONTEXT: 'development',
      DEPLOY_ENV: 'test',
      APP_ENV: 'dev',
      ENVIRONMENT: 'test',
      BONO_OPERATION_ENV: 'development',
    });
    await expectProductionDenial({
      NODE_ENV: 'development',
      VERCEL_ENV: 'preview',
      CONTEXT: 'development',
      DEPLOY_ENV: 'test',
      APP_ENV: 'dev',
      ENVIRONMENT: 'test',
      BONO_OPERATION_ENV: 'production',
    });
  });

  test('marker matching is trimmed and case-insensitive', async () => {
    await expectProductionDenial({ NODE_ENV: '  PRODUCTION  ' });
    await expectProductionDenial({ VERCEL_ENV: 'Production' });
  });

  test('refusal occurs before authentication and PIN verification', async () => {
    // No session, no PIN, no confirmation: an auth-first route would return 401
    // or 400. Only the production guard can produce 403 here.
    const noCredentials = await expectProductionDenial(
      { NODE_ENV: 'production' },
      makeRequest({ body: JSON.stringify({}) })
    );
    assert.doesNotMatch(noCredentials.body.error, /authentication|pin/i);

    const wrongPin = await expectProductionDenial(
      { NODE_ENV: 'production' },
      makeRequest({ body: JSON.stringify({ currentManagerPin: '0000', confirm: 'CLEAR-ORDERS' }) })
    );
    assert.doesNotMatch(wrongPin.body.error, /pin/i);

    const code = executableSource();
    const guard = code.indexOf('isProductionDeployment(process.env)');
    assert.ok(guard > 0, 'production guard is invoked');
    assert.ok(
      guard < code.indexOf('requireAuth(request'),
      'guard precedes MANAGER authentication'
    );
    assert.ok(guard < code.indexOf('validatePin('), 'guard precedes PIN parsing');
    assert.ok(guard < code.indexOf('checkRateLimit('), 'guard precedes rate limiting');
    assert.ok(guard < code.indexOf('request.json()'), 'guard precedes body parsing');
  });

  test('refusal occurs before any database connection, model, or destructive call', async () => {
    const { response } = await expectProductionDenial({ NODE_ENV: 'production' });
    // A DB failure would surface as 503 via withApi; 403 proves the DB path was
    // never entered.
    assert.notEqual(response.status, 503);

    const code = executableSource();
    const guard = code.indexOf('isProductionDeployment(process.env)');
    for (const forbidden of [
      'connectToDatabase(',
      'getOrderModel(',
      'getInventoryReservationModel(',
      'getInventoryItemModel(',
      'Order.deleteMany(',
      'Reservation.deleteMany(',
      'InventoryItem.updateMany(',
      'counters")',
      'logEvent(',
    ]) {
      const index = code.indexOf(forbidden);
      assert.ok(index === -1 || guard < index, `guard precedes ${forbidden}`);
    }
    // The guard branch itself is synchronous: it returns before any await.
    const guardBlock = code.slice(guard, code.indexOf('const auth = await requireAuth'));
    assert.ok(!/\bawait\b/.test(guardBlock), 'production refusal uses no async work');
    assert.ok(guardBlock.includes('403'), 'refusal uses HTTP 403');
  });

  test('no client-controlled input can change the production decision', async () => {
    await expectProductionDenial(
      { NODE_ENV: 'production' },
      makeRequest({
        headers: {
          cookie: 'NODE_ENV=development; VERCEL_ENV=preview',
          'x-bono-environment': 'development',
          'x-forwarded-host': 'localhost',
          'x-vercel-env': 'preview',
        },
        body: JSON.stringify({
          currentManagerPin: '1234',
          confirm: 'CLEAR-ORDERS',
          environment: 'development',
          env: 'test',
          NODE_ENV: 'development',
        }),
      })
    );

    await expectProductionDenial(
      { NODE_ENV: 'production' },
      new Request('http://localhost/api/manager/settings/clear-orders?env=development&NODE_ENV=test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentManagerPin: '1234', confirm: 'CLEAR-ORDERS' }),
      })
    );
  });

  test('refusal precedes payload-size and malformed-body handling', async () => {
    const oversized = await expectProductionDenial(
      { NODE_ENV: 'production' },
      makeRequest({ headers: { 'content-length': '999999' } })
    );
    assert.equal(oversized.response.status, 403);

    const malformed = await expectProductionDenial(
      { NODE_ENV: 'production' },
      makeRequest({ body: '{not valid json' })
    );
    assert.equal(malformed.response.status, 403);
  });

  test('missing or ambiguous environment fails closed (no accidental bypass)', async () => {
    // Documented behavior: unclassified and ambiguous runtimes are production.
    await expectProductionDenial({});
    await expectProductionDenial({ NODE_ENV: 'qa' });
    await expectProductionDenial({ NODE_ENV: 'development', CONTEXT: 'somewhere-else' });
    await expectProductionDenial({ ENVIRONMENT: 'on-prem' });
  });

  test('exactly one production error code is defined and returned', async () => {
    const code = executableSource();
    const references = code.match(/\bDESTRUCTIVE_ADMIN_DISABLED_IN_PRODUCTION\b/g) || [];
    assert.equal(references.length, 3, 'constant name + literal in the declaration, plus one usage');
    const quoted = code.match(new RegExp(`"${PRODUCTION_CODE}"`, 'g')) || [];
    assert.equal(quoted.length, 1, 'the exact string literal appears once');
    const { body } = await expectProductionDenial({ NODE_ENV: 'production' });
    assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'error', 'message', 'success']);
  });
});

describe('C3-02 clear-orders non-production behavior preserved', () => {
  test('recognized non-production environments reach the existing auth gate', async () => {
    for (const env of [
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test' },
      { BONO_OPERATION_ENV: 'staging' },
      { NODE_ENV: 'development', VERCEL_ENV: 'preview' },
    ]) {
      await withEnv(env, async () => {
        const response = await POST(makeRequest());
        const body = await readBody(response);
        assert.equal(response.status, 401, `auth gate reached for ${JSON.stringify(env)}`);
        assert.match(body.error, /authentication required/i);
        assert.notEqual(body.code, PRODUCTION_CODE);
      });
    }
  });

  test('MANAGER authorization, own-PIN step-up, and confirmation contract remain intact', () => {
    const code = executableSource();
    assert.ok(code.includes('requireAuth(request, ["MANAGER"])'), 'MANAGER-only gate');
    assert.ok(code.includes('verifyStaffPinById(conn, auth.payload.staffId, currentManagerPin)'), 'own-PIN step-up');
    assert.ok(code.includes('const CONFIRMATION_TOKEN = "CLEAR-ORDERS";'));
    assert.ok(code.includes('confirmation !== CONFIRMATION_TOKEN'), 'confirmation gate');
    assert.ok(code.includes('CLEAR_ORDERS_CONFIRMATION_REQUIRED'), 'confirmation error code');
    assert.ok(!code.includes('body.role') && !code.includes('body.staffId'), 'no client identity authority');
  });

  test('PAID/CONSUMING protections and destructive behavior remain unchanged', () => {
    const code = executableSource();
    assert.ok(code.includes('PRESERVED_ORDER_STATUSES = Object.freeze(["PAID", "ARCHIVED"])'));
    assert.ok(code.includes('Order.deleteMany({ status: { $nin: PRESERVED_ORDER_STATUSES } })'));
    assert.ok(!code.includes('Order.deleteMany({})'), 'no unconditional wipe');
    assert.ok(code.includes('CLEAR_ORDERS_PAID_EVIDENCE_PRESENT'));
    assert.ok(code.includes('CLEAR_ORDERS_V1_CONSUMPTION_IN_FLIGHT'));
    assert.ok(code.includes('Reservation.deleteMany({ status: { $nin: ["CONSUMED", "CONSUMING"] } })'));
    assert.ok(code.includes('{ $set: { reservedStock: 0 } }'));
    assert.ok(code.includes('if (remainingOrders === 0)'), 'counter reset still guarded');
    assert.ok(code.includes('ok({ clearedOrders: deleted.deletedCount'));
    // The preview branch still returns before any mutation.
    assert.ok(code.indexOf('if (dryRun)') < code.indexOf('Order.deleteMany('), 'dry-run precedes deletion');
  });

  test('the guard adds no bypass flag, query, header, or override path', () => {
    const code = executableSource();
    for (const banned of [
      'ALLOW_CLEAR_ORDERS',
      'CLEAR_ORDERS_PRODUCTION_OVERRIDE',
      '--force',
      'forceProduction',
      'skipProduction',
      'allowProduction',
      'request.nextUrl',
      'searchParams',
    ]) {
      assert.ok(!code.includes(banned), `route must not contain ${banned}`);
    }
    const guardStart = code.indexOf('isProductionDeployment(process.env)');
    const guardBlock = code.slice(guardStart, code.indexOf('const auth = await requireAuth'));
    assert.ok(!guardBlock.includes('request.'), 'guard never reads client input');
    assert.ok(!guardBlock.includes('body'), 'guard never reads the request body');
    assert.ok(code.includes('isProductionDeployment(process.env)'), 'decision comes from process env only');
  });
});
