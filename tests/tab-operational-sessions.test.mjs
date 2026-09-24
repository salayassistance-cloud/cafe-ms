// AUTH-ARCH-11 tab-scoped multi-staff operational sessions — DB-free tests.
// Transport/header/credential logic is exercised through the real engine and
// stub connections (thenable Mongoose-style doubles); UI wiring is verified
// by explicit source assertions (repo convention). No database, no production.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { authenticateRequest, parseTabCredential, TAB_SESSION_HEADER } from '../lib/serverAuth.js';
import {
  generateTabCredential,
  hashTabCredential,
  attachTabCredential,
  getSessionByTabCredential,
  revokeSessionByTabCredential,
  refreshTabSession,
  TAB_HEARTBEAT_INTERVAL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from '../lib/sessionStore.js';
import { can } from '../lib/policy.js';
import {
  stationStatusOf,
  stationActionOf,
  applyStationUpdate,
  hasActiveStationLines,
} from '../lib/stationStatus.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const NOW = Date.now();

// ---- Stub world: rows addressed by sessionId AND by tabTokenHash ----
function makeWorld(rows = [], staffById = {}) {
  const calls = [];
  const pick = (q) => {
    if (!q) return null;
    const hit = rows.find((r) => {
      if (q.sessionId && q.sessionId !== r.sessionId) return false;
      if (q.tabTokenHash && q.tabTokenHash !== r.tabTokenHash) return false;
      if (Object.prototype.hasOwnProperty.call(q, 'revokedAt') && q.revokedAt === null && r.revokedAt) return false;
      return true;
    }) || null;
    return hit;
  };
  const query = (q) => {
    const rec = pick(q);
    const self = { select: () => self, lean: () => self, then: (r) => r(rec) };
    return self;
  };
  const conn = { models: {
    Session: {
      findOne: (q) => query(q),
      updateOne: (filter, update) => { calls.push({ op: 'updateOne', filter, update }); const rec = pick(filter); if (rec) Object.assign(rec, update.$set || {}); return { modifiedCount: rec ? 1 : 0 }; },
      findOneAndUpdate: (filter, update, opts) => { calls.push({ op: 'findOneAndUpdate', filter, update }); const rec = pick(filter); if (!rec) return query(null); const out = { ...rec, ...(update.$set || {}) }; Object.assign(rec, update.$set || {}); return query(out); },
    },
    Staff: { findById: (id) => ({ select: () => ({ lean: async () => staffById[String(id)] || null }) }) },
  } };
  return { conn, calls };
}

function rowFor(staff, role, over = {}) {
  const id = new mongoose.Types.ObjectId();
  return {
    _id: id, sessionId: `sess-${role}-${id.toString().slice(-6)}-abcdefghijklmnopqrstuvwxyz012345`,
    staffId: staff._id, roleSnapshot: role, tabTokenHash: null,
    lastSeenAt: new Date(NOW), expiresAt: new Date(NOW + SESSION_ABSOLUTE_MS), idleExpiresAt: new Date(NOW + SESSION_IDLE_MS),
    version: 1, revokedAt: null, revokeReason: null, ...over,
  };
}
function staffRec(name, role, over = {}) {
  const _id = new mongoose.Types.ObjectId();
  return { _id, name, role, waiterNumber: role === 'WAITER' ? 3 : null, isActive: true, ...over };
}
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('AUTH-ARCH-11-A/B: independent tab identities', () => {
  test('A: single tab login per role resolves through the tab credential', async () => {
    for (const role of ['KITCHEN', 'BARISTA', 'CASHIER', 'WAITER', 'MANAGER']) {
      const staff = staffRec(`${role}-op`, role);
      const row = rowFor(staff, role);
      const raw = 'a'.repeat(42) + '1';
      row.tabTokenHash = sha256hex(raw);
      const { conn } = makeWorld([row], { [String(staff._id)]: staff });
      const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: raw, allowedRoles: [role] });
      assert.equal(res.ok, true, role);
      assert.equal(res.authMethod, 'tab');
      assert.equal(res.payload.role, role);
    }
  });

  test('B: four tabs hold four identities; login/logout never cross over', async () => {
    const kitchen = staffRec('Kitchen', 'KITCHEN'), barista = staffRec('Barista', 'BARISTA');
    const cashier = staffRec('Cash', 'CASHIER'), waiter = staffRec('Abel', 'WAITER');
    const rows = [rowFor(kitchen, 'KITCHEN'), rowFor(barista, 'BARISTA'), rowFor(cashier, 'CASHIER'), rowFor(waiter, 'WAITER')];
    const raws = ['k'.repeat(43), 'b'.repeat(43), 'c'.repeat(43), 'w'.repeat(43)];
    rows.forEach((r, i) => { r.tabTokenHash = sha256hex(raws[i]); });
    const staffById = Object.fromEntries([kitchen, barista, cashier, waiter].map((s) => [String(s._id), s]));
    const { conn } = makeWorld(rows, staffById);
    const provider = async () => conn;
    // Each tab authenticates with its own credential only.
    const expectRole = async (i, role) => {
      const res = await authenticateRequest({ connectProvider: provider, tabCredential: raws[i], allowedRoles: [role] });
      assert.equal(res.ok, true, `tab ${i} as ${role}`);
      assert.equal(res.payload.role, role);
    };
    await expectRole(0, 'KITCHEN'); await expectRole(1, 'BARISTA');
    await expectRole(2, 'CASHIER'); await expectRole(3, 'WAITER');
    // Forbidden cross-checks still enforced per tab.
    const cross = await authenticateRequest({ connectProvider: provider, tabCredential: raws[0], allowedRoles: ['BARISTA'] });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    // Tab-scoped logout revokes ONLY that row.
    const { revokeSessionByTabCredential: revoke } = await import('../lib/sessionStore.js');
    const gone = await revoke(conn, raws[1], 'LOGOUT');
    assert.ok(gone && gone.revokedAt, 'barista row revoked');
    const stillBarista = await authenticateRequest({ connectProvider: provider, tabCredential: raws[1] });
    assert.equal(stillBarista.code, 'SESSION_REVOKED');
    for (const [i, role] of [[0, 'KITCHEN'], [2, 'CASHIER'], [3, 'WAITER']]) await expectRole(i, role);
  });

  test('tab login rotation never touches other sessions (no mass revoke)', () => {
    for (const f of ['app/api/auth/login-staff/route.js', 'app/api/auth/verify-pin/route.js']) {
      const s = src(f);
      assert.ok(!s.includes('revokeAllStaffSessions'), `${f}: no mass revocation on login`);
      assert.ok(s.includes('attachTabCredential'), `${f}: tab credential bound at login`);
    }
  });
});

describe('AUTH-ARCH-11-C/D: same staff, two tabs + device independence', () => {
  test('C: same Staff in two tabs gets separate rows; logout A keeps B', async () => {
    const staff = staffRec('Abel', 'WAITER');
    const rowA = rowFor(staff, 'WAITER'), rowB = rowFor(staff, 'WAITER');
    const rawA = 'A'.repeat(43), rawB = 'B'.repeat(43);
    rowA.tabTokenHash = sha256hex(rawA); rowB.tabTokenHash = sha256hex(rawB);
    assert.notEqual(rowA.tabTokenHash, rowB.tabTokenHash, 'distinct bindings (fixation-proof: fresh randoms)');
    const { conn } = makeWorld([rowA, rowB], { [String(staff._id)]: staff });
    const { revokeSessionByTabCredential: revoke } = await import('../lib/sessionStore.js');
    await revoke(conn, rawA, 'LOGOUT');
    const resB = await authenticateRequest({ connectProvider: async () => conn, tabCredential: rawB });
    assert.equal(resB.ok, true, 'tab B unaffected');
    const resA = await authenticateRequest({ connectProvider: async () => conn, tabCredential: rawA });
    assert.equal(resA.code, 'SESSION_REVOKED');
  });

  test('C: disable revokes all Staff rows; PIN reset path still revokes by staff', async () => {
    const staff = staffRec('Abel', 'WAITER');
    const rowA = rowFor(staff, 'WAITER'), rowB = rowFor(staff, 'WAITER');
    rowA.tabTokenHash = sha256hex('1'.repeat(43)); rowB.tabTokenHash = sha256hex('2'.repeat(43));
    const { conn } = makeWorld([rowA, rowB], { [String(staff._id)]: { ...staff, isActive: false } });
    for (const raw of ['1'.repeat(43), '2'.repeat(43)]) {
      const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: raw });
      assert.equal(res.code, 'ACCOUNT_DISABLED');
    }
    assert.ok(src('app/api/auth/change-pin/route.js').includes('revokeAllStaffSessions'), 'PIN change revokes staff sessions (existing rule kept)');
  });

  test('D: different devices/browsers stay independent (row-per-login)', async () => {
    const staff = staffRec('Kitchen', 'KITCHEN');
    const devA = rowFor(staff, 'KITCHEN'), devB = rowFor(staff, 'KITCHEN');
    devA.tabTokenHash = sha256hex('d'.repeat(43)); devB.tabTokenHash = sha256hex('e'.repeat(43));
    const { conn } = makeWorld([devA, devB], { [String(staff._id)]: staff });
    const { revokeSessionByTabCredential: revoke } = await import('../lib/sessionStore.js');
    await revoke(conn, 'd'.repeat(43), 'LOGOUT');
    const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: 'e'.repeat(43) });
    assert.equal(res.ok, true, 'second device unaffected');
  });
});

describe('AUTH-ARCH-11 credential, transport, lifetime', () => {
  test('credential: 256-bit random, opaque, hashed server-side', () => {
    const a = generateTabCredential(), b = generateTabCredential();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.ok(!a.includes('WAITER') && !a.includes('CASHIER'));
    const h = hashTabCredential(a);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, sha256hex(a));
    assert.notEqual(h, a);
  });

  test('attach binds hash (never raw) to exactly one row', async () => {
    const staff = staffRec('Cash', 'CASHIER');
    const row = rowFor(staff, 'CASHIER');
    const { conn, calls } = makeWorld([row], { [String(staff._id)]: staff });
    const raw = await attachTabCredential(conn, row.sessionId);
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
    const write = calls.find((c) => c.op === 'updateOne');
    assert.ok(write, 'single scoped write');
    assert.equal(write.update.$set.tabTokenHash, sha256hex(raw), 'only the hash is stored');
    assert.ok(!JSON.stringify(write).includes(raw.slice(0, 20)), 'raw never persisted');
    const found = await getSessionByTabCredential(conn, raw);
    assert.equal(found.sessionId, row.sessionId);
    assert.equal(await attachTabCredential(conn, 'missing-row'), null);
  });

  test('header transport is narrowly scoped (not generic Bearer)', () => {
    assert.equal(TAB_SESSION_HEADER, 'x-bono-tab-session');
    const get = (k) => (String(k).toLowerCase() === 'x-bono-tab-session' ? 'X'.repeat(43) : null);
    assert.equal(parseTabCredential({ get }), 'X'.repeat(43));
    assert.equal(parseTabCredential({ get: () => null }), null);
    assert.equal(parseTabCredential(null), null);
    const engine = src('lib/serverAuth.js');
    assert.ok(!engine.includes('bearerToken'), 'no generic bearer slot');
  });

  test('heartbeat records active tabs, never extends absolute, never the revoked/disabled/expired', async () => {
    assert.equal(TAB_HEARTBEAT_INTERVAL_MS, 5 * 60 * 1000);
    const staff = staffRec('Kitchen', 'KITCHEN');
    // idleExpiresAt in the past must NOT matter (restaurant policy: no idle logout).
    const row = rowFor(staff, 'KITCHEN', { lastSeenAt: new Date(NOW - 3600000), expiresAt: new Date(NOW + 8 * 3600 * 1000), idleExpiresAt: new Date(NOW - 1000) });
    const raw = 'h'.repeat(43);
    row.tabTokenHash = sha256hex(raw);
    const { conn, calls } = makeWorld([row], { [String(staff._id)]: staff });
    const t = NOW + 60000;
    const res = await refreshTabSession(conn, raw, t);
    assert.equal(res.ok, true);
    const write = calls.find((c) => c.op === 'updateOne');
    assert.ok(!('expiresAt' in (write.update.$set || {})), 'absolute deadline never extended by heartbeat');
    assert.equal(Number(write.update.$set.idleExpiresAt), t + SESSION_IDLE_MS, 'idle slides');
    // Expired row: no write, stays expired.
    row.expiresAt = new Date(NOW - 1000);
    const callsBefore = calls.length;
    const resExp = await refreshTabSession(conn, raw, t);
    assert.equal(resExp.code, 'SESSION_EXPIRED');
    assert.equal(calls.length, callsBefore, 'no write for expired rows');
    row.expiresAt = new Date(NOW + 8 * 3600 * 1000);
    // Revoked row: no extension.
    row.revokedAt = new Date(NOW); row.revokeReason = 'LOGOUT';
    const res2 = await refreshTabSession(conn, raw, t);
    assert.equal(res2.code, 'SESSION_REVOKED');
    // Disabled staff: no extension.
    row.revokedAt = null;
    const { conn: conn2 } = makeWorld([row], { [String(staff._id)]: { ...staff, isActive: false } });
    const res3 = await refreshTabSession(conn2, raw, t);
    assert.equal(res3.code, 'ACCOUNT_DISABLED');
  });

  test('memory-only: no credential persistence anywhere in client code', () => {
    const fetch = src('lib/clientFetch.js');
    assert.ok(fetch.includes('let tabCredential = null'), 'module memory registry');
    for (const access of ['localStorage.', 'sessionStorage.', 'indexedDB', 'document.cookie']) {
      assert.ok(!fetch.includes(access), `clientFetch has no ${access} access`);
    }
    const scanDirs = ['app/components', 'app/waiter', 'app/cashier', 'app/barista', 'app/kds', 'app/manager'];
    const hits = [];
    const scan = (dir) => {
      for (const e of readdirSync(join(root, dir))) {
        const p = join(root, dir, e);
        if (statSync(p).isDirectory()) scan(join(dir, e));
        else if (/\.(js|jsx)$/.test(e)) {
          const raw = readFileSync(p, 'utf8');
          const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
          // Resolve UPPER_SNAKE = 'literal' key constants, then judge the KEY
          // argument of each storage call (not the API name itself).
          const consts = {};
          for (const m of code.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g)) consts[m[1]] = m[2];
          const keyOf = (expr) => {
            const t = expr.trim();
            const lit = t.match(/^['"]([^'"]+)['"]$/);
            if (lit) return lit[1];
            const id = t.match(/^([A-Z][A-Z0-9_]*)$/);
            if (id && consts[id[1]]) return consts[id[1]];
            return t;
          };
          for (const m of code.matchAll(/(?:localStorage|sessionStorage)\s*\.\s*(setItem|getItem)\s*\(\s*([^,)]+)/g)) {
            const key = keyOf(m[2]).toLowerCase();
            if (/sess|token|credential|pin|auth|passwd|secret/.test(key) && !key.includes('receive:draft')) hits.push(`${p}: ${key}`);
          }
          if (/document\.cookie\s*=/.test(code)) hits.push(`${p}: document.cookie write`);
        }
      }
    };
    scanDirs.forEach(scan);
    assert.deepEqual(hits, [], 'no credential persistence in portals');
  });

  test('no credential in URLs, SSE URLs, or logs', () => {
    for (const f of ['lib/clientFetch.js', 'app/components/WaiterUI.js', 'app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx', 'app/components/PinGuard.js', 'app/components/PinLoginModal.js']) {
      const code = src(f).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
      assert.ok(!/[?&](tab|token|credential|session)=/.test(code), `${f}: no credential query params`);
      assert.ok(!code.includes('EventSource(`/api/events?'), `${f}: no SSE URL token`);
    }
    assert.ok(src('lib/orderEvents.js').includes('new EventSource("/api/events")'), 'SSE uses fixed URL, no identity');
    for (const f of ['lib/serverAuth.js', 'lib/sessionStore.js', 'lib/clientFetch.js', 'app/api/auth/tab/heartbeat/route.js']) {
      for (const line of src(f).split('\n')) {
        if (/console\.(log|info|debug|warn|error)/.test(line)) {
          assert.ok(!/tabCredential|tabToken|sessionId|cookie|pin|secret|bearer|authorization/i.test(line), `${f}: ${line.trim()}`);
        }
      }
    }
  });
});

describe('AUTH-ARCH-11-E/F/G/H/I/J/K/L/M/N: stations, waiters, cashier, streams', () => {
  test('E: Kitchen+Barista same order stay independent under tab auth', async () => {
    const kitchen = staffRec('Kitchen', 'KITCHEN'), barista = staffRec('Barista', 'BARISTA');
    const rk = rowFor(kitchen, 'KITCHEN'), rb = rowFor(barista, 'BARISTA');
    rk.tabTokenHash = sha256hex('k'.repeat(43)); rb.tabTokenHash = sha256hex('e'.repeat(43));
    const staffById = { [String(kitchen._id)]: kitchen, [String(barista._id)]: barista };
    const { conn } = makeWorld([rk, rb], staffById);
    const provider = async () => conn;
    const kPrep = await authenticateRequest({ connectProvider: provider, tabCredential: 'k'.repeat(43), allowedRoles: ['KITCHEN'] });
    assert.equal(kPrep.payload.role, 'KITCHEN');
    const bDeniedKitchen = await authenticateRequest({ connectProvider: provider, tabCredential: 'e'.repeat(43), allowedRoles: ['KITCHEN'] });
    assert.equal(bDeniedKitchen.status, 403);
    const order = { kitchenStatus: 'PREPARING', baristaStatus: 'PENDING', items: [{ type: 'FOOD', cancelled: false }, { type: 'DRINK', cancelled: false }] };
    assert.equal(stationStatusOf(order, 'KITCHEN'), 'PREPARING');
    assert.equal(stationStatusOf(order, 'BARISTA'), 'PENDING');
  });

  test('F: stale conflict reconciles (no retry loop scheduled)', () => {
    const s = src('app/components/KitchenDisplay.js');
    assert.ok(s.includes('scheduleRefresh();'), 'conflict path refetches once');
    const catches = s.split('} catch (err) {').slice(1);
    for (const c of catches) assert.ok(!c.slice(0, 400).includes('setInterval'), 'no retry timers in failure paths');
  });

  test('G: cancellation stays station-scoped', () => {
    const order = { items: [{ type: 'FOOD', cancelled: true }, { type: 'DRINK', cancelled: false }] };
    assert.equal(hasActiveStationLines(order, 'KITCHEN'), false);
    assert.equal(hasActiveStationLines(order, 'BARISTA'), true);
    assert.ok(src('lib/orderService.js').includes('if (isKitchen && target.type !== "FOOD") throw'), 'server enforces cancel ownership');
  });

  test('H: Cashier tab stays Cashier; Manager tab stays Manager', async () => {
    const cashier = staffRec('Cash', 'CASHIER'), manager = staffRec('Manager', 'MANAGER');
    const rc = rowFor(cashier, 'CASHIER'), rm = rowFor(manager, 'MANAGER');
    rc.tabTokenHash = sha256hex('c'.repeat(43)); rm.tabTokenHash = sha256hex('m'.repeat(43));
    const staffById = { [String(cashier._id)]: cashier, [String(manager._id)]: manager };
    const { conn } = makeWorld([rc, rm], staffById);
    const provider = async () => conn;
    assert.equal((await authenticateRequest({ connectProvider: provider, tabCredential: 'c'.repeat(43) })).payload.role, 'CASHIER');
    assert.equal((await authenticateRequest({ connectProvider: provider, tabCredential: 'm'.repeat(43) })).payload.role, 'MANAGER');
    assert.equal((await authenticateRequest({ connectProvider: provider, tabCredential: 'c'.repeat(43), allowedRoles: ['MANAGER'] })).status, 403);
  });

  test('I: Waiter tabs stay isolated (server-scoped ownership)', async () => {
    const alice = staffRec('Alice', 'WAITER'), bob = staffRec('Bob', 'WAITER');
    const ra = rowFor(alice, 'WAITER'), rb = rowFor(bob, 'WAITER');
    ra.tabTokenHash = sha256hex('a'.repeat(43)); rb.tabTokenHash = sha256hex('o'.repeat(43));
    const staffById = { [String(alice._id)]: alice, [String(bob._id)]: bob };
    const { conn } = makeWorld([ra, rb], staffById);
    const provider = async () => conn;
    const resA = await authenticateRequest({ connectProvider: provider, tabCredential: 'a'.repeat(43), allowedRoles: ['WAITER'] });
    const resB = await authenticateRequest({ connectProvider: provider, tabCredential: 'o'.repeat(43), allowedRoles: ['WAITER'] });
    assert.notEqual(resA.payload.staffId, resB.payload.staffId, 'distinct waiter identities');
    assert.ok(src('app/api/orders/route.js').includes('query.waiterId = String(auth.payload.staffId)'), 'server scopes waiter reads to session staff');
  });

  test('J: SSE is identity-free (per-tab streams unnecessary by design)', () => {
    assert.ok(src('app/api/events/route.js').includes('no session/auth required'), 'stream carries no authenticated stream');
    const pubs = [];
    for (const f of ['app/api/orders/route.js', 'app/api/orders/[id]/route.js']) {
      for (const m of src(f).match(/publish\(\{[\s\S]*?\}\)/g) || []) pubs.push(m);
    }
    assert.ok(pubs.length > 0, 'publish sites enumerated');
    for (const p of pubs) assert.ok(!/token|credential|pin|staffId|role/i.test(p), `invalidation-only event: ${p.slice(0, 60)}`);
    assert.ok(src('lib/orderEvents.js').includes('if (!enabled) return;'), 'streams suspend on session end');
  });

  test('K: polling uses the tab context via one canonical transport', () => {
    const fetch = src('lib/clientFetch.js');
    const attachSites = (fetch.match(/withTabHeaders\(/g) || []).length;
    assert.ok(attachSites >= 2, `single merge helper used by all fetch paths (found ${attachSites})`);
    assert.ok(!fetch.includes('window.globalAuth') && !fetch.includes('globalThis.currentUser'), 'no global auth singleton');
  });

  test('L/M/N: revocation, role change, disable act per affected identity only', async () => {
    const staff = staffRec('Abel', 'WAITER');
    const row = rowFor(staff, 'CASHIER');
    row.tabTokenHash = sha256hex('z'.repeat(43));
    // Role snapshot says CASHIER but live Staff says WAITER -> WAITER wins.
    const { conn } = makeWorld([row], { [String(staff._id)]: staff });
    const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: 'z'.repeat(43), allowedRoles: ['WAITER'] });
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'WAITER', 'live role wins immediately');
    const denied = await authenticateRequest({ connectProvider: async () => conn, tabCredential: 'z'.repeat(43), allowedRoles: ['CASHIER'] });
    assert.equal(denied.status, 403, 'old role access stops');
  });
});

describe('AUTH-ARCH-11 login/logout/rotation wiring', () => {
  test('login issues tab credential without touching other sessions', () => {
    for (const f of ['app/api/auth/login-staff/route.js', 'app/api/auth/verify-pin/route.js']) {
      const s = src(f);
      assert.ok(s.includes('attachTabCredential'), `${f}: binds tab credential`);
      assert.ok(s.includes('tabCredential'), `${f}: returns it to the issuing tab`);
    }
  });

  test('logout revokes the presenting tab session only', () => {
    const s = src('app/api/auth/logout/route.js');
    assert.ok(s.includes('revokeSessionByTabCredential'), 'tab-scoped revocation present');
    assert.ok(!s.includes('revokeAllStaffSessions'), 'never mass-revokes on logout');
  });

  test('client login stores credential in memory and preserves it across nav', () => {
    for (const f of ['app/components/PinGuard.js', 'app/components/PinLoginModal.js']) {
      const s = src(f);
      assert.ok(s.includes('setTabCredential(data.tabCredential'), `${f}: stores issued credential`);
      assert.ok(s.includes('startTabHeartbeat()'), `${f}: starts tab heartbeat`);
    }
    assert.ok(src('app/components/PinGuard.js').includes('navigateAfterAuth(router, target)'), 'PinGuard soft-navigates (memory survives)');
    assert.ok(!src('app/components/PinGuard.js').includes('window.location.reload'), 'no reload wiping memory');
  });

  test('portal logouts clear tab memory via the canonical helper', () => {
    for (const f of ['app/components/WaiterUI.js', 'app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx']) {
      assert.ok(src(f).includes('tabLogout()'), `${f}: tab-scoped logout`);
    }
  });

  test('Server Actions resolve the tab credential without weakening cookie auth', () => {
    const s = src('app/manager/menu-crud/actions.js');
    assert.ok(s.includes('resolveTabSession'), 'tab-first Server Action auth');
    assert.ok(s.includes('getLiveSessionFromCookies'), 'cookie fallback preserved');
    assert.ok(src('app/manager/menu-crud/MenuCrudClient.jsx').includes('appendTabCredential(fd)'), 'client attaches credential to FormData');
  });
});

describe('AUTH-ARCH-12: no cross-tab conflict logic (§11 items 9,10,15-19)', () => {
  const codeOnly = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');

  test('9-10. no switched/continue-as flow is triggered by another tab', () => {
    for (const f of ['app/components/WaiterUI.js', 'app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx', 'lib/clientFetch.js']) {
      const code = codeOnly(f);
      for (const banned of ["'switched'", '"switched"', 'adoptPendingIdentity', 'pendingIdentityRef', 'continueBtn', 'sessionSwitched']) {
        assert.ok(!code.includes(banned), `${f}: no ${banned}`);
      }
    }
    assert.ok(!codeOnly('app/components/WaiterUI.js').includes('setWaiterId(pending'), 'WaiterUI never adopts a pending identity');
    const w = src('app/components/WaiterUI.js');
    const check = w.slice(w.indexOf('async function checkIdentity()'), w.indexOf('intervalId = setInterval'));
    const block = check.slice(check.indexOf('String(oldId) !== String(newId)'), check.indexOf('if (!newId && oldId)'));
    assert.ok(block.includes("enterSessionEnded('expired')") && block.includes('return;'), 'mismatch ends own session and returns');
    assert.ok(!block.includes('setWaiterId') && !block.includes('setWaiterName'), 'mismatch writes no identity state');
  });

  test('15. a tab credential never falls back to another tab identity', async () => {
    const alice = { _id: new mongoose.Types.ObjectId(), name: 'Alice', role: 'WAITER', waiterNumber: 3, isActive: true };
    const bob = { _id: new mongoose.Types.ObjectId(), name: 'Bob', role: 'WAITER', waiterNumber: 4, isActive: true };
    const mk = (staff) => ({ _id: new mongoose.Types.ObjectId(), sessionId: generateTabCredential(), staffId: staff._id, roleSnapshot: 'WAITER', tabTokenHash: null, lastSeenAt: new Date(NOW), expiresAt: new Date(NOW + 8 * 3600 * 1000), idleExpiresAt: new Date(NOW + 1800 * 1000), version: 1, revokedAt: new Date(NOW), revokeReason: 'LOGOUT' });
    const rowA = mk(alice), rowB = mk(bob);
    rowA.tabTokenHash = crypto.createHash('sha256').update('a'.repeat(43)).digest('hex');
    rowB.tabTokenHash = crypto.createHash('sha256').update('b'.repeat(43)).digest('hex');
    rowB.revokedAt = null; rowB.revokeReason = null;
    const pick = (q) => {
      const hit = [rowA, rowB].find((r) => {
        if (q && q.tabTokenHash && q.tabTokenHash !== r.tabTokenHash) return false;
        if (q && Object.prototype.hasOwnProperty.call(q, 'revokedAt') && q.revokedAt === null && r.revokedAt) return false;
        return true;
      }) || null;
      return hit;
    };
    const query = (q) => { const rec = pick(q); const self = { select: () => self, lean: () => self, then: (r) => r(rec) }; return self; };
    const conn = { models: {
      Session: { findOne: (q) => query(q), updateOne: () => ({ modifiedCount: 0 }), findOneAndUpdate: (f, u) => query(f) },
      Staff: { findById: (id) => ({ select: () => ({ lean: async () => [alice, bob].find((s) => String(s._id) === String(id)) || null }) }) },
    } };
    // Revoked Alice + valid Bob present: Alice's credential yields REVOKED, never Bob.
    const res = await authenticateRequest({ connectProvider: async () => conn, tabCredential: 'a'.repeat(43) });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_REVOKED');
  });

  test('16-19. credentials stay out of storage, broadcast, URLs, and logs', () => {
    for (const f of ['lib/clientFetch.js', 'app/components/WaiterUI.js', 'app/components/KitchenDisplay.js', 'app/components/CashierUI.jsx', 'app/components/PinGuard.js', 'app/components/PinLoginModal.js', 'lib/orderEvents.js']) {
      const code = codeOnly(f);
      assert.ok(!code.includes('BroadcastChannel'), `${f}: no cross-tab broadcast`);
      assert.ok(!/new EventSource\(`/.test(code), `${f}: no dynamic SSE URL construction`);
    }
    assert.ok(!codeOnly('lib/orderEvents.js').includes('token'), 'event hook carries no credential material');
  });
});
