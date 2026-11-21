// JEBENA / KDS polling hygiene — DB-free proofs.
//
// The station board (app/components/KitchenDisplay.js, mounted by /jebena with
// station="HOT_DRINK") must never stack concurrent
// /api/orders?status=ACTIVE&dest=HOT_DRINK requests. These tests pin the
// single-flight guard, the coalesced trailing refresh, unmount abort/cleanup,
// the explicit retry affordance, and the station-scoped fetch contract.
//
// Source/unit based only: no MongoDB, no production writes, no React runtime.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const board = src('app/components/KitchenDisplay.js');

describe('KDS single-flight station polling', () => {
  test('fetchOrders refuses to start a second concurrent request', () => {
    assert.ok(board.includes('if (fetchInFlightRef.current) {'), 'in-flight guard present');
    assert.ok(board.includes('fetchQueuedRef.current = true;'), 'overlap is coalesced, not dropped');
    assert.ok(board.includes('fetchInFlightRef.current = true;'), 'guard is acquired before fetch');
  });

  test('the in-flight flag is always released in finally', () => {
    const finallyBlock = board.slice(board.indexOf('} finally {'));
    assert.ok(finallyBlock.includes('fetchInFlightRef.current = false;'));
    assert.ok(finallyBlock.includes('setInitialLoading(false)'));
  });

  test('a burst during one request coalesces into exactly one trailing refresh', () => {
    assert.ok(board.includes('if (fetchQueuedRef.current) {'));
    assert.ok(board.includes('queuedTimerRef.current = setTimeout('));
    assert.ok(board.includes('fetchOrdersRef.current?.()'));
    assert.ok(board.includes('}, 150);'), 'same debounce as the SSE refresh');
  });

  test('unmount aborts the in-flight request and clears every refresh timer', () => {
    assert.ok(board.includes('const controller = abortRef.current;'));
    assert.ok(board.includes('controller?.abort();'));
    assert.ok(board.includes('clearTimeout(queuedTimerRef.current);'));
    assert.ok(board.includes('clearTimeout(refreshTimer.current);'));
    assert.ok(board.includes('mountedRef.current = false;'));
  });

  test('an aborted request never flips the board to a false offline state', () => {
    assert.ok(board.includes("err.name === 'AbortError'"));
    assert.ok(board.includes('controller?.signal?.aborted'));
  });

  test('the fetch stays scoped to the HOT_DRINK dest (no unrelated statuses)', () => {
    assert.ok(
      board.includes(
        "const url = dest === 'ALL' ? '/api/orders?status=ACTIVE' : `/api/orders?status=ACTIVE&dest=${dest}`;"
      ),
      'dest-scoped station fetch preserved'
    );
    assert.ok(board.includes("view === 'HOT_DRINK' ? 'HOT_DRINK'"), 'Jebena dest mapping preserved');
    assert.ok(!board.includes('status=SERVED'), 'board never requests SERVED');
    assert.ok(!board.includes('status=PAID'), 'board never requests PAID');
    assert.ok(!board.includes('status=ARCHIVED'), 'board never requests ARCHIVED');
  });

  test('failed loads offer an explicit retry and never claim empty-as-confirmed', () => {
    assert.ok(board.includes('const retryNow = useCallback('));
    assert.ok(board.includes('onClick={retryNow}'));
    assert.ok(board.includes("t('retry')"));
    assert.ok(board.includes('Can&apos;t load orders'));
    assert.ok(board.includes('No order state is shown as confirmed.'));
  });

  test('a confirmed transition triggers a prompt, coalesced refresh', () => {
    const lf = board.replace(/\r\n/g, '\n');
    assert.ok(lf.includes('scheduleRefresh();\n    } catch (err) {'));
  });

  test('optimistic actions still show in-flight labels, never saved state', () => {
    assert.ok(board.includes("? 'Starting…'"));
    assert.ok(board.includes("? 'Marking Ready…'"));
  });
});

// Behavioral mirror of the guard (no React import). Proves the algorithm the
// source assertions pin actually serialises requests and emits one trailing
// refresh — not zero and not a storm.
function createRunner() {
  let inFlight = false;
  let queued = false;
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let trailing = 0;
  const resolvers = [];

  const fetchOrders = async () => {
    if (inFlight) {
      queued = true;
      return 'queued';
    }
    inFlight = true;
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => resolvers.push(resolve));
    } finally {
      active -= 1;
      inFlight = false;
      if (queued) {
        queued = false;
        trailing += 1;
        queueMicrotask(() => {
          fetchOrders();
        });
      }
    }
  };

  return {
    fetchOrders,
    resolveOne: () => resolvers.shift()?.(),
    stats: () => ({ started, maxActive, trailing }),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('single-flight algorithm behaviour', () => {
  test('overlapping polls collapse to one request plus one trailing refresh', async () => {
    const r = createRunner();
    const first = r.fetchOrders();
    const dupes = await Promise.all([r.fetchOrders(), r.fetchOrders(), r.fetchOrders()]);
    assert.deepEqual(dupes, ['queued', 'queued', 'queued']);
    assert.deepEqual(r.stats(), { started: 1, maxActive: 1, trailing: 0 });

    r.resolveOne();
    await first;
    await tick();
    assert.deepEqual(r.stats(), { started: 2, maxActive: 1, trailing: 1 });

    r.resolveOne();
    await tick();
    assert.deepEqual(r.stats(), { started: 2, maxActive: 1, trailing: 1 });
  });
});
