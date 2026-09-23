// ============================================================================
// LaundryFlow Presentation Layer — Production Domain TanStack Query Hooks
// (Strict use-case delegation: UI -> Hook -> Application Service -> Repository)
// ============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { applicationService } from '../../application/laundryApplicationService';
import { productionKeys, orderKeys } from './queryKeys';
import {
  ProductionJob,
  ProductionStage,
  SplitReason,
  WorkshopProductionReadModel,
} from '../../types/database';

// ============================================================================
// Mutation Input DTOs
// ============================================================================

export interface AdvanceWorkItemInput {
  workItemId: string;
  notes?: string;
}

export interface SplitWorkItemInput {
  workItemId: string;
  splitQuantities: number[];
  splitReason: SplitReason;
  notes?: string;
}

export interface EvaluateQCInput {
  workItemId: string;
  passed: boolean;
  remediationStage?: ProductionStage;
  notes?: string;
}

// ============================================================================
// Production Query Hooks
// ============================================================================

/**
 * Hook to retrieve the active or latest ProductionJob for an order.
 * Disabled when orderId is empty or undefined.
 */
export function useProductionJob(orderId: string | undefined | null) {
  const cleanId = orderId?.trim();
  return useQuery<ProductionJob | null, Error>({
    queryKey: productionKeys.byOrder(cleanId || ''),
    queryFn: () => applicationService.getProductionJob(cleanId!),
    enabled: Boolean(cleanId && cleanId.length > 0),
  });
}

/**
 * Hook to retrieve a ProductionJob by its primary key UUID.
 * Disabled when jobId is empty or undefined.
 */
export function useProductionJobById(jobId: string | undefined | null) {
  const cleanId = jobId?.trim();
  return useQuery<ProductionJob | null, Error>({
    queryKey: productionKeys.byId(cleanId || ''),
    queryFn: () => applicationService.getProductionJobById(cleanId!),
    enabled: Boolean(cleanId && cleanId.length > 0),
  });
}

/**
 * Hook to retrieve the active workshop production read model.
 * Disabled when workshopBranchId is empty or undefined.
 */
export function useWorkshopProduction(workshopBranchId: string | undefined | null) {
  const cleanId = workshopBranchId?.trim();
  return useQuery<WorkshopProductionReadModel, Error>({
    queryKey: productionKeys.byWorkshop(cleanId || ''),
    queryFn: () => applicationService.getWorkshopProduction(cleanId!),
    enabled: Boolean(cleanId && cleanId.length > 0),
  });
}

// ============================================================================
// Production Mutation Hooks
// ============================================================================

/**
 * Hook to initialize a production job for an order.
 * Invalidation Matrix:
 * - production query for the order
 * - all production jobs
 * - all order queries (order milestone status projects to WASHING)
 */
export function useStartProduction() {
  const queryClient = useQueryClient();

  return useMutation<ProductionJob, Error, string>({
    mutationFn: (orderId: string) => applicationService.startProduction(orderId),
    onSuccess: (data, orderId) => {
      const cleanOrderId = orderId.trim();
      queryClient.invalidateQueries({ queryKey: productionKeys.byOrder(cleanOrderId) });
      queryClient.invalidateQueries({ queryKey: productionKeys.byId(data.id) });
      queryClient.invalidateQueries({ queryKey: productionKeys.all });
      queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

/**
 * Hook to advance a work item sequentially to its next stage.
 * Invalidation Matrix:
 * - all production queries (stage progression & stage logs update)
 */
export function useAdvanceWorkItem() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, AdvanceWorkItemInput>({
    mutationFn: (input) => applicationService.advanceWorkItem(input.workItemId, input.notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productionKeys.all });
    },
  });
}

/**
 * Hook to split a work item into child batches.
 * Invalidation Matrix:
 * - all production queries (parent marked SPLIT, child work items created)
 */
export function useSplitWorkItem() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, SplitWorkItemInput>({
    mutationFn: (input) =>
      applicationService.splitWorkItem(
        input.workItemId,
        input.splitQuantities,
        input.splitReason,
        input.notes
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productionKeys.all });
    },
  });
}

/**
 * Hook to evaluate quality control for a work item at PACKED stage.
 * Invalidation Matrix:
 * - all production queries (QC pass status or remediation stage rewind logged)
 */
export function useEvaluateQC() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, EvaluateQCInput>({
    mutationFn: (input) =>
      applicationService.evaluateQC(
        input.workItemId,
        input.passed,
        input.remediationStage,
        input.notes
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productionKeys.all });
    },
  });
}

/**
 * Hook to complete a granular production job.
 * Invalidation Matrix:
 * - production query for this job ID
 * - all production jobs
 * - all order queries (for local orders, status projects to READY)
 */
export function useCompleteProduction() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (jobId: string) => applicationService.completeProduction(jobId),
    onSuccess: (_, jobId) => {
      const cleanJobId = jobId.trim();
      queryClient.invalidateQueries({ queryKey: productionKeys.byId(cleanJobId) });
      queryClient.invalidateQueries({ queryKey: productionKeys.all });
      queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

/**
 * Hook to complete production for an order operating in SIMPLE mode.
 * Invalidation Matrix:
 * - production query for this order ID
 * - all production jobs
 * - all order queries (for local orders, status projects to READY)
 */
export function useCompleteSimpleProduction() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (orderId: string) => applicationService.completeSimpleProduction(orderId),
    onSuccess: (_, orderId) => {
      const cleanOrderId = orderId.trim();
      queryClient.invalidateQueries({ queryKey: productionKeys.byOrder(cleanOrderId) });
      queryClient.invalidateQueries({ queryKey: productionKeys.all });
      queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}
