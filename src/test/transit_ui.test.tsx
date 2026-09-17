// ============================================================================
// LaundryFlow — Transit Manifest UI Tests (STEP 4B.2)
// Verifies UI Component behavior, user interactions, and application hook delegation
// ============================================================================

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransitListView } from '../features/transit/TransitListView';
import { TransitDetailView } from '../features/transit/TransitDetailView';
import { CreateManifestModal } from '../features/transit/CreateManifestModal';
import { ReceiveManifestModal } from '../features/transit/ReceiveManifestModal';
import { ManifestStatusBadge } from '../features/transit/components/ManifestStatusBadge';
import { applicationService, ApplicationError } from '../core/application/laundryApplicationService';
import { repository } from '../core/services/repository';
import { usePosStore } from '../core/store/posStore';
import { TransitManifest } from '../core/types/database';

const createTestWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children, initialEntries = ['/'] }: { children: React.ReactNode; initialEntries?: string[] }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );

  return { queryClient, Wrapper };
};

describe('Transit Manifest UI Components', () => {
  const OUTLET_BKS = '22222222-2222-2222-2222-222222222221';
  const CENTRAL_PROD = '22222222-2222-2222-2222-222222222223';

  beforeEach(() => {
    repository.resetSandbox();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Status Badge
  // ==========================================================================
  describe('ManifestStatusBadge', () => {
    it('renders human-readable Indonesian labels for all manifest statuses', () => {
      const { rerender } = render(<ManifestStatusBadge status="DRAFT" />);
      expect(screen.getByText('Draft')).toBeInTheDocument();

      rerender(<ManifestStatusBadge status="READY_TO_DISPATCH" />);
      expect(screen.getByText('Siap Dikirim')).toBeInTheDocument();

      rerender(<ManifestStatusBadge status="IN_TRANSIT" />);
      expect(screen.getByText('Dalam Perjalanan')).toBeInTheDocument();

      rerender(<ManifestStatusBadge status="RECEIVED" />);
      expect(screen.getByText('Diterima')).toBeInTheDocument();

      rerender(<ManifestStatusBadge status="CANCELLED" />);
      expect(screen.getByText('Dibatalkan')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // 2. Transit List View
  // ==========================================================================
  describe('TransitListView', () => {
    it('renders manifest list successfully with numbers, routes, and statuses', async () => {
      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper initialEntries={['/transit']}>
          <TransitListView />
        </Wrapper>
      );

      // Verify list renders manifests from sandbox seed (present in both desktop and mobile views)
      await waitFor(() => {
        expect(screen.getAllByText('TRX-BKS-CP-260917-001').length).toBeGreaterThan(0);
      });

      expect(screen.getByText('Logistik & Transit Antar-Cabang')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Buat Pengiriman Baru/i })).toBeInTheDocument();
    });

    it('renders empty state when no manifests match filter', async () => {
      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper initialEntries={['/transit']}>
          <TransitListView />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('TRX-BKS-CP-260917-001').length).toBeGreaterThan(0);
      });

      // Filter by non-matching search term
      const searchInput = screen.getByPlaceholderText(/Cari nomor manifest/i);
      fireEvent.change(searchInput, { target: { value: 'NONEXISTENT-MANIFEST-XYZ' } });

      await waitFor(() => {
        expect(screen.getByText('Belum ada manifest pengiriman.')).toBeInTheDocument();
      });
    });

    it('renders formatted error state when query fails', async () => {
      vi.spyOn(applicationService, 'listTransitManifests').mockRejectedValueOnce(
        new ApplicationError('DATABASE_ERROR', 'Gagal memuat basis data')
      );

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper initialEntries={['/transit']}>
          <TransitListView />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(/Gagal memuat basis data/i)).toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // 3. Create Manifest Modal
  // ==========================================================================
  describe('CreateManifestModal', () => {
    it('opens modal, renders eligible orders, handles select all / deselect all, and prevents submit without order', async () => {
      const { Wrapper } = createTestWrapper();
      const onClose = vi.fn();
      const onSuccess = vi.fn();

      render(
        <Wrapper>
          <CreateManifestModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />
        </Wrapper>
      );

      expect(screen.getByText('Buat Pengiriman Antar-Cabang')).toBeInTheDocument();

      // Wait for eligible orders to load (BKS-2609-0003 is the unassigned eligible order at OUTLET_BKS)
      await screen.findByText('BKS-2609-0003');

      // Submit button should be disabled because selectedCount is 0
      const submitBtn = screen.getByRole('button', { name: /Buat Surat Jalan/i });
      expect(submitBtn).toBeDisabled();

      // Click "Pilih Semua"
      const selectAllBtn = screen.getByRole('button', { name: 'Pilih Semua' });
      fireEvent.click(selectAllBtn);

      await waitFor(() => {
        expect(screen.getByText(/Jumlah Nota Dipilih: [1-9]/i)).toBeInTheDocument();
      });
      expect(submitBtn).not.toBeDisabled();

      // Click "Hapus Semua"
      const deselectAllBtn = screen.getByRole('button', { name: 'Hapus Semua' });
      fireEvent.click(deselectAllBtn);

      await waitFor(() => {
        expect(screen.getByText(/Jumlah Nota Dipilih: 0/i)).toBeInTheDocument();
      });
      expect(submitBtn).toBeDisabled();
    });

    it('submits valid CreateTransitManifestDTO and triggers success callback', async () => {
      const { Wrapper } = createTestWrapper();
      const onClose = vi.fn();
      const onSuccess = vi.fn();
      const createSpy = vi.spyOn(applicationService, 'createTransitManifest');

      render(
        <Wrapper>
          <CreateManifestModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />
        </Wrapper>
      );

      // Wait for eligible orders to load
      await screen.findByText('BKS-2609-0003');

      // Select orders
      fireEvent.click(screen.getByRole('button', { name: 'Pilih Semua' }));

      await waitFor(() => {
        expect(screen.getByText(/Jumlah Nota Dipilih: [1-9]/i)).toBeInTheDocument();
      });

      // Fill optional driver/vehicle/notes
      const vehicleInput = screen.getByPlaceholderText(/Contoh: B 1234 SAA/i);
      fireEvent.change(vehicleInput, { target: { value: 'B 9999 KSR' } });

      const notesInput = screen.getByPlaceholderText(/Contoh: Pengiriman pagi/i);
      fireEvent.change(notesInput, { target: { value: 'Pengiriman sore workshop' } });

      // Submit form
      const submitBtn = screen.getByRole('button', { name: /Buat Surat Jalan/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalled();
      });

      const calledWith = createSpy.mock.calls[0][0];
      expect(calledWith.destinationBranchId).toBeDefined();
      expect(calledWith.orderIds.length).toBeGreaterThan(0);
      expect(calledWith.vehicleIdentifier).toBe('B 9999 KSR');
      expect(calledWith.notes).toBe('Pengiriman sore workshop');
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 4. Manifest Detail & State Machine Actions
  // ==========================================================================
  describe('TransitDetailView & Action Availability', () => {
    it('renders correct actions for DRAFT status: "Siapkan Pengiriman" and "Batalkan"', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const manifest = await applicationService.createTransitManifest({
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [eligible[0].id],
      });

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper initialEntries={[`/transit/${manifest.id}`]}>
          <Routes>
            <Route path="/transit/:id" element={<TransitDetailView />} />
          </Routes>
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(manifest.manifest_number)).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /Siapkan Pengiriman/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Batalkan/i })).toBeInTheDocument();
    });

    it('renders correct actions for READY_TO_DISPATCH: "Kirim Armada Sekarang", "Kembali ke Draft", "Batalkan"', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const manifest = await applicationService.createTransitManifest({
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [eligible[0].id],
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
      });

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper initialEntries={[`/transit/${manifest.id}`]}>
          <Routes>
            <Route path="/transit/:id" element={<TransitDetailView />} />
          </Routes>
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(manifest.manifest_number)).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /Kirim Armada Sekarang/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Kembali ke Draft/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Batalkan/i })).toBeInTheDocument();
    });

    it('renders "Terima & Periksa Manifest" for IN_TRANSIT and strictly DOES NOT render "Batalkan"', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const manifest = await applicationService.createTransitManifest({
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [eligible[0].id],
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'IN_TRANSIT',
      });

      const { Wrapper } = createTestWrapper();
      render(
        <Wrapper initialEntries={[`/transit/${manifest.id}`]}>
          <Routes>
            <Route path="/transit/:id" element={<TransitDetailView />} />
          </Routes>
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(manifest.manifest_number)).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /Terima & Periksa Manifest/i })).toBeInTheDocument();
      // Crucial domain rule: IN_TRANSIT cannot be cancelled!
      expect(screen.queryByRole('button', { name: /Batalkan/i })).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // 5. Receive Manifest Modal
  // ==========================================================================
  describe('ReceiveManifestModal', () => {
    it('defaults orders to EXPECTED, updates all to RECEIVED_OK with "Semua Sesuai", and allows discrepancy review', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrder = eligible[0];
      const manifest = await applicationService.createTransitManifest({
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrder.id],
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
      });
      const inTransitManifest = await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'IN_TRANSIT',
      });

      // Hydrate with full details
      const fullManifest = await applicationService.getTransitManifest(inTransitManifest.id);

      const { Wrapper } = createTestWrapper();
      const onClose = vi.fn();
      const onSuccess = vi.fn();
      const receiveSpy = vi.spyOn(applicationService, 'receiveTransitManifest');

      render(
        <Wrapper>
          <ReceiveManifestModal
            isOpen={true}
            manifest={fullManifest!}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        </Wrapper>
      );

      expect(screen.getByText(/Penerimaan & Inspeksi Fisik Cucian/i)).toBeInTheDocument();
      expect(screen.getByText(/Belum Diperiksa: 1/i)).toBeInTheDocument();

      // Click "Semua Sesuai"
      const markAllBtn = screen.getByRole('button', { name: /Semua Sesuai/i });
      fireEvent.click(markAllBtn);

      await waitFor(() => {
        expect(screen.getByText(/Sesuai: 1/i)).toBeInTheDocument();
      });

      // Submit
      const submitBtn = screen.getByRole('button', { name: /Selesaikan Penerimaan Manifest/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(receiveSpy).toHaveBeenCalled();
      });

      const payload = receiveSpy.mock.calls[0][0];
      expect(payload.manifestId).toBe(fullManifest!.id);
      expect(payload.itemsReview).toEqual([
        {
          orderId: testOrder.id,
          status: 'RECEIVED_OK',
          notes: undefined,
        },
      ]);
    });

    it('submits exact ReceiveTransitManifestDTO with discrepancy when item is marked DAMAGED with notes', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrder = eligible[0];
      const manifest = await applicationService.createTransitManifest({
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrder.id],
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
      });
      const inTransitManifest = await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'IN_TRANSIT',
      });

      const fullManifest = await applicationService.getTransitManifest(inTransitManifest.id);

      const { Wrapper } = createTestWrapper();
      const onClose = vi.fn();
      const onSuccess = vi.fn();
      const receiveSpy = vi.spyOn(applicationService, 'receiveTransitManifest');

      render(
        <Wrapper>
          <ReceiveManifestModal
            isOpen={true}
            manifest={fullManifest!}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        </Wrapper>
      );

      // Mark order as DAMAGED
      const damagedBtn = screen.getByRole('button', { name: 'Rusak' });
      fireEvent.click(damagedBtn);

      // Enter notes
      const notesInput = screen.getByPlaceholderText(/Catatan kendala/i);
      fireEvent.change(notesInput, { target: { value: 'Kantong sobek saat diangkut' } });

      // Click submit (shows confirmation for discrepancy)
      const submitBtn = screen.getByRole('button', { name: /Selesaikan Penerimaan Manifest/i });
      fireEvent.click(submitBtn);

      // Confirm discrepancy button appears
      const confirmBtn = await screen.findByRole('button', { name: /Ya, Konfirmasi Penerimaan/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(receiveSpy).toHaveBeenCalled();
      });

      const payload = receiveSpy.mock.calls[0][0];
      expect(payload.itemsReview).toEqual([
        {
          orderId: testOrder.id,
          status: 'DAMAGED',
          notes: 'Kantong sobek saat diangkut',
        },
      ]);
    });
  });
});
