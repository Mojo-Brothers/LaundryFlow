import { describe, it, expect } from 'vitest';
import { calculateItemPrice, applyWeightRounding } from '../core/services/pricing';

describe('Pricing Engine & Weight Rounding', () => {
  it('should enforce minimum charge when weight is below min_charge_unit', () => {
    const result = calculateItemPrice({
      service: {
        base_price: 8000,
        min_charge_unit: 3.0,
        rounding_rule: 'ROUND_HALF_UP_0_5',
        unit: 'KG',
      },
      actualQuantityOrWeight: 1.2,
    });

    expect(result.actualQuantityOrWeight).toBe(1.2);
    expect(result.billableQuantityOrWeight).toBe(3.0);
    expect(result.subtotal).toBe(24000); // 3 * 8000
    expect(result.finalAmount).toBe(24000);
  });

  it('should apply ROUND_HALF_UP_0_5 correctly for weight above minimum charge', () => {
    expect(applyWeightRounding(4.1, 'ROUND_HALF_UP_0_5')).toBe(4.5);
    expect(applyWeightRounding(4.5, 'ROUND_HALF_UP_0_5')).toBe(4.5);
    expect(applyWeightRounding(4.6, 'ROUND_HALF_UP_0_5')).toBe(5.0);

    const result = calculateItemPrice({
      service: {
        base_price: 10000,
        min_charge_unit: 3.0,
        rounding_rule: 'ROUND_HALF_UP_0_5',
        unit: 'KG',
      },
      actualQuantityOrWeight: 4.2,
    });

    expect(result.billableQuantityOrWeight).toBe(4.5);
    expect(result.subtotal).toBe(45000);
  });

  it('should apply CEIL_1_0 correctly', () => {
    expect(applyWeightRounding(3.1, 'CEIL_1_0')).toBe(4.0);
    expect(applyWeightRounding(3.0, 'CEIL_1_0')).toBe(3.0);
  });

  it('should handle satuan items correctly without weight rounding', () => {
    const result = calculateItemPrice({
      service: {
        base_price: 35000,
        min_charge_unit: 1.0,
        rounding_rule: 'EXACT',
        unit: 'PCS',
      },
      actualQuantityOrWeight: 2,
    });

    expect(result.billableQuantityOrWeight).toBe(2);
    expect(result.subtotal).toBe(70000);
  });

  it('should apply discount and delivery fee correctly', () => {
    const result = calculateItemPrice({
      service: {
        base_price: 10000,
        min_charge_unit: 3.0,
        rounding_rule: 'EXACT',
        unit: 'KG',
      },
      actualQuantityOrWeight: 5.0,
      customDiscountAmount: 5000,
      deliveryFee: 10000,
    });

    expect(result.subtotal).toBe(50000);
    expect(result.discountAmount).toBe(5000);
    expect(result.finalAmount).toBe(55000); // 50000 - 5000 + 10000
  });
});
