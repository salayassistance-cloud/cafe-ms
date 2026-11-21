// Phase 2.2 — inventory hook observability.
//
// Verifies the narrow change only: swallowed inventory failures are no longer
// silent/unstructured, while the non-fatal control flow (payment already
// committed) is preserved. This does NOT claim to prove MongoDB atomicity; the
// transaction/consumption engine is unchanged and not exercised here.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const service = () => src('lib/orderService.js');

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return text.slice(start, end);
}

describe('Phase 2.2 inventory hook failure logging', () => {
  test('runInventoryHook stays non-fatal and emits a structured event', () => {
    const hook = sliceBetween(service(), 'async function runInventoryHook', '// Create an order.');
    assert.ok(hook.includes('logEvent("error", "inventory_hook_failed"'), 'structured error event');
    assert.ok(hook.includes('hook: label'), 'hook name captured');
    assert.ok(hook.includes('orderId: String(order?._id || order || "")'), 'order identity captured');
    assert.ok(hook.includes('errorName: err?.name'), 'error class captured');
    assert.ok(hook.includes('errorMessage: err?.message || String(err)'), 'redactable message captured');
    assert.ok(hook.includes('return null;'), 'failure is still non-fatal');
    assert.ok(!/\bthrow\b/.test(hook.replace(/to a throw/g, '')), 'hook never throws');
    assert.ok(!hook.includes('console.warn'), 'no unstructured warning remains');
  });

  test('payment consumption failure is logged, never reported as a payment failure', () => {
    const fn = sliceBetween(service(), 'async function applyPaidInventory', 'export async function payOrder');
    assert.ok(fn.includes('logEvent("error", "inventory_consumption_failed"'), 'failure event');
    assert.ok(fn.includes('logEvent("warn", "inventory_consumption_warnings"'), 'warnings event');
    assert.ok(fn.includes('logEvent("error", "inventory_consumption_error"'), 'exception event');
    assert.ok(!/\bthrow\b/.test(fn), 'applyPaidInventory never throws (payment is already committed)');
    assert.ok(!fn.includes('console.warn'), 'no unstructured warnings remain');
    assert.ok(fn.includes('releaseOrderInventory'), 'real holds are still released after a failed consume');
    assert.ok(fn.includes('isOrderInventoryConsumed'), 'physical consumption is still detected before release');
  });

  test('an inconclusive consumption probe is logged and never releases or voids', () => {
    const fn = sliceBetween(service(), 'async function applyPaidInventory', 'export async function payOrder');
    assert.ok(fn.includes('if (alreadyConsumed === false)'), 'only a confirmed unconsumed verdict releases');
    assert.ok(fn.includes('else if (alreadyConsumed !== true)'), 'null/non-boolean verdicts are explicit');
    assert.ok(
      fn.includes('logEvent("error", "inventory_consumption_probe_unknown"'),
      'inconclusive probe event'
    );
    assert.ok(fn.includes('recordVoid: false'), 'the payment-failure path can never void');
    assert.equal(fn.includes('if (!alreadyConsumed)'), false, 'null must not be treated as unconsumed');

    const start = fn.indexOf('inventory_consumption_probe_unknown');
    const end = fn.indexOf('});', start);
    assert.ok(start > 0 && end > start, 'probe event block is present');
    const block = fn.slice(start, end);
    assert.ok(block.includes('orderId: String(doc._id)'), 'order identity only');
    assert.ok(block.includes('probeResult:'), 'verdict type only');
    assert.ok(block.includes('consumptionCode:'), 'typed result code only');
    for (const forbidden of ['errorMessage', 'result?.error', 'warnings', 'errorName']) {
      assert.equal(block.includes(forbidden), false, `probe event must not include ${forbidden}`);
    }
  });

  test('both payment commit paths still call the same consumption step', () => {
    const pay = sliceBetween(service(), 'export async function payOrder', '// KDS staff dismiss');
    const confirm = sliceBetween(service(), 'export async function confirmPayment', '// Cashier rejects pending payment');
    for (const [label, body] of [
      ['payOrder', pay],
      ['confirmPayment', confirm],
    ]) {
      assert.ok(body.includes('await applyPaidInventory(conn, doc, actorId);'), `${label} consumes once`);
      assert.ok(
        body.indexOf('await applyPaidInventory(conn, doc, actorId);') < body.lastIndexOf('return doc;'),
        `${label} consumes before returning the PAID order`
      );
    }
  });

  test('old unstructured inventory warnings were fully removed', () => {
    const text = service();
    for (const legacy of [
      '[inventory] ${label} failed for order',
      '[inventory] consumption failed for order',
      '[inventory] consumption warnings for order',
      '[inventory] consumption error for order',
    ]) {
      assert.ok(!text.includes(legacy), `legacy warning removed: ${legacy}`);
    }
  });

  test('no sensitive value is passed to the inventory log events', () => {
    const fn = sliceBetween(service(), 'async function applyPaidInventory', 'export async function payOrder');
    const hook = sliceBetween(service(), 'async function runInventoryHook', '// Create an order.');
    for (const body of [fn, hook]) {
      assert.ok(!/pin|password|secret|token|MONGODB_URI/i.test(body), 'no credential field in inventory logs');
    }
  });
});
