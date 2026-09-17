// ============================================================================
// Core Pricing Engine (High-Integrity Laundromat Calculation)
// ============================================================================

import { RoundingRule, Service } from '../types/database';

export interface CalculationInput {
  service: Pick<Service, 'base_price' | 'min_charge_unit' | 'rounding_rule' | 'unit'>;
  actualQuantityOrWeight: number;
  customDiscountAmount?: number;
  deliveryFee?: number;
}

export interface CalculationResult {
  actualQuantityOrWeight: number;
  appliedRoundingRule: RoundingRule;
  billableQuantityOrWeight: number;
  unitPrice: number;
  subtotal: number;
  discountAmount: number;
  deliveryFee: number;
  finalAmount: number;
}

/**
 * Rounds weight according to the service's rounding rule
 */
export function applyWeightRounding(weight: number, rule: RoundingRule): number {
  if (weight <= 0) return 0;

  switch (rule) {
    case 'ROUND_HALF_UP_0_5':
      // Round to nearest 0.5 step upwards (e.g. 2.1 -> 2.5, 2.5 -> 2.5, 2.6 -> 3.0)
      return Math.ceil(weight * 2) / 2;

    case 'CEIL_1_0':
      // Round up to nearest whole kilogram (e.g. 2.1 -> 3.0)
      return Math.ceil(weight);

    case 'FLOOR':
      return Math.floor(weight);

    case 'EXACT':
    default:
      // Round to 2 decimal places to avoid floating point anomalies
      return Math.round(weight * 100) / 100;
  }
}

/**
 * Calculates billable weight and total price, strictly enforcing minimum charge
 */
export function calculateItemPrice(input: CalculationInput): CalculationResult {
  const { service, actualQuantityOrWeight, customDiscountAmount = 0, deliveryFee = 0 } = input;

  const rawQty = Math.max(0, actualQuantityOrWeight);
  
  // 1. Apply rounding rule to actual weight (especially for KG kiloan)
  const roundedWeight = service.unit === 'KG'
    ? applyWeightRounding(rawQty, service.rounding_rule)
    : rawQty;

  // 2. Apply minimum charge rule (e.g. min 3 KG)
  const billableQuantityOrWeight = Math.max(
    roundedWeight,
    service.min_charge_unit || 1
  );

  // 3. Calculate subtotal (unit price * billable quantity)
  const subtotal = Math.round(billableQuantityOrWeight * service.base_price);

  // 4. Apply discount
  const validDiscount = Math.min(subtotal, Math.max(0, customDiscountAmount));

  // 5. Final billable amount with delivery fee
  const finalAmount = Math.max(0, subtotal - validDiscount + Math.max(0, deliveryFee));

  return {
    actualQuantityOrWeight: rawQty,
    appliedRoundingRule: service.rounding_rule,
    billableQuantityOrWeight,
    unitPrice: service.base_price,
    subtotal,
    discountAmount: validDiscount,
    deliveryFee,
    finalAmount,
  };
}
