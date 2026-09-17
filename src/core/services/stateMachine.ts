// ============================================================================
// Order State Machine (Strict Lifecycle Transitions & History Enforcer)
// ============================================================================

import { OrderStatus, OperatingMode } from '../types/database';

export interface TransitionRule {
  allowedNext: OrderStatus[];
  description: string;
}

// Universal invalid transitions that can never be reversed
export const TERMINAL_STATUSES: OrderStatus[] = ['COMPLETED', 'CANCELLED'];

// State transition table across modes
export const SIMPLE_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['WASHING', 'READY', 'CANCELLED'],
  SORTING: ['WASHING', 'CANCELLED'],
  WASHING: ['READY', 'CANCELLED'],
  DRYING: ['READY', 'CANCELLED'],
  IRONING: ['READY', 'CANCELLED'],
  PACKING: ['READY', 'CANCELLED'],
  QC: ['READY', 'CANCELLED'],
  READY: ['PICKED_UP', 'DELIVERED', 'COMPLETED'],
  PICKED_UP: ['COMPLETED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [], // Terminal
  CANCELLED: [], // Terminal
};

export const ADVANCED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['SORTING', 'WASHING', 'CANCELLED'],
  SORTING: ['WASHING', 'CANCELLED'],
  WASHING: ['DRYING', 'CANCELLED'],
  DRYING: ['IRONING', 'CANCELLED'],
  IRONING: ['PACKING', 'CANCELLED'],
  PACKING: ['QC', 'READY', 'CANCELLED'],
  QC: ['READY', 'IRONING', 'CANCELLED'], // Can send back to IRONING if QC fails
  READY: ['PICKED_UP', 'DELIVERED', 'COMPLETED'],
  PICKED_UP: ['COMPLETED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [], // Terminal
  CANCELLED: [], // Terminal
};

/**
 * Validates if an order can transition from currentStatus to nextStatus
 */
export function isValidOrderTransition(
  fromStatus: OrderStatus,
  toStatus: OrderStatus,
  mode: OperatingMode = 'SIMPLE'
): { isValid: boolean; reason?: string } {
  if (fromStatus === toStatus) {
    return { isValid: false, reason: 'Status target sama dengan status saat ini.' };
  }

  if (TERMINAL_STATUSES.includes(fromStatus)) {
    return {
      isValid: false,
      reason: `Pesanan telah berstatus akhir '${fromStatus}' dan tidak dapat diubah lagi.`,
    };
  }

  const table = mode === 'ADVANCED' ? ADVANCED_TRANSITIONS : SIMPLE_TRANSITIONS;
  const allowed = table[fromStatus] || [];

  if (!allowed.includes(toStatus)) {
    return {
      isValid: false,
      reason: `Transisi ilegal: status '${fromStatus}' tidak dapat langsung diubah menjadi '${toStatus}' pada mode ${mode}.`,
    };
  }

  return { isValid: true };
}
