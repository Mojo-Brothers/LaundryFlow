// ============================================================================
// LaundryFlow Presentation Layer — Cashier Shift TanStack Query Hooks
// (Strict use-case delegation: UI -> Hook -> Application Service -> Repository)
// ============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  applicationService,
  OpenShiftDTO,
  CloseShiftDTO,
} from '../../application/laundryApplicationService';
import { shiftKeys } from './queryKeys';
import { CashierShift } from '../../types/database';
import { ShiftReconciliationResult } from '../../services/shiftReconciliation';

// ============================================================================
// Cashier Shift Query Hooks
// ============================================================================

/**
 * Hook to retrieve the currently active OPEN shift for a branch.
 */
export function useActiveShift(branchId: string | undefined | null) {
  const id = branchId?.trim();
  return useQuery<CashierShift | null, Error>({
    queryKey: shiftKeys.active(id || ''),
    queryFn: () => applicationService.getActiveShift(id!),
    enabled: Boolean(id && id.length > 0),
  });
}

/**
 * Hook to retrieve a READ-ONLY preview of a shift's cash reconciliation status.
 * NOTE: This is an informational preview. Authoritative closing occurs via useCloseShift.
 */
export function useShiftSummary(shiftId: string | undefined | null) {
  const id = shiftId?.trim();
  return useQuery<
    ShiftReconciliationResult & { shift: CashierShift; paymentsCount: number },
    Error
  >({
    queryKey: shiftKeys.summary(id || ''),
    queryFn: () => applicationService.getShiftSummary(id!),
    enabled: Boolean(id && id.length > 0),
  });
}

// ============================================================================
// Cashier Shift Mutation Hooks
// ============================================================================

/**
 * Hook to open a new cashier shift with an opening cash amount.
 * Invalidation Matrix:
 * - active shift for the target branch
 */
export function useOpenShift() {
  const queryClient = useQueryClient();

  return useMutation<CashierShift, Error, OpenShiftDTO>({
    mutationFn: (input) => applicationService.openShift(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.active(data.branch_id) });
    },
  });
}

/**
 * Hook to close a cashier shift with physical drawer reconciliation.
 * Invalidation Matrix:
 * - active shift for the branch
 * - shift summary
 * - all shift queries
 */
export function useCloseShift() {
  const queryClient = useQueryClient();

  return useMutation<CashierShift, Error, CloseShiftDTO>({
    mutationFn: (input) => applicationService.closeShift(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: shiftKeys.active(data.branch_id) });
      queryClient.invalidateQueries({ queryKey: shiftKeys.summary(data.id) });
      queryClient.invalidateQueries({ queryKey: shiftKeys.all });
    },
  });
}
