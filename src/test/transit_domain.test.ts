import { describe, it, expect } from 'vitest';
import {
  canTransitionManifest,
  assertManifestTransition,
  transitionManifest,
  ManifestTransitionError,
  isOrderEligibleForTransit,
  validateManifestDraft,
  calculateManifestDiscrepancy,
  TransitManifestStatus,
} from '../core/services/transitStateMachine';
import { TransitManifest, OrderStatus } from '../core/types/database';

describe('Transit Manifest State Machine', () => {
  const sampleManifest: TransitManifest = {
    id: 'man-1111',
    organization_id: 'org-1111',
    manifest_number: 'TRX-BKS-CP-260917-001',
    source_branch_id: 'branch-bks',
    destination_branch_id: 'branch-cp',
    status: 'DRAFT',
    total_expected_orders: 2,
    total_received_orders: 0,
    has_discrepancy: false,
    created_by: 'user-1',
    created_at: '2026-09-17T08:00:00.000Z',
    updated_at: '2026-09-17T08:00:00.000Z',
  };

  describe('canTransitionManifest', () => {
    it('allows legal forward transitions', () => {
      expect(canTransitionManifest('DRAFT', 'READY_TO_DISPATCH')).toBe(true);
      expect(canTransitionManifest('READY_TO_DISPATCH', 'IN_TRANSIT')).toBe(true);
      expect(canTransitionManifest('IN_TRANSIT', 'RECEIVED')).toBe(true);
    });

    it('allows legal cancellations', () => {
      expect(canTransitionManifest('DRAFT', 'CANCELLED')).toBe(true);
      expect(canTransitionManifest('READY_TO_DISPATCH', 'CANCELLED')).toBe(true);
    });

    it('allows resetting READY_TO_DISPATCH back to DRAFT', () => {
      expect(canTransitionManifest('READY_TO_DISPATCH', 'DRAFT')).toBe(true);
    });

    it('rejects illegal skipped transitions', () => {
      expect(canTransitionManifest('DRAFT', 'IN_TRANSIT')).toBe(false);
      expect(canTransitionManifest('DRAFT', 'RECEIVED')).toBe(false);
      expect(canTransitionManifest('READY_TO_DISPATCH', 'RECEIVED')).toBe(false);
    });

    it('rejects illegal reversal or cancellation from IN_TRANSIT', () => {
      expect(canTransitionManifest('IN_TRANSIT', 'DRAFT')).toBe(false);
      expect(canTransitionManifest('IN_TRANSIT', 'READY_TO_DISPATCH')).toBe(false);
      expect(canTransitionManifest('IN_TRANSIT', 'CANCELLED')).toBe(false);
    });

    it('rejects any transition from terminal states (RECEIVED, CANCELLED)', () => {
      const allStatuses: TransitManifestStatus[] = [
        'DRAFT',
        'READY_TO_DISPATCH',
        'IN_TRANSIT',
        'RECEIVED',
        'CANCELLED',
      ];

      for (const target of allStatuses) {
        expect(canTransitionManifest('RECEIVED', target)).toBe(false);
        expect(canTransitionManifest('CANCELLED', target)).toBe(false);
      }
    });

    it('rejects self-transitions (from === to)', () => {
      expect(canTransitionManifest('DRAFT', 'DRAFT')).toBe(false);
      expect(canTransitionManifest('IN_TRANSIT', 'IN_TRANSIT')).toBe(false);
    });
  });

  describe('assertManifestTransition & ManifestTransitionError', () => {
    it('does not throw on legal transitions', () => {
      expect(() => assertManifestTransition('DRAFT', 'READY_TO_DISPATCH')).not.toThrow();
      expect(() => assertManifestTransition('IN_TRANSIT', 'RECEIVED')).not.toThrow();
    });

    it('throws ManifestTransitionError on illegal transitions with status context', () => {
      try {
        assertManifestTransition('DRAFT', 'RECEIVED');
        expect.fail('Should have thrown ManifestTransitionError');
      } catch (err) {
        expect(err).toBeInstanceOf(ManifestTransitionError);
        const error = err as ManifestTransitionError;
        expect(error.currentStatus).toBe('DRAFT');
        expect(error.requestedStatus).toBe('RECEIVED');
        expect(error.message).toContain("tidak dapat mengubah status manifest dari 'DRAFT' ke 'RECEIVED'");
      }
    });

    it('throws specific immutable message when transitioning from RECEIVED', () => {
      expect(() => assertManifestTransition('RECEIVED', 'IN_TRANSIT')).toThrow(
        /Manifest telah berstatus akhir RECEIVED/
      );
    });

    it('throws specific immutable message when transitioning from CANCELLED', () => {
      expect(() => assertManifestTransition('CANCELLED', 'DRAFT')).toThrow(
        /Manifest telah berstatus CANCELLED/
      );
    });
  });

  describe('transitionManifest (Pure & Immutable)', () => {
    it('returns a new manifest without mutating the input object', () => {
      const original = { ...sampleManifest };
      const updated = transitionManifest(sampleManifest, 'READY_TO_DISPATCH', {
        notes: 'Semua karung telah ditimbang',
        now: '2026-09-17T09:00:00.000Z',
      });

      // Assert input was untouched
      expect(sampleManifest.status).toBe('DRAFT');
      expect(sampleManifest.notes).toBeUndefined();
      expect(sampleManifest).toEqual(original);

      // Assert output has updated fields
      expect(updated.status).toBe('READY_TO_DISPATCH');
      expect(updated.notes).toBe('Semua karung telah ditimbang');
      expect(updated.updated_at).toBe('2026-09-17T09:00:00.000Z');
      expect(Object.isFrozen(updated)).toBe(true);
    });

    it('sets dispatched_at and dispatched_by when transitioning to IN_TRANSIT', () => {
      const readyManifest: TransitManifest = {
        ...sampleManifest,
        status: 'READY_TO_DISPATCH',
      };

      const inTransit = transitionManifest(readyManifest, 'IN_TRANSIT', {
        actorId: 'driver-999',
        notes: 'Berangkat membawa 2 karung',
        now: '2026-09-17T10:00:00.000Z',
      });

      expect(inTransit.status).toBe('IN_TRANSIT');
      expect(inTransit.dispatched_by).toBe('driver-999');
      expect(inTransit.dispatched_at).toBe('2026-09-17T10:00:00.000Z');
      expect(inTransit.notes).toBe('Berangkat membawa 2 karung');
    });

    it('sets received_at and received_by when transitioning to RECEIVED', () => {
      const inTransitManifest: TransitManifest = {
        ...sampleManifest,
        status: 'IN_TRANSIT',
        dispatched_at: '2026-09-17T10:00:00.000Z',
      };

      const received = transitionManifest(inTransitManifest, 'RECEIVED', {
        actorId: 'receiver-888',
        notes: 'Diterima lengkap di workshop',
        now: '2026-09-17T11:00:00.000Z',
      });

      expect(received.status).toBe('RECEIVED');
      expect(received.received_by).toBe('receiver-888');
      expect(received.received_at).toBe('2026-09-17T11:00:00.000Z');
      expect(received.discrepancy_summary).toBe('Diterima lengkap di workshop');
    });
  });
});

describe('Order Eligibility for Transit', () => {
  it('rejects orders with CANCELLED status', () => {
    expect(isOrderEligibleForTransit({ status: 'CANCELLED' })).toBe(false);
  });

  it('rejects orders with COMPLETED status', () => {
    expect(isOrderEligibleForTransit({ status: 'COMPLETED' })).toBe(false);
  });

  it('accepts active production and transit-eligible statuses', () => {
    const eligibleStatuses: OrderStatus[] = [
      'DRAFT',
      'RECEIVED',
      'SORTING',
      'WASHING',
      'DRYING',
      'IRONING',
      'PACKING',
      'QC',
      'READY',
      'PICKED_UP',
      'DELIVERED',
    ];

    for (const status of eligibleStatuses) {
      expect(isOrderEligibleForTransit({ status })).toBe(true);
    }
  });
});

describe('validateManifestDraft', () => {
  it('rejects empty or whitespace organization_id', () => {
    const res = validateManifestDraft({
      organization_id: '   ',
      source_branch_id: 'b1',
      destination_branch_id: 'b2',
    });
    expect(res.isValid).toBe(false);
    expect(res.errors).toContain('Organization ID wajib diisi.');
  });

  it('rejects self-routing when source and destination are identical', () => {
    const res = validateManifestDraft({
      organization_id: 'org-1',
      source_branch_id: 'branch-bks',
      destination_branch_id: 'branch-bks',
    });
    expect(res.isValid).toBe(false);
    expect(res.errors).toContain(
      'Cabang asal dan cabang tujuan tidak boleh sama (self-routing ditolak).'
    );
  });

  it('accepts valid distinct branches', () => {
    const res = validateManifestDraft({
      organization_id: 'org-1',
      source_branch_id: 'branch-bks',
      destination_branch_id: 'branch-cp',
    });
    expect(res.isValid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });
});

describe('calculateManifestDiscrepancy', () => {
  it('reports no discrepancy when all items are RECEIVED_OK', () => {
    const res = calculateManifestDiscrepancy([
      { received_status: 'RECEIVED_OK' },
      { received_status: 'RECEIVED_OK' },
      { received_status: 'RECEIVED_OK' },
    ]);

    expect(res.hasDiscrepancy).toBe(false);
    expect(res.receivedOkCount).toBe(3);
    expect(res.missingCount).toBe(0);
    expect(res.damagedCount).toBe(0);
    expect(res.wrongBranchCount).toBe(0);
    expect(res.totalCount).toBe(3);
    expect(res.summaryText).toBe('Diterima lengkap & sesuai');
  });

  it('detects missing item discrepancy', () => {
    const res = calculateManifestDiscrepancy([
      { received_status: 'RECEIVED_OK' },
      { received_status: 'MISSING' },
    ]);

    expect(res.hasDiscrepancy).toBe(true);
    expect(res.missingCount).toBe(1);
    expect(res.receivedOkCount).toBe(1);
    expect(res.summaryText).toContain('1 hilang (missing)');
  });

  it('detects damaged item discrepancy', () => {
    const res = calculateManifestDiscrepancy([
      { received_status: 'RECEIVED_OK' },
      { received_status: 'DAMAGED' },
    ]);

    expect(res.hasDiscrepancy).toBe(true);
    expect(res.damagedCount).toBe(1);
    expect(res.summaryText).toContain('1 rusak (damaged)');
  });

  it('detects wrong branch discrepancy', () => {
    const res = calculateManifestDiscrepancy([
      { received_status: 'WRONG_BRANCH' },
    ]);

    expect(res.hasDiscrepancy).toBe(true);
    expect(res.wrongBranchCount).toBe(1);
    expect(res.summaryText).toContain('1 salah kirim cabang (wrong branch)');
  });

  it('tracks unresolved EXPECTED items', () => {
    const res = calculateManifestDiscrepancy([
      { received_status: 'RECEIVED_OK' },
      { received_status: 'EXPECTED' },
    ]);

    expect(res.unresolvedCount).toBe(1);
    expect(res.receivedOkCount).toBe(1);
    expect(res.summaryText).toContain('1 item belum diperiksa (masih EXPECTED)');
  });

  it('handles empty manifest items array gracefully', () => {
    const res = calculateManifestDiscrepancy([]);
    expect(res.hasDiscrepancy).toBe(false);
    expect(res.totalCount).toBe(0);
    expect(res.summaryText).toBe('Manifest kosong tanpa item');
  });

  it('reports multi-issue discrepancy accurately', () => {
    const res = calculateManifestDiscrepancy([
      { received_status: 'RECEIVED_OK' },
      { received_status: 'MISSING' },
      { received_status: 'DAMAGED' },
      { received_status: 'WRONG_BRANCH' },
    ]);

    expect(res.hasDiscrepancy).toBe(true);
    expect(res.receivedOkCount).toBe(1);
    expect(res.missingCount).toBe(1);
    expect(res.damagedCount).toBe(1);
    expect(res.wrongBranchCount).toBe(1);
    expect(res.totalCount).toBe(4);
    expect(res.summaryText).toContain('1 hilang');
    expect(res.summaryText).toContain('1 rusak');
    expect(res.summaryText).toContain('1 salah kirim');
  });
});
