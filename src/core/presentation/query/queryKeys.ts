// ============================================================================
// LaundryFlow Presentation Layer — Centralized Query Keys Architecture
// (Zero hardcoded query key strings, hierarchical invalidation paths)
// ============================================================================

import { TransitManifestFiltersDTO } from '../../application/laundryApplicationService';

export const transitKeys = {
  all: ['transit'] as const,
  lists: () => [...transitKeys.all, 'list'] as const,
  list: (filters?: TransitManifestFiltersDTO) => [...transitKeys.lists(), filters ?? {}] as const,
  details: () => [...transitKeys.all, 'detail'] as const,
  detail: (id: string) => [...transitKeys.details(), id] as const,
  eligibleOrders: (sourceBranchId: string, destinationBranchId?: string) =>
    [...transitKeys.all, 'eligible-orders', sourceBranchId, destinationBranchId ?? 'all'] as const,
  history: (manifestId: string) => [...transitKeys.all, 'history', manifestId] as const,
};

export const shiftKeys = {
  all: ['shift'] as const,
  actives: () => [...shiftKeys.all, 'active'] as const,
  active: (branchId: string) => [...shiftKeys.actives(), branchId] as const,
  summaries: () => [...shiftKeys.all, 'summary'] as const,
  summary: (shiftId: string) => [...shiftKeys.summaries(), shiftId] as const,
};

export const productionKeys = {
  all: ['production'] as const,
  jobs: () => [...productionKeys.all, 'job'] as const,
  byOrder: (orderId: string) => [...productionKeys.jobs(), 'order', orderId] as const,
  byId: (jobId: string) => [...productionKeys.jobs(), 'id', jobId] as const,
  byWorkshop: (workshopBranchId: string) =>
    [...productionKeys.all, 'workshop', workshopBranchId] as const,
};

export const orderKeys = {
  all: ['orders'] as const,
  lists: () => [...orderKeys.all, 'list'] as const,
  list: (branchId?: string) => [...orderKeys.lists(), branchId ?? 'all'] as const,
  details: () => [...orderKeys.all, 'detail'] as const,
  detail: (id: string) => [...orderKeys.details(), id] as const,
  workshop: (branchId?: string) => [...orderKeys.all, 'workshop', branchId ?? 'all'] as const,
};
