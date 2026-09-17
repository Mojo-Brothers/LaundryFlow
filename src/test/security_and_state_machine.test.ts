import { describe, it, expect, beforeEach } from 'vitest';
import { repository } from '../core/services/repository';
import { isValidOrderTransition } from '../core/services/stateMachine';
import { hasPermission } from '../core/types/roles';

describe('Security, RBAC & State Machine Hardening Tests', () => {
  beforeEach(() => {
    repository.resetSandbox();
  });

  // ==========================================================================
  // 1. RBAC & PERMISSION GUARD TESTS
  // ==========================================================================
  describe('RBAC Permissions Verification', () => {
    it('grants CASHIER standard POS permissions but denies admin actions', () => {
      expect(hasPermission('CASHIER', 'orders.create')).toBe(true);
      expect(hasPermission('CASHIER', 'orders.view')).toBe(true);
      expect(hasPermission('CASHIER', 'payments.create')).toBe(true);
      expect(hasPermission('CASHIER', 'shifts.manage')).toBe(true);

      // Denied actions
      expect(hasPermission('CASHIER', 'services.manage')).toBe(false);
      expect(hasPermission('CASHIER', 'payments.refund')).toBe(false);
      expect(hasPermission('CASHIER', 'orders.discount_override')).toBe(false);
      expect(hasPermission('CASHIER', 'users.manage')).toBe(false);
      expect(hasPermission('CASHIER', 'audit.view')).toBe(false);
    });

    it('grants OPERATOR production update but denies order creation and financial access', () => {
      expect(hasPermission('OPERATOR', 'orders.view')).toBe(true);
      expect(hasPermission('OPERATOR', 'orders.update_status')).toBe(true);

      // Denied actions
      expect(hasPermission('OPERATOR', 'orders.create')).toBe(false);
      expect(hasPermission('OPERATOR', 'payments.create')).toBe(false);
      expect(hasPermission('OPERATOR', 'shifts.manage')).toBe(false);
      expect(hasPermission('OPERATOR', 'reports.view')).toBe(false);
    });

    it('grants OWNER all granular permissions', () => {
      expect(hasPermission('OWNER', 'orders.create')).toBe(true);
      expect(hasPermission('OWNER', 'payments.refund')).toBe(true);
      expect(hasPermission('OWNER', 'services.manage')).toBe(true);
      expect(hasPermission('OWNER', 'users.manage')).toBe(true);
      expect(hasPermission('OWNER', 'audit.view')).toBe(true);
    });
  });

  // ==========================================================================
  // 2. ORDER STATE MACHINE TESTS
  // ==========================================================================
  describe('Order State Machine Transition Boundaries', () => {
    it('allows legal sequential transitions in SIMPLE mode', () => {
      expect(isValidOrderTransition('RECEIVED', 'WASHING', 'SIMPLE').isValid).toBe(true);
      expect(isValidOrderTransition('WASHING', 'READY', 'SIMPLE').isValid).toBe(true);
      expect(isValidOrderTransition('READY', 'COMPLETED', 'SIMPLE').isValid).toBe(true);
      expect(isValidOrderTransition('RECEIVED', 'CANCELLED', 'SIMPLE').isValid).toBe(true);
    });

    it('strictly rejects illegal backward transitions', () => {
      const completedBackToWashing = isValidOrderTransition('COMPLETED', 'WASHING', 'SIMPLE');
      expect(completedBackToWashing.isValid).toBe(false);
      expect(completedBackToWashing.reason).toContain('tidak dapat diubah lagi');

      const readyBackToReceived = isValidOrderTransition('READY', 'RECEIVED', 'SIMPLE');
      expect(readyBackToReceived.isValid).toBe(false);
      expect(readyBackToReceived.reason).toContain('Transisi ilegal');

      const cancelledToReady = isValidOrderTransition('CANCELLED', 'READY', 'SIMPLE');
      expect(cancelledToReady.isValid).toBe(false);
    });

    it('rejects identity transition (currentStatus == nextStatus)', () => {
      const identity = isValidOrderTransition('WASHING', 'WASHING', 'SIMPLE');
      expect(identity.isValid).toBe(false);
      expect(identity.reason).toContain('sama dengan status saat ini');
    });

    it('enforces transition check and records history inside repository.updateOrderStatus', async () => {
      // Create a SIMPLE mode order
      const branches = await repository.getBranches();
      const simpleOrder = await repository.createOrder(
        {
          organization_id: branches[0].organization_id,
          branch_id: branches[0].id,
          production_branch_id: branches[0].id,
          customer_id: 'cust-1',
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal: 24000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 24000,
          paid_amount: 24000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: 'user-cashier-1',
        },
        []
      );

      // Legal update: RECEIVED -> WASHING
      const washing = await repository.updateOrderStatus(simpleOrder.id, 'WASHING', 'user-cashier-1');
      expect(washing.status).toBe('WASHING');

      // Legal update in SIMPLE mode: WASHING -> READY
      const ready = await repository.updateOrderStatus(simpleOrder.id, 'READY', 'user-cashier-1', 'Selesai dijemur');
      expect(ready.status).toBe('READY');

      // Verify status history was recorded
      const history = await repository.getOrderStatusHistory(simpleOrder.id);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].to_status).toBe('READY');

      // Illegal update: try reverting READY -> RECEIVED -> MUST THROW
      await expect(
        repository.updateOrderStatus(simpleOrder.id, 'RECEIVED', 'user-cashier-1')
      ).rejects.toThrow(/Transisi ilegal/);
    });
  });

  // ==========================================================================
  // 3. PUBLIC TRACKING ZERO-PII TEST
  // ==========================================================================
  describe('Public Tracking Security (Zero PII Exposure)', () => {
    it('returns sanitized order data without exposing customer phone, address, or internal notes', async () => {
      const token = 'trk_live_bks01_budi9988';
      const trackingData = await repository.getOrderByTrackingToken(token);

      expect(trackingData).toBeDefined();
      expect(trackingData.order_number).toBe('BKS-2609-0001');
      expect(trackingData.status).toBe('WASHING');
      expect(trackingData.final_amount).toBe(36000);
      expect(trackingData.branch_name).toBeDefined();

      // ZERO PII Verification
      expect(trackingData.customer).toBeUndefined();
      expect(trackingData.customer_id).toBeUndefined();
      expect(trackingData.customer_phone).toBeUndefined();
      expect(trackingData.customer_address).toBeUndefined();
      expect(trackingData.internal_notes).toBeUndefined();
      expect(trackingData.audit_logs).toBeUndefined();
    });

    it('returns null for nonexistent or tampered tracking tokens', async () => {
      const fakeToken = 'trk_invalid_token_9999';
      const result = await repository.getOrderByTrackingToken(fakeToken);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // 4. CASHIER SHIFT IMMUTABILITY TEST
  // ==========================================================================
  describe('Cashier Shift Immutability', () => {
    it('prevents modifying a closed shift', async () => {
      const branches = await repository.getBranches();
      const branchId = branches[0].id;

      // 1. Open shift
      const shift = await repository.openShift({
        organization_id: branches[0].organization_id,
        branch_id: branchId,
        cashier_id: 'cashier-1',
        opening_cash: 100000,
        expected_cash: 100000,
        status: 'OPEN',
      });

      // 2. Close shift
      const closedShift = await repository.closeShift(shift.id, 100000, 'Shift closed peacefully');
      expect(closedShift.status).toBe('CLOSED');

      // 3. Try to close or modify it again -> MUST THROW
      await expect(
        repository.closeShift(shift.id, 150000, 'Tampering attempt')
      ).rejects.toThrow(/CLOSED/);
    });
  });
});
