// ============================================================================
// LaundryFlow Presentation Layer — Transit Manifest TanStack Query Hooks
// (Strict use-case delegation: UI -> Hook -> Application Service -> Repository)
// ============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  applicationService,
  CreateTransitManifestDTO,
  TransitManifestFiltersDTO,
  TransitionTransitManifestDTO,
  ReceiveTransitManifestDTO,
} from '../../application/laundryApplicationService';
import { transitKeys } from './queryKeys';
import { TransitManifest, TransitManifestHistory, Order } from '../../types/database';

// ============================================================================
// Transit Query Hooks
// ============================================================================

/**
 * Hook to list transit manifests with optional filters (status, branches, search).
 */
export function useTransitManifests(filters?: TransitManifestFiltersDTO) {
  return useQuery<TransitManifest[], Error>({
    queryKey: transitKeys.list(filters),
    queryFn: () => applicationService.listTransitManifests(filters),
  });
}

/**
 * Hook to retrieve a single transit manifest with full item details & branch hydration.
 */
export function useTransitManifest(manifestId: string | undefined | null) {
  const id = manifestId?.trim();
  return useQuery<TransitManifest | null, Error>({
    queryKey: transitKeys.detail(id || ''),
    queryFn: () => applicationService.getTransitManifest(id!),
    enabled: Boolean(id && id.length > 0),
  });
}

/**
 * Hook to fetch orders at source branch that are eligible for transit dispatch.
 */
export function useEligibleTransitOrders(
  sourceBranchId: string | undefined | null,
  destinationBranchId?: string
) {
  const src = sourceBranchId?.trim();
  return useQuery<Order[], Error>({
    queryKey: transitKeys.eligibleOrders(src || '', destinationBranchId),
    queryFn: () => applicationService.getEligibleTransitOrders(src!, destinationBranchId),
    enabled: Boolean(src && src.length > 0),
  });
}

/**
 * Hook to retrieve immutable transit status transition history.
 */
export function useTransitManifestHistory(manifestId: string | undefined | null) {
  const id = manifestId?.trim();
  return useQuery<TransitManifestHistory[], Error>({
    queryKey: transitKeys.history(id || ''),
    queryFn: () => applicationService.getTransitManifestHistory(id!),
    enabled: Boolean(id && id.length > 0),
  });
}

// ============================================================================
// Transit Mutation Hooks
// ============================================================================

/**
 * Hook to create a new transit manifest draft.
 * Invalidation Matrix:
 * - transit lists
 * - eligible orders
 */
export function useCreateTransitManifest() {
  const queryClient = useQueryClient();

  return useMutation<TransitManifest, Error, CreateTransitManifestDTO>({
    mutationFn: (input) => applicationService.createTransitManifest(input),
    onSuccess: () => {
      // Invalidate manifest lists
      queryClient.invalidateQueries({ queryKey: transitKeys.lists() });
      // Invalidate eligible orders queries as items are now assigned to draft
      queryClient.invalidateQueries({
        queryKey: [...transitKeys.all, 'eligible-orders'],
      });
    },
  });
}

/**
 * Hook to orchestrate manifest lifecycle state transition.
 * Invalidation Matrix:
 * - manifest detail
 * - manifest lists
 * - manifest history
 */
export function useTransitionTransitManifest() {
  const queryClient = useQueryClient();

  return useMutation<TransitManifest, Error, TransitionTransitManifestDTO>({
    mutationFn: (input) => applicationService.transitionTransitManifest(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: transitKeys.detail(data.id) });
      queryClient.invalidateQueries({ queryKey: transitKeys.lists() });
      queryClient.invalidateQueries({ queryKey: transitKeys.history(data.id) });
      queryClient.invalidateQueries({
        queryKey: [...transitKeys.all, 'eligible-orders'],
      });
    },
  });
}

/**
 * Hook to receive manifest with item-level discrepancy inspection.
 * Invalidation Matrix:
 * - manifest detail
 * - manifest lists
 * - manifest history
 * - eligible orders
 */
export function useReceiveTransitManifest() {
  const queryClient = useQueryClient();

  return useMutation<TransitManifest, Error, ReceiveTransitManifestDTO>({
    mutationFn: (input) => applicationService.receiveTransitManifest(input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: transitKeys.detail(data.id) });
      queryClient.invalidateQueries({ queryKey: transitKeys.lists() });
      queryClient.invalidateQueries({ queryKey: transitKeys.history(data.id) });
      queryClient.invalidateQueries({
        queryKey: [...transitKeys.all, 'eligible-orders'],
      });
    },
  });
}
