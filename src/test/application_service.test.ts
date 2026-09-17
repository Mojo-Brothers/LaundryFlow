import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applicationService,
  LaundryApplicationService,
  ApplicationError,
} from '../core/application/laundryApplicationService';
import { repository, RepositoryError } from '../core/services/repository';

describe('LaundryApplicationService — Master Use-Case Orchestration', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const OUTLET_BKS = '22222222-2222-2222-2222-222222222221';
  const CENTRAL_PROD = '22222222-2222-2222-2222-222222222223';
  const DRIVER_ID = '33333333-3333-3333-3333-333333333333';
  const CASHIER_ID = '33333333-3333-3333-3333-333333333332';

  beforeEach(() => {
    repository.resetSandbox();
  });

  // ==========================================================================
  // Transit Use Cases
  // ==========================================================================
  describe('Transit Use Cases', () => {
    it('1. successfully creates manifest with valid normalized input', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      expect(eligible.length).toBeGreaterThan(0);
      const testOrderId = eligible[0].id;

      const manifest = await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: `  ${OUTLET_BKS}  `,
        destinationBranchId: `  ${CENTRAL_PROD}  `,
        driverUserId: `  ${DRIVER_ID}  `,
        vehicleIdentifier: '  B 1234 KRO  ',
        notes: '  Batch pagi hari  ',
        orderIds: [testOrderId],
      });

      expect(manifest.id).toBeDefined();
      expect(manifest.source_branch_id).toBe(OUTLET_BKS);
      expect(manifest.destination_branch_id).toBe(CENTRAL_PROD);
      expect(manifest.vehicle_identifier).toBe('B 1234 KRO');
      expect(manifest.notes).toBe('Batch pagi hari');
      expect(manifest.status).toBe('DRAFT');
      expect(manifest.total_expected_orders).toBe(1);
    });

    it('2. rejects empty order list with ApplicationError(VALIDATION_ERROR)', async () => {
      await expect(
        applicationService.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [],
        })
      ).rejects.toThrowError(ApplicationError);

      try {
        await applicationService.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: ['   '],
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApplicationError);
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.message).toContain('minimal 1 ID order');
      }
    });

    it('3. rejects duplicate order IDs with ApplicationError(VALIDATION_ERROR)', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      try {
        await applicationService.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [testOrderId, testOrderId], // Duplicate!
        });
        expect.unreachable('Should have failed on duplicate order IDs');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApplicationError);
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.message).toContain('duplikasi ID order');
      }
    });

    it('4. rejects self-routing (sourceBranchId === destinationBranchId)', async () => {
      try {
        await applicationService.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: OUTLET_BKS, // Self-routing
          orderIds: ['order-xyz'],
        });
        expect.unreachable('Should have failed on self-routing');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApplicationError);
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.message).toContain('tidak boleh sama');
      }
    });

    it('5. translates repository conflicts (already assigned orders) into ApplicationError(CONFLICT)', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      // 1. Create active manifest with order
      await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      // 2. Attempt to create another manifest with same order
      try {
        await applicationService.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [testOrderId],
        });
        expect.unreachable('Should have failed with CONFLICT');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApplicationError);
        expect(err.code).toBe('CONFLICT');
        expect(err.message).toContain('manifest aktif');
      }
    });

    it('6. transitions manifest through repository with normalized input and logs history', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      const manifest = await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      const updated = await applicationService.transitionTransitManifest({
        manifestId: `  ${manifest.id}  `,
        targetStatus: 'READY_TO_DISPATCH',
        notes: '  Siap diberangkatkan driver  ',
      });

      expect(updated.status).toBe('READY_TO_DISPATCH');

      const history = await applicationService.getTransitManifestHistory(manifest.id);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].to_status).toBe('READY_TO_DISPATCH');
    });

    it('7. rejects transition to RECEIVED directing caller to receive use case', async () => {
      const manifests = await applicationService.listTransitManifests({ status: 'IN_TRANSIT' });
      expect(manifests.length).toBeGreaterThan(0);

      try {
        await applicationService.transitionTransitManifest({
          manifestId: manifests[0].id,
          targetStatus: 'RECEIVED',
        });
        expect.unreachable('Should have rejected direct transition to RECEIVED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApplicationError);
        expect(err.code).toBe('INVALID_STATE');
        expect(err.message).toContain('receiveTransitManifest');
      }
    });

    it('8. receive payload is normalized and delegated to repository with discrepancy tracking', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      expect(eligible.length).toBeGreaterThanOrEqual(2);
      const orderA = eligible[0].id;
      const orderB = eligible[1].id;

      const manifest = await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [orderA, orderB],
      });

      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'IN_TRANSIT',
      });

      // Operator only reviews Order A; Order B omitted (becomes MISSING)
      const received = await applicationService.receiveTransitManifest({
        manifestId: manifest.id,
        itemsReview: [
          {
            orderId: `  ${orderA}  `,
            status: 'RECEIVED_OK',
            notes: '  Kondisi bersih  ',
          },
        ],
        summaryNotes: '  Penerimaan sebagian  ',
      });

      expect(received.status).toBe('RECEIVED');
      expect(received.has_discrepancy).toBe(true);
      expect(received.total_received_orders).toBe(1);
    });

    it('9. getEligibleTransitOrders validates sourceBranchId requirement', async () => {
      await expect(applicationService.getEligibleTransitOrders('')).rejects.toThrowError(
        ApplicationError
      );
    });

    it('10. getTransitManifest retrieves full manifest with items and branch hydration', async () => {
      const manifests = await applicationService.listTransitManifests();
      const first = manifests[0];

      const detailed = await applicationService.getTransitManifest(first.id);
      expect(detailed).not.toBeNull();
      expect(detailed!.id).toBe(first.id);
      expect(detailed!.source_branch).toBeDefined();
      expect(Array.isArray(detailed!.items)).toBe(true);
    });
  });

  // ==========================================================================
  // Shift & Reconciliation Use Cases
  // ==========================================================================
  describe('Shift & Reconciliation Use Cases', () => {
    it('11. openShift normalizes inputs and delegates to repository', async () => {
      const shift = await applicationService.openShift({
        organizationId: `  ${ORG_ID}  `,
        branchId: `  ${OUTLET_BKS}  `,
        cashierId: `  ${CASHIER_ID}  `,
        openingCash: 250000,
        notes: '  Shift pagi awal minggu  ',
      });

      expect(shift.id).toBeDefined();
      expect(shift.status).toBe('OPEN');
      expect(shift.opening_cash).toBe(250000);
    });

    it('12. closeShift validates non-negative finite actualCash number', async () => {
      await expect(
        applicationService.closeShift({
          shiftId: 'shift-123',
          actualCash: -5000,
        })
      ).rejects.toThrowError(ApplicationError);

      await expect(
        applicationService.closeShift({
          shiftId: 'shift-123',
          actualCash: NaN,
        })
      ).rejects.toThrowError(ApplicationError);
    });

    it('13. closeShift translates repository FINANCIAL_ERROR when variance note missing', async () => {
      const shift = await applicationService.openShift({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        cashierId: CASHIER_ID,
        openingCash: 100000,
      });

      // Actual cash is 90000 (selisih -10000), no varianceNote provided
      try {
        await applicationService.closeShift({
          shiftId: shift.id,
          actualCash: 90000,
        });
        expect.unreachable('Should have failed with FINANCIAL_ERROR');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApplicationError);
        expect(err.code).toBe('FINANCIAL_ERROR');
        expect(err.message).toContain('variance_note');
      }
    });

    it('14. closeShift successfully reconciles balanced shift', async () => {
      const shift = await applicationService.openShift({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        cashierId: CASHIER_ID,
        openingCash: 100000,
      });

      const closed = await applicationService.closeShift({
        shiftId: shift.id,
        actualCash: 100000,
      });

      expect(closed.status).toBe('CLOSED');
      expect(closed.actual_cash).toBe(100000);
      expect(closed.difference).toBe(0);
    });

    it('15. getShiftSummary remains a read-only preview without modifying shift status', async () => {
      const shift = await applicationService.openShift({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        cashierId: CASHIER_ID,
        openingCash: 150000,
      });

      const summary = await applicationService.getShiftSummary(shift.id);
      expect(summary.openingCash).toBe(150000);
      expect(summary.expectedCash).toBe(150000);
      expect(summary.isBalanced).toBe(true);

      // Verify shift is still OPEN (getShiftSummary must NOT mutate or close the shift)
      const active = await applicationService.getActiveShift(OUTLET_BKS);
      expect(active?.status).toBe('OPEN');
    });
  });

  // ==========================================================================
  // Public Tracking Use Case (Security-Sensitive)
  // ==========================================================================
  describe('Public Tracking Use Case', () => {
    it('16. getPublicOrderTracking delegates strictly to sanitized tracking repository method', async () => {
      const orders = await repository.getOrders(OUTLET_BKS);
      expect(orders.length).toBeGreaterThan(0);
      const trackingToken = orders[0].tracking_token;

      const trackingData = await applicationService.getPublicOrderTracking(trackingToken);
      expect(trackingData).not.toBeNull();
      expect(trackingData!.order_number).toBe(orders[0].order_number);
      expect(trackingData!.branch_name).toBeDefined();

      // Ensure NO PII or staff internal identifiers are exposed
      expect((trackingData as any).customer_phone).toBeUndefined();
      expect((trackingData as any).customer_id).toBeUndefined();
      expect((trackingData as any).created_by).toBeUndefined();
    });

    it('17. getPublicOrderTracking returns null for empty or invalid token without throwing', async () => {
      const resEmpty = await applicationService.getPublicOrderTracking('');
      expect(resEmpty).toBeNull();

      const resShort = await applicationService.getPublicOrderTracking('abc');
      expect(resShort).toBeNull();
    });
  });

  // ==========================================================================
  // Customer & Fast Checkout Regression Use Cases
  // ==========================================================================
  describe('Customer & POS / Fast Checkout Use Cases', () => {
    it('18. searchCustomers and createCustomer normalize inputs and validate required fields', async () => {
      const newCust = await applicationService.createCustomer({
        organizationId: ORG_ID,
        name: '  Bapak Joko Widodo  ',
        phone: '  0812-3456-7890  ',
      });

      expect(newCust.id).toBeDefined();
      expect(newCust.name).toBe('Bapak Joko Widodo');
      expect(newCust.phone).toBe('081234567890');

      const searchResults = await applicationService.searchCustomers('Joko');
      expect(searchResults.some((c) => c.id === newCust.id)).toBe(true);
    });

    it('19. calculateOrderPricing delegates to pure pricing engine and enforces minimum charge', () => {
      const pricing = applicationService.calculateOrderPricing({
        service: {
          base_price: 10000,
          min_charge_unit: 3.0,
          rounding_rule: 'ROUND_HALF_UP_0_5',
          unit: 'KG',
        },
        actualQuantityOrWeight: 1.2, // Under 3.0 kg min charge
      });

      expect(pricing.actualQuantityOrWeight).toBe(1.2);
      expect(pricing.billableQuantityOrWeight).toBe(3.0); // Enforced min charge
      expect(pricing.finalAmount).toBe(30000);
    });

    it('20. createOrder orchestrates order placement and payment capture end-to-end', async () => {
      const customers = await applicationService.searchCustomers();
      const services = await repository.getServices();

      const order = await applicationService.createOrder({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        customerId: customers[0].id,
        subtotal: 25000,
        items: [
          {
            serviceId: services[0].id,
            itemType: 'KILOAN',
            serviceNameSnap: services[0].name,
            unitPriceSnap: 25000,
            quantityOrWeight: 2.5,
            billableWeight: 2.5,
            subtotal: 25000,
          },
        ],
        payment: {
          method: 'CASH',
          amount: 25000,
        },
        createdBy: CASHIER_ID,
      });

      expect(order.id).toBeDefined();
      expect(order.final_amount).toBe(25000);
      expect(order.paid_amount).toBe(25000);
      expect(order.payment_status).toBe('PAID');
    });

    it('21. LaundryApplicationService accepts mock repository port and translates unexpected errors', async () => {
      const mockRepo: any = {
        getTransitManifest: vi.fn().mockRejectedValue(new Error('Koneksi timeout')),
      };

      const customService = new LaundryApplicationService(mockRepo);

      try {
        await customService.getTransitManifest('man-123');
        expect.unreachable('Should have caught error');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApplicationError);
        expect(err.code).toBe('DATABASE_ERROR');
        expect(err.message).toBe('Koneksi timeout');
      }
    });
  });
});
