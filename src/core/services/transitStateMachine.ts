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

export type TransitRouteDirection = 'OUTBOUND' | 'RETURN' | 'INVALID';

export interface RouteDeterminationInput {
  order: { branch_id: string; production_branch_id?: string };
  sourceBranchId: string;
  destinationBranchId: string;
}

/**
 * Pure function determining the directed transit route type.
 * Outbound: Origin Outlet (order.branch_id) -> Designated Production Workshop (order.production_branch_id)
 * Return: Designated Production Workshop (order.production_branch_id) -> Origin Outlet (order.branch_id)
 */
export function determineTransitRouteDirection(
  input: RouteDeterminationInput
): TransitRouteDirection {
  const { order, sourceBranchId, destinationBranchId } = input;
  if (!sourceBranchId || !destinationBranchId || sourceBranchId === destinationBranchId) {
    return 'INVALID';
  }

  const effectiveProdBranch = order.production_branch_id || destinationBranchId;

  // OUTBOUND ROUTE: branch_id -> production_branch_id
  if (
    sourceBranchId === order.branch_id &&
    destinationBranchId === effectiveProdBranch
  ) {
    return 'OUTBOUND';
  }

  // RETURN ROUTE: production_branch_id -> branch_id
  if (
    sourceBranchId === effectiveProdBranch &&
    destinationBranchId === order.branch_id
  ) {
    return 'RETURN';
  }

  return 'INVALID';
}

export interface HistoricalTransitItem {
  order_id: string;
  received_status: TransitManifestItemStatus;
  received_at?: string | null;
  manifest: {
    source_branch_id: string;
    destination_branch_id: string;
    status: TransitManifestStatus;
    received_at?: string | null;
  };
}

export type OrderCustodyState =
  | 'AT_ORIGIN'
  | 'OUTBOUND_IN_TRANSIT'
  | 'AT_WORKSHOP'
  | 'AT_WORKSHOP_DAMAGED'
  | 'RETURN_IN_TRANSIT'
  | 'AT_ORIGIN_DAMAGED'
  | 'CUSTODY_UNKNOWN_MISSING'
  | 'CUSTODY_EXCEPTION_WRONG_BRANCH';

/**
 * Pure helper retrieving the latest completed Outbound transit item for an order.
 * Route: Origin Outlet (order.branch_id) -> Designated Production Workshop.
 * Status: Manifest RECEIVED, item RECEIVED_OK or DAMAGED.
 */
export function getLatestCompletedOutbound(
  orderId: string,
  history: HistoricalTransitItem[],
  originBranchId: string,
  productionBranchId: string
): HistoricalTransitItem | null {
  const matching = history.filter(
    (h) =>
      h.order_id === orderId &&
      h.manifest.source_branch_id === originBranchId &&
      h.manifest.destination_branch_id === productionBranchId &&
      h.manifest.status === 'RECEIVED' &&
      (h.received_status === 'RECEIVED_OK' || h.received_status === 'DAMAGED')
  );
  if (matching.length === 0) return null;
  return matching.reduce((latest, current) => {
    const latestTime = latest.manifest.received_at || latest.received_at || '';
    const currentTime = current.manifest.received_at || current.received_at || '';
    return currentTime >= latestTime ? current : latest;
  });
}

/**
 * Pure helper retrieving the latest Outbound transit item regardless of item received_status.
 * Used to identify whether the latest outbound event resulted in MISSING or WRONG_BRANCH.
 */
export function getLatestOutboundItem(
  orderId: string,
  history: HistoricalTransitItem[],
  originBranchId: string,
  productionBranchId: string
): HistoricalTransitItem | null {
  const matching = history.filter(
    (h) =>
      h.order_id === orderId &&
      h.manifest.source_branch_id === originBranchId &&
      h.manifest.destination_branch_id === productionBranchId &&
      h.manifest.status === 'RECEIVED'
  );
  if (matching.length === 0) return null;
  return matching.reduce((latest, current) => {
    const latestTime = latest.manifest.received_at || latest.received_at || '';
    const currentTime = current.manifest.received_at || current.received_at || '';
    return currentTime >= latestTime ? current : latest;
  });
}

/**
 * Pure helper retrieving the latest completed Return transit item for an order.
 * Route: Designated Production Workshop -> Origin Outlet (order.branch_id).
 * Status: Manifest RECEIVED, item RECEIVED_OK or DAMAGED.
 */
export function getLatestCompletedReturn(
  orderId: string,
  history: HistoricalTransitItem[],
  originBranchId: string,
  productionBranchId: string
): HistoricalTransitItem | null {
  const matching = history.filter(
    (h) =>
      h.order_id === orderId &&
      h.manifest.source_branch_id === productionBranchId &&
      h.manifest.destination_branch_id === originBranchId &&
      h.manifest.status === 'RECEIVED' &&
      (h.received_status === 'RECEIVED_OK' || h.received_status === 'DAMAGED')
  );
  if (matching.length === 0) return null;
  return matching.reduce((latest, current) => {
    const latestTime = latest.manifest.received_at || latest.received_at || '';
    const currentTime = current.manifest.received_at || current.received_at || '';
    return currentTime >= latestTime ? current : latest;
  });
}

/**
 * Derives current physical custody state of an order from canonical transit history.
 */
export function deriveOrderCustodyState(
  order: { id: string; branch_id: string; production_branch_id?: string },
  history: HistoricalTransitItem[] = []
): OrderCustodyState {
  const effectiveProd = order.production_branch_id;
  if (!effectiveProd || effectiveProd === order.branch_id) {
    return 'AT_ORIGIN';
  }

  // 1. Check active manifests first
  const activeItem = history.find(
    (h) =>
      h.order_id === order.id &&
      ['DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT'].includes(h.manifest.status)
  );
  if (activeItem) {
    if (
      activeItem.manifest.source_branch_id === order.branch_id &&
      activeItem.manifest.destination_branch_id === effectiveProd
    ) {
      return 'OUTBOUND_IN_TRANSIT';
    }
    if (
      activeItem.manifest.source_branch_id === effectiveProd &&
      activeItem.manifest.destination_branch_id === order.branch_id
    ) {
      return 'RETURN_IN_TRANSIT';
    }
  }

  // 2. Evaluate historical received transit evidence
  const latestOutbound = getLatestOutboundItem(order.id, history, order.branch_id, effectiveProd);
  if (!latestOutbound) {
    return 'AT_ORIGIN';
  }

  const latestReturn = history
    .filter(
      (h) =>
        h.order_id === order.id &&
        h.manifest.source_branch_id === effectiveProd &&
        h.manifest.destination_branch_id === order.branch_id &&
        h.manifest.status === 'RECEIVED'
    )
    .reduce<HistoricalTransitItem | null>((latest, current) => {
      if (!latest) return current;
      const latestTime = latest.manifest.received_at || latest.received_at || '';
      const currentTime = current.manifest.received_at || current.received_at || '';
      return currentTime >= latestTime ? current : latest;
    }, null);

  const outTime = latestOutbound.manifest.received_at || latestOutbound.received_at || '';
  const retTime = latestReturn ? (latestReturn.manifest.received_at || latestReturn.received_at || '') : '';

  if (latestReturn && retTime >= outTime) {
    if (latestReturn.received_status === 'MISSING') return 'CUSTODY_UNKNOWN_MISSING';
    if (latestReturn.received_status === 'WRONG_BRANCH') return 'CUSTODY_EXCEPTION_WRONG_BRANCH';
    if (latestReturn.received_status === 'DAMAGED') return 'AT_ORIGIN_DAMAGED';
    return 'AT_ORIGIN';
  } else {
    if (latestOutbound.received_status === 'MISSING') return 'CUSTODY_UNKNOWN_MISSING';
    if (latestOutbound.received_status === 'WRONG_BRANCH') return 'CUSTODY_EXCEPTION_WRONG_BRANCH';
    if (latestOutbound.received_status === 'DAMAGED') return 'AT_WORKSHOP_DAMAGED';
    return 'AT_WORKSHOP';
  }
}

/**
 * Pure evaluation function for Outbound Transit eligibility (Outlet -> Workshop).
 * Ensures order is not in active manifest, has valid physical custody at origin,
 * and requires an approved rework authorization for Cycle 2+.
 */
export function isOutboundTransitEligible(
  order: { id: string; branch_id: string; production_branch_id?: string; status: OrderStatus },
  sourceBranchId: string,
  destinationBranchId: string,
  history: HistoricalTransitItem[] = [],
  hasApprovedRework: boolean = false
): boolean {
  if (!isOrderEligibleForTransit(order)) return false;

  const direction = determineTransitRouteDirection({
    order,
    sourceBranchId,
    destinationBranchId,
  });
  if (direction !== 'OUTBOUND') return false;

  // 1. Order cannot be in an ACTIVE manifest
  const hasActiveManifest = history.some(
    (h) =>
      h.order_id === order.id &&
      ['DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT'].includes(h.manifest.status)
  );
  if (hasActiveManifest) return false;

  // 2. Check if a prior completed outbound transit exists
  const effectiveProdBranch = order.production_branch_id || destinationBranchId;
  const latestCompletedOutbound = getLatestCompletedOutbound(
    order.id,
    history,
    order.branch_id,
    effectiveProdBranch
  );

  if (latestCompletedOutbound) {
    // A prior completed outbound exists. Check if it has returned to origin outlet.
    const latestCompletedReturn = getLatestCompletedReturn(
      order.id,
      history,
      order.branch_id,
      effectiveProdBranch
    );

    const outTime = latestCompletedOutbound.manifest.received_at || latestCompletedOutbound.received_at || '';
    const retTime = latestCompletedReturn
      ? (latestCompletedReturn.manifest.received_at || latestCompletedReturn.received_at || '')
      : '';

    if (!latestCompletedReturn || retTime < outTime) {
      // Order has not yet been received back at the origin outlet
      return false;
    }

    // Order has returned to origin outlet (Cycle 1 complete).
    // For Cycle 2+, an approved rework authorization is STRICTLY required.
    if (!hasApprovedRework) {
      return false;
    }
  }

  return true;
}

/**
 * Pure evaluation function for Return Transit eligibility (Workshop -> Outlet).
 * Requires prior outbound transit to have been RECEIVED with item RECEIVED_OK or DAMAGED.
 * Forbids return if latest outbound transit was marked MISSING or WRONG_BRANCH.
 * Forbids duplicate return if already returned.
 */
export function isReturnTransitEligible(
  order: { id: string; branch_id: string; production_branch_id?: string; status: OrderStatus },
  sourceBranchId: string,
  destinationBranchId: string,
  history: HistoricalTransitItem[] = []
): boolean {
  if (!isOrderEligibleForTransit(order)) return false;

  const direction = determineTransitRouteDirection({
    order,
    sourceBranchId,
    destinationBranchId,
  });
  if (direction !== 'RETURN') return false;

  // 1. Order cannot be in an ACTIVE manifest
  const hasActiveManifest = history.some(
    (h) =>
      h.order_id === order.id &&
      ['DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT'].includes(h.manifest.status)
  );
  if (hasActiveManifest) return false;

  // 2. Must have a prior Outbound transit that was RECEIVED with RECEIVED_OK or DAMAGED
  const effectiveProdBranch = order.production_branch_id || sourceBranchId;
  const latestCompletedOutbound = getLatestCompletedOutbound(
    order.id,
    history,
    order.branch_id,
    effectiveProdBranch
  );
  if (!latestCompletedOutbound) return false;

  const latestCompletedTime = latestCompletedOutbound.manifest.received_at || latestCompletedOutbound.received_at || '';

  // 3. Forbid return if latest outbound transit was marked as MISSING or WRONG_BRANCH after latest completed
  const latestOutboundAny = getLatestOutboundItem(
    order.id,
    history,
    order.branch_id,
    effectiveProdBranch
  );
  if (latestOutboundAny) {
    const latestAnyTime = latestOutboundAny.manifest.received_at || latestOutboundAny.received_at || '';
    if (
      (latestOutboundAny.received_status === 'MISSING' || latestOutboundAny.received_status === 'WRONG_BRANCH') &&
      latestAnyTime >= latestCompletedTime
    ) {
      return false;
    }
  }

  // 4. Must not have already completed a return transit after that outbound receipt
  const latestCompletedReturn = getLatestCompletedReturn(
    order.id,
    history,
    order.branch_id,
    effectiveProdBranch
  );
  if (latestCompletedReturn) {
    const returnTime = latestCompletedReturn.manifest.received_at || latestCompletedReturn.received_at || '';
    if (returnTime >= latestCompletedTime) {
      return false;
    }
  }

  return true;
}

/**
 * Pure domain validation asserting that an order belongs to the manifest's organization
 * and satisfies directed routing constraints (Outbound or Return) and rework authorization.
 * Throws an Error or ManifestTransitionError on violation.
 */
export function assertOrderEligibleForManifest(
  manifest: {
    organization_id: string;
    source_branch_id: string;
    destination_branch_id?: string;
    status: TransitManifestStatus;
  },
  order: {
    id: string;
    organization_id?: string;
    branch_id: string;
    production_branch_id?: string;
    status: OrderStatus;
    order_number?: string;
  },
  history: HistoricalTransitItem[] = [],
  hasApprovedRework: boolean = false
): void {
  if (manifest.status !== 'DRAFT' && manifest.status !== 'READY_TO_DISPATCH') {
    throw new ManifestTransitionError(
      manifest.status,
      manifest.status,
      `Cannot attach order to manifest with status '${manifest.status}'. Orders can only be attached to DRAFT or READY_TO_DISPATCH manifests.`
    );
  }

  if (order.organization_id && order.organization_id !== manifest.organization_id) {
    throw new Error(
      `Cross-tenant violation: Order ${order.order_number || order.id} belongs to organization ${order.organization_id}, but manifest belongs to ${manifest.organization_id}.`
    );
  }

  if (!isOrderEligibleForTransit(order)) {
    throw new Error(
      `Order ${order.order_number || order.id} dengan status '${order.status}' tidak eligible untuk manifest transit.`
    );
  }

  // Directed Route Validation
  if (manifest.destination_branch_id) {
    const direction = determineTransitRouteDirection({
      order,
      sourceBranchId: manifest.source_branch_id,
      destinationBranchId: manifest.destination_branch_id,
    });

    if (direction === 'OUTBOUND') {
      if (
        !isOutboundTransitEligible(
          order,
          manifest.source_branch_id,
          manifest.destination_branch_id,
          history,
          hasApprovedRework
        )
      ) {
        const effectiveProdBranch = order.production_branch_id || manifest.destination_branch_id;
        const latestCompletedOutbound = getLatestCompletedOutbound(
          order.id,
          history,
          order.branch_id,
          effectiveProdBranch
        );
        if (latestCompletedOutbound) {
          const latestCompletedReturn = getLatestCompletedReturn(
            order.id,
            history,
            order.branch_id,
            effectiveProdBranch
          );
          const outTime = latestCompletedOutbound.manifest.received_at || latestCompletedOutbound.received_at || '';
          const retTime = latestCompletedReturn
            ? (latestCompletedReturn.manifest.received_at || latestCompletedReturn.received_at || '')
            : '';
          if (latestCompletedReturn && retTime >= outTime && !hasApprovedRework) {
            throw new Error(
              `Outbound route violation: Order ${order.order_number || order.id} requires an active approved rework request for additional outbound transit.`
            );
          }
        }
        throw new Error(
          `Outbound route violation: Order ${order.order_number || order.id} is not eligible for outbound dispatch from ${manifest.source_branch_id} to ${manifest.destination_branch_id}.`
        );
      }
    } else if (direction === 'RETURN') {
      if (
        !isReturnTransitEligible(
          order,
          manifest.source_branch_id,
          manifest.destination_branch_id,
          history
        )
      ) {
        throw new Error(
          `Return route violation: Order ${order.order_number || order.id} cannot be returned from ${manifest.source_branch_id} to ${manifest.destination_branch_id}. Verify that a prior outbound manifest was RECEIVED.`
        );
      }
    } else {
      throw new Error(
        `Cross-branch violation: Order ${order.order_number || order.id} (branch ${order.branch_id}, production ${order.production_branch_id || 'N/A'}) is not eligible for manifest route ${manifest.source_branch_id} -> ${manifest.destination_branch_id}.`
      );
    }
  } else {
    // If destination not yet assigned, check if source is either branch_id or production_branch_id
    if (
      order.branch_id !== manifest.source_branch_id &&
      order.production_branch_id !== manifest.source_branch_id
    ) {
      throw new Error(
        `Cross-branch violation: Order ${order.order_number || order.id} belongs to branch ${order.branch_id}, but manifest source branch is ${manifest.source_branch_id}.`
      );
    }
  }
}

/**
 * Pure domain validation asserting that a manifest is not in a terminal state (RECEIVED or CANCELLED)
 * and can accept metadata modifications.
 */
export function assertManifestMutable(manifest: { id: string; status: TransitManifestStatus }): void {
  if (manifest.status === 'RECEIVED') {
    throw new ManifestTransitionError(
      manifest.status,
      manifest.status,
      `Illegal operation: Manifest ${manifest.id} is already RECEIVED and is strictly immutable.`
    );
  }
  if (manifest.status === 'CANCELLED') {
    throw new ManifestTransitionError(
      manifest.status,
      manifest.status,
      `Illegal operation: Manifest ${manifest.id} is CANCELLED and is strictly immutable.`
    );
  }
}

/**
 * Pure domain validation asserting that items on a manifest can be modified or inspected.
 * Once parent manifest is RECEIVED or CANCELLED, items are strictly locked.
 */
export function assertManifestItemMutable(parentManifest: { id: string; status: TransitManifestStatus }): void {
  if (parentManifest.status === 'RECEIVED') {
    throw new ManifestTransitionError(
      parentManifest.status,
      parentManifest.status,
      `Illegal operation: Parent manifest ${parentManifest.id} is already RECEIVED. Manifest items are strictly immutable.`
    );
  }
  if (parentManifest.status === 'CANCELLED') {
    throw new ManifestTransitionError(
      parentManifest.status,
      parentManifest.status,
      `Illegal operation: Parent manifest ${parentManifest.id} is CANCELLED. Manifest items cannot be modified.`
    );
  }
}

/**
 * Pure domain validation asserting that items can be removed from a manifest.
 * Items can ONLY be removed while the manifest is in DRAFT status.
 */
export function assertManifestCanRemoveItem(parentManifest: { id: string; status: TransitManifestStatus }): void {
  if (parentManifest.status !== 'DRAFT') {
    throw new ManifestTransitionError(
      parentManifest.status,
      parentManifest.status,
      `Cannot delete item from manifest ${parentManifest.id} with status '${parentManifest.status}'. Items can only be removed while in DRAFT.`
    );
  }
}

/**
 * Pure domain validation asserting that a manifest route (source/destination branch) can be modified.
 * If source_branch_id changes, no items can be attached to the manifest.
 */
export function assertManifestRouteMutable(
  manifest: { id: string; status: TransitManifestStatus; source_branch_id: string; destination_branch_id: string },
  newSourceBranchId?: string,
  newDestinationBranchId?: string,
  itemCount: number = 0
): void {
  assertManifestMutable(manifest);

  if (manifest.status === 'IN_TRANSIT') {
    if (
      (newSourceBranchId && newSourceBranchId !== manifest.source_branch_id) ||
      (newDestinationBranchId && newDestinationBranchId !== manifest.destination_branch_id)
    ) {
      throw new ManifestTransitionError(
        manifest.status,
        manifest.status,
        `Cannot alter source or destination branch of manifest ${manifest.id} while IN_TRANSIT.`
      );
    }
  }

  if (newSourceBranchId && newSourceBranchId !== manifest.source_branch_id) {
    if (itemCount > 0) {
      throw new ManifestTransitionError(
        manifest.status,
        manifest.status,
        `Cannot modify source_branch_id of manifest ${manifest.id} while items are attached. Remove all items before changing source branch.`
      );
    }
  }
}

/**
 * Pure domain validation asserting that a manifest can be deleted.
 * In LaundryFlow SaaS ERP, manifests are append-only audit documents.
 * Terminal states (RECEIVED, CANCELLED) and active states (IN_TRANSIT, READY_TO_DISPATCH, DRAFT) cannot be deleted.
 */
export function assertManifestDeletable(
  manifest: { id: string; status: TransitManifestStatus }
): void {
  if (manifest.status === 'RECEIVED') {
    throw new ManifestTransitionError(
      manifest.status,
      manifest.status,
      `Illegal operation: Manifest ${manifest.id} is already RECEIVED and cannot be deleted.`
    );
  }
  if (manifest.status === 'CANCELLED') {
    throw new ManifestTransitionError(
      manifest.status,
      manifest.status,
      `Illegal operation: Manifest ${manifest.id} is CANCELLED and cannot be deleted.`
    );
  }
  if (manifest.status === 'IN_TRANSIT' || manifest.status === 'READY_TO_DISPATCH') {
    throw new ManifestTransitionError(
      manifest.status,
      manifest.status,
      `Illegal operation: Manifest ${manifest.id} is in active status ${manifest.status} and cannot be deleted.`
    );
  }
  throw new ManifestTransitionError(
    manifest.status,
    manifest.status,
    `Illegal operation: Manifest ${manifest.id} is in DRAFT status and cannot be deleted. Cancel manifest to preserve audit trail.`
  );
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
