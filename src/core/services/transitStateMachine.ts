// ============================================================================
// Transit Manifest State Machine & Pure Logistics Domain Logic
// (Strict Lifecycle Transitions, Immutability, and Discrepancy Calculation)
// ============================================================================

import {
  TransitManifestStatus,
  TransitManifestItemStatus,
  TransitManifest,
  OrderStatus,
} from '../types/database';

export type { TransitManifestStatus, TransitManifestItemStatus };

/**
 * Domain error representing an illegal transit manifest lifecycle transition.
 */
export class ManifestTransitionError extends Error {
  readonly currentStatus: TransitManifestStatus;
  readonly requestedStatus: TransitManifestStatus;

  constructor(
    currentStatus: TransitManifestStatus,
    requestedStatus: TransitManifestStatus,
    reason?: string
  ) {
    super(
      reason ||
        `Transisi manifest ilegal: tidak dapat mengubah status manifest dari '${currentStatus}' ke '${requestedStatus}'.`
    );
    this.name = 'ManifestTransitionError';
    this.currentStatus = currentStatus;
    this.requestedStatus = requestedStatus;
    Object.setPrototypeOf(this, ManifestTransitionError.prototype);
  }
}

/**
 * Authoritative lifecycle transition matrix for multi-outlet transit manifests.
 * Matches PostgreSQL trigger trg_enforce_manifest_state_machine in migration 004.
 */
export const LEGAL_MANIFEST_TRANSITIONS: Record<TransitManifestStatus, TransitManifestStatus[]> = {
  DRAFT: ['READY_TO_DISPATCH', 'CANCELLED'],
  READY_TO_DISPATCH: ['DRAFT', 'IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: [], // Terminal immutable state
  CANCELLED: [], // Terminal immutable state
};

/**
 * Pure evaluation function checking if a manifest can transition to targetStatus.
 */
export function canTransitionManifest(
  fromStatus: TransitManifestStatus,
  toStatus: TransitManifestStatus
): boolean {
  if (fromStatus === toStatus) return false;
  const allowed = LEGAL_MANIFEST_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

/**
 * Assertion function throwing a ManifestTransitionError if transition is illegal.
 */
export function assertManifestTransition(
  fromStatus: TransitManifestStatus,
  toStatus: TransitManifestStatus
): void {
  if (fromStatus === toStatus) {
    throw new ManifestTransitionError(
      fromStatus,
      toStatus,
      `Status target sama dengan status manifest saat ini ('${fromStatus}').`
    );
  }

  if (fromStatus === 'RECEIVED') {
    throw new ManifestTransitionError(
      fromStatus,
      toStatus,
      'Manifest telah berstatus akhir RECEIVED (diterima) dan tidak dapat dimodifikasi lagi.'
    );
  }

  if (fromStatus === 'CANCELLED') {
    throw new ManifestTransitionError(
      fromStatus,
      toStatus,
      'Manifest telah berstatus CANCELLED (dibatalkan) dan tidak dapat diaktifkan kembali.'
    );
  }

  const allowed = LEGAL_MANIFEST_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new ManifestTransitionError(fromStatus, toStatus);
  }
}

export interface TransitionManifestOptions {
  actorId?: string;
  notes?: string;
  now?: string;
}

/**
 * Pure state transition function returning an immutable updated TransitManifest.
 * Guarantees zero mutation on the original input manifest object.
 */
export function transitionManifest(
  manifest: Readonly<TransitManifest>,
  targetStatus: TransitManifestStatus,
  options?: TransitionManifestOptions
): TransitManifest {
  assertManifestTransition(manifest.status, targetStatus);
  const timestamp = options?.now || new Date().toISOString();

  const nextManifest: TransitManifest = {
    ...manifest,
    status: targetStatus,
    updated_at: timestamp,
  };

  switch (targetStatus) {
    case 'READY_TO_DISPATCH':
      if (options?.notes) nextManifest.notes = options.notes;
      break;

    case 'IN_TRANSIT':
      nextManifest.dispatched_at = timestamp;
      if (options?.actorId) nextManifest.dispatched_by = options.actorId;
      if (options?.notes) nextManifest.notes = options.notes;
      break;

    case 'RECEIVED':
      nextManifest.received_at = timestamp;
      if (options?.actorId) nextManifest.received_by = options.actorId;
      if (options?.notes) nextManifest.discrepancy_summary = options.notes;
      break;

    case 'CANCELLED':
      nextManifest.cancelled_at = timestamp;
      if (options?.actorId) nextManifest.cancelled_by = options.actorId;
      if (options?.notes) nextManifest.notes = options.notes;
      break;

    case 'DRAFT':
      if (options?.notes) nextManifest.notes = options.notes;
      break;
  }

  return Object.freeze(nextManifest);
}

/**
 * Pure validation rule for order eligibility in transit manifests.
 * Orders with terminal statuses (CANCELLED, COMPLETED) cannot be added to a manifest.
 */
export function isOrderEligibleForTransit(order: { status: OrderStatus }): boolean {
  return order.status !== 'CANCELLED' && order.status !== 'COMPLETED';
}

export interface ManifestDraftValidationInput {
  organization_id?: string;
  source_branch_id?: string;
  destination_branch_id?: string;
  manifest_number?: string;
  driver_user_id?: string;
}

/**
 * Pure domain validation for draft manifest parameters.
 * Rejects invalid routes (e.g. self-routing Branch A -> Branch A).
 */
export function validateManifestDraft(input: ManifestDraftValidationInput): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!input.organization_id || input.organization_id.trim() === '') {
    errors.push('Organization ID wajib diisi.');
  }

  if (!input.source_branch_id || input.source_branch_id.trim() === '') {
    errors.push('Cabang asal (source_branch_id) wajib dipilih.');
  }

  if (!input.destination_branch_id || input.destination_branch_id.trim() === '') {
    errors.push('Cabang tujuan (destination_branch_id) wajib dipilih.');
  }

  if (
    input.source_branch_id &&
    input.destination_branch_id &&
    input.source_branch_id === input.destination_branch_id
  ) {
    errors.push('Cabang asal dan cabang tujuan tidak boleh sama (self-routing ditolak).');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export interface DiscrepancyItemInput {
  received_status: TransitManifestItemStatus;
}

export interface DiscrepancySummary {
  hasDiscrepancy: boolean;
  receivedOkCount: number;
  missingCount: number;
  damagedCount: number;
  wrongBranchCount: number;
  unresolvedCount: number;
  totalCount: number;
  summaryText: string;
}

/**
 * Pure domain calculation for receiving inspection and discrepancy reporting.
 */
export function calculateManifestDiscrepancy(items: DiscrepancyItemInput[]): DiscrepancySummary {
  let receivedOkCount = 0;
  let missingCount = 0;
  let damagedCount = 0;
  let wrongBranchCount = 0;
  let unresolvedCount = 0;

  for (const item of items) {
    switch (item.received_status) {
      case 'RECEIVED_OK':
        receivedOkCount++;
        break;
      case 'MISSING':
        missingCount++;
        break;
      case 'DAMAGED':
        damagedCount++;
        break;
      case 'WRONG_BRANCH':
        wrongBranchCount++;
        break;
      case 'EXPECTED':
        unresolvedCount++;
        break;
    }
  }

  const discrepancyIssues = missingCount + damagedCount + wrongBranchCount;
  const hasDiscrepancy = discrepancyIssues > 0;

  let summaryText = 'Diterima lengkap & sesuai';
  if (items.length === 0) {
    summaryText = 'Manifest kosong tanpa item';
  } else if (hasDiscrepancy) {
    const parts: string[] = [];
    if (missingCount > 0) parts.push(`${missingCount} hilang (missing)`);
    if (damagedCount > 0) parts.push(`${damagedCount} rusak (damaged)`);
    if (wrongBranchCount > 0) parts.push(`${wrongBranchCount} salah kirim cabang (wrong branch)`);
    summaryText = `Terdapat selisih fisik: ${parts.join(', ')}`;
  } else if (unresolvedCount > 0) {
    summaryText = `${unresolvedCount} item belum diperiksa (masih EXPECTED)`;
  }

  return {
    hasDiscrepancy,
    receivedOkCount,
    missingCount,
    damagedCount,
    wrongBranchCount,
    unresolvedCount,
    totalCount: items.length,
    summaryText,
  };
}
