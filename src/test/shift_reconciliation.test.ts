import { describe, it, expect } from 'vitest';
import { calculateShiftReconciliation } from '../core/services/shiftReconciliation';

describe('Cashier Shift Reconciliation Calculator', () => {
  describe('Basic Balanced, Over, and Short Drawer Classifications', () => {
    it('classifies exact match as BALANCED with difference 0', () => {
      const result = calculateShiftReconciliation({
        openingCash: 100000,
        cashPayments: 200000,
        actualCash: 300000,
      });

      expect(result.expectedCash).toBe(300000);
      expect(result.actualCash).toBe(300000);
      expect(result.difference).toBe(0);
      expect(result.classification).toBe('BALANCED');
      expect(result.isBalanced).toBe(true);
      expect(result.requiresVarianceNote).toBe(false);
      expect(result.isVarianceNoteValid).toBe(true);
    });

    it('classifies surplus cash as OVER with positive difference', () => {
      const result = calculateShiftReconciliation({
        openingCash: 100000,
        cashPayments: 200000,
        actualCash: 305000,
      });

      expect(result.expectedCash).toBe(300000);
      expect(result.actualCash).toBe(305000);
      expect(result.difference).toBe(5000);
      expect(result.classification).toBe('OVER');
      expect(result.isBalanced).toBe(false);
      expect(result.requiresVarianceNote).toBe(true);
    });

    it('classifies deficit cash as SHORT with negative difference', () => {
      const result = calculateShiftReconciliation({
        openingCash: 100000,
        cashPayments: 200000,
        actualCash: 295000,
      });

      expect(result.expectedCash).toBe(300000);
      expect(result.actualCash).toBe(295000);
      expect(result.difference).toBe(-5000);
      expect(result.classification).toBe('SHORT');
      expect(result.isBalanced).toBe(false);
      expect(result.requiresVarianceNote).toBe(true);
    });
  });

  describe('Comprehensive Drawer Calculation (Cash In, Cash Out, Cash Refunds)', () => {
    // Expected Cash = Opening (100,000) + Cash Payments (250,000) + Cash In (50,000) - Cash Out (25,000) - Refunds (10,000)
    // Expected Cash = 365,000
    const baseParams = {
      openingCash: 100000,
      cashPayments: 250000,
      cashIn: 50000,
      cashOut: 25000,
      cashRefunds: 10000,
    };

    it('calculates exact expected cash of Rp 365,000', () => {
      const result = calculateShiftReconciliation({
        ...baseParams,
        actualCash: 365000,
      });

      expect(result.expectedCash).toBe(365000);
      expect(result.difference).toBe(0);
      expect(result.classification).toBe('BALANCED');
    });

    it('detects Rp 5,000 surplus when actual cash is Rp 370,000 (OVER)', () => {
      const result = calculateShiftReconciliation({
        ...baseParams,
        actualCash: 370000,
      });

      expect(result.expectedCash).toBe(365000);
      expect(result.difference).toBe(5000);
      expect(result.classification).toBe('OVER');
    });

    it('detects Rp 5,000 deficit when actual cash is Rp 360,000 (SHORT)', () => {
      const result = calculateShiftReconciliation({
        ...baseParams,
        actualCash: 360000,
      });

      expect(result.expectedCash).toBe(365000);
      expect(result.difference).toBe(-5000);
      expect(result.classification).toBe('SHORT');
    });
  });

  describe('Physical Drawer vs Non-Cash Isolation', () => {
    it('isolates QRIS and Bank Transfer from physical cash drawer', () => {
      const result = calculateShiftReconciliation({
        openingCash: 150000,
        cashPayments: 350000, // Physical cash
        actualCash: 500000,
        nonCashPayments: {
          qris: 850000,
          transfer: 400000,
          edc: 200000,
        },
      });

      // Drawer expected cash must ONLY equal opening (150,000) + cash payments (350,000) = 500,000
      expect(result.expectedCash).toBe(500000);
      expect(result.difference).toBe(0);
      expect(result.classification).toBe('BALANCED');

      // Gross turnover reporting includes all payment methods
      // Cash (350,000) + QRIS (850,000) + Transfer (400,000) + EDC (200,000) = 1,800,000
      expect(result.totalGrossTurnover).toBe(1800000);
      expect(result.nonCashBreakdown.qris).toBe(850000);
      expect(result.nonCashBreakdown.transfer).toBe(400000);
      expect(result.nonCashBreakdown.edc).toBe(200000);
      expect(result.nonCashBreakdown.totalNonCash).toBe(1450000);
    });
  });

  describe('Variance Note Enforcement', () => {
    it('requires a variance note with minimum 5 characters when unbalanced', () => {
      // Unbalanced with no note -> invalid
      const withoutNote = calculateShiftReconciliation({
        openingCash: 100000,
        cashPayments: 100000,
        actualCash: 190000, // short 10,000
      });
      expect(withoutNote.requiresVarianceNote).toBe(true);
      expect(withoutNote.isVarianceNoteValid).toBe(false);

      // Unbalanced with short note (< 5 chars) -> invalid
      const shortNote = calculateShiftReconciliation({
        openingCash: 100000,
        cashPayments: 100000,
        actualCash: 190000,
        varianceNote: 'lupa', // 4 chars
      });
      expect(shortNote.isVarianceNoteValid).toBe(false);

      // Unbalanced with valid explanation (>= 5 chars) -> valid
      const validNote = calculateShiftReconciliation({
        openingCash: 100000,
        cashPayments: 100000,
        actualCash: 190000,
        varianceNote: 'Kembalian koin kurang Rp 10.000',
      });
      expect(validNote.isVarianceNoteValid).toBe(true);
    });

    it('does not require a note when drawer is BALANCED', () => {
      const balanced = calculateShiftReconciliation({
        openingCash: 100000,
        cashPayments: 100000,
        actualCash: 200000,
      });
      expect(balanced.requiresVarianceNote).toBe(false);
      expect(balanced.isVarianceNoteValid).toBe(true);
    });
  });

  describe('Zero Values and Decimal Precision', () => {
    it('handles zero values cleanly', () => {
      const result = calculateShiftReconciliation({
        openingCash: 0,
        cashPayments: 0,
        actualCash: 0,
      });

      expect(result.expectedCash).toBe(0);
      expect(result.actualCash).toBe(0);
      expect(result.difference).toBe(0);
      expect(result.classification).toBe('BALANCED');
      expect(result.totalGrossTurnover).toBe(0);
    });

    it('avoids IEEE-754 decimal floating-point drift', () => {
      const result = calculateShiftReconciliation({
        openingCash: 0.1,
        cashPayments: 0.2,
        actualCash: 0.3,
      });

      expect(result.expectedCash).toBe(0.3);
      expect(result.actualCash).toBe(0.3);
      expect(result.difference).toBe(0);
      expect(result.isBalanced).toBe(true);
      expect(result.classification).toBe('BALANCED');
    });
  });
});
