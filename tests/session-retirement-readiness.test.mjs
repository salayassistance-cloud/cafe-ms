// AUTH-ARCH-7 retirement readiness — DB-free tests (static + stubbed engine).
// Proves legacy issuance can be retired later; nothing is removed here.
// No database, no production, no PIN values asserted.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authenticateRequest } from '../lib/serverAuth.js';
import { resolveSessionPrecedence } from '../lib/serverSessionCookies.js';
import { generateSessionId } from '../lib/sessionStore.js';
import { SessionSchema } from '../lib/models/Session.js';
import { STAFF_ROLES } from '../lib/models/Staff.js';
import { SESSION_ROLES } from '../lib/models/Session.js';
import { validateRole } from '../lib/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

const NOW = Date.now();
const STAFF_ID = new mongoose.Types.ObjectId();
function sessionRec(over = {}) {
  return { _id: new mongoose.Types.ObjectId(), sessionId: generateSessionId(), staffId: STAFF_ID, roleSnapshot: 'WAITER', lastSeenAt: new Date(NOW), expiresAt: new Date(NOW + 8 * 3600 * 1000), idleExpiresAt: new Date(NOW + 1800 * 1000), version: 1, revokedAt: null, revokeReason: null, ...over };
}
function stubConn({ session = sessionRec(), staff = { _id: STAFF_ID, name: 'Abel', role: 'WAITER', waiterNumber: 3, isActive: true } } = {}) {
  const pick = (q) => (!session || (q && q.sessionId && q.sessionId !== session.sessionId) ? null : session);
  const query = (q) => { const rec = pick(q); const self = { select: () => self, lean: () => self, then: (r) => r(rec) }; return self; };
  return { models: { Session: { findOne: (q) => query(q), findByIdAndUpdate: () => ({ lean: async () => ({}) }) }, Staff: { findById: () => ({ select: () => ({ lean: async () => staff }) }) } } };
}

describe('AUTH-ARCH-7 retirement readiness (DB-free)', () => {
  test('1. Staff login creates a canonical server Session', () => {
    assert.ok(src('app/api/auth/login-staff/route.js').includes('createSession(conn'));
  });

  test('2. Staff login sets the canonical opaque cookie', () => {
    assert.ok(src('app/api/auth/login-staff/route.js').includes('NEW_SESSION_COOKIE'));
    assert.ok(src('app/api/auth/verify-pin/route.js').includes('NEW_SESSION_COOKIE'));
  });

  test('3. legacy issuance retired from normal Staff login (AUTH-ARCH-8D/8F)', () => {
    assert.ok(!src('app/api/auth/login-staff/route.js').includes('createSessionToken('), 'login-staff: no legacy issuance');
    const vp = src('app/api/auth/verify-pin/route.js');
    assert.ok(!vp.includes('createSessionToken('), 'verify-pin: no legacy issuance on any branch (bootstrap retired in 8F)');
    assert.ok(!vp.includes('if (!hasStaffForRole)'), 'verify-pin bootstrap gate retired in 8F');
  });

  test('4. new session takes precedence; never silently falls back', () => {
    const id = generateSessionId();
    assert.equal(resolveSessionPrecedence({ newSessionId: id, legacyToken: 'anything' }), 'server');
    assert.equal(resolveSessionPrecedence({ newSessionId: null, legacyToken: 'x' }), 'legacy');
  });

  test('5-7. revoked/expired/malformed new session never authenticates via legacy', async () => {
    const bad = [
      sessionRec({ revokedAt: new Date(NOW), revokeReason: 'LOGOUT' }),
      sessionRec({ expiresAt: new Date(NOW - 1000) }),
    ];
    for (const s of bad) {
      const res = await authenticateRequest({ connectProvider: async () => stubConn({ session: s }), newSessionId: s.sessionId, legacyToken: 'valid-looking-legacy' });
      assert.equal(res.ok, false, 'no legacy resurrection');
    }
    const dbCalls = [];
    const malformed = await authenticateRequest({ connectProvider: async () => { dbCalls.push(1); throw new Error('must not connect'); }, newSessionId: 'not-opaque!!!', legacyToken: 'x' });
    assert.equal(malformed.code, 'SESSION_INVALID');
    assert.equal(dbCalls.length, 0);
  });

  test('8. all five roles have Staff authentication paths (no SystemAuth needed)', () => {
    for (const role of ['WAITER', 'KITCHEN', 'BARISTA', 'CASHIER', 'MANAGER']) {
      assert.ok(STAFF_ROLES.includes(role), `Staff supports ${role}`);
      assert.ok(SESSION_ROLES.includes(role), `Session supports ${role}`);
      assert.equal(validateRole(role.toLowerCase()), role);
    }
    assert.ok(src('app/api/auth/login-staff/route.js').includes('isValidRole(role)'), 'login-staff accepts Staff roles');
  });

  test('9. SystemAuth bootstrap fallback retired; model retained for scripts (8F)', () => {
    const vp = src('app/api/auth/verify-pin/route.js');
    assert.ok(!vp.includes('hasStaffForRole'), 'bootstrap gate retired from production login');
    assert.ok(!vp.includes('verifyRolePin'), 'no SystemAuth verification in login');
    // AUTH-ARCH-8C: update-pins retired — the legacy mass-PIN route is gone.
    // AUTH-ARCH-8F: the SystemAuth MODEL file stays (explicit ops scripts
    // import it directly); no production runtime path uses it.
    assert.ok(!existsSync(join(root, 'app/api/manager/settings/update-pins/route.js')), 'update-pins route retired');
    assert.ok(existsSync(join(root, 'lib/models/SystemAuth.js')), 'SystemAuth model file retained for scripts');
  });

  test('10. no sensitive route relies on legacy HMAC authorization', () => {
    const scan = (dir, out = []) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) scan(p, out);
        else if (e === 'route.js' || e === 'layout.js' || e === 'actions.js') out.push(p);
      }
      return out;
    };
    const allowed = new Set(['app/api/auth/login-staff/route.js', 'app/api/auth/verify-pin/route.js'].map((f) => join(root, ...f.split('/'))));
    for (const f of scan(join(root, 'app'))) {
      const c = readFileSync(f, 'utf8');
      if (c.includes('verifySessionToken') && !allowed.has(f)) {
        assert.fail(`${f.slice(root.length + 1)} performs direct HMAC verification`);
      }
    }
  });

  test('11. no browser client directly depends on bono_sess', () => {
    const scan = (dir, out = []) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) scan(p, out);
        else if (/\.(js|jsx)$/.test(e)) out.push(p);
      }
      return out;
    };
    // Strip comments: a mention in prose is not a dependency.
    const codeOnly = (c) => c.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
    for (const f of scan(join(root, 'app', 'components'))) {
      const c = codeOnly(readFileSync(f, 'utf8'));
      assert.ok(!c.includes('bono_sess'), `${f.slice(root.length + 1)} functionally references bono_sess`);
      assert.ok(!c.includes('document.cookie'), `${f.slice(root.length + 1)} reads document.cookie`);
    }
  });

  test('12-13. Session indexes present, complete, and conflict-free', () => {
    const idx = SessionSchema.indexes();
    const byName = new Map();
    for (const [fields, opts] of idx) {
      const name = (opts && opts.name) || Object.entries(fields).map(([k, v]) => `${k}_${v}`).join('_');
      assert.ok(!byName.has(name) || JSON.stringify(byName.get(name).opts || {}) === JSON.stringify(opts || {}), `conflicting duplicate index: ${name}`);
      byName.set(name, { fields, opts });
    }
    const find = (pred) => [...byName.values()].find(pred);
    const sid = find((i) => i.fields.sessionId === 1);
    assert.ok(sid && sid.opts && sid.opts.unique === true, 'unique sessionId lookup index');
    assert.ok(find((i) => i.fields.staffId === 1 && i.fields.revokedAt === 1), 'staffId+revokedAt compound index');
    const ttl = [...byName.values()].filter((i) => i.fields.expiresAt === 1);
    assert.equal(ttl.length, 1, 'exactly one expiresAt definition (no field/TTL conflict)');
    assert.equal(ttl[0].opts && ttl[0].opts.expireAfterSeconds, 0, 'TTL expireAfterSeconds: 0');
  });

  test('14. ARCH-8 blockers explicitly detectable (not silently resolved)', () => {
    // AUTH-ARCH-8A: clear-orders migrated to canonical Staff re-auth — it is
    // no longer a SystemAuth blocker (assert the migration, not the marker).
    assert.ok(!src('app/api/manager/settings/clear-orders/route.js').includes('verifyRolePin'), 'clear-orders no longer SystemAuth-based');
    // AUTH-ARCH-8B: runtime default-Staff bootstrap removed from staffService —
    // assert the removal (tombstone documents the virgin-DB procedure).
    assert.ok(!src('lib/staffService.js').includes('export const DEFAULT_STAFF'), 'no DEFAULT_STAFF factory remains');
    assert.ok(!src('lib/staffService.js').includes('export async function ensureDefaultStaff'), 'no ensureDefaultStaff remains');
    // AUTH-ARCH-8F: the SystemAuth runtime module itself is retired (explicit
    // ops scripts that import the MODEL directly are unaffected).
    assert.ok(!existsSync(join(root, 'lib/authService.js')), 'SystemAuth runtime helpers removed');
    assert.ok(src('lib/config/security.js').includes('DEFAULT_MANAGER_PIN'), 'env defaults still defined (comparison-only, 8B keeps)');
  });
});
