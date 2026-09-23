// ============================================================================
// LaundryFlow — Production Kanban View Unit & Architectural Invariant Tests
// STEP 4C.4C-B.2.5: Verifies Workshop-Wide Board & Read Model Integration
// ============================================================================

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as fs from 'fs';
import * as path from 'path';

import { ProductionKanbanView } from '../features/production/ProductionKanbanView';
import { applicationService } from '../core/application/laundryApplicationService';
import { repository } from '../core/services/repository';
import { productionKeys } from '../core/presentation/query/queryKeys';
import {
  WorkshopProductionReadModel,
  WorkshopProductionWorkItem,
  WorkshopProductionJobSummary,
} from '../core/types/database';
import { usePosStore } from '../core/store/posStore';

const createTestWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({
    children,
    initialEntries = ['/production'],
  }: {
    children: React.ReactNode;
    initialEntries?: string[];
  }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  );

  return { queryClient, Wrapper };
};

const createMockWorkItem = (
  overrides?: Partial<WorkshopProductionWorkItem>
): WorkshopProductionWorkItem => ({
  id: 'wi-1',
  job_id: 'job-123',
  order_id: 'order-123',
  order_number: 'BKS-2609-0099',
  customer_name: 'Ibu Ratna',
  order_item_id: 'oi-1',
  service_id: 'svc-1',
  item_code: 'BKS-0099-ITM-01',
  service_name: 'Cuci Kiloan Reguler',
  service_name_snap: 'Cuci Kiloan Reguler',
  unit: 'KG',
  quantity: 5,
  service_stages: ['WASHING', 'DRYING', 'IRONING', 'PACKED'],
  current_stage: 'WASHING',
  stage_index: 1,
  status: 'IN_PROGRESS',
  parent_item_id: null,
  split_reason: null,
  job_status: 'IN_PROGRESS',
  rework_request_id: null,
  is_rework: false,
  job_created_at: new Date().toISOString(),
  workshop_branch_id: '22222222-2222-2222-2222-222222222223',
  workshop_branch_name: 'Central Production Unit Tambun',
  notes: null,
  created_at: new Date().toISOString(),
  ...overrides,
});

const createMockJobSummary = (
  overrides?: Partial<WorkshopProductionJobSummary>
): WorkshopProductionJobSummary => ({
  id: 'job-123',
  order_id: 'order-123',
  order_number: 'BKS-2609-0099',
  customer_name: 'Ibu Ratna',
  branch_id: '22222222-2222-2222-2222-222222222223',
  rework_request_id: null,
  is_rework: false,
  status: 'IN_PROGRESS',
  created_at: new Date().toISOString(),
  work_items_count: 3,
  ...overrides,
});

const createMockWorkshopModel = (
  overrides?: Partial<WorkshopProductionReadModel>
): WorkshopProductionReadModel => ({
  workshop_branch_id: '22222222-2222-2222-2222-222222222223',
  workshop_branch_name: 'Central Production Unit Tambun',
  jobs_count: 1,
  work_items_count: 3,
  jobs: [createMockJobSummary()],
  work_items: [
    createMockWorkItem({
      id: 'wi-1',
      item_code: 'BKS-0099-ITM-01',
      service_name_snap: 'Cuci Kiloan Reguler',
      quantity: 5,
      unit: 'KG',
      current_stage: 'WASHING',
      stage_index: 1,
    }),
    createMockWorkItem({
      id: 'wi-2',
      item_code: 'BKS-0099-ITM-02',
      service_name_snap: 'Bed Cover King Size',
      quantity: 1,
      unit: 'PCS',
      current_stage: 'DRYING',
      stage_index: 2,
    }),
    createMockWorkItem({
      id: 'wi-3',
      item_code: 'BKS-0099-ITM-03',
      service_name_snap: 'Kemeja Katun',
      quantity: 2,
      unit: 'PCS',
      current_stage: 'PACKED',
      stage_index: 4,
    }),
  ],
  ...overrides,
});

describe('ProductionKanbanView Workshop-Wide Tests (STEP 4C.4C-B.2.5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    usePosStore.setState({
      currentBranch: {
        id: '22222222-2222-2222-2222-222222222223',
        organization_id: '11111111-1111-1111-1111-111111111111',
        code: 'CP-01',
        name: 'Central Production Unit Tambun',
        branch_type: 'CENTRAL_PRODUCTION',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
  });

  // ==========================================================================
  // Section 1: Architecture & Invariant Guardrails
  // ==========================================================================
  describe('Architecture & Invariant Guardrails', () => {
    it('1. Kanban does not call repository.updateOrderStatus', async () => {
      const updateOrderSpy = vi.spyOn(repository, 'updateOrderStatus');
      const advanceSpy = vi.spyOn(applicationService, 'advanceWorkItem').mockResolvedValue(undefined);
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');
      const advanceButtons = screen.getAllByRole('button', { name: /Lanjut Tahap/i });
      fireEvent.click(advanceButtons[0]);

      await waitFor(() => {
        expect(advanceSpy).toHaveBeenCalledWith('wi-1', undefined);
      });

      expect(updateOrderSpy).not.toHaveBeenCalled();
    });

    it('2. Kanban does not call Supabase RPC directly', () => {
      const filePath = path.resolve(__dirname, '../features/production/ProductionKanbanView.tsx');
      const fileContent = fs.readFileSync(filePath, 'utf8');

      expect(fileContent).not.toMatch(/supabase\.rpc/);
      expect(fileContent).not.toMatch(/from\s+['"].*supabase\/client['"]/);
    });

    it('3. Kanban does not import ProductionRepository', () => {
      const filePath = path.resolve(__dirname, '../features/production/ProductionKanbanView.tsx');
      const fileContent = fs.readFileSync(filePath, 'utf8');

      expect(fileContent).not.toMatch(/productionRepository/);
      expect(fileContent).not.toMatch(/from\s+['"].*productionRepository['"]/);
    });

    it('4. Kanban does not use setQueryData to fabricate production state', async () => {
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());
      const { queryClient, Wrapper } = createTestWrapper();
      const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');

      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');
      expect(setQueryDataSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Section 2: Workshop Read Model & Data Presentation
  // ==========================================================================
  describe('Workshop Read Model & Data Presentation', () => {
    it('5. Single job work items render with order number and customer name', async () => {
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');

      // Verify order number and customer name appear on cards
      expect(screen.getAllByText('BKS-2609-0099').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Ibu Ratna/).length).toBeGreaterThan(0);

      // Verify items appear in correct stage columns
      const washingColumn = screen.getByTestId('stage-column-WASHING');
      const dryingColumn = screen.getByTestId('stage-column-DRYING');
      const packedColumn = screen.getByTestId('stage-column-PACKED');

      expect(within(washingColumn).getByText('Cuci Kiloan Reguler')).toBeInTheDocument();
      expect(within(dryingColumn).getByText('Bed Cover King Size')).toBeInTheDocument();
      expect(within(packedColumn).getByText('Kemeja Katun')).toBeInTheDocument();
    });

    it('6. Multiple jobs from different orders render in the same stage column', async () => {
      const multiJobModel = createMockWorkshopModel({
        jobs_count: 2,
        work_items_count: 2,
        jobs: [
          createMockJobSummary({ id: 'job-1', order_number: 'BKS-001', customer_name: 'Ibu Ratna' }),
          createMockJobSummary({ id: 'job-2', order_number: 'TBN-002', customer_name: 'Pak Budi' }),
        ],
        work_items: [
          createMockWorkItem({
            id: 'wi-101',
            job_id: 'job-1',
            order_number: 'BKS-001',
            customer_name: 'Ibu Ratna',
            item_code: 'BKS-001-ITM-01',
            service_name_snap: 'Cuci Kiloan Reguler',
            current_stage: 'WASHING',
          }),
          createMockWorkItem({
            id: 'wi-102',
            job_id: 'job-2',
            order_number: 'TBN-002',
            customer_name: 'Pak Budi',
            item_code: 'TBN-002-ITM-01',
            service_name_snap: 'Jas Formal 2 Stel',
            current_stage: 'WASHING',
          }),
        ],
      });

      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(multiJobModel);

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');

      const washingCol = screen.getByTestId('stage-column-WASHING');
      expect(within(washingCol).getByText('BKS-001')).toBeInTheDocument();
      expect(within(washingCol).getByText('Ibu Ratna')).toBeInTheDocument();
      expect(within(washingCol).getByText('TBN-002')).toBeInTheDocument();
      expect(within(washingCol).getByText('Pak Budi')).toBeInTheDocument();
    });

    it('7. Empty workshop renders operational empty state', async () => {
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(
        createMockWorkshopModel({
          jobs_count: 0,
          work_items_count: 0,
          jobs: [],
          work_items: [],
        })
      );

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByTestId('production-kanban-empty');
      expect(
        screen.getByText(/Tidak ada antrean produksi aktif di workshop ini/i)
      ).toBeInTheDocument();
      // Ensure central production does NOT render outlet guidance
      expect(
        screen.queryByText(/Outlet ini tidak memiliki antrean produksi lokal/i)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/pilih Workshop Pusat pada pilihan cabang di atas/i)
      ).not.toBeInTheDocument();
    });

    it('8. Loading state renders correctly', async () => {
      vi.spyOn(applicationService, 'getWorkshopProduction').mockReturnValue(new Promise(() => {}));

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      expect(screen.getByTestId('production-kanban-loading')).toBeInTheDocument();
      expect(screen.getByText(/Memuat antrean produksi workshop.../i)).toBeInTheDocument();
    });

    it('9. Error state renders normalized error banner', async () => {
      vi.spyOn(applicationService, 'getWorkshopProduction').mockRejectedValue(
        new Error('Koneksi database workshop terputus')
      );

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText(/Koneksi database workshop terputus/i);
    });

    it('10. Stage partitioning covers all five authoritative stages', async () => {
      const allStagesModel = createMockWorkshopModel({
        jobs_count: 1,
        work_items_count: 5,
        work_items: [
          createMockWorkItem({ id: 'wi-w', current_stage: 'WASHING', service_name_snap: 'Item Cuci' }),
          createMockWorkItem({ id: 'wi-d', current_stage: 'DRYING', service_name_snap: 'Item Kering' }),
          createMockWorkItem({ id: 'wi-i', current_stage: 'IRONING', service_name_snap: 'Item Setrika' }),
          createMockWorkItem({ id: 'wi-p', current_stage: 'PACKED', service_name_snap: 'Item Packing' }),
          createMockWorkItem({ id: 'wi-s', current_stage: 'SPECIAL_TREATMENT', service_name_snap: 'Item Treatment' }),
        ],
      });

      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(allStagesModel);

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Item Cuci');

      expect(within(screen.getByTestId('stage-column-WASHING')).getByText('Item Cuci')).toBeInTheDocument();
      expect(within(screen.getByTestId('stage-column-DRYING')).getByText('Item Kering')).toBeInTheDocument();
      expect(within(screen.getByTestId('stage-column-IRONING')).getByText('Item Setrika')).toBeInTheDocument();
      expect(within(screen.getByTestId('stage-column-PACKED')).getByText('Item Packing')).toBeInTheDocument();
      expect(within(screen.getByTestId('stage-column-SPECIAL_TREATMENT')).getByText('Item Treatment')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Section 3: Split & Rework Semantics
  // ==========================================================================
  describe('Split & Rework Semantics', () => {
    it('11. Split parent is excluded and active child displays "Pecahan" badge', async () => {
      const splitModel = createMockWorkshopModel({
        work_items: [
          // SPLIT parent (simulating defense-in-depth if passed from DB)
          createMockWorkItem({
            id: 'wi-parent',
            item_code: 'BKS-SPLIT-PARENT',
            status: 'SPLIT',
            current_stage: 'WASHING',
          }),
          // Active child item
          createMockWorkItem({
            id: 'wi-child-1',
            item_code: 'BKS-SPLIT-CHILD-1',
            parent_item_id: 'wi-parent',
            split_reason: 'CAPACITY_OVERFLOW',
            status: 'IN_PROGRESS',
            current_stage: 'WASHING',
            quantity: 2.5,
          }),
        ],
      });

      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(splitModel);

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('BKS-SPLIT-CHILD-1');
      expect(screen.queryByText('BKS-SPLIT-PARENT')).not.toBeInTheDocument();
      expect(screen.getByText('Pecahan')).toBeInTheDocument();
    });

    it('12. Rework item displays "Rework" indicator badge', async () => {
      const reworkModel = createMockWorkshopModel({
        work_items: [
          createMockWorkItem({
            id: 'wi-rework',
            item_code: 'BKS-RWK-01',
            is_rework: true,
            rework_request_id: 'rwk-req-99',
            current_stage: 'WASHING',
          }),
        ],
      });

      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(reworkModel);

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('BKS-RWK-01');
      expect(screen.getByText('Rework')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Section 4: Client-Side Presentation Filtering
  // ==========================================================================
  describe('Client-Side Presentation Filtering', () => {
    it('13. Search filters cards by customer name without triggering new network queries', async () => {
      const getWorkshopSpy = vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(
        createMockWorkshopModel({
          jobs_count: 2,
          work_items: [
            createMockWorkItem({ id: 'wi-1', customer_name: 'Ibu Ratna', service_name_snap: 'Cucian Ratna' }),
            createMockWorkItem({ id: 'wi-2', customer_name: 'Pak Budi', service_name_snap: 'Cucian Budi' }),
          ],
        })
      );

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cucian Ratna');
      expect(screen.getByText('Cucian Budi')).toBeInTheDocument();

      // Exactly 1 network query on initial load
      expect(getWorkshopSpy).toHaveBeenCalledTimes(1);

      // Type in search bar (accessible aria-label FIND-A11Y-01)
      const searchInput = screen.getByLabelText('Cari nomor order, pelanggan, atau kode item');
      expect(searchInput).toBeInTheDocument();
      fireEvent.change(searchInput, { target: { value: 'Budi' } });

      // Presentation filter takes effect
      expect(screen.getByText('Cucian Budi')).toBeInTheDocument();
      expect(screen.queryByText('Cucian Ratna')).not.toBeInTheDocument();

      // Zero extra network queries!
      expect(getWorkshopSpy).toHaveBeenCalledTimes(1);
    });

    it('14. Optional orderId prop filters the board to that order', async () => {
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(
        createMockWorkshopModel({
          work_items: [
            createMockWorkItem({ id: 'wi-1', order_number: 'ORD-AAA', service_name_snap: 'Item AAA' }),
            createMockWorkItem({ id: 'wi-2', order_number: 'ORD-BBB', service_name_snap: 'Item BBB' }),
          ],
        })
      );

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView orderId="ORD-AAA" />
        </Wrapper>
      );

      await screen.findByText('Item AAA');
      expect(screen.queryByText('Item BBB')).not.toBeInTheDocument();
      expect(screen.getByText(/Filter: ORD-AAA/)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Section 5: Stage Actions & Mutations
  // ==========================================================================
  describe('Stage Actions & Mutations', () => {
    it('15. Advance action calls useAdvanceWorkItem with workItemId and does not calculate next stage', async () => {
      const advanceSpy = vi.spyOn(applicationService, 'advanceWorkItem').mockResolvedValue(undefined);
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');
      const advanceButtons = screen.getAllByRole('button', { name: /Lanjut Tahap/i });
      fireEvent.click(advanceButtons[0]);

      await waitFor(() => {
        expect(advanceSpy).toHaveBeenCalledWith('wi-1', undefined);
      });

      // Verify UI does NOT pass a fabricated next stage string
      expect(advanceSpy.mock.calls[0][1]).not.toBe('DRYING');
    });

    it('16. Split action submits correct quantities and reason', async () => {
      const splitSpy = vi.spyOn(applicationService, 'splitWorkItem').mockResolvedValue(undefined);
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');
      const splitButtons = screen.getAllByRole('button', { name: /Pecah/i });
      fireEvent.click(splitButtons[0]);

      expect(screen.getByText('Pecah Batch Work Item')).toBeInTheDocument();

      const inputs = screen.getAllByRole('spinbutton');
      fireEvent.change(inputs[0], { target: { value: '2.5' } });
      fireEvent.change(inputs[1], { target: { value: '2.5' } });

      const reasonSelect = screen.getByLabelText(/Alasan Pemecahan/i);
      fireEvent.change(reasonSelect, { target: { value: 'QC_DEFECT_ISOLATION' } });

      const submitBtn = screen.getByRole('button', { name: /Konfirmasi Pecah Batch/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(splitSpy).toHaveBeenCalledWith(
          'wi-1',
          [2.5, 2.5],
          'QC_DEFECT_ISOLATION',
          undefined
        );
      });
    });

    it('17. QC PASS and FAIL submit correct payloads and exclude PACKED from remediation', async () => {
      const qcSpy = vi.spyOn(applicationService, 'evaluateQC').mockResolvedValue(undefined);
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Kemeja Katun');
      fireEvent.click(screen.getByRole('button', { name: /Evaluasi QC/i }));

      // Verify PACKED is not an option
      fireEvent.click(screen.getByRole('button', { name: /Gagal QC \(FAIL\)/i }));
      const remediationSelect = screen.getByLabelText(/Tahapan Remediasi \(Wajib Dipilih\)/i);
      const options = Array.from(remediationSelect.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
      expect(options).not.toContain('PACKED');
      expect(options).toContain('WASHING');

      // Select remediation and submit
      fireEvent.change(remediationSelect, { target: { value: 'IRONING' } });
      fireEvent.click(screen.getByRole('button', { name: /Simpan Evaluasi QC/i }));

      await waitFor(() => {
        expect(qcSpy).toHaveBeenCalledWith('wi-3', false, 'IRONING', undefined);
      });
    });

    it('18. Job completion is executed at job level from Active Jobs modal', async () => {
      const completeSpy = vi.spyOn(applicationService, 'completeProduction').mockResolvedValue(undefined);
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');

      // Open Active Jobs modal
      const kelolaJobBtn = screen.getByRole('button', { name: /Kelola Job/i });
      fireEvent.click(kelolaJobBtn);

      expect(screen.getByText('Daftar Job Produksi Aktif')).toBeInTheDocument();

      const completeBtn = screen.getByRole('button', { name: /Selesaikan Produksi/i });
      fireEvent.click(completeBtn);

      await waitFor(() => {
        expect(completeSpy).toHaveBeenCalledWith('job-123');
      });
    });
  });

  // ==========================================================================
  // Section 6: Invalidation & Branch Switching
  // ==========================================================================
  describe('Invalidation & Branch Switching', () => {
    it('19. Mutation success triggers invalidation of productionKeys.all covering workshop query', async () => {
      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(createMockWorkshopModel());
      vi.spyOn(applicationService, 'advanceWorkItem').mockResolvedValue(undefined);

      const { queryClient, Wrapper } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByText('Cuci Kiloan Reguler');
      const advanceButtons = screen.getAllByRole('button', { name: /Lanjut Tahap/i });
      fireEvent.click(advanceButtons[0]);

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productionKeys.all });
      });
    });

    it('20. Changing workshopBranchId requests data for the new branch', async () => {
      const getWorkshopSpy = vi.spyOn(applicationService, 'getWorkshopProduction').mockImplementation((branchId) =>
        Promise.resolve(
          createMockWorkshopModel({
            workshop_branch_id: branchId,
            workshop_branch_name: branchId === 'branch-B' ? 'Workshop Cabang B' : 'Workshop Cabang A',
          })
        )
      );

      const { Wrapper } = createTestWrapper();
      const { rerender } = render(
        <Wrapper>
          <ProductionKanbanView workshopBranchId="branch-A" />
        </Wrapper>
      );

      await screen.findByText('Workshop Cabang A');
      expect(getWorkshopSpy).toHaveBeenCalledWith('branch-A');

      // Rerender with branch-B
      rerender(
        <Wrapper>
          <ProductionKanbanView workshopBranchId="branch-B" />
        </Wrapper>
      );

      await screen.findByText('Workshop Cabang B');
      expect(getWorkshopSpy).toHaveBeenCalledWith('branch-B');
    });

    it('21. Mutation triggers automatic query refetch and updates the rendered DOM elements (FIND-TEST-01)', async () => {
      const initialModel = createMockWorkshopModel({
        jobs_count: 1,
        work_items_count: 1,
        jobs: [createMockJobSummary({ id: 'job-001', order_number: 'ORD-INITIAL' })],
        work_items: [
          createMockWorkItem({
            id: 'wi-initial',
            job_id: 'job-001',
            order_number: 'ORD-INITIAL',
            service_name_snap: 'Item Awal Sebelum Mutasi',
            current_stage: 'WASHING',
          }),
        ],
      });

      const updatedModel = createMockWorkshopModel({
        jobs_count: 1,
        work_items_count: 1,
        jobs: [createMockJobSummary({ id: 'job-002', order_number: 'ORD-REFETCHED' })],
        work_items: [
          createMockWorkItem({
            id: 'wi-updated',
            job_id: 'job-002',
            order_number: 'ORD-REFETCHED',
            service_name_snap: 'Item Baru Hasil Refetch',
            current_stage: 'DRYING',
          }),
        ],
      });

      let callCount = 0;
      const getWorkshopSpy = vi
        .spyOn(applicationService, 'getWorkshopProduction')
        .mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(initialModel);
          }
          return Promise.resolve(updatedModel);
        });

      const advanceSpy = vi
        .spyOn(applicationService, 'advanceWorkItem')
        .mockResolvedValue(undefined);

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      // 1. Initial query: rendered in DOM
      await screen.findByText('Item Awal Sebelum Mutasi');
      expect(screen.getByText('ORD-INITIAL')).toBeInTheDocument();
      expect(getWorkshopSpy).toHaveBeenCalledTimes(1);

      // 2. Execute mutation
      const advanceBtn = screen.getByRole('button', { name: /Lanjut Tahap/i });
      fireEvent.click(advanceBtn);

      await waitFor(() => {
        expect(advanceSpy).toHaveBeenCalledWith('wi-initial', undefined);
      });

      // 3. Invalidation -> 4. Second query/refetch of active workshop query
      await waitFor(() => {
        expect(getWorkshopSpy).toHaveBeenCalledTimes(2);
      });

      // 5. Updated read model reached the DOM
      await waitFor(() => {
        expect(screen.getByText('Item Baru Hasil Refetch')).toBeInTheDocument();
      });

      expect(screen.getByText('ORD-REFETCHED')).toBeInTheDocument();
      expect(screen.queryByText('Item Awal Sebelum Mutasi')).not.toBeInTheDocument();
      expect(screen.queryByText('ORD-INITIAL')).not.toBeInTheDocument();
    });

    it('22. Outlet empty state displays guidance to switch to central workshop (FIND-UX-01)', async () => {
      // Set branch context to OUTLET
      usePosStore.setState({
        currentBranch: {
          id: '11111111-1111-1111-1111-111111111112',
          organization_id: '11111111-1111-1111-1111-111111111111',
          code: 'OUT-01',
          name: 'Outlet Rawamangun',
          branch_type: 'OUTLET',
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });

      vi.spyOn(applicationService, 'getWorkshopProduction').mockResolvedValue(
        createMockWorkshopModel({
          jobs_count: 0,
          work_items_count: 0,
          jobs: [],
          work_items: [],
        })
      );

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper>
          <ProductionKanbanView />
        </Wrapper>
      );

      await screen.findByTestId('production-kanban-empty');

      // Operator-facing guidance for OUTLET
      expect(
        screen.getByText(/Outlet ini tidak memiliki antrean produksi lokal/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/pilih Workshop Pusat pada pilihan cabang di atas/i)
      ).toBeInTheDocument();
    });
  });
});
