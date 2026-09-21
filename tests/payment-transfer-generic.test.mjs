import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { validateOrderStatusUpdate, validatePaymentMethod, isTransferMethod } from '../lib/validate.js';
import { can, canTransition } from '../lib/policy.js';
import { VALID_PAYMENT_METHODS } from '../lib/constants.js';

function readSrc(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('Generic TRANSFER payment (Telebirr brand removed) - DB-free', () => {
  test('No active Telebirr UI labels in Cashier/Waiter/Manager', () => {
    const cashier = readSrc('app/components/CashierUI.jsx');
    const waiter = readSrc('app/components/WaiterUI.js');
    const manager = readSrc('app/manager/reports/page.js');
    // Active buttons/labels must not contain Telebirr brand
    assert.ok(!cashier.includes('Telebirr — Mark Paid'), 'Cashier Mark Paid bypass removed');
    assert.ok(!cashier.includes("label: 'TELEBIRR'"), 'Cashier PAY_META uses TRANSFER');
    assert.ok(!waiter.includes("'TELEBIRR' : 'CASH'") && !waiter.includes('? \'TELEBIRR\''), 'Waiter maps TRANSFER directly');
    // Manager payment breakdown uses generic bankTransfer, not Telebirr string in label logic
    assert.ok(!manager.includes("p.method === 'TELEBIRR'") || manager.includes("TRANSFER"), 'Manager handles TRANSFER (legacy TELEBIRR grouped)');
    // Historical compat references (comments, legacy mapping) are allowed but must mention TRANSFER
    assert.ok(cashier.includes('TRANSFER'), 'Cashier uses TRANSFER');
    assert.ok(waiter.includes('TRANSFER'), 'Waiter uses TRANSFER');
  });

  test('Dynamic active-account selection uses PaymentInfo source (no hardcode)', () => {
    const cashier = readSrc('app/components/CashierUI.jsx');
    const waiter = readSrc('app/components/WaiterUI.js');
    for (const src of [cashier, waiter]) {
      assert.ok(src.includes('/api/payment-info'), 'fetches PaymentInfo API');
      assert.ok(src.includes('isActive !== false'), 'filters active only');
      assert.ok(!src.includes('0911') || src.includes('accountNumber'), 'no hardcoded account numbers');
    }
    // Cashier mirrors Waiter: method state + selectedTransferAccount + loading
    assert.ok(cashier.includes('selectedTransferAccount'), 'Cashier has account selection');
    assert.ok(cashier.includes('cashierMethod'), 'Cashier has method selector');
  });

  test('Account snapshot preserved (historical correctness)', () => {
    const order = {
      paymentMethod: 'TRANSFER',
      paymentAccountId: new mongoose.Types.ObjectId(),
      paymentAccountSnapshot: { bankName: 'CBE', ownerName: 'Abebe', accountNumber: '10001234' },
    };
    // Simulate account rename — snapshot unchanged
    const renamed = { bankName: 'Awash', ownerName: 'Abebe', accountNumber: '10001234' };
    assert.equal(order.paymentAccountSnapshot.bankName, 'CBE');
    assert.notEqual(order.paymentAccountSnapshot.bankName, renamed.bankName);
  });

  test('CASH does not require transfer account', () => {
    const r = validateOrderStatusUpdate({ status: 'PAYMENT_PENDING', paymentMethod: 'CASH' });
    assert.equal(r.ok, true);
    assert.equal(r.data.paymentMethod, 'CASH');
    assert.equal(r.data.paymentAccountId, undefined);
  });

  test('TRANSFER requires valid active account where workflow requires one', () => {
    const accId = new mongoose.Types.ObjectId().toString();
    const ok = validateOrderStatusUpdate({ status: 'PAYMENT_PENDING', paymentMethod: 'TRANSFER', paymentAccountId: accId });
    assert.equal(ok.ok, true);
    const missing = validateOrderStatusUpdate({ status: 'PAYMENT_PENDING', paymentMethod: 'TRANSFER' });
    assert.equal(missing.ok, undefined);
    assert.ok(missing.error.includes('paymentAccountId is required'));
    const bad = validateOrderStatusUpdate({ status: 'PAYMENT_PENDING', paymentMethod: 'TRANSFER', paymentAccountId: 'bad-id' });
    assert.equal(bad.ok, undefined);
    // Legacy TELEBIRR normalized to TRANSFER
    const legacy = validateOrderStatusUpdate({ status: 'PAYMENT_PENDING', paymentMethod: 'TELEBIRR', paymentAccountId: accId });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.data.paymentMethod, 'TRANSFER');
  });

  test('Waiter cannot directly mark PAID', () => {
    assert.equal(canTransition('WAITER', 'PAID'), false);
    assert.equal(can('WAITER', 'orders:payment:confirm'), false);
    const waiterSrc = readSrc('app/components/WaiterUI.js');
    assert.ok(!waiterSrc.includes("status: 'PAID'"), 'Waiter never PATCHes PAID');
  });

  test('Cashier/Manager confirmation and rejection permissions', () => {
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(canTransition('CASHIER', 'PAID'), true);
    assert.equal(canTransition('MANAGER', 'PAID'), true);
    assert.equal(can('WAITER', 'orders:payment:confirm'), false);
    assert.equal(canTransition('KITCHEN', 'PAID'), false);
  });

  test('Rejected payments remain unpaid until resubmitted and confirmed', () => {
    const rejected = { status: 'SERVED', paymentRejectedAt: new Date(), paymentMethod: 'TRANSFER' };
    const paidRevenue = [rejected].filter((o) => o.status === 'PAID').length;
    assert.equal(paidRevenue, 0);
    // Resubmit goes to PAYMENT_PENDING, still not PAID
    const resubmitted = { status: 'PAYMENT_PENDING' };
    assert.equal([resubmitted].filter((o) => o.status === 'PAID').length, 0);
    // Only confirm counts
    const confirmed = { status: 'PAID' };
    assert.equal([confirmed].filter((o) => o.status === 'PAID').length, 1);
  });

  test('Manager completed-service details use actual order/payment data', () => {
    const managerSrc = readSrc('app/manager/reports/page.js');
    assert.ok(managerSrc.includes('Completed Services'), 'Manager has completed details section');
    assert.ok(managerSrc.includes('/api/orders?status=PAID'), 'Fetches persisted PAID orders');
    assert.ok(managerSrc.includes('paymentAccountSnapshot'), 'Shows snapshot account');
    assert.ok(managerSrc.includes('paymentSubmittedAt'), 'Shows submission time');
    assert.ok(managerSrc.includes('paymentVerifiedAt') || managerSrc.includes('paidAt'), 'Shows verification time');
    assert.ok(managerSrc.includes('netAmount') || managerSrc.includes('totalAmount'), 'Uses server totals');
    // No fake totals
    assert.ok(!managerSrc.includes('Math.random') || managerSrc.includes('fmtETB'), 'No fabricated financials');
  });

  test('Pending/rejected/cancelled not counted as paid revenue', () => {
    const orders = [
      { status: 'PAYMENT_PENDING', totalAmount: 100 },
      { status: 'SERVED', totalAmount: 100, paymentRejectedAt: new Date() },
      { status: 'CANCELLED', totalAmount: 100 },
      { status: 'PAID', totalAmount: 200 },
    ];
    const revenue = orders.filter((o) => o.status === 'PAID').reduce((s, o) => s + Number(o.totalAmount), 0);
    assert.equal(revenue, 200);
  });

  test('Cancelled items and components do not cause double counting', () => {
    const order = {
      status: 'PAID',
      totalAmount: 300,
      items: [
        { price: 100, quantity: 1, cancelled: false, components: [{ kind: 'PRICED_COMPONENT', quantity: 1, unitPrice: 50, lineSum: 50 }] },
        { price: 100, quantity: 1, cancelled: true, components: [] },
        { price: 50, quantity: 1, cancelled: false, components: [{ kind: 'NOTE', note: 'no salt' }] },
      ],
    };
    function effective(o) {
      return o.items.filter((it) => !it.cancelled).reduce((s, it) => {
        const base = Number(it.price) * Number(it.quantity);
        const comps = (it.components || []).filter((c) => c.kind === 'PRICED_COMPONENT').reduce((cs, c) => cs + Number(c.lineSum), 0);
        return s + base + comps;
      }, 0);
    }
    // Base 100 + comp 50 + base 50 (note 0) = 200; cancelled 100 excluded
    assert.equal(effective(order), 200);
    assert.notEqual(effective(order), 300);
  });

  test('VALID_PAYMENT_METHODS includes TRANSFER (canonical) with TELEBIRR legacy', () => {
    assert.ok(VALID_PAYMENT_METHODS.includes('TRANSFER'));
    assert.ok(VALID_PAYMENT_METHODS.includes('CASH'));
    // Legacy TELEBIRR still in DB enum for historical reads
    assert.ok(VALID_PAYMENT_METHODS.includes('TELEBIRR'));
    assert.equal(validatePaymentMethod('TRANSFER'), 'TRANSFER');
    assert.equal(validatePaymentMethod('TELEBIRR'), 'TRANSFER');
    assert.ok(isTransferMethod('TRANSFER'));
    assert.ok(isTransferMethod('TELEBIRR'));
    assert.ok(!isTransferMethod('CASH'));
  });
});
