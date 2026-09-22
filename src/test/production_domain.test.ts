import { describe, it, expect } from 'vitest';
import {
  ALLOWED_PRODUCTION_STAGES,
  ALLOWED_TRANSITION_TYPES,
  ALLOWED_SPLIT_REASONS,
  assertValidTransitionType,
  assertValidSplitReason,
  validateSplitQuantities,
  assertValidQcRemediation,
  deriveProductionCompletionOrderStatus,
  simulateSimpleProductionWorkflow,
  ProductionDomainError,
} from '../core/services/productionStateMachine';
import { ProductionStage } from '../core/types/database';

describe('Production Domain Contract Reconciliation Tests (Step 4C.3.3)', () => {
  describe('1. Stage Transition Types & Enum Safety', () => {
    it('allows all frozen transition types', () => {
      for (const type of ALLOWED_TRANSITION_TYPES) {
        expect(() => assertValidTransitionType(type)).not.toThrow();
      }
    });

    it('strictly rejects illegal "COMPLETE" transition type', () => {
      expect(() => assertValidTransitionType('COMPLETE')).toThrow(ProductionDomainError);
      expect(() => assertValidTransitionType('COMPLETE')).toThrow(/Illegal transition type 'COMPLETE'/);
    });

    it('strictly rejects "DISPATCH" as a stage transition type', () => {
      expect(() => assertValidTransitionType('DISPATCH')).toThrow(ProductionDomainError);
    });

    it('strictly rejects arbitrary unknown transition strings', () => {
      expect(() => assertValidTransitionType('FINISH')).toThrow(ProductionDomainError);
      expect(() => assertValidTransitionType('SKIP')).toThrow(ProductionDomainError);
    });
  });

  describe('2. Split Reason Contract', () => {
    it('accepts all three frozen split reasons', () => {
      expect(() => assertValidSplitReason('CAPACITY_OVERFLOW')).not.toThrow();
      expect(() => assertValidSplitReason('QC_DEFECT_ISOLATION')).not.toThrow();
      expect(() => assertValidSplitReason('TREATMENT_SEGREGATION')).not.toThrow();
    });

    it('rejects missing or undefined split reason', () => {
      expect(() => assertValidSplitReason(null)).toThrow(ProductionDomainError);
      expect(() => assertValidSplitReason(undefined)).toThrow(ProductionDomainError);
      expect(() => assertValidSplitReason('')).toThrow(ProductionDomainError);
    });

    it('rejects invalid or arbitrary split reasons', () => {
      expect(() => assertValidSplitReason('CUSTOMER_REQUEST')).toThrow(ProductionDomainError);
      expect(() => assertValidSplitReason('ACCIDENT')).toThrow(ProductionDomainError);
    });
  });

  describe('3. Split Conservation & Quantity Rules', () => {
    it('succeeds on exact quantity conservation for KG', () => {
      const res = validateSplitQuantities(10.0, [4.5, 5.5], 'KG');
      expect(res.valid).toBe(true);
      expect(res.totalChildQuantity).toBe(10.0);
    });

    it('fails when split sum is less than parent quantity', () => {
      expect(() => validateSplitQuantities(10.0, [4.0, 5.0], 'KG')).toThrow(
        /Quantity conservation violation/
      );
    });

    it('fails when split sum is greater than parent quantity', () => {
      expect(() => validateSplitQuantities(10.0, [4.0, 6.0, 1.0], 'KG')).toThrow(
        /Quantity conservation violation/
      );
    });

    it('fails on zero quantity part', () => {
      expect(() => validateSplitQuantities(10.0, [0, 10.0], 'KG')).toThrow(
        /Child split quantity must be strictly > 0/
      );
    });

    it('fails on negative quantity part', () => {
      expect(() => validateSplitQuantities(10.0, [-2.0, 12.0], 'KG')).toThrow(
        /Child split quantity must be strictly > 0/
      );
    });

    it('fails when split parts count is less than 2', () => {
      expect(() => validateSplitQuantities(10.0, [10.0], 'KG')).toThrow(
        /Split operation requires at least 2 child quantities/
      );
    });

    it('enforces whole integers for PCS and SET units', () => {
      expect(() => validateSplitQuantities(5, [2.5, 2.5], 'PCS')).toThrow(
        /requires whole integer quantities/
      );
      expect(() => validateSplitQuantities(4, [1.5, 2.5], 'SET')).toThrow(
        /requires whole integer quantities/
      );
      expect(validateSplitQuantities(5, [2, 3], 'PCS').valid).toBe(true);
    });
  });

  describe('4. QC_FAIL Remediation Boundary', () => {
    const fullServiceStages: ProductionStage[] = ['WASHING', 'DRYING', 'IRONING', 'PACKED'];

    it('strictly forbids QC_FAIL from targeting terminal PACKED stage', () => {
      expect(() => assertValidQcRemediation('PACKED', fullServiceStages)).toThrow(
        /QC_FAIL cannot target terminal PACKED stage/
      );
    });

    it('rejects missing remediation stage on QC_FAIL', () => {
      expect(() => assertValidQcRemediation(null, fullServiceStages)).toThrow(
        /Remediation stage is mandatory when QC fails/
      );
      expect(() => assertValidQcRemediation(undefined, fullServiceStages)).toThrow(
        /Remediation stage is mandatory when QC fails/
      );
    });

    it('rejects remediation stage that is not part of the service stages', () => {
      expect(() => assertValidQcRemediation('SPECIAL_TREATMENT', fullServiceStages)).toThrow(
        /not a valid remediation stage for this service workflow/
      );
    });

    it('allows rewinding to valid preceding stages', () => {
      expect(() => assertValidQcRemediation('WASHING', fullServiceStages)).not.toThrow();
      expect(() => assertValidQcRemediation('DRYING', fullServiceStages)).not.toThrow();
      expect(() => assertValidQcRemediation('IRONING', fullServiceStages)).not.toThrow();
    });
  });

  describe('5. Production Completion & Commercial READY Projection', () => {
    it('projects READY for local production orders (origin = workshop)', () => {
      const status = deriveProductionCompletionOrderStatus('branch-origin-1', 'branch-origin-1');
      expect(status).toBe('READY');
    });

    it('preserves WASHING for central production orders (origin != workshop)', () => {
      const status = deriveProductionCompletionOrderStatus('branch-retail-origin', 'branch-central-workshop');
      expect(status).toBe('WASHING');
      expect(status).not.toBe('READY');
    });
  });

  describe('6. Simple Mode Regression & State/Audit Integrity', () => {
    const standardStages: ProductionStage[] = ['WASHING', 'DRYING', 'IRONING', 'PACKED'];

    it('simulates local Simple Mode production completion with full audit fidelity', () => {
      const res = simulateSimpleProductionWorkflow({
        originBranchId: 'branch-local-1',
        productionBranchId: 'branch-local-1',
        initialStage: 'WASHING',
        serviceStages: standardStages,
      });

      expect(res.job_status).toBe('COMPLETED');
      expect(res.work_item_status).toBe('COMPLETED');
      expect(res.current_stage).toBe('PACKED');
      expect(res.is_local).toBe(true);
      expect(res.order_status).toBe('READY');

      // Verify audit logs
      expect(res.stage_logs.length).toBe(4); // START, ADVANCE to DRYING, ADVANCE to IRONING, ADVANCE to PACKED
      expect(res.stage_logs[0].transition_type).toBe('START');
      expect(res.stage_logs[1].transition_type).toBe('ADVANCE');
      expect(res.stage_logs[2].transition_type).toBe('ADVANCE');
      expect(res.stage_logs[3].transition_type).toBe('ADVANCE');

      // Crucial: NO illegal COMPLETE and NO fake QC_PASS
      const loggedTransitions = res.stage_logs.map((l) => l.transition_type);
      expect(loggedTransitions).not.toContain('COMPLETE');
      expect(loggedTransitions).not.toContain('QC_PASS');
    });

    it('simulates central Simple Mode production completion keeping order in WASHING', () => {
      const res = simulateSimpleProductionWorkflow({
        originBranchId: 'outlet-bks',
        productionBranchId: 'workshop-cp',
        initialStage: 'WASHING',
        serviceStages: standardStages,
      });

      expect(res.job_status).toBe('COMPLETED');
      expect(res.work_item_status).toBe('COMPLETED');
      expect(res.current_stage).toBe('PACKED');
      expect(res.is_local).toBe(false);

      // Central workshop MUST NOT set order to READY
      expect(res.order_status).toBe('WASHING');
      expect(res.order_status).not.toBe('READY');
    });
  });
});
