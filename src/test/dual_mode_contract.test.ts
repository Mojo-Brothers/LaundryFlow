import { describe, it, expect } from 'vitest';
import { repository, normalizeRepositoryError, RepositoryError } from '../core/services/repository';

describe('Repository Dual-Mode Contract & Error Normalization', () => {
  describe('1. Repository Public Contract Integrity', () => {
    it('exposes all required Phase 1 and Phase 2 methods on the single repository contract', () => {
      // Phase 1 methods
      expect(typeof repository.getOrganization).toBe('function');
      expect(typeof repository.getBranches).toBe('function');
      expect(typeof repository.getUsers).toBe('function');
      expect(typeof repository.getCustomers).toBe('function');
      expect(typeof repository.createCustomer).toBe('function');
      expect(typeof repository.getServices).toBe('function');
      expect(typeof repository.getActiveShift).toBe('function');
      expect(typeof repository.openShift).toBe('function');
      expect(typeof repository.closeShift).toBe('function');
      expect(typeof repository.getShiftSummary).toBe('function');
      expect(typeof repository.getOrders).toBe('function');
      expect(typeof repository.createOrder).toBe('function');
      expect(typeof repository.updateOrderStatus).toBe('function');
      expect(typeof repository.getOrderByTrackingToken).toBe('function');
      expect(typeof repository.getOrderStatusHistory).toBe('function');

      // Phase 2 Transit methods
      expect(typeof repository.createTransitManifest).toBe('function');
      expect(typeof repository.getTransitManifest).toBe('function');
      expect(typeof repository.listTransitManifests).toBe('function');
      expect(typeof repository.transitionTransitManifest).toBe('function');
      expect(typeof repository.receiveTransitManifest).toBe('function');
      expect(typeof repository.getTransitManifestItems).toBe('function');
      expect(typeof repository.getTransitManifestHistory).toBe('function');
      expect(typeof repository.getEligibleOrdersForTransit).toBe('function');

      // Phase 4B Rework Gate & Workshop Kanban methods
      expect(typeof repository.createOrderReworkRequest).toBe('function');
      expect(typeof repository.getOrderReworkRequests).toBe('function');
      expect(typeof repository.getActiveOrderReworkRequest).toBe('function');
      expect(typeof repository.cancelOrderReworkRequest).toBe('function');
      expect(typeof repository.getWorkshopOrders).toBe('function');

      // Reset method
      expect(typeof repository.resetSandbox).toBe('function');
    });
  });

  describe('2. Error Normalization', () => {
    it('normalizes duplicate/conflict database errors to CONFLICT', () => {
      const err = normalizeRepositoryError(new Error('Order 123 is already assigned to active manifest'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('CONFLICT');
    });

    it('normalizes validation errors to VALIDATION_ERROR', () => {
      const err = normalizeRepositoryError(new Error('Source branch and destination branch must be different'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('normalizes illegal transition errors to INVALID_STATE_TRANSITION', () => {
      const err = normalizeRepositoryError(new Error('Illegal state transition: cannot transition from DRAFT to RECEIVED'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('normalizes variance note/financial errors to FINANCIAL_VALIDATION_ERROR', () => {
      const err = normalizeRepositoryError(new Error('Selisih kas terdeteksi (10000). Wajib mencantumkan variance_note minimal 5 karakter.'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('FINANCIAL_VALIDATION_ERROR');
    });

    it('normalizes access denied errors to FORBIDDEN', () => {
      const err = normalizeRepositoryError(new Error('Access denied for branch xyz'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('FORBIDDEN');
    });

    it('normalizes not found errors to NOT_FOUND', () => {
      const err = normalizeRepositoryError(new Error('Manifest xyz not found'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('NOT_FOUND');
    });

    it('normalizes unspecified database errors to DATABASE_ERROR', () => {
      const err = normalizeRepositoryError(new Error('Connection timeout to host'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('DATABASE_ERROR');
    });

    it('normalizes rework gate custody violations to VALIDATION_ERROR', () => {
      const err = normalizeRepositoryError(new Error('Physical custody violation: Order ORD-001 is not physically at origin outlet'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('normalizes cross-tenant violations to FORBIDDEN', () => {
      const err = normalizeRepositoryError(new Error('Cross-tenant violation: Order belongs to another organization.'));
      expect(err).toBeInstanceOf(RepositoryError);
      expect(err.code).toBe('FORBIDDEN');
    });
  });

  describe('3. Workshop Kanban & Custody Segregation Contract', () => {
    it('returns washQueue and damagedQueue arrays complying with the contract', async () => {
      const result = await repository.getWorkshopOrders('test-workshop-id');
      expect(result).toHaveProperty('washQueue');
      expect(result).toHaveProperty('damagedQueue');
      expect(Array.isArray(result.washQueue)).toBe(true);
      expect(Array.isArray(result.damagedQueue)).toBe(true);
    });
  });
});
