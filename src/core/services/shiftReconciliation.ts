// ============================================================================
// Cashier Shift Reconciliation Calculator & Pure Financial Domain Logic
// (Drawer Expected Cash Authority, Decimal-Safe Math, and Variance Enforcement)
// ============================================================================

export type VarianceClassification = 'BALANCED' | 'OVER' | 'SHORT';

export interface ShiftReconciliationInput {
  openingCash: number;
  cashPayments: number;
  cashIn?: number;
  cashOut?: number;
  cashRefunds?: number;
  actualCash: number;
  nonCashPayments?: {
    qris?: number;
    transfer?: number;
    edc?: number;
    other?: number;
  };
  varianceNote?: string;
}

export interface ShiftReconciliationResult {
  openingCash: number;
  cashPayments: number;
  cashIn: number;
  cashOut: number;
  cashRefunds: number;
  expectedCash: number;
  actualCash: number;
  difference: number;
  classification: VarianceClassification;
  isBalanced: boolean;
  requiresVarianceNote: boolean;
  isVarianceNoteValid: boolean;
  totalGrossTurnover: number;
  nonCashBreakdown: {
    qris: number;
    transfer: number;
    edc: number;
    other: number;
    totalNonCash: number;
  };
}

/**
 * Precision helper converting monetary numbers to integer cents to completely
 * prevent IEEE-754 binary floating-point drift (e.g. 0.1 + 0.2 = 0.30000000000000004).
 */
function toCents(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Pure calculator for cashier drawer reconciliation at shift close.
 * 
 * Formula:
 *   Expected Cash = Opening Cash + Cash Payments + Cash In - Cash Out - Cash Refunds
 *   Difference    = Actual Cash - Expected Cash
 * 
 * Rules:
 *   Difference = 0  -> BALANCED
 *   Difference > 0  -> OVER
 *   Difference < 0  -> SHORT
 */
export function calculateShiftReconciliation(
  input: ShiftReconciliationInput
): ShiftReconciliationResult {
  const openingCents = toCents(input.openingCash);
  const cashPaymentsCents = toCents(input.cashPayments);
  const cashInCents = toCents(input.cashIn ?? 0);
  const cashOutCents = toCents(input.cashOut ?? 0);
  const cashRefundsCents = toCents(input.cashRefunds ?? 0);
  const actualCents = toCents(input.actualCash);

  // Exact integer cents calculation for physical drawer expected cash
  const expectedCents =
    openingCents + cashPaymentsCents + cashInCents - cashOutCents - cashRefundsCents;
  const diffCents = actualCents - expectedCents;

  const expectedCash = fromCents(expectedCents);
  const difference = fromCents(diffCents);

  let classification: VarianceClassification = 'BALANCED';
  if (diffCents > 0) {
    classification = 'OVER';
  } else if (diffCents < 0) {
    classification = 'SHORT';
  }

  const isBalanced = diffCents === 0;
  const requiresVarianceNote = !isBalanced;
  const isVarianceNoteValid =
    !requiresVarianceNote ||
    (typeof input.varianceNote === 'string' && input.varianceNote.trim().length >= 5);

  // Non-cash calculations (Reporting turnover only, not added to drawer physical cash)
  const qrisCents = toCents(input.nonCashPayments?.qris ?? 0);
  const transferCents = toCents(input.nonCashPayments?.transfer ?? 0);
  const edcCents = toCents(input.nonCashPayments?.edc ?? 0);
  const otherCents = toCents(input.nonCashPayments?.other ?? 0);
  const totalNonCashCents = qrisCents + transferCents + edcCents + otherCents;

  const totalGrossTurnover = fromCents(cashPaymentsCents + totalNonCashCents);

  return {
    openingCash: fromCents(openingCents),
    cashPayments: fromCents(cashPaymentsCents),
    cashIn: fromCents(cashInCents),
    cashOut: fromCents(cashOutCents),
    cashRefunds: fromCents(cashRefundsCents),
    expectedCash,
    actualCash: fromCents(actualCents),
    difference,
    classification,
    isBalanced,
    requiresVarianceNote,
    isVarianceNoteValid,
    totalGrossTurnover,
    nonCashBreakdown: {
      qris: fromCents(qrisCents),
      transfer: fromCents(transferCents),
      edc: fromCents(edcCents),
      other: fromCents(otherCents),
      totalNonCash: fromCents(totalNonCashCents),
    },
  };
}
