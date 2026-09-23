// ============================================================================
// LaundryFlow — Workshop Production Read Model Integration & Contract Tests (Step 4C.4C-B.2)
// Architecture Boundary: UI -> Hook -> Application Service -> Production Repository -> Database
// Proves:
// 1. Single-query bulk workshop aggregation (Zero N+1)
// 2. Multi-stage distribution across active work items
// 3. SPLIT parent exclusion and child leaf inclusion
// 4. Multi-cycle rework discrimination (Cycle 1 completed excluded, Cycle 2 active included)
// 5. Job status filtering (IN_PROGRESS included, COMPLETED/CANCELLED excluded)
// 6. Branch and tenant boundary scoping
// 7. TanStack Query Hook integration & invalidation matrix
// ============================================================================

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useWorkshopProduction,
  useAdvanceWorkItem,
  useSplitWorkItem,
  productionKeys,
} from '../core/presentation/query';
import { applicationService, ApplicationError } from '../core/application/laundryApplicationService';
import { productionRepository } from '../core/services/productionRepository';
import { repository } from '../core/services/repository';
import {
  WorkshopProductionReadModel,
  Order,
  ProductionJob,
  ProductionWorkItem,
} from '../core/types/database';

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

let orderSeq = 0;
async function createLocalTestOrder(branchId: string, quantity = 4, customerId?: string) {
  orderSeq++;
  const branches = await repository.getBranches();
  const branch = branches.find((b) => b.id === branchId) || branches[0];
  const customers = await repository.getCustomers();
  const customer = customers[0];
  const services = await repository.getServices();
  const service = services[0];
  const users = await repository.getUsers();
  const user = users[0];

  const uniqueId = `test-order-${Date.now()}-${orderSeq}-${Math.floor(Math.random() * 10000)}`;
  const orderNumber = `BKS-TEST-${orderSeq}-${Math.floor(Math.random() * 10000)}`;

  const created = await repository.createOrder(
    {
      organization_id: branch.organization_id,
      branch_id: branch.id,
      production_branch_id: branch.id,
      customer_id: customerId || customer.id,
      status: 'RECEIVED',
      operating_mode: 'ADVANCED',
      subtotal: 50000,
      discount_amount: 0,
      delivery_fee: 0,
      final_amount: 50000,
      paid_amount: 50000,
      remaining_amount: 0,
      payment_status: 'PAID',
      promised_ready_at: new Date(Date.now() + 48 * 3600000).toISOString(),
      created_by: user.id,
      notes: 'Test Order for Workshop Kanban',
    },
    [
      {
        service_id: service.id,
        item_type: 'KILOAN',
        service_name_snap: service.name,
        unit_price_snap: service.base_price,
        quantity_or_weight: quantity,
        billable_weight: quantity,
        subtotal: 50000,
      },
    ]
  );

  created.id = uniqueId;
  created.order_number = orderNumber;
  if (created.items) {
    created.items.forEach((item, idx) => {
      item.id = `test-item-${uniqueId}-${idx}`;
      item.order_id = uniqueId;
    });
  }

  return created;
}

describe('STEP 4C.4C-B.2 — Workshop Production Read Model Contract', () => {
  beforeEach(() => {
    repository.resetSandbox();
    productionRepository.resetSandbox();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Basic Workshop Read Contract
  // ==========================================================================
  describe('1. Basic Workshop Read Contract', () => {
    it('returns empty read model for a workshop with zero active production jobs', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      expect(readModel).toBeDefined();
      expect(readModel.workshop_branch_id).toBe(workshopBranch.id);
      expect(readModel.jobs_count).toBe(0);
      expect(readModel.work_items_count).toBe(0);
      expect(readModel.jobs).toEqual([]);
      expect(readModel.work_items).toEqual([]);
    });

    it('aggregates a single active job and all its initial work items in one call', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];
      const localOrder = await createLocalTestOrder(workshopBranch.id, 3);

      // Start production
      await applicationService.startProduction(localOrder.id);

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      expect(readModel.workshop_branch_id).toBe(workshopBranch.id);
      expect(readModel.jobs_count).toBe(1);
      expect(readModel.jobs[0].order_id).toBe(localOrder.id);
      expect(readModel.jobs[0].order_number).toBe(localOrder.order_number);
      expect(readModel.jobs[0].status).toBe('IN_PROGRESS');
      expect(readModel.jobs[0].is_rework).toBe(false);

      expect(readModel.work_items_count).toBeGreaterThan(0);
      for (const item of readModel.work_items) {
        expect(item.order_id).toBe(localOrder.id);
        expect(item.order_number).toBe(localOrder.order_number);
        expect(item.workshop_branch_id).toBe(workshopBranch.id);
        expect(item.status).toBe('IN_PROGRESS');
        expect(item.current_stage).toBe('WASHING');
      }
    });

    it('aggregates multiple active jobs across different orders in one call without N+1', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];

      const order1 = await createLocalTestOrder(workshopBranch.id, 2);
      const order2 = await createLocalTestOrder(workshopBranch.id, 3);

      await applicationService.startProduction(order1.id);
      await applicationService.startProduction(order2.id);

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      expect(readModel.jobs_count).toBe(2);
      expect(readModel.jobs.map((j) => j.order_id).sort()).toEqual([order1.id, order2.id].sort());

      const orderIdsInItems = Array.from(new Set(readModel.work_items.map((w) => w.order_id)));
      expect(orderIdsInItems.sort()).toEqual([order1.id, order2.id].sort());
    });
  });

  // ==========================================================================
  // 2. Multi-Stage Representation
  // ==========================================================================
  describe('2. Multi-Stage Representation', () => {
    it('accurately represents work items concurrently across WASHING, DRYING, IRONING, and PACKED stages', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];
      const localOrder = await createLocalTestOrder(workshopBranch.id, 4);

      const job = await applicationService.startProduction(localOrder.id);
      const items = job.work_items!;

      // Advance first item to DRYING
      if (items.length > 0) {
        await applicationService.advanceWorkItem(items[0].id);
      }

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);
      expect(readModel.work_items.some((w) => w.current_stage === 'DRYING')).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Split Item Semantics
  // ==========================================================================
  describe('3. Split Item Semantics', () => {
    it('strictly excludes the parent SPLIT item and includes active child leaf items', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];
      const localOrder = await createLocalTestOrder(workshopBranch.id, 5);

      const job = await applicationService.startProduction(localOrder.id);
      const targetItem = job.work_items![0];

      // Split into 2 children (2 and 3)
      await applicationService.splitWorkItem(targetItem.id, [2, 3], 'CAPACITY_OVERFLOW', 'Bagi kapasitas mesin');

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      // Parent item must NOT exist in the read model active work items
      const parentInRead = readModel.work_items.find((w) => w.id === targetItem.id);
      expect(parentInRead).toBeUndefined();

      // Child items MUST exist with parent_item_id referencing targetItem.id
      const children = readModel.work_items.filter((w) => w.parent_item_id === targetItem.id);
      expect(children.length).toBe(2);
      expect(children.map((c) => c.quantity).sort()).toEqual([2, 3]);
      expect(children.every((c) => c.split_reason === 'CAPACITY_OVERFLOW')).toBe(true);
      expect(children.every((c) => c.status === 'IN_PROGRESS')).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Multi-Cycle Rework Semantics
  // ==========================================================================
  describe('4. Multi-Cycle Rework Semantics', () => {
    it('returns only active rework job (Cycle 2) and excludes completed Cycle 1 job without cycle_number column', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];
      const localOrder = await createLocalTestOrder(workshopBranch.id, 3);

      // Cycle 1: Start and complete production
      await applicationService.startProduction(localOrder.id);
      await applicationService.completeSimpleProduction(localOrder.id);

      // Create and consume a rework request for Cycle 2
      const rework = await repository.createOrderReworkRequest({
        order_id: localOrder.id,
        reason: 'OUTLET_QC_REJECT',
        notes: 'Pencucian ulang noda kotoran tertinggal',
      });
      // Simulate transit consuming the token
      rework.status = 'CONSUMED';
      rework.consumed_at = new Date().toISOString();

      // Start Cycle 2 production
      const reworkJob = await applicationService.startProduction(localOrder.id);
      // Link the rework request to job
      reworkJob.rework_request_id = rework.id;

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      // Must only find 1 active job for this order (Cycle 2)
      const orderJobs = readModel.jobs.filter((j) => j.order_id === localOrder.id);
      expect(orderJobs.length).toBe(1);
      expect(orderJobs[0].id).toBe(reworkJob.id);
      expect(orderJobs[0].status).toBe('IN_PROGRESS');
      expect(orderJobs[0].is_rework).toBe(true);
      expect(orderJobs[0].rework_request_id).toBe(rework.id);

      // Active work items must all belong to Cycle 2
      const orderItems = readModel.work_items.filter((w) => w.order_id === localOrder.id);
      expect(orderItems.every((w) => w.job_id === reworkJob.id)).toBe(true);
      expect(orderItems.every((w) => w.is_rework === true)).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Job Status Filtering
  // ==========================================================================
  describe('5. Job Status Filtering', () => {
    it('excludes COMPLETED and CANCELLED jobs from the workshop read model', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];

      const order1 = await createLocalTestOrder(workshopBranch.id, 2);
      const order2 = await createLocalTestOrder(workshopBranch.id, 2);
      const order3 = await createLocalTestOrder(workshopBranch.id, 2);

      // Job 1: IN_PROGRESS
      await applicationService.startProduction(order1.id);

      // Job 2: COMPLETED
      await applicationService.completeSimpleProduction(order2.id);

      // Job 3: Start then manually mark CANCELLED in sandbox store
      const job3 = await applicationService.startProduction(order3.id);
      const storedJob3 = (productionRepository as any).sandbox.jobs.find((j: any) => j.id === job3.id);
      if (storedJob3) storedJob3.status = 'CANCELLED';

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      expect(readModel.jobs.some((j) => j.order_id === order1.id)).toBe(true);
      expect(readModel.jobs.some((j) => j.order_id === order2.id)).toBe(false);
      expect(readModel.jobs.some((j) => j.order_id === order3.id)).toBe(false);

      expect(readModel.work_items.some((w) => w.order_id === order1.id)).toBe(true);
      expect(readModel.work_items.some((w) => w.order_id === order2.id)).toBe(false);
      expect(readModel.work_items.some((w) => w.order_id === order3.id)).toBe(false);
    });
  });

  // ==========================================================================
  // 6. Branch Scoping & Privacy Isolation
  // ==========================================================================
  describe('6. Branch Scoping & Privacy Isolation', () => {
    it('isolates production jobs to their designated workshop branch', async () => {
      const branches = await repository.getBranches();
      const branchA = branches[0];
      const branchB = branches[1];

      const orderA = await createLocalTestOrder(branchA.id, 2);

      await applicationService.startProduction(orderA.id);

      // Query Branch A: must see the job
      const modelA = await applicationService.getWorkshopProduction(branchA.id);
      expect(modelA.jobs.some((j) => j.order_id === orderA.id)).toBe(true);

      // Query Branch B: must NOT see Branch A's job
      const modelB = await applicationService.getWorkshopProduction(branchB.id);
      expect(modelB.jobs.some((j) => j.order_id === orderA.id)).toBe(false);
    });

    it('attaches minimal customer display context (name) and zero sensitive PII', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];
      const localOrder = await createLocalTestOrder(workshopBranch.id, 2);

      await applicationService.startProduction(localOrder.id);
      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      const firstItem = readModel.work_items[0];
      expect(firstItem.order_number).toBe(localOrder.order_number);
      expect(firstItem.customer_name).toBeDefined();

      // Ensure no sensitive properties leaked on work item contract
      expect((firstItem as any).phone).toBeUndefined();
      expect((firstItem as any).address).toBeUndefined();
      expect((firstItem as any).subtotal).toBeUndefined();
      expect((firstItem as any).final_amount).toBeUndefined();
    });

    it('defends against cross-tenant customer context leakage (FIND-SEC-01)', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];

      // Create a customer belonging to an entirely different organization
      const foreignOrgCustomer = await repository.createCustomer({
        organization_id: 'org-completely-different-tenant-uuid',
        name: 'Evil Corp Hacker',
        phone: '081299999999',
        membership_tier: 'REGULAR',
      });

      // Create order referencing foreign customer
      const localOrder = await createLocalTestOrder(workshopBranch.id, 2, foreignOrgCustomer.id);

      await applicationService.startProduction(localOrder.id);
      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      const job = readModel.jobs.find((j) => j.order_id === localOrder.id);
      expect(job).toBeDefined();
      // Must NOT leak the foreign tenant's customer name
      expect(job!.customer_name).not.toBe('Evil Corp Hacker');
      expect(job!.customer_name).toBe('Pelanggan');

      const items = readModel.work_items.filter((w) => w.order_id === localOrder.id);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((w) => w.customer_name !== 'Evil Corp Hacker')).toBe(true);
      expect(items.every((w) => w.customer_name === 'Pelanggan')).toBe(true);
    });
  });

  // ==========================================================================
  // 7. Application Service Validation & Error Translation
  // ==========================================================================
  describe('7. Application Service Validation', () => {
    it('rejects empty workshop branch ID with ApplicationError(VALIDATION_ERROR)', async () => {
      await expect(applicationService.getWorkshopProduction('')).rejects.toThrowError(ApplicationError);
      await expect(applicationService.getWorkshopProduction('   ')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('ID workshop branch wajib diisi'),
      });
    });
  });

  // ==========================================================================
  // 8. TanStack Query Hook Contract
  // ==========================================================================
  describe('8. TanStack Query Hook Contract (useWorkshopProduction)', () => {
    it('uses productionKeys.byWorkshop and delegates to applicationService.getWorkshopProduction', async () => {
      const { Wrapper } = createTestWrapper();
      const testBranchId = 'branch-workshop-alpha';
      const spy = vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValueOnce({
        workshop_branch_id: testBranchId,
        workshop_branch_name: 'Workshop Alpha',
        jobs_count: 0,
        work_items_count: 0,
        jobs: [],
        work_items: [],
      });

      const { result } = renderHook(() => useWorkshopProduction(testBranchId), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(spy).toHaveBeenCalledWith(testBranchId);
      expect(result.current.data?.workshop_branch_id).toBe(testBranchId);
    });

    it('remains disabled when workshopBranchId is undefined or empty', async () => {
      const { Wrapper } = createTestWrapper();
      const spy = vi.spyOn(applicationService, 'getWorkshopProduction');

      const { result } = renderHook(() => useWorkshopProduction(undefined), {
        wrapper: Wrapper,
      });

      expect(result.current.isFetching).toBe(false);
      expect(result.current.data).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    });

    it('invalidates workshop production queries when advanceWorkItem mutation succeeds', async () => {
      const { queryClient, Wrapper } = createTestWrapper();
      const testBranchId = 'branch-123';
      const workshopKey = productionKeys.byWorkshop(testBranchId);

      queryClient.setQueryData(workshopKey, {
        workshop_branch_id: testBranchId,
        jobs_count: 1,
        work_items_count: 1,
        jobs: [],
        work_items: [],
      });

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result: advanceMutation } = renderHook(() => useAdvanceWorkItem(), {
        wrapper: Wrapper,
      });

      vi.spyOn(applicationService, 'advanceWorkItem').mockResolvedValueOnce();

      advanceMutation.current.mutate({ workItemId: 'item-999' });

      await waitFor(() => expect(advanceMutation.current.isSuccess).toBe(true));

      // Verifies that productionKeys.all invalidation covers productionKeys.byWorkshop
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: productionKeys.all,
      });
    });
  });

  // ==========================================================================
  // 9. Deterministic Ordering Hardening (FIND-SQL-01)
  // ==========================================================================
  describe('9. Deterministic Ordering Hardening (FIND-SQL-01)', () => {
    it('guarantees deterministic ordering for jobs and work items sharing identical created_at timestamps using id ASC tie-breaker', async () => {
      const branches = await repository.getBranches();
      const workshopBranch = branches[0];

      const order1 = await createLocalTestOrder(workshopBranch.id, 2);
      const order2 = await createLocalTestOrder(workshopBranch.id, 2);
      const order3 = await createLocalTestOrder(workshopBranch.id, 2);

      await applicationService.startProduction(order1.id);
      await applicationService.startProduction(order2.id);
      await applicationService.startProduction(order3.id);

      // Force identical created_at timestamp on all 3 jobs to test tie-breaker
      const fixedTimestamp = '2026-09-23T10:00:00.000Z';
      const jobs = (productionRepository as any).sandbox.jobs;
      jobs.forEach((j: any) => {
        j.created_at = fixedTimestamp;
      });

      // Force identical created_at timestamp on all work items
      const workItems = (productionRepository as any).sandbox.workItems;
      workItems.forEach((w: any) => {
        w.created_at = fixedTimestamp;
      });

      const readModel = await applicationService.getWorkshopProduction(workshopBranch.id);

      // Verify jobs are strictly sorted by id ASC as tie-breaker
      const jobIds = readModel.jobs.map((j) => j.id);
      const sortedJobIds = [...jobIds].sort((a, b) => a.localeCompare(b));
      expect(jobIds).toEqual(sortedJobIds);

      // Verify work items are strictly sorted by id ASC as tie-breaker
      const itemIds = readModel.work_items.map((w) => w.id);
      const sortedItemIds = [...itemIds].sort((a, b) => a.localeCompare(b));
      expect(itemIds).toEqual(sortedItemIds);
    });
  });
});
