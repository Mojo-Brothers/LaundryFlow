// ============================================================================
// Production State Machine & Invariant Enforcer (Domain Rules & Contracts)
// Step 4C.3.3 Contract Reconciliation
// ============================================================================

import {
  ProductionStage,
  ProductionStageTransitionType,
  ProductionJobStatus,
  WorkItemStatus,
  SplitReason,
  ServiceUnit,
  OrderStatus,
} from '../types/database';

export const ALLOWED_PRODUCTION_STAGES: readonly ProductionStage[] = [
  'WASHING',
  'DRYING',
  'IRONING',
  'PACKED',
  'SPECIAL_TREATMENT',
] as const;

export const ALLOWED_TRANSITION_TYPES: readonly ProductionStageTransitionType[] = [
  'START',
  'ADVANCE',
  'QC_PASS',
  'QC_FAIL',
  'SPLIT',
  'CANCEL',
] as const;

export const ALLOWED_SPLIT_REASONS: readonly SplitReason[] = [
  'CAPACITY_OVERFLOW',
  'QC_DEFECT_ISOLATION',
  'TREATMENT_SEGREGATION',
] as const;

export class ProductionDomainError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'ProductionDomainError';
  }
}

/**
 * Validates stage transition type against frozen enum
 */
export function assertValidTransitionType(type: string): asserts type is ProductionStageTransitionType {
  if (!ALLOWED_TRANSITION_TYPES.includes(type as ProductionStageTransitionType)) {
    throw new ProductionDomainError(
      `Illegal transition type '${type}'. Allowed types: ${ALLOWED_TRANSITION_TYPES.join(', ')}`,
      'INVALID_TRANSITION_TYPE'
    );
  }
}

/**
 * Validates that a split reason is present and matches the frozen enum
 */
export function assertValidSplitReason(reason: unknown): asserts reason is SplitReason {
  if (!reason || typeof reason !== 'string' || !ALLOWED_SPLIT_REASONS.includes(reason as SplitReason)) {
    throw new ProductionDomainError(
      `Invalid or missing split reason: '${String(reason)}'. Must be one of: ${ALLOWED_SPLIT_REASONS.join(', ')}`,
      'INVALID_SPLIT_REASON'
    );
  }
}

/**
 * Validates split quantities and exact quantity conservation
 */
export function validateSplitQuantities(
  parentQuantity: number,
  childQuantities: number[],
  unit: ServiceUnit
): { valid: boolean; totalChildQuantity: number } {
  if (!childQuantities || childQuantities.length < 2) {
    throw new ProductionDomainError('Split operation requires at least 2 child quantities.', 'SPLIT_MIN_PARTS');
  }

  let sum = 0;
  for (const qty of childQuantities) {
    if (qty <= 0) {
      throw new ProductionDomainError(`Child split quantity must be strictly > 0 (got ${qty})`, 'SPLIT_NON_POSITIVE');
    }

    if (unit === 'PCS' || unit === 'SET') {
      if (!Number.isInteger(qty)) {
        throw new ProductionDomainError(
          `Unit '${unit}' requires whole integer quantities (got ${qty})`,
          'SPLIT_INTEGER_UNIT_VIOLATION'
        );
      }
    }

    // Round each part to 2 decimal places to avoid floating point imprecision
    sum = Math.round((sum + qty) * 100) / 100;
  }

  const roundedParent = Math.round(parentQuantity * 100) / 100;
  if (sum !== roundedParent) {
    throw new ProductionDomainError(
      `Quantity conservation violation: Sum of split parts (${sum}) does not equal parent quantity (${roundedParent}).`,
      'QUANTITY_CONSERVATION_VIOLATION'
    );
  }

  return { valid: true, totalChildQuantity: sum };
}

/**
 * Validates that QC_FAIL targets a valid non-terminal remediation stage
 */
export function assertValidQcRemediation(
  remediationStage: string | null | undefined,
  serviceStages: ProductionStage[]
): asserts remediationStage is ProductionStage {
  if (!remediationStage) {
    throw new ProductionDomainError('Remediation stage is mandatory when QC fails.', 'MISSING_REMEDIATION_STAGE');
  }

  if (remediationStage === 'PACKED') {
    throw new ProductionDomainError(
      'Invalid remediation stage: QC_FAIL cannot target terminal PACKED stage.',
      'INVALID_REMEDIATION_STAGE'
    );
  }

  if (!serviceStages.includes(remediationStage as ProductionStage)) {
    throw new ProductionDomainError(
      `Stage '${remediationStage}' is not a valid remediation stage for this service workflow.`,
      'STAGE_NOT_IN_SERVICE_WORKFLOW'
    );
  }
}

/**
 * Derives resulting commercial order status upon production completion.
 * Local production (origin = workshop): READY.
 * Central production (origin != workshop): WASHING (until return transit receipt at origin).
 */
export function deriveProductionCompletionOrderStatus(
  originBranchId: string,
  productionBranchId: string
): OrderStatus {
  if (originBranchId === productionBranchId) {
    return 'READY';
  }
  return 'WASHING';
}

export interface SimulatedStageLog {
  from_stage: ProductionStage | null;
  to_stage: ProductionStage;
  transition_type: ProductionStageTransitionType;
  notes: string;
}

export interface SimpleProductionSimulationResult {
  job_status: ProductionJobStatus;
  work_item_status: WorkItemStatus;
  current_stage: ProductionStage;
  stage_logs: SimulatedStageLog[];
  order_status: OrderStatus;
  is_local: boolean;
}

/**
 * Simulates Simple Mode server-side sequential stage progression (Option B).
 * Advances item stage-by-stage using 'ADVANCE' until 'PACKED', then completes job.
 */
export function simulateSimpleProductionWorkflow(params: {
  originBranchId: string;
  productionBranchId: string;
  initialStage: ProductionStage;
  serviceStages: ProductionStage[];
}): SimpleProductionSimulationResult {
  const { originBranchId, productionBranchId, initialStage, serviceStages } = params;

  let currentIdx = serviceStages.indexOf(initialStage);
  if (currentIdx === -1) {
    throw new ProductionDomainError(`Initial stage '${initialStage}' not in service stages.`);
  }

  const stageLogs: SimulatedStageLog[] = [
    {
      from_stage: null,
      to_stage: initialStage,
      transition_type: 'START',
      notes: 'Initial production start',
    },
  ];

  let currentStage = initialStage;
  let workItemStatus: WorkItemStatus = 'IN_PROGRESS';

  // Sequential progression through remaining stages
  for (let idx = currentIdx + 1; idx < serviceStages.length; idx++) {
    const fromStage = currentStage;
    const targetStage = serviceStages[idx];
    const isTerminal = idx === serviceStages.length - 1 && targetStage === 'PACKED';

    currentStage = targetStage;
    currentIdx = idx;

    if (isTerminal) {
      workItemStatus = 'COMPLETED';
    }

    // Step uses strictly valid 'ADVANCE' transition
    assertValidTransitionType('ADVANCE');
    stageLogs.push({
      from_stage: fromStage,
      to_stage: targetStage,
      transition_type: 'ADVANCE',
      notes: `Automated progression to ${targetStage}`,
    });
  }

  const orderStatus = deriveProductionCompletionOrderStatus(originBranchId, productionBranchId);

  return {
    job_status: 'COMPLETED',
    work_item_status: workItemStatus,
    current_stage: currentStage,
    stage_logs: stageLogs,
    order_status: orderStatus,
    is_local: originBranchId === productionBranchId,
  };
}
