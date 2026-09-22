import { describe, it, expect, beforeEach } from 'vitest';
import { productionRepository } from '../core/services/productionRepository';
import { repository, RepositoryError } from '../core/services/repository';

describe('Production Repository Contract Tests (Step 4C.4A)', () => {
  const OUTLET_BKS = '22222222-2222-2222-2222-222222222221';
  const CENTRAL_PROD = '22222222-2222-2222-2222-222222222223';

  beforeEach(() => {
    repository.resetSandbox();
    productionRepository.resetSandbox();
  });

  describe('1. startProductionJob', () => {
    it('successfully starts a production job for a local order and creates work items', async () => {
      // Find or create local order (branch_id = production_branch_id = OUTLET_BKS)
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id);
      expect(localOrder).toBeDefined();

      const job = await productionRepository.startProductionJob(localOrder!.id);

      expect(job.id).toBeDefined();
      expect(job.order_id).toBe(localOrder!.id);
      expect(job.status).toBe('IN_PROGRESS');
      expect(job.work_items).toBeDefined();
      expect(job.work_items!.length).toBeGreaterThan(0);

      // Check first work item attributes
      const firstItem = job.work_items![0];
      expect(firstItem.job_id).toBe(job.id);
      expect(firstItem.status).toBe('IN_PROGRESS');
      expect(firstItem.service_stages).toBeDefined();
      expect(firstItem.service_stages.length).toBeGreaterThanOrEqual(1);
      expect(firstItem.current_stage).toBe(firstItem.service_stages[0]);
      expect(firstItem.stage_index).toBe(1);
      expect(firstItem.parent_item_id).toBeNull();
      expect(firstItem.split_reason).toBeNull();
      expect(firstItem.stage_logs).toHaveLength(1);
      expect(firstItem.stage_logs![0].transition_type).toBe('START');
    });

    it('is idempotent: calling startProductionJob repeatedly returns the same job', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      const job1 = await productionRepository.startProductionJob(localOrder.id);
      const job2 = await productionRepository.startProductionJob(localOrder.id);

      expect(job1.id).toBe(job2.id);
      expect(job2.work_items?.length).toBe(job1.work_items?.length);
    });

    it('rejects central order production start without physical custody (RECEIVED_OK)', async () => {
      const orders = await repository.getOrders();
      const centralOrder = orders.find((o) => o.branch_id !== o.production_branch_id)!;

      await expect(productionRepository.startProductionJob(centralOrder.id)).rejects.toThrowError(
        RepositoryError
      );
    });
  });

  describe('2. advanceWorkItemStage', () => {
    it('advances a work item sequentially and records an ADVANCE stage log', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const item = job.work_items![0];

      const initialStage = item.current_stage;
      const expectedNextStage = item.service_stages[1];

      await productionRepository.advanceWorkItemStage(item.id, 'Pencucian selesai');

      const updatedJob = await productionRepository.getProductionJobById(job.id);
      const updatedItem = updatedJob!.work_items!.find((w) => w.id === item.id)!;

      expect(updatedItem.current_stage).toBe(expectedNextStage);
      expect(updatedItem.stage_index).toBe(2);

      const latestLog = updatedItem.stage_logs![updatedItem.stage_logs!.length - 1];
      expect(latestLog.from_stage).toBe(initialStage);
      expect(latestLog.to_stage).toBe(expectedNextStage);
      expect(latestLog.transition_type).toBe('ADVANCE');
      expect(latestLog.notes).toBe('Pencucian selesai');
    });

    it('marks the work item COMPLETED when advanced to terminal PACKED stage', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const item = job.work_items![0];

      // Advance until PACKED
      while (item.stage_index < item.service_stages.length) {
        await productionRepository.advanceWorkItemStage(item.id);
        const current = (await productionRepository.getProductionJobById(job.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.stage_index = current.stage_index;
        item.current_stage = current.current_stage;
        item.status = current.status;
      }

      expect(item.current_stage).toBe('PACKED');
      expect(item.status).toBe('COMPLETED');
    });

    it('rejects advancing past the terminal stage', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const item = job.work_items![0];

      // Advance to end
      while (item.stage_index < item.service_stages.length) {
        await productionRepository.advanceWorkItemStage(item.id);
        const current = (await productionRepository.getProductionJobById(job.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.stage_index = current.stage_index;
      }

      await expect(productionRepository.advanceWorkItemStage(item.id)).rejects.toThrowError(
        RepositoryError
      );
    });
  });

  describe('3. splitWorkItem', () => {
    it('splits a parent work item with exact quantity conservation and splitReason', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      // Pick a KG item to test decimal split
      const parentItem = job.work_items!.find((w) => w.unit === 'KG') || job.work_items![0];

      const parentQty = parentItem.quantity;
      const part1 = Math.round((parentQty * 0.4) * 100) / 100;
      const part2 = Math.round((parentQty - part1) * 100) / 100;

      await productionRepository.splitWorkItem(
        parentItem.id,
        [part1, part2],
        'CAPACITY_OVERFLOW',
        'Kapasitas mesin cuci penuh, dibagi 2 batch'
      );

      const updatedJob = await productionRepository.getProductionJobById(job.id);
      const updatedParent = updatedJob!.work_items!.find((w) => w.id === parentItem.id)!;
      expect(updatedParent.status).toBe('SPLIT');

      const childItems = updatedJob!.work_items!.filter((w) => w.parent_item_id === parentItem.id);
      expect(childItems).toHaveLength(2);
      expect(childItems[0].split_reason).toBe('CAPACITY_OVERFLOW');
      expect(childItems[1].split_reason).toBe('CAPACITY_OVERFLOW');
      expect(childItems[0].quantity + childItems[1].quantity).toBe(parentQty);
      expect(childItems[0].status).toBe('IN_PROGRESS');
      expect(childItems[1].status).toBe('IN_PROGRESS');

      // Check stage logs
      const parentLogs = updatedParent.stage_logs!;
      const lastParentLog = parentLogs[parentLogs.length - 1];
      expect(lastParentLog.transition_type).toBe('SPLIT');

      const childLogs = childItems[0].stage_logs!;
      expect(childLogs[0].transition_type).toBe('START');
    });

    it('rejects fractional split for integer units (PCS/SET)', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const pcsItem = job.work_items!.find((w) => w.unit === 'PCS' || w.unit === 'SET')!;

      await expect(
        productionRepository.splitWorkItem(pcsItem.id, [0.5, 0.5], 'CAPACITY_OVERFLOW')
      ).rejects.toThrowError(/Unit 'PCS' membutuhkan kuantitas bulat utuh|integer/i);
    });

    it('rejects split without valid splitReason', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const parentItem = job.work_items!.find((w) => w.unit === 'KG') || job.work_items![0];

      await expect(
        productionRepository.splitWorkItem(parentItem.id, [1, parentItem.quantity - 1], '' as any)
      ).rejects.toThrowError(RepositoryError);
    });

    it('rejects split violating quantity conservation', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const parentItem = job.work_items!.find((w) => w.unit === 'KG') || job.work_items![0];

      await expect(
        productionRepository.splitWorkItem(
          parentItem.id,
          [parentItem.quantity, 1], // sum exceeds parent
          'QC_DEFECT_ISOLATION'
        )
      ).rejects.toThrowError(/Quantity conservation violation/);
    });

    it('rejects splitting a child item (depth limit 1)', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const parentItem = job.work_items!.find((w) => w.unit === 'KG') || job.work_items![0];

      const part1 = Math.round((parentItem.quantity * 0.5) * 100) / 100;
      const part2 = Math.round((parentItem.quantity - part1) * 100) / 100;

      await productionRepository.splitWorkItem(parentItem.id, [part1, part2], 'TREATMENT_SEGREGATION');

      const updatedJob = await productionRepository.getProductionJobById(job.id);
      const childItem = updatedJob!.work_items!.find((w) => w.parent_item_id === parentItem.id)!;

      // Attempt to split child
      await expect(
        productionRepository.splitWorkItem(
          childItem.id,
          [childItem.quantity * 0.5, childItem.quantity * 0.5],
          'TREATMENT_SEGREGATION'
        )
      ).rejects.toThrowError(/Split depth violation/);
    });
  });

  describe('4. qcEvaluateWorkItem', () => {
    it('completes packed item on QC PASS', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const item = job.work_items![0];

      // Advance to PACKED
      while (item.stage_index < item.service_stages.length) {
        await productionRepository.advanceWorkItemStage(item.id);
        const current = (await productionRepository.getProductionJobById(job.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.stage_index = current.stage_index;
        item.current_stage = current.current_stage;
      }

      await productionRepository.qcEvaluateWorkItem(item.id, true, undefined, 'Lolos QC rapi');

      const updated = (await productionRepository.getProductionJobById(job.id))!.work_items!.find(
        (w) => w.id === item.id
      )!;
      expect(updated.status).toBe('COMPLETED');
      const latestLog = updated.stage_logs![updated.stage_logs!.length - 1];
      expect(latestLog.transition_type).toBe('QC_PASS');
    });

    it('rewinds to remediation stage on QC FAIL', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const item = job.work_items![0];

      // Advance to PACKED
      while (item.stage_index < item.service_stages.length) {
        await productionRepository.advanceWorkItemStage(item.id);
        const current = (await productionRepository.getProductionJobById(job.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.stage_index = current.stage_index;
        item.current_stage = current.current_stage;
      }

      const remediationTarget = item.service_stages[0]; // e.g. WASHING
      await productionRepository.qcEvaluateWorkItem(
        item.id,
        false,
        remediationTarget,
        'Noda belum bersih, cuci ulang'
      );

      const updated = (await productionRepository.getProductionJobById(job.id))!.work_items!.find(
        (w) => w.id === item.id
      )!;
      expect(updated.status).toBe('IN_PROGRESS');
      expect(updated.current_stage).toBe(remediationTarget);
      expect(updated.stage_index).toBe(1);

      const latestLog = updated.stage_logs![updated.stage_logs!.length - 1];
      expect(latestLog.transition_type).toBe('QC_FAIL');
      expect(latestLog.to_stage).toBe(remediationTarget);
    });

    it('strictly forbids QC FAIL from targeting PACKED', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);
      const item = job.work_items![0];

      await expect(
        productionRepository.qcEvaluateWorkItem(item.id, false, 'PACKED')
      ).rejects.toThrowError(/tidak dapat menargetkan tahapan akhir PACKED/);
    });
  });

  describe('5. completeProductionJob & completeSimpleProductionJob', () => {
    it('completes local production and updates order status to READY', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      await productionRepository.completeSimpleProductionJob(localOrder.id);

      const updatedJob = await productionRepository.getProductionJobWithItems(localOrder.id);
      expect(updatedJob).toBeDefined();
      expect(updatedJob!.status).toBe('COMPLETED');
      expect(updatedJob!.work_items!.every((w) => w.status === 'COMPLETED')).toBe(true);

      const updatedOrders = await repository.getOrders();
      const updatedOrder = updatedOrders.find((o) => o.id === localOrder.id);
      expect(updatedOrder!.status).toBe('READY');
    });

    it('rejects granular completeProductionJob if items are incomplete', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await productionRepository.startProductionJob(localOrder.id);

      await expect(productionRepository.completeProductionJob(job.id)).rejects.toThrowError(
        /masih terdapat .* work item yang belum selesai/
      );
    });
  });
});
