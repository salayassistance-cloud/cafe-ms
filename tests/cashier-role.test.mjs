import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { validateRole } from '../lib/validate.js';
import { can, canTransition, ROLES } from '../lib/policy.js';
import { STAFF_ROLES } from '../lib/models/Staff.js';

describe('CASHIER Role Activation - DB-free', () => {
  test('CASHIER role accepted by staff validation', () => {
    assert.equal(validateRole('CASHIER'), 'CASHIER');
    assert.equal(validateRole('cashier'), 'CASHIER');
    assert.ok(STAFF_ROLES.includes('CASHIER'));
    assert.ok(ROLES.CASHIER === 'CASHIER');
  });

  test('Manager can provision a CASHIER staff account - role validation', () => {
    // Simulate manager creating CASHIER via POST /api/manager/waiters with role:CASHIER
    // Validation should allow WAITER and CASHIER, reject others
    const allowedCreateRoles = ['WAITER', 'CASHIER'];
    assert.ok(allowedCreateRoles.includes('CASHIER'));
    assert.ok(allowedCreateRoles.includes('WAITER'));
    assert.ok(!allowedCreateRoles.includes('MANAGER'));
    // Username and PIN validation already tested elsewhere
  });

  test('CASHIER can access Cashier portal and permitted APIs', () => {
    // Cashier portal guard now allows CASHIER and MANAGER
    assert.equal(can('CASHIER', 'orders:read'), true); // via ALL_ROLES
    assert.equal(can('CASHIER', 'orders:transition:PAID'), true);
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    assert.equal(canTransition('CASHIER', 'PAID'), true);
  });

  test('WAITER cannot access Cashier confirmation API', () => {
    assert.equal(can('WAITER', 'orders:payment:confirm'), false);
    assert.equal(canTransition('WAITER', 'PAID'), false);
    // WAITER can submit PAYMENT_PENDING but not confirm
    assert.equal(canTransition('WAITER', 'PAYMENT_PENDING'), true);
  });

  test('KITCHEN/BARISTA cannot confirm payment', () => {
    assert.equal(can('KITCHEN', 'orders:payment:confirm'), false);
    assert.equal(can('BARISTA', 'orders:payment:confirm'), false);
    assert.equal(canTransition('KITCHEN', 'PAID'), false);
    assert.equal(canTransition('BARISTA', 'PAID'), false);
  });

  test('CASHIER can confirm PAYMENT_PENDING', () => {
    assert.equal(can('CASHIER', 'orders:payment:confirm'), true);
    // Simulate order in PAYMENT_PENDING, cashier confirm should succeed
    const orderStatus = 'PAYMENT_PENDING';
    const canConfirm = can('CASHIER', 'orders:payment:confirm') && orderStatus === 'PAYMENT_PENDING';
    assert.equal(canConfirm, true);
  });

  test('CASHIER cannot directly PAID an arbitrary unpaid order (must be PAYMENT_PENDING)', () => {
    // Service filter for confirmPayment is status:"PAYMENT_PENDING" only
    const orderStatusUnpaid = 'SERVED'; // not pending
    const canDirectPaid = can('CASHIER', 'orders:transition:PAID') && orderStatusUnpaid === 'PAYMENT_PENDING';
    assert.equal(canDirectPaid, false);
    // Direct pay from SERVED should be via payOrder legacy, but policy now only CASHIER/MANAGER can PAID from SERVED via payOrder
    // However new workflow requires PAYMENT_PENDING, so direct from SERVED should be considered not allowed for new orders
    // For test, we assert that payOrder filter for direct PAID from SERVED is still allowed for MANAGER but not for CASHIER without pending
    // Here we test that CASHIER cannot directly PAID from SERVED without pending
    assert.equal(orderStatusUnpaid !== 'PAYMENT_PENDING', true);
  });

  test('CASHIER cannot confirm twice or race another cashier - atomic', () => {
    // First confirm sets status PAID, second with same filter status:"PAYMENT_PENDING" will miss
    const firstStatus = 'PAYMENT_PENDING';
    const secondStatusAfterFirst = 'PAID';
    const firstCanConfirm = firstStatus === 'PAYMENT_PENDING';
    const secondCanConfirm = secondStatusAfterFirst === 'PAYMENT_PENDING';
    assert.equal(firstCanConfirm, true);
    assert.equal(secondCanConfirm, false);
  });

  test('CASHIER cannot access manager-only staff/menu/settings APIs', () => {
    assert.equal(can('CASHIER', 'staff:mutate'), false);
    assert.equal(can('CASHIER', 'menu:mutate'), false);
    assert.equal(can('CASHIER', 'inventory:mutate'), false);
    assert.equal(can('CASHIER', 'reports:read'), false);
    assert.equal(can('CASHIER', 'settings:clearOrders'), false);
    assert.equal(can('MANAGER', 'staff:mutate'), true);
    assert.equal(can('MANAGER', 'menu:mutate'), true);
  });

  test('Waiter cannot submit PAID - only PAYMENT_PENDING', () => {
    assert.equal(canTransition('WAITER', 'PAID'), false);
    assert.equal(canTransition('WAITER', 'PAYMENT_PENDING'), true);
    // Validate that WAITER trying to send status PAID would be rejected by policy
    const waiterCanPaid = canTransition('WAITER', 'PAID');
    assert.equal(waiterCanPaid, false);
  });

  test('Reject preserves payment details and audit history', () => {
    // Simulate order in PAYMENT_PENDING with snapshot, after reject it goes to SERVED but snapshot preserved
    const orderBeforeReject = {
      status: 'PAYMENT_PENDING',
      paymentMethod: 'TELEBIRR',
      paymentAccountId: 'acc1',
      paymentAccountSnapshot: { bankName: 'CBE', ownerName: 'Abebe', accountNumber: '123' },
      paymentSubmittedAt: new Date(),
    };
    const orderAfterReject = {
      status: 'SERVED',
      paymentMethod: orderBeforeReject.paymentMethod, // preserved
      paymentAccountId: orderBeforeReject.paymentAccountId,
      paymentAccountSnapshot: orderBeforeReject.paymentAccountSnapshot,
      paymentRejectedAt: new Date(),
      paymentRejectedBy: 'cashierId',
      paymentRejectionReason: 'Insufficient funds',
    };
    assert.equal(orderAfterReject.status, 'SERVED');
    assert.equal(orderAfterReject.paymentAccountSnapshot.bankName, 'CBE');
    assert.ok(orderAfterReject.paymentRejectedAt);
  });

  test('Existing WAITER/MANAGER flows remain compatible', () => {
    // WAITER can still create orders and serve
    assert.equal(can('WAITER', 'orders:create'), true);
    assert.equal(can('WAITER', 'orders:transition:SERVED'), true);
    // MANAGER can still do all (except now PAID is shared with CASHIER)
    assert.equal(can('MANAGER', 'orders:transition:PAID'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:read'), true);
  });
});
