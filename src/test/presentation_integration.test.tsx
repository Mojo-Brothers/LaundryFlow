// ============================================================================
// LaundryFlow — Presentation Layer Integration & Query Hook Tests
// (Verifies UI -> Query Hook -> Application Service -> Repository delegation)
// ============================================================================

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useTransitManifests,
  useTransitManifest,
  useEligibleTransitOrders,
  useTransitManifestHistory,
  useCreateTransitManifest,
  useTransitionTransitManifest,
  useReceiveTransitManifest,
  useActiveShift,
  useShiftSummary,
  useOpenShift,
  useCloseShift,
  transitKeys,
  shiftKeys,
  formatPresentationError,
} from '../core/presentation/query';
import { applicationService, ApplicationError } from '../core/application/laundryApplicationService';
import { repository } from '../core/services/repository';

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

describe('Presentation Layer Integration — Query & Mutation Hooks', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const OUTLET_BKS = '22222222-2222-2222-2222-222222222221';
  const CENTRAL_PROD = '22222222-2222-2222-2222-222222222223';
  const DRIVER_ID = '33333333-3333-3333-3333-333333333333';
  const CASHIER_ID = '33333333-3333-3333-3333-333333333332';

  beforeEach(() => {
    repository.resetSandbox();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Query Hooks Delegation
  // ==========================================================================
  describe('Query Hooks Delegation', () => {
    it('1. useTransitManifests delegates to applicationService.listTransitManifests', async () => {
      const spy = vi.spyOn(applicationService, 'listTransitManifests');
      const { Wrapper } = createTestWrapper();

      const { result } = renderHook(() => useTransitManifests({ status: 'DRAFT' }), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(spy).toHaveBeenCalledWith({ status: 'DRAFT' });
      expect(Array.isArray(result.current.data)).toBe(true);
      expect(result.current.data!.every((m) => m.status === 'DRAFT')).toBe(true);
    });

    it('2. useTransitManifest delegates to applicationService.getTransitManifest and disables on empty id', async () => {
      const spy = vi.spyOn(applicationService, 'getTransitManifest');
      const { Wrapper } = createTestWrapper();

      // Test with empty id (query should be disabled)
      const { result: disabledResult } = renderHook(() => useTransitManifest(''), {
        wrapper: Wrapper,
      });
      expect(disabledResult.current.fetchStatus).toBe('idle');
      expect(spy).not.toHaveBeenCalled();

      // Test with valid id
      const allManifests = await applicationService.listTransitManifests();
      const targetId = allManifests[0].id;

      const { result: activeResult } = renderHook(() => useTransitManifest(targetId), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(activeResult.current.isSuccess).toBe(true));
      expect(spy).toHaveBeenCalledWith(targetId);
      expect(activeResult.current.data?.id).toBe(targetId);
    });

    it('3. useEligibleTransitOrders delegates to applicationService with correct parameters', async () => {
      const spy = vi.spyOn(applicationService, 'getEligibleTransitOrders');
      const { Wrapper } = createTestWrapper();

      const { result } = renderHook(
        () => useEligibleTransitOrders(OUTLET_BKS, CENTRAL_PROD),
        { wrapper: Wrapper }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(spy).toHaveBeenCalledWith(OUTLET_BKS, CENTRAL_PROD);
      expect(Array.isArray(result.current.data)).toBe(true);
    });

    it('4. useShiftSummary delegates to applicationService and remains read-only', async () => {
      const shift = await applicationService.openShift({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        cashierId: CASHIER_ID,
        openingCash: 125000,
      });

      const spy = vi.spyOn(applicationService, 'getShiftSummary');
      const { Wrapper } = createTestWrapper();

      const { result } = renderHook(() => useShiftSummary(shift.id), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(spy).toHaveBeenCalledWith(shift.id);
      expect(result.current.data?.openingCash).toBe(125000);
      expect(result.current.data?.expectedCash).toBe(125000);

      // Verify shift is still open (read-only preview contract)
      const active = await applicationService.getActiveShift(OUTLET_BKS);
      expect(active?.status).toBe('OPEN');
    });

    it('5. useActiveShift delegates to applicationService.getActiveShift', async () => {
      const spy = vi.spyOn(applicationService, 'getActiveShift');
      const { Wrapper } = createTestWrapper();

      const { result } = renderHook(() => useActiveShift(OUTLET_BKS), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(spy).toHaveBeenCalledWith(OUTLET_BKS);
      expect(result.current.data).toBeDefined();
    });
  });

  // ==========================================================================
  // 2. Mutation Hooks Delegation
  // ==========================================================================
  describe('Mutation Hooks Delegation', () => {
    it('6. useCreateTransitManifest delegates to applicationService and creates draft', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrderId = eligible[0].id;
      const spy = vi.spyOn(applicationService, 'createTransitManifest');

      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useCreateTransitManifest(), { wrapper: Wrapper });

      const res = await result.current.mutateAsync({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe('DRAFT');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.status).toBe('DRAFT');
    });

    it('7. useTransitionTransitManifest delegates to applicationService', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const manifest = await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [eligible[0].id],
      });

      const spy = vi.spyOn(applicationService, 'transitionTransitManifest');
      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useTransitionTransitManifest(), { wrapper: Wrapper });

      const res = await result.current.mutateAsync({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
        notes: 'Siap kirim',
      });

      expect(spy).toHaveBeenCalledWith({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
        notes: 'Siap kirim',
      });
      expect(res.status).toBe('READY_TO_DISPATCH');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.status).toBe('READY_TO_DISPATCH');
    });

    it('8. useReceiveTransitManifest delegates to applicationService', async () => {
      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      const manifest = await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'IN_TRANSIT',
      });

      const spy = vi.spyOn(applicationService, 'receiveTransitManifest');
      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useReceiveTransitManifest(), { wrapper: Wrapper });

      const res = await result.current.mutateAsync({
        manifestId: manifest.id,
        itemsReview: [{ orderId: testOrderId, status: 'RECEIVED_OK' }],
        summaryNotes: 'Diterima lengkap',
      });

      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe('RECEIVED');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.status).toBe('RECEIVED');
    });

    it('9. useOpenShift delegates to applicationService', async () => {
      const spy = vi.spyOn(applicationService, 'openShift');
      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useOpenShift(), { wrapper: Wrapper });

      const res = await result.current.mutateAsync({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        cashierId: CASHIER_ID,
        openingCash: 300000,
      });

      expect(spy).toHaveBeenCalled();
      expect(res.opening_cash).toBe(300000);
      expect(res.status).toBe('OPEN');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.opening_cash).toBe(300000);
      expect(result.current.data?.status).toBe('OPEN');
    });

    it('10. useCloseShift delegates to applicationService', async () => {
      const shift = await applicationService.openShift({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        cashierId: CASHIER_ID,
        openingCash: 100000,
      });

      const spy = vi.spyOn(applicationService, 'closeShift');
      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useCloseShift(), { wrapper: Wrapper });

      const res = await result.current.mutateAsync({
        shiftId: shift.id,
        actualCash: 100000,
      });

      expect(spy).toHaveBeenCalledWith({
        shiftId: shift.id,
        actualCash: 100000,
      });
      expect(res.status).toBe('CLOSED');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.status).toBe('CLOSED');
    });
  });

  // ==========================================================================
  // 3. Cache Invalidation Matrix
  // ==========================================================================
  describe('Cache Invalidation Matrix', () => {
    it('11. create manifest invalidates manifest list and eligible orders queries', async () => {
      const { queryClient, Wrapper } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const { result } = renderHook(() => useCreateTransitManifest(), { wrapper: Wrapper });

      await result.current.mutateAsync({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [eligible[0].id],
      });

      // Verify invalidation calls
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transitKeys.lists(),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [...transitKeys.all, 'eligible-orders'],
      });
    });

    it('12. transition manifest invalidates detail, lists, history, and eligible orders', async () => {
      const { queryClient, Wrapper } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const serviceSpy = vi.spyOn(applicationService, 'transitionTransitManifest');

      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrderId = eligible[0].id;
      const manifest = await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      const { result } = renderHook(() => useTransitionTransitManifest(), { wrapper: Wrapper });

      const transitionPayload = {
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH' as const,
        notes: 'Diverifikasi siap kirim',
      };

      await result.current.mutateAsync(transitionPayload);

      // Verify applicationService called with correct DTO
      expect(serviceSpy).toHaveBeenCalledWith(transitionPayload);

      // Verify exact invalidation matrix
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transitKeys.detail(manifest.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transitKeys.lists(),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transitKeys.history(manifest.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [...transitKeys.all, 'eligible-orders'],
      });
    });

    it('13. receive manifest invalidates detail, lists, history, and eligible orders', async () => {
      const { queryClient, Wrapper } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const eligible = await applicationService.getEligibleTransitOrders(OUTLET_BKS);
      const testOrderId = eligible[0].id;
      const manifest = await applicationService.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'READY_TO_DISPATCH',
      });
      await applicationService.transitionTransitManifest({
        manifestId: manifest.id,
        targetStatus: 'IN_TRANSIT',
      });

      const { result } = renderHook(() => useReceiveTransitManifest(), { wrapper: Wrapper });

      await result.current.mutateAsync({
        manifestId: manifest.id,
        itemsReview: [{ orderId: testOrderId, status: 'RECEIVED_OK' }],
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transitKeys.detail(manifest.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transitKeys.lists(),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transitKeys.history(manifest.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [...transitKeys.all, 'eligible-orders'],
      });
    });

    it('14. close shift invalidates active shift, summary, and all shift queries', async () => {
      const { queryClient, Wrapper } = createTestWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const shift = await applicationService.openShift({
        organizationId: ORG_ID,
        branchId: OUTLET_BKS,
        cashierId: CASHIER_ID,
        openingCash: 100000,
      });

      const { result } = renderHook(() => useCloseShift(), { wrapper: Wrapper });

      await result.current.mutateAsync({
        shiftId: shift.id,
        actualCash: 100000,
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: shiftKeys.active(shift.branch_id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: shiftKeys.summary(shift.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: shiftKeys.all,
      });
    });
  });

  // ==========================================================================
  // 4. Error Presentation Adapter
  // ==========================================================================
  describe('Error Presentation Adapter', () => {
    it('15. formats ApplicationErrors into actionable, human-readable Indonesian UI models', () => {
      // Validation error
      const valErr = formatPresentationError(
        new ApplicationError('VALIDATION_ERROR', 'Cabang asal wajib diisi')
      );
      expect(valErr.code).toBe('VALIDATION_ERROR');
      expect(valErr.title).toBe('Periksa Kembali Input Data');
      expect(valErr.isRetryable).toBe(false);

      // Conflict error
      const conflictErr = formatPresentationError(
        new ApplicationError('CONFLICT', 'Order sudah ada di manifest aktif')
      );
      expect(conflictErr.code).toBe('CONFLICT');
      expect(conflictErr.title).toBe('Konflik Data Terdeteksi');
      expect(conflictErr.isRetryable).toBe(true);

      // Financial error
      const finErr = formatPresentationError(
        new ApplicationError('FINANCIAL_ERROR', 'Selisih kas terdeteksi')
      );
      expect(finErr.code).toBe('FINANCIAL_ERROR');
      expect(finErr.title).toBe('Selisih Kas Terdeteksi');

      // Invalid state error
      const stateErr = formatPresentationError(
        new ApplicationError('INVALID_STATE', 'Transisi ilegal')
      );
      expect(stateErr.code).toBe('INVALID_STATE');
      expect(stateErr.title).toBe('Transisi Status Tidak Diizinkan');

      // Database / generic error
      const dbErr = formatPresentationError(
        new ApplicationError('DATABASE_ERROR', 'Connection failure')
      );
      expect(dbErr.code).toBe('DATABASE_ERROR');
      expect(dbErr.isRetryable).toBe(true);
    });

    it('16. handles query hook error state without crashing presentation layer', async () => {
      vi.spyOn(applicationService, 'getTransitManifest').mockRejectedValueOnce(
        new ApplicationError('NOT_FOUND', 'Manifest tidak ditemukan')
      );

      const { Wrapper } = createTestWrapper();
      const { result } = renderHook(() => useTransitManifest('missing-id-999'), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeInstanceOf(ApplicationError);

      const formatted = formatPresentationError(result.current.error);
      expect(formatted.code).toBe('NOT_FOUND');
      expect(formatted.title).toBe('Data Tidak Ditemukan');
      expect(formatted.message).toBe('Manifest tidak ditemukan');
    });
  });
});
