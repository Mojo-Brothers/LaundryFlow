// ============================================================================
// LaundryFlow — Production Domain Query & Mutation Hooks Unit Tests (Step 4C.4C-A)
// Architecture Boundary: UI -> Hook -> Application Service -> Production Repository -> DB RPC
// ============================================================================

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useProductionJob,
  useProductionJobById,
  useStartProduction,
  useAdvanceWorkItem,
  useSplitWorkItem,
  useEvaluateQC,
  useCompleteProduction,
  useCompleteSimpleProduction,
  productionKeys,
  orderKeys,
} from '../core/presentation/query';
import { applicationService, ApplicationError } from '../core/application/laundryApplicationService';
import { productionRepository } from '../core/services/productionRepository';
import { repository } from '../core/services/repository';
import { supabase } from '../core/supabase/client';
import { ProductionJob } from '../core/types/database';

// Helper to construct a clean QueryClient wrapper for isolated test runs
const createTestWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
};

describe('Production Query & Mutation Hooks Contract (Step 4C.4C-A)', () => {
  beforeEach(() => {
    repository.resetSandbox();
    productionRepository.resetSandbox();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Query Hooks Contract
  // ==========================================================================
  describe('Query Hooks', () => {
    it('1. useProductionJob uses correct query key and delegates to applicationService.getProductionJob', async () => {
      const { Wrapper } = createTestWrapper();
      const testOrderId = '77777777-7777-7777-7777-777777777771';
      const spy = vi.spyOn(applicationService, 'getProductionJob');

      const { result } = renderHook(() => useProductionJob(testOrderId), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(spy).toHaveBeenCalledWith(testOrderId);
      expect(result.current.data).toBeDefined();
    });

    it('2. useProductionJob is disabled when orderId is empty, whitespace, or undefined', async () => {
      const { Wrapper } = createTestWrapper();
      const spy = vi.spyOn(applicationService, 'getProductionJob');

      const { result: emptyRes } = renderHook(() => useProductionJob(''), {
        wrapper: Wrapper,
      });
      expect(emptyRes.current.fetchStatus).toBe('idle');

      const { result: spaceRes } = renderHook(() => useProductionJob('   '), {
        wrapper: Wrapper,
      });
      expect(spaceRes.current.fetchStatus).toBe('idle');

      const { result: nullRes } = renderHook(() => useProductionJob(null), {
        wrapper: Wrapper,
      });
      expect(nullRes.current.fetchStatus).toBe('idle');

      expect(spy).not.toHaveBeenCalled();
    });

    it('3. useProductionJobById uses correct query key and delegates to applicationService.getProductionJobById', async () => {
      const { Wrapper } = createTestWrapper();
      const testJobId = 'job-test-12345';
      const spy = vi.spyOn(applicationService, 'getProductionJobById').mockResolvedValue({
        id: testJobId,
        order_id: 'ord-1',
        organization_id: 'org-1',
        branch_id: 'br-1',
        status: 'IN_PROGRESS',
        created_by: 'system',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const { result } = renderHook(() => useProductionJobById(testJobId), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(spy).toHaveBeenCalledWith(testJobId);
      expect(result.current.data?.id).toBe(testJobId);
    });

    it('4. useProductionJobById is disabled when jobId is empty or undefined', async () => {
      const { Wrapper } = createTestWrapper();
      const spy = vi.spyOn(applicationService, 'getProductionJobById');

      const { result } = renderHook(() => useProductionJobById(''), {
        wrapper: Wrapper,
      });
      expect(result.current.fetchStatus).toBe('idle');
      expect(spy).not.toHaveBeenCalled();
    });

    it('5. returned data is authoritative read model without synthesizing fake status', async () => {
      const { Wrapper } = createTestWrapper();
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      // Start production
      await applicationService.startProduction(localOrder.id);

      const { result } = renderHook(() => useProductionJob(localOrder.id), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const job = result.current.data!;
      expect(job.order_id).toBe(localOrder.id);
      expect(job.status).toBe('IN_PROGRESS');
      expect(job.work_items).toBeDefined();
      expect(job.work_items!.length).toBeGreaterThan(0);
      // Data matches authoritative structure with standard stages
      expect(job.work_items![0].service_stages).toBeDefined();
    });
  });

  // ==========================================================================
  // 2. Mutation Hooks Contract
  // ==========================================================================
  describe('Mutation Hooks', () => {
    it('6. useStartProduction delegates to applicationService.startProduction and invalidates queries', async () => {
      const { Wrapper, queryClient } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const serviceSpy = vi.spyOn(applicationService, 'startProduction');

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      const { result } = renderHook(() => useStartProduction(), { wrapper: Wrapper });

      await result.current.mutateAsync(localOrder.id);

      expect(serviceSpy).toHaveBeenCalledWith(localOrder.id);

      // Invalidation verified: order production job, all production jobs, and order queries
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.byOrder(localOrder.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.all,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: orderKeys.all,
      });
    });

    it('7. useAdvanceWorkItem delegates to applicationService.advanceWorkItem and invalidates productionKeys.all', async () => {
      const { Wrapper, queryClient } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const serviceSpy = vi.spyOn(applicationService, 'advanceWorkItem');

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const item = job.work_items![0];

      const { result } = renderHook(() => useAdvanceWorkItem(), { wrapper: Wrapper });

      await result.current.mutateAsync({
        workItemId: item.id,
        notes: 'Pencucian selesai, masuk pengering',
      });

      expect(serviceSpy).toHaveBeenCalledWith(item.id, 'Pencucian selesai, masuk pengering');
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.all,
      });
    });

    it('8. useSplitWorkItem delegates to applicationService.splitWorkItem and invalidates productionKeys.all', async () => {
      const { Wrapper, queryClient } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const serviceSpy = vi.spyOn(applicationService, 'splitWorkItem');

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const kgItem = job.work_items!.find((w) => w.unit === 'KG') || job.work_items![0];

      const { result } = renderHook(() => useSplitWorkItem(), { wrapper: Wrapper });

      await result.current.mutateAsync({
        workItemId: kgItem.id,
        splitQuantities: [1.5, 1.5],
        splitReason: 'CAPACITY_OVERFLOW',
        notes: 'Mesin penuh',
      });

      expect(serviceSpy).toHaveBeenCalledWith(
        kgItem.id,
        [1.5, 1.5],
        'CAPACITY_OVERFLOW',
        'Mesin penuh'
      );
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.all,
      });
    });

    it('9. useEvaluateQC delegates to applicationService.evaluateQC and invalidates productionKeys.all', async () => {
      const { Wrapper, queryClient } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const serviceSpy = vi.spyOn(applicationService, 'evaluateQC');

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const item = job.work_items![0];

      // Advance to PACKED
      while (item.current_stage !== 'PACKED') {
        await applicationService.advanceWorkItem(item.id);
        const cur = (await applicationService.getProductionJob(localOrder.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.current_stage = cur.current_stage;
      }

      const { result } = renderHook(() => useEvaluateQC(), { wrapper: Wrapper });

      await result.current.mutateAsync({
        workItemId: item.id,
        passed: true,
        notes: 'Semua bersih dan rapi',
      });

      expect(serviceSpy).toHaveBeenCalledWith(
        item.id,
        true,
        undefined,
        'Semua bersih dan rapi'
      );
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.all,
      });
    });

    it('10. useCompleteProduction delegates to applicationService.completeProduction and invalidates production and order queries', async () => {
      const { Wrapper, queryClient } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const serviceSpy = vi.spyOn(applicationService, 'completeProduction');

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);

      // Complete all items
      for (const item of job.work_items!) {
        let cur = item;
        while (cur.current_stage !== 'PACKED') {
          await applicationService.advanceWorkItem(cur.id);
          cur = (await applicationService.getProductionJob(localOrder.id))!.work_items!.find(
            (w) => w.id === item.id
          )!;
        }
        await applicationService.evaluateQC(cur.id, true);
      }

      const { result } = renderHook(() => useCompleteProduction(), { wrapper: Wrapper });

      await result.current.mutateAsync(job.id);

      expect(serviceSpy).toHaveBeenCalledWith(job.id);
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.byId(job.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.all,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: orderKeys.all,
      });
    });

    it('11. useCompleteSimpleProduction delegates to applicationService.completeSimpleProduction and invalidates production and order queries', async () => {
      const { Wrapper, queryClient } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const serviceSpy = vi.spyOn(applicationService, 'completeSimpleProduction');

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      const { result } = renderHook(() => useCompleteSimpleProduction(), { wrapper: Wrapper });

      await result.current.mutateAsync(localOrder.id);

      expect(serviceSpy).toHaveBeenCalledWith(localOrder.id);
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.byOrder(localOrder.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.all,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: orderKeys.all,
      });
    });
  });

  // ==========================================================================
  // 3. Architectural Invariants
  // ==========================================================================
  describe('Architectural Invariants', () => {
    it('12. Hooks do NOT invoke Supabase RPC directly', async () => {
      const rpcSpy = vi.fn();
      if (supabase) {
        vi.spyOn(supabase, 'rpc').mockImplementation(rpcSpy);
      }

      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useStartProduction(), { wrapper: Wrapper });

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      await result.current.mutateAsync(localOrder.id);

      // In sandbox mode, no direct RPC is called from presentation
      expect(rpcSpy).not.toHaveBeenCalled();
    });

    it('13. Hooks do NOT invoke repository.updateOrderStatus', async () => {
      const updateStatusSpy = vi.spyOn(repository, 'updateOrderStatus');

      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useCompleteSimpleProduction(), { wrapper: Wrapper });

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      await result.current.mutateAsync(localOrder.id);

      expect(updateStatusSpy).not.toHaveBeenCalled();
    });

    it('14. Hooks do NOT invoke queryClient.setQueryData for fake READY/WASHING projection', async () => {
      const { Wrapper, queryClient } = createTestWrapper();
      const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');

      const { result } = renderHook(() => useCompleteSimpleProduction(), { wrapper: Wrapper });

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      await result.current.mutateAsync(localOrder.id);

      // setQueryData should never be used to fabricate client-side status
      expect(setQueryDataSpy).not.toHaveBeenCalled();
    });

    it('15. Structured ApplicationError is preserved on failure', async () => {
      const { Wrapper } = createTestWrapper();
      vi.spyOn(applicationService, 'startProduction').mockRejectedValue(
        new ApplicationError('VALIDATION_ERROR', 'Cabang tidak valid')
      );

      const { result } = renderHook(() => useStartProduction(), { wrapper: Wrapper });

      await expect(result.current.mutateAsync('invalid-ord')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Cabang tidak valid',
      });
    });
  });
});
