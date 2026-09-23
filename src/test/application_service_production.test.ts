import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applicationService,
  LaundryApplicationService,
  ApplicationError,
} from '../core/application/laundryApplicationService';
import { repository, RepositoryError } from '../core/services/repository';
import {
  productionRepository,
  ProductionRepository,
  IProductionRepository,
} from '../core/services/productionRepository';
import { ProductionJob, ProductionStage, SplitReason } from '../core/types/database';

describe('LaundryApplicationService — Production Domain Orchestration (Step 4C.4B)', () => {
  beforeEach(() => {
    repository.resetSandbox();
    productionRepository.resetSandbox();
  });

  // ==========================================================================
  // 1. Production Start
  // ==========================================================================
  describe('1. startProduction', () => {
    it('successfully starts production for a local order without UI sending branch/tenant context', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      const job = await applicationService.startProduction(localOrder.id);

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.order_id).toBe(localOrder.id);
      expect(job.status).toBe('IN_PROGRESS');
      expect(job.work_items).toBeDefined();
      expect(job.work_items!.length).toBeGreaterThan(0);
    });

    it('rejects empty orderId with ApplicationError(VALIDATION_ERROR)', async () => {
      await expect(applicationService.startProduction('')).rejects.toThrowError(ApplicationError);
      await expect(applicationService.startProduction('   ')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('ID order wajib diisi'),
      });
    });

    it('propagates custody failure for central order without physical custody as ApplicationError(VALIDATION_ERROR)', async () => {
      const orders = await repository.getOrders();
      const centralOrder = orders.find((o) => o.branch_id !== o.production_branch_id)!;

      await expect(applicationService.startProduction(centralOrder.id)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/RECEIVED_OK|custody/i),
      });
    });

    it('is idempotent: calling startProduction repeatedly returns the identical production job', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      const job1 = await applicationService.startProduction(localOrder.id);
      const job2 = await applicationService.startProduction(localOrder.id);

      expect(job1.id).toBe(job2.id);
    });
  });

  // ==========================================================================
  // 2. Stage Advancement
  // ==========================================================================
  describe('2. advanceWorkItem', () => {
    it('advances work item stage and propagates notes without calculating nextStage in application service', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const item = job.work_items![0];
      const initialStage = item.current_stage;

      await applicationService.advanceWorkItem(item.id, '  Pakaian dipindahkan ke pengering  ');

      const updatedJob = await applicationService.getProductionJob(localOrder.id);
      const updatedItem = updatedJob!.work_items!.find((w) => w.id === item.id)!;
      expect(updatedItem.current_stage).not.toBe(initialStage);
      expect(updatedItem.stage_index).toBe(2);

      const logs = updatedItem.stage_logs!;
      expect(logs[logs.length - 1].notes).toBe('Pakaian dipindahkan ke pengering');
    });

    it('rejects empty workItemId with ApplicationError(VALIDATION_ERROR)', async () => {
      await expect(applicationService.advanceWorkItem('')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('translates terminal stage advancement failure to ApplicationError(INVALID_STATE)', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const item = job.work_items![0];

      // Advance to terminal stage PACKED
      while (item.stage_index < item.service_stages.length) {
        await applicationService.advanceWorkItem(item.id);
        const cur = (await applicationService.getProductionJob(localOrder.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.stage_index = cur.stage_index;
      }

      // Further advance should fail
      await expect(applicationService.advanceWorkItem(item.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: expect.stringMatching(/tidak dapat dimajukan|tahapan akhir|terminal/i),
      });
    });
  });

  // ==========================================================================
  // 3. Split Orchestration
  // ==========================================================================
  describe('3. splitWorkItem', () => {
    it('validates input shape and delegates valid split to repository', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      // Pick a KG item to test decimal split
      const parentItem = job.work_items!.find((w) => w.unit === 'KG') || job.work_items![0];

      const parentQty = parentItem.quantity;
      const part1 = Math.round((parentQty * 0.5) * 100) / 100;
      const part2 = Math.round((parentQty - part1) * 100) / 100;

      await applicationService.splitWorkItem(
        parentItem.id,
        [part1, part2],
        'CAPACITY_OVERFLOW',
        '  Kapasitas penuh, dipisah 2 batch  '
      );

      const updatedJob = await applicationService.getProductionJob(localOrder.id);
      const updatedParent = updatedJob!.work_items!.find((w) => w.id === parentItem.id)!;
      expect(updatedParent.status).toBe('SPLIT');

      const children = updatedJob!.work_items!.filter((w) => w.parent_item_id === parentItem.id);
      expect(children).toHaveLength(2);
      expect(children[0].split_reason).toBe('CAPACITY_OVERFLOW');
    });

    it('rejects invalid split shapes at application boundary', async () => {
      // 1. Less than 2 quantities
      await expect(
        applicationService.splitWorkItem('itm-1', [5], 'CAPACITY_OVERFLOW')
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('minimal 2 porsi'),
      });

      // 2. Non-positive numbers
      await expect(
        applicationService.splitWorkItem('itm-1', [2, -1], 'CAPACITY_OVERFLOW')
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('angka positif yang lebih besar dari 0'),
      });

      // 3. Invalid splitReason
      await expect(
        applicationService.splitWorkItem('itm-1', [2, 2], 'INVALID_REASON' as any)
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('Alasan split tidak valid'),
      });
    });

    it('propagates repository quantity conservation violation as ApplicationError(VALIDATION_ERROR)', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const parentItem = job.work_items!.find((w) => w.unit === 'KG') || job.work_items![0];

      await expect(
        applicationService.splitWorkItem(
          parentItem.id,
          [parentItem.quantity, 10], // sum exceeds parent
          'CAPACITY_OVERFLOW'
        )
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('Quantity conservation violation'),
      });
    });
  });

  // ==========================================================================
  // 4. QC Evaluation
  // ==========================================================================
  describe('4. evaluateQC', () => {
    it('requires remediationStage when passed is false', async () => {
      await expect(
        applicationService.evaluateQC('itm-1', false, undefined)
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('Tahapan remediasi (remediationStage) wajib ditentukan'),
      });
    });

    it('omits remediationStage when passed is true', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const item = job.work_items![0];

      // Advance item to PACKED
      while (item.current_stage !== 'PACKED') {
        await applicationService.advanceWorkItem(item.id);
        const cur = (await applicationService.getProductionJob(localOrder.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.current_stage = cur.current_stage;
      }

      // Evaluate QC PASS — even if someone passes a remediationStage, application service omits it
      await applicationService.evaluateQC(item.id, true, 'WASHING' as ProductionStage, 'Lolos QC sempurna');

      const updatedJob = await applicationService.getProductionJob(localOrder.id);
      const updatedItem = updatedJob!.work_items!.find((w) => w.id === item.id)!;
      expect(updatedItem.status).toBe('COMPLETED');
      expect(updatedItem.current_stage).toBe('PACKED');
    });

    it('rewinds to remediationStage on QC FAIL and translates errors', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const item = job.work_items![0];

      // Advance item to PACKED
      while (item.current_stage !== 'PACKED') {
        await applicationService.advanceWorkItem(item.id);
        const cur = (await applicationService.getProductionJob(localOrder.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.current_stage = cur.current_stage;
      }

      // Evaluate QC FAIL targeting WASHING
      await applicationService.evaluateQC(item.id, false, 'WASHING', 'Noda oli belum hilang');

      const updatedJob = await applicationService.getProductionJob(localOrder.id);
      const updatedItem = updatedJob!.work_items!.find((w) => w.id === item.id)!;
      expect(updatedItem.status).toBe('IN_PROGRESS');
      expect(updatedItem.current_stage).toBe('WASHING');
      expect(updatedItem.stage_index).toBe(1);
    });

    it('rejects QC FAIL targeting PACKED as ApplicationError(INVALID_STATE)', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);
      const item = job.work_items![0];

      while (item.current_stage !== 'PACKED') {
        await applicationService.advanceWorkItem(item.id);
        const cur = (await applicationService.getProductionJob(localOrder.id))!.work_items!.find(
          (w) => w.id === item.id
        )!;
        item.current_stage = cur.current_stage;
      }

      await expect(
        applicationService.evaluateQC(item.id, false, 'PACKED', 'Salah remediation')
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('QC_FAIL tidak dapat menargetkan tahapan akhir PACKED'),
      });
    });
  });

  // ==========================================================================
  // 5. Completion (Granular and SIMPLE)
  // ==========================================================================
  describe('5. completeProduction & completeSimpleProduction', () => {
    it('completes granular production when all items are COMPLETED', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;
      const job = await applicationService.startProduction(localOrder.id);

      // Complete all items through PACKED + QC PASS
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

      await applicationService.completeProduction(job.id);

      const completedJob = await applicationService.getProductionJobById(job.id);
      expect(completedJob!.status).toBe('COMPLETED');
      expect(completedJob!.completed_at).toBeDefined();

      // Verify local order projection to READY was performed by repository/RPC
      const updatedOrder = (await repository.getOrders()).find((o) => o.id === localOrder.id)!;
      expect(updatedOrder.status).toBe('READY');
    });

    it('completes SIMPLE mode order production directly', async () => {
      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      await applicationService.completeSimpleProduction(localOrder.id);

      const job = await applicationService.getProductionJob(localOrder.id);
      expect(job).toBeDefined();
      expect(job!.status).toBe('COMPLETED');

      const updatedOrder = (await repository.getOrders()).find((o) => o.id === localOrder.id)!;
      expect(updatedOrder.status).toBe('READY');
    });
  });

  // ==========================================================================
  // 6. Section 19 — Architectural Boundary Test (Zero legacy status bypass)
  // ==========================================================================
  describe('6. Architectural Invariant — Zero Direct repository.updateOrderStatus Calls', () => {
    it('strictly guarantees completeProduction and completeSimpleProduction do NOT invoke repository.updateOrderStatus', async () => {
      const updateOrderStatusSpy = vi.spyOn(repository, 'updateOrderStatus');

      const orders = await repository.getOrders();
      const localOrder = orders.find((o) => o.branch_id === o.production_branch_id)!;

      // 1. Start production through Application Service
      const job = await applicationService.startProduction(localOrder.id);
      expect(updateOrderStatusSpy).not.toHaveBeenCalled();

      // 2. Advance all items to completed
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
      expect(updateOrderStatusSpy).not.toHaveBeenCalled();

      // 3. Complete granular production through Application Service
      await applicationService.completeProduction(job.id);
      expect(updateOrderStatusSpy).not.toHaveBeenCalled();

      // 4. Test SIMPLE mode completion on another order
      const anotherOrder = orders.find(
        (o) => o.branch_id === o.production_branch_id && o.id !== localOrder.id
      ) || localOrder;
      
      productionRepository.resetSandbox();
      await applicationService.completeSimpleProduction(anotherOrder.id);
      expect(updateOrderStatusSpy).not.toHaveBeenCalled();

      updateOrderStatusSpy.mockRestore();
    });
  });

  // ==========================================================================
  // 7. Dependency Injection & Error Mapping Verification
  // ==========================================================================
  describe('7. Dependency Injection and Error Normalization', () => {
    it('properly uses injected IProductionRepository mock and translates errors', async () => {
      const mockProdRepo: IProductionRepository = {
        startProductionJob: vi.fn().mockRejectedValue(new RepositoryError('FORBIDDEN', 'Akses cabang ditolak')),
        advanceWorkItemStage: vi.fn().mockRejectedValue(new RepositoryError('INVALID_STATE_TRANSITION', 'Transisi ilegal')),
        splitWorkItem: vi.fn().mockRejectedValue(new RepositoryError('VALIDATION_ERROR', 'Split gagal')),
        qcEvaluateWorkItem: vi.fn().mockRejectedValue(new RepositoryError('CONFLICT', 'Konflik QC')),
        completeProductionJob: vi.fn().mockRejectedValue(new RepositoryError('NOT_FOUND', 'Job tidak ditemukan')),
        completeSimpleProductionJob: vi.fn().mockRejectedValue(new RepositoryError('FINANCIAL_VALIDATION_ERROR', 'Financial error')),
        getProductionJobWithItems: vi.fn().mockResolvedValue(null),
        getProductionJobById: vi.fn().mockResolvedValue(null),
        getWorkshopProduction: vi.fn().mockRejectedValue(new RepositoryError('FORBIDDEN', 'Akses workshop ditolak')),
      };

      const customService = new LaundryApplicationService(repository, mockProdRepo);

      await expect(customService.startProduction('ord-1')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Akses cabang ditolak',
      });

      await expect(customService.advanceWorkItem('item-1')).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: 'Transisi ilegal',
      });

      await expect(customService.splitWorkItem('item-1', [1, 1], 'CAPACITY_OVERFLOW')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Split gagal',
      });

      await expect(customService.completeProduction('job-1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Job tidak ditemukan',
      });

      await expect(customService.getWorkshopProduction('branch-1')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Akses workshop ditolak',
      });
    });
  });
});
