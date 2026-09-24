// Forceful separation (production repair): /cashier is STRICT CASHIER-only at
// the server portal gate. MANAGER keeps API-level payment-confirm authority
// via policy (shared BUSINESS operation), but MANAGER portal access to
// /cashier is rejected. Identity is never converted.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { can } from '../lib/policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

describe('AUTH-ARCH-5 CASHIER access audit (DB-free)', () => {
  test('14. CASHIER layout accepts ONLY live CASHIER (strict portal gate)', () => {
    const s = src('app/cashier/layout.js');
    assert.ok(s.includes('getPortalSession("CASHIER")'), 'canonical CASHIER-only gate');
    assert.ok(!s.includes('getPortalSession("MANAGER")'), 'no MANAGER portal acceptance');
    assert.ok(!s.includes('getLiveSessionFromCookies'), 'no dual-role session read');
  });

  test('15. layout never converts identity (no role assignment or alias)', () => {
    const s = src('app/cashier/layout.js');
    assert.ok(!s.includes('verifySessionToken'), 'no parallel HMAC path');
    // Role is derived read-only from the live session; JSX prop role="CASHIER"
    // (PinGuard target) is not an assignment. Spaced assignments would be.
    assert.ok(!/role\s+=\s+"(CASHIER|MANAGER)"|role\s+=\s+'(CASHIER|MANAGER)'/.test(s), 'role is read-only');
    assert.ok(!s.includes('? "MANAGER"') && !s.includes("? 'MANAGER'"), 'no MANAGER substitution');
    assert.ok(!s.includes('roleSnapshot'), 'no snapshot authority');
  });

  test('16. payment confirmation stays CASHIER-or-MANAGER by policy (not layout)', () => {
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(can('WAITER', 'orders:payment:confirm'), false);
    assert.equal(can('KITCHEN', 'orders:payment:confirm'), false);
    assert.equal(can('BARISTA', 'orders:payment:confirm'), false);
  });

  test('17. cashier-sensitive APIs are server-authorized (navigation grants nothing)', () => {
    const orderId = src('app/api/orders/[id]/route.js');
    assert.ok(orderId.includes('"orders:payment:confirm"'), 'PAID/reject gated server-side');
    const staff = src('app/api/manager/staff/route.js');
    assert.ok(staff.includes('requireAuth(request, ["MANAGER"])'), 'staff admin stays MANAGER-only');
    const cashierUI = src('app/components/CashierUI.jsx');
    assert.ok(!cashierUI.includes('/api/manager'), 'cashier UI calls no manager-only endpoints');
    assert.ok(cashierUI.includes('/api/orders'), 'cashier UI uses the authorized order APIs');
  });
});
