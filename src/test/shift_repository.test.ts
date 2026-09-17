import { describe, it, expect, beforeEach } from 'vitest';
import { repository, RepositoryError } from '../core/services/repository';

describe('Cashier Shift Repository — Sandbox & Reconciliation Operations', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const OUTLET_BKS = '22222222-2222-2222-2222-222222222221';
  const CASHIER_ID = '33333333-3333-3333-3333-333333333332';

  beforeEach(() => {
    repository.resetSandbox();
  });

  describe('1. Open Shift', () => {
    it('opens a new shift with opening cash', async () => {
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 200000,
        expected_cash: 200000,
        status: 'OPEN',
      });

      expect(shift.id).toBeDefined();
      expect(shift.status).toBe('OPEN');
      expect(shift.opening_cash).toBe(200000);
      expect(shift.opened_at).toBeDefined();
    });
  });

  describe('2. Close Shift — Balanced, Over, and Short', () => {
    it('closes shift in BALANCED state when actual cash equals expected cash', async () => {
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 100000,
        expected_cash: 100000,
        cash_in: 0,
        cash_out: 0,
        refund_amount: 0,
        status: 'OPEN',
      });

      // No sales transactions: expected cash is 100000
      const closed = await repository.closeShift(shift.id, 100000);

      expect(closed.status).toBe('CLOSED');
      expect(closed.actual_cash).toBe(100000);
      expect(closed.expected_cash).toBe(100000);
      expect(closed.difference).toBe(0);
      expect(closed.closed_at).toBeDefined();
    });

    it('closes shift in OVER state when actual cash > expected cash with valid variance note', async () => {
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 100000,
        expected_cash: 100000,
        status: 'OPEN',
      });

      const closed = await repository.closeShift(
        shift.id,
        110000,
        'Pelanggan tidak mengambil uang kembalian Rp 10.000'
      );

      expect(closed.status).toBe('CLOSED');
      expect(closed.actual_cash).toBe(110000);
      expect(closed.difference).toBe(10000);
      expect(closed.variance_note).toBe('Pelanggan tidak mengambil uang kembalian Rp 10.000');
    });

    it('closes shift in SHORT state when actual cash < expected cash with valid variance note', async () => {
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 100000,
        expected_cash: 100000,
        status: 'OPEN',
      });

      const closed = await repository.closeShift(
        shift.id,
        95000,
        'Salah hitung uang kembalian pada transaksi siang'
      );

      expect(closed.status).toBe('CLOSED');
      expect(closed.actual_cash).toBe(95000);
      expect(closed.difference).toBe(-5000);
    });

    it('rejects closing shift when variance exists and variance_note is missing or too short', async () => {
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 100000,
        expected_cash: 100000,
        status: 'OPEN',
      });

      // No note provided
      await expect(repository.closeShift(shift.id, 90000)).rejects.toThrowError(RepositoryError);

      try {
        await repository.closeShift(shift.id, 90000);
      } catch (err: any) {
        expect(err.code).toBe('FINANCIAL_VALIDATION_ERROR');
        expect(err.message).toContain('variance_note');
      }

      // Note too short (< 5 chars)
      await expect(repository.closeShift(shift.id, 90000, 'beda')).rejects.toThrowError(
        RepositoryError
      );
    });

    it('rejects modifying or re-closing an already CLOSED shift (audit-locked)', async () => {
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 100000,
        expected_cash: 100000,
        status: 'OPEN',
      });

      await repository.closeShift(shift.id, 100000);

      // Attempt to close again
      await expect(repository.closeShift(shift.id, 100000)).rejects.toThrowError(RepositoryError);

      try {
        await repository.closeShift(shift.id, 100000);
      } catch (err: any) {
        expect(err.code).toBe('CONFLICT');
        expect(err.message).toContain('CLOSED');
      }
    });
  });

  describe('3. Non-Cash Physical Isolation & Financial Ledger Calculation', () => {
    it('excludes non-cash (QRIS, BANK_TRANSFER, EDC) from physical cash drawer', async () => {
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 100000,
        expected_cash: 100000,
        status: 'OPEN',
      });

      const customer = (await repository.getCustomers())[0];
      const services = await repository.getServices();

      // Transaction 1: Cash payment Rp 50.000
      await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_BKS,
          production_branch_id: OUTLET_BKS,
          customer_id: customer.id,
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal: 50000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 50000,
          paid_amount: 50000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: CASHIER_ID,
        },
        [
          {
            service_id: services[0].id,
            item_type: 'KILOAN',
            service_name_snap: services[0].name,
            unit_price_snap: 50000,
            quantity_or_weight: 1,
            billable_weight: 1,
            subtotal: 50000,
          },
        ],
        { method: 'CASH', amount: 50000 }
      );

      // Transaction 2: QRIS payment Rp 75.000
      await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_BKS,
          production_branch_id: OUTLET_BKS,
          customer_id: customer.id,
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal: 75000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 75000,
          paid_amount: 75000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: CASHIER_ID,
        },
        [
          {
            service_id: services[0].id,
            item_type: 'KILOAN',
            service_name_snap: services[0].name,
            unit_price_snap: 75000,
            quantity_or_weight: 1,
            billable_weight: 1,
            subtotal: 75000,
          },
        ],
        { method: 'QRIS_MANUAL', amount: 75000 }
      );

      // Transaction 3: Bank Transfer payment Rp 120.000
      await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_BKS,
          production_branch_id: OUTLET_BKS,
          customer_id: customer.id,
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal: 120000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 120000,
          paid_amount: 120000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: CASHIER_ID,
        },
        [
          {
            service_id: services[0].id,
            item_type: 'KILOAN',
            service_name_snap: services[0].name,
            unit_price_snap: 120000,
            quantity_or_weight: 1,
            billable_weight: 1,
            subtotal: 120000,
          },
        ],
        { method: 'BANK_TRANSFER', amount: 120000 }
      );

      // Shift summary inspection
      const summary = await repository.getShiftSummary(shift.id);

      // Expected physical cash must ONLY include CASH: 100.000 opening + 50.000 cash sales = 150.000
      // QRIS (75.000) and Bank Transfer (120.000) MUST NOT be in expected physical cash
      expect(summary.openingCash).toBe(100000);
      expect(summary.cashPayments).toBe(50000);
      expect(summary.expectedCash).toBe(150000);
      expect(summary.nonCashBreakdown.qris).toBe(75000);
      expect(summary.nonCashBreakdown.transfer).toBe(120000);
      expect(summary.totalGrossTurnover).toBe(245000); // 50k + 75k + 120k

      // Closing with 150.000 actual cash is BALANCED (difference = 0)
      const closed = await repository.closeShift(shift.id, 150000);
      expect(closed.expected_cash).toBe(150000);
      expect(closed.actual_cash).toBe(150000);
      expect(closed.difference).toBe(0);
      expect(closed.cash_sales).toBe(50000);
      expect(closed.qris_sales).toBe(75000);
      expect(closed.transfer_sales).toBe(120000);
      expect(closed.transaction_count).toBe(3);
    });

    it('accounts for cashIn, cashOut, and cashRefunds in physical drawer formula', async () => {
      // Opening 200.000, cashIn: +50.000 (modal tukar), cashOut: -30.000 (beli kantong plastik), refund: -20.000
      // Expected = 200.000 + 0 + 50.000 - 30.000 - 20.000 = 200.000
      const shift = await repository.openShift({
        organization_id: ORG_ID,
        branch_id: OUTLET_BKS,
        cashier_id: CASHIER_ID,
        opening_cash: 200000,
        expected_cash: 200000,
        cash_in: 50000,
        cash_out: 30000,
        refund_amount: 20000,
        status: 'OPEN',
      });

      const closed = await repository.closeShift(shift.id, 200000);
      expect(closed.expected_cash).toBe(200000);
      expect(closed.actual_cash).toBe(200000);
      expect(closed.difference).toBe(0);
    });
  });
});
