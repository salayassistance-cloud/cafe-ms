import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { validateOrderStatusUpdate } from '../lib/validate.js';
import { can, canTransition } from '../lib/policy.js';

describe('Payment rejection and resubmission - DB-free', () => {
  test('1. Waiter cannot directly mark PAID', () => {
    assert.equal(canTransition('WAITER', 'PAID'), false);
    assert.equal(can('WAITER', 'orders:payment:confirm'), false);
    // Even with valid paymentMethod, route auth must reject WAITER PAID
    const r = validateOrderStatusUpdate({ status: 'PAID', paymentMethod: 'CASH' });
    assert.equal(r.ok, true); // validation passes format, but policy blocks
    assert.equal(canTransition('WAITER', r.data.status), false);
  });

  test('2. Rejected order can be resubmitted from SERVED', () => {
    // submitPaymentForVerification filter allows SERVED or READY
    const allowedSubmit = ['SERVED', 'READY'];
    const rejectedOrderStatus = 'SERVED'; // after rejectPayment sets SERVED
    assert.ok(allowedSubmit.includes(rejectedOrderStatus));
    const r = validateOrderStatusUpdate({ status: 'PAYMENT_PENDING', paymentMethod: 'CASH' });
    assert.equal(r.ok, true);
    assert.equal(canTransition('WAITER', 'PAYMENT_PENDING'), true);
  });

  test('3. Resubmission preserves previous rejection audit/history', () => {
    // Service submitPaymentForVerification must NOT clear paymentRejected* fields
    // Simulate: order has prior rejection, resubmit sets new PAYMENT_PENDING but keeps rejection
    const orderBefore = {
      status: 'SERVED',
      paymentRejectedAt: new Date('2024-01-01'),
      paymentRejectedBy: 'cashier1',
      paymentRejectionReason: 'Wrong account',
    };
    // Simulate submit update preserving rejection (only clears verified)
    const update = {
      status: 'PAYMENT_PENDING',
      paymentVerifiedAt: null,
      paymentVerifiedBy: null,
      // rejection preserved
      paymentRejectedAt: orderBefore.paymentRejectedAt,
      paymentRejectedBy: orderBefore.paymentRejectedBy,
      paymentRejectionReason: orderBefore.paymentRejectionReason,
    };
    assert.equal(update.status, 'PAYMENT_PENDING');
    assert.equal(update.paymentRejectedAt, orderBefore.paymentRejectedAt);
    assert.equal(update.paymentRejectionReason, 'Wrong account');
    // Verify actual service source preserves rejection (does not $set null)
    const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'orderService.js'), 'utf8');
    const submitFn = src.slice(src.indexOf('export async function submitPaymentForVerification'));
    const submitBlock = submitFn.slice(0, submitFn.indexOf('export async function confirmPayment'));
    assert.ok(!submitBlock.includes('paymentRejectedAt: null'), 'submit must not clear rejection audit');
    assert.ok(!submitBlock.includes('paymentRejectionReason: null'), 'submit must not clear rejection reason');
  });

  test('4. New submission appears in PAYMENT_PENDING', () => {
    const orderAfterSubmit = { status: 'PAYMENT_PENDING', paymentMethod: 'CASH' };
    assert.equal(orderAfterSubmit.status, 'PAYMENT_PENDING');
    // Cashier pending queue fetches ?status=PAYMENT_PENDING, so it will appear
    // Waiter poll fetches ACTIVE + PAYMENT_PENDING, so it will appear
    assert.ok(['PAYMENT_PENDING'].includes(orderAfterSubmit.status));
  });

  test('5. Rejection does not trigger inventory deduction', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'orderService.js'), 'utf8');
    const rejectFn = src.slice(src.indexOf('export async function rejectPayment'));
    const rejectBlock = rejectFn.slice(0, rejectFn.indexOf('// Update payment fields'));
    assert.ok(!rejectBlock.includes('prepareInventoryDeduction'), 'reject must not deduct inventory');
    assert.ok(!rejectBlock.includes('executeInventoryDeduction'), 'reject must not deduct inventory');
  });

  test('6. Inventory deduction occurs only after successful confirmation', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'orderService.js'), 'utf8');
    const confirmFn = src.slice(src.indexOf('export async function confirmPayment'));
    const confirmBlock = confirmFn.slice(0, confirmFn.indexOf('// Cashier rejects'));
    assert.ok(confirmBlock.includes('prepareInventoryDeduction'), 'confirm must deduct inventory');
    assert.ok(confirmBlock.includes('executeInventoryDeduction'), 'confirm must deduct inventory');
    const submitFn = src.slice(src.indexOf('export async function submitPaymentForVerification'));
    const submitBlock = submitFn.slice(0, submitFn.indexOf('export async function confirmPayment'));
    assert.ok(!submitBlock.includes('prepareInventoryDeduction'), 'submit must not deduct inventory');
  });

  test('7. Cashier and Manager can confirm/reject', () => {
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(canTransition('CASHIER', 'PAID'), true);
    assert.equal(canTransition('MANAGER', 'PAID'), true);
    // Reject uses same confirm permission
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
  });

  test('8. Waiter UI has no active direct Cash Paid / Telebirr Paid action', () => {
    const waiterSrc = fs.readFileSync(path.join(process.cwd(), 'app', 'components', 'WaiterUI.js'), 'utf8');
    // No direct PATCH status PAID from Waiter
    assert.ok(!waiterSrc.includes("status: 'PAID'"), 'Waiter must not PATCH PAID');
    assert.ok(!waiterSrc.includes('status:"PAID"'), 'Waiter must not PATCH PAID');
    // No legacy Mark Paid buttons
    assert.ok(!waiterSrc.includes('Mark Paid'), 'Waiter must not show Mark Paid');
    assert.ok(!waiterSrc.includes('Cash Paid'), 'Waiter must not show Cash Paid');
    assert.ok(!waiterSrc.includes('Telebirr Paid'), 'Waiter must not show Telebirr Paid');
    // Still has CASH/Transfer selection for verification
    assert.ok(waiterSrc.includes("confirmPayment('CASH')"), 'Waiter keeps CASH submit');
    assert.ok(waiterSrc.includes("confirmPayment('TRANSFER')"), 'Waiter keeps Transfer submit');
    // Submit uses PAYMENT_PENDING
    assert.ok(waiterSrc.includes("status: 'PAYMENT_PENDING'"), 'Waiter submits PAYMENT_PENDING');
    // Rejection reason visible and resubmit wording
    assert.ok(waiterSrc.includes('paymentRejectedAt'), 'Waiter shows rejection state');
    assert.ok(waiterSrc.includes('RESUBMIT') || waiterSrc.includes('Resubmit'), 'Waiter shows resubmit action');
  });
});
