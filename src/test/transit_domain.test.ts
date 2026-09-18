import { describe, it, expect } from 'vitest';
import {
  canTransitionManifest,
  assertManifestTransition,
  transitionManifest,
  ManifestTransitionError,
  isOrderEligibleForTransit,
  validateManifestDraft,
  calculateManifestDiscrepancy,
  assertOrderEligibleForManifest,
  assertManifestMutable,
  assertManifestItemMutable,
  assertManifestCanRemoveItem,
  assertManifestRouteMutable,
  assertManifestDeletable,
  determineTransitRouteDirection,
  isOutboundTransitEligible,
  isReturnTransitEligible,
  getLatestCompletedOutbound,
  getLatestCompletedReturn,
  getLatestOutboundItem,
  deriveOrderCustodyState,
  HistoricalTransitItem,
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

describe('Transit Domain Hardening (P0-A & P0-B)', () => {
  const baseManifest = {
    id: 'man-1',
    organization_id: 'org-1',
    source_branch_id: 'branch-a',
    destination_branch_id: 'branch-b',
    status: 'DRAFT' as const,
  };

  describe('assertOrderEligibleForManifest', () => {
    it('accepts order from same org and source branch', () => {
      expect(() =>
        assertOrderEligibleForManifest(baseManifest, {
          id: 'ord-1',
          organization_id: 'org-1',
          branch_id: 'branch-a',
          status: 'RECEIVED',
        })
      ).not.toThrow();
    });

    it('rejects order with different branch_id (Cross-Branch)', () => {
      expect(() =>
        assertOrderEligibleForManifest(baseManifest, {
          id: 'ord-1',
          organization_id: 'org-1',
          branch_id: 'branch-b',
          status: 'RECEIVED',
        })
      ).toThrow(/Cross-branch violation/);
    });

    it('rejects order with different organization_id (Cross-Tenant)', () => {
      expect(() =>
        assertOrderEligibleForManifest(baseManifest, {
          id: 'ord-1',
          organization_id: 'org-2',
          branch_id: 'branch-a',
          status: 'RECEIVED',
        })
      ).toThrow(/Cross-tenant violation/);
    });

    it('rejects order with CANCELLED or COMPLETED status', () => {
      expect(() =>
        assertOrderEligibleForManifest(baseManifest, {
          id: 'ord-1',
          organization_id: 'org-1',
          branch_id: 'branch-a',
          status: 'CANCELLED',
        })
      ).toThrow(/tidak eligible/);

      expect(() =>
        assertOrderEligibleForManifest(baseManifest, {
          id: 'ord-1',
          organization_id: 'org-1',
          branch_id: 'branch-a',
          status: 'COMPLETED',
        })
      ).toThrow(/tidak eligible/);
    });

    it('rejects attaching order to IN_TRANSIT or terminal manifests', () => {
      expect(() =>
        assertOrderEligibleForManifest(
          { ...baseManifest, status: 'IN_TRANSIT' },
          { id: 'ord-1', branch_id: 'branch-a', status: 'RECEIVED' }
        )
      ).toThrow(/Cannot attach order/);

      expect(() =>
        assertOrderEligibleForManifest(
          { ...baseManifest, status: 'RECEIVED' },
          { id: 'ord-1', branch_id: 'branch-a', status: 'RECEIVED' }
        )
      ).toThrow(/Cannot attach order/);
    });
  });

  describe('assertManifestMutable', () => {
    it('permits mutations on DRAFT, READY_TO_DISPATCH, and IN_TRANSIT', () => {
      expect(() => assertManifestMutable({ id: 'man-1', status: 'DRAFT' })).not.toThrow();
      expect(() => assertManifestMutable({ id: 'man-1', status: 'READY_TO_DISPATCH' })).not.toThrow();
      expect(() => assertManifestMutable({ id: 'man-1', status: 'IN_TRANSIT' })).not.toThrow();
    });

    it('strictly rejects mutations on RECEIVED manifest', () => {
      expect(() => assertManifestMutable({ id: 'man-1', status: 'RECEIVED' })).toThrow(
        /is already RECEIVED and is strictly immutable/
      );
    });

    it('strictly rejects mutations on CANCELLED manifest', () => {
      expect(() => assertManifestMutable({ id: 'man-1', status: 'CANCELLED' })).toThrow(
        /is CANCELLED and is strictly immutable/
      );
    });
  });

  describe('assertManifestItemMutable & assertManifestCanRemoveItem', () => {
    it('permits item mutations when parent manifest is active', () => {
      expect(() => assertManifestItemMutable({ id: 'man-1', status: 'DRAFT' })).not.toThrow();
      expect(() => assertManifestItemMutable({ id: 'man-1', status: 'IN_TRANSIT' })).not.toThrow();
    });

    it('strictly rejects item mutations when parent manifest is RECEIVED', () => {
      expect(() => assertManifestItemMutable({ id: 'man-1', status: 'RECEIVED' })).toThrow(
        /Parent manifest man-1 is already RECEIVED. Manifest items are strictly immutable/
      );
    });

    it('strictly rejects item mutations when parent manifest is CANCELLED', () => {
      expect(() => assertManifestItemMutable({ id: 'man-1', status: 'CANCELLED' })).toThrow(
        /Parent manifest man-1 is CANCELLED/
      );
    });

    it('permits item removal only in DRAFT status', () => {
      expect(() => assertManifestCanRemoveItem({ id: 'man-1', status: 'DRAFT' })).not.toThrow();
      expect(() => assertManifestCanRemoveItem({ id: 'man-1', status: 'READY_TO_DISPATCH' })).toThrow(
        /Items can only be removed while in DRAFT/
      );
      expect(() => assertManifestCanRemoveItem({ id: 'man-1', status: 'IN_TRANSIT' })).toThrow(
        /Items can only be removed while in DRAFT/
      );
      expect(() => assertManifestCanRemoveItem({ id: 'man-1', status: 'RECEIVED' })).toThrow(
        /Items can only be removed while in DRAFT/
      );
    });
  });

  describe('assertManifestRouteMutable (Parent Source Branch Integrity O-01)', () => {
    const draftManifest = {
      id: 'man-draft-1',
      status: 'DRAFT' as TransitManifestStatus,
      source_branch_id: 'branch-a',
      destination_branch_id: 'branch-b',
    };

    it('Case C: permits changing source branch on DRAFT when NO items are attached', () => {
      expect(() =>
        assertManifestRouteMutable(draftManifest, 'branch-c', undefined, 0)
      ).not.toThrow();
    });

    it('Case A: strictly rejects changing source branch on DRAFT when items are attached', () => {
      expect(() =>
        assertManifestRouteMutable(draftManifest, 'branch-c', undefined, 2)
      ).toThrow(
        /Cannot modify source_branch_id of manifest man-draft-1 while items are attached/
      );
    });

    it('permits changing destination branch on DRAFT even when items are attached', () => {
      expect(() =>
        assertManifestRouteMutable(draftManifest, undefined, 'branch-c', 2)
      ).not.toThrow();
    });

    it('strictly rejects altering route when manifest is IN_TRANSIT', () => {
      const inTransitManifest = { ...draftManifest, status: 'IN_TRANSIT' as TransitManifestStatus };
      expect(() =>
        assertManifestRouteMutable(inTransitManifest, 'branch-c', undefined, 0)
      ).toThrow(/Cannot alter source or destination branch of manifest man-draft-1 while IN_TRANSIT/);
      expect(() =>
        assertManifestRouteMutable(inTransitManifest, undefined, 'branch-c', 0)
      ).toThrow(/Cannot alter source or destination branch of manifest man-draft-1 while IN_TRANSIT/);
    });

    it('strictly rejects route updates on RECEIVED and CANCELLED manifests', () => {
      const receivedManifest = { ...draftManifest, status: 'RECEIVED' as TransitManifestStatus };
      expect(() =>
        assertManifestRouteMutable(receivedManifest, 'branch-c', undefined, 0)
      ).toThrow(/is already RECEIVED and is strictly immutable/);

      const cancelledManifest = { ...draftManifest, status: 'CANCELLED' as TransitManifestStatus };
      expect(() =>
        assertManifestRouteMutable(cancelledManifest, 'branch-c', undefined, 0)
      ).toThrow(/is CANCELLED and is strictly immutable/);
    });
  });

  describe('assertManifestDeletable (Manifest Deletion Guard M-01)', () => {
    it('Case D: strictly rejects deleting RECEIVED manifest', () => {
      expect(() =>
        assertManifestDeletable({ id: 'man-rec-1', status: 'RECEIVED' })
      ).toThrow(/Manifest man-rec-1 is already RECEIVED and cannot be deleted/);
    });

    it('Case E: strictly rejects deleting CANCELLED manifest', () => {
      expect(() =>
        assertManifestDeletable({ id: 'man-can-1', status: 'CANCELLED' })
      ).toThrow(/Manifest man-can-1 is CANCELLED and cannot be deleted/);
    });

    it('strictly rejects deleting active manifests (IN_TRANSIT, READY_TO_DISPATCH)', () => {
      expect(() =>
        assertManifestDeletable({ id: 'man-active-1', status: 'IN_TRANSIT' })
      ).toThrow(/Manifest man-active-1 is in active status IN_TRANSIT and cannot be deleted/);

      expect(() =>
        assertManifestDeletable({ id: 'man-active-2', status: 'READY_TO_DISPATCH' })
      ).toThrow(/Manifest man-active-2 is in active status READY_TO_DISPATCH and cannot be deleted/);
    });

    it('strictly rejects deleting DRAFT manifest (audit trail preservation)', () => {
      expect(() =>
        assertManifestDeletable({ id: 'man-draft-1', status: 'DRAFT' })
      ).toThrow(/Manifest man-draft-1 is in DRAFT status and cannot be deleted/);
    });
  });

  // ==========================================================================
  // 10. DIRECTED TRANSIT ROUTING (STEP 4B.5 / MODEL C)
  // ==========================================================================
  describe('10. Directed Transit Routing Domain Logic (STEP 4B.5 / Model C)', () => {
    const OUTLET_A = 'branch-outlet-a';
    const OUTLET_C = 'branch-outlet-c';
    const CENTRAL_B = 'branch-central-b';

    const baseOrder = {
      id: 'ord-100',
      organization_id: 'org-1',
      branch_id: OUTLET_A,
      production_branch_id: CENTRAL_B,
      status: 'RECEIVED' as OrderStatus,
      order_number: 'ORD-100',
    };

    describe('determineTransitRouteDirection', () => {
      it('identifies OUTBOUND: Origin Outlet -> Designated Workshop', () => {
        const dir = determineTransitRouteDirection({
          order: baseOrder,
          sourceBranchId: OUTLET_A,
          destinationBranchId: CENTRAL_B,
        });
        expect(dir).toBe('OUTBOUND');
      });

      it('identifies RETURN: Designated Workshop -> Origin Outlet', () => {
        const dir = determineTransitRouteDirection({
          order: baseOrder,
          sourceBranchId: CENTRAL_B,
          destinationBranchId: OUTLET_A,
        });
        expect(dir).toBe('RETURN');
      });

      it('rejects self-routing (A -> A or B -> B)', () => {
        expect(
          determineTransitRouteDirection({
            order: baseOrder,
            sourceBranchId: OUTLET_A,
            destinationBranchId: OUTLET_A,
          })
        ).toBe('INVALID');
      });

      it('rejects routing to unexpected destination (A -> C when prod is B)', () => {
        expect(
          determineTransitRouteDirection({
            order: baseOrder,
            sourceBranchId: OUTLET_A,
            destinationBranchId: OUTLET_C,
          })
        ).toBe('INVALID');
      });
    });

    describe('isOutboundTransitEligible', () => {
      it('approves outbound when no prior transit exists', () => {
        const eligible = isOutboundTransitEligible(
          baseOrder,
          OUTLET_A,
          CENTRAL_B,
          []
        );
        expect(eligible).toBe(true);
      });

      it('rejects outbound if order is in an active manifest (IN_TRANSIT)', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'EXPECTED',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'IN_TRANSIT',
            },
          },
        ];
        expect(isOutboundTransitEligible(baseOrder, OUTLET_A, CENTRAL_B, history)).toBe(false);
      });

      it('rejects outbound if order is already received at workshop and not yet returned (Re-Eligibility Gap Fixed)', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'RECEIVED_OK',
            received_at: '2026-09-18T10:00:00.000Z',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'RECEIVED',
              received_at: '2026-09-18T10:00:00.000Z',
            },
          },
        ];
        expect(isOutboundTransitEligible(baseOrder, OUTLET_A, CENTRAL_B, history)).toBe(false);
      });

      it('allows outbound if previous outbound was cancelled', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'EXPECTED',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'CANCELLED',
            },
          },
        ];
        expect(isOutboundTransitEligible(baseOrder, OUTLET_A, CENTRAL_B, history)).toBe(true);
      });
    });

    describe('isReturnTransitEligible', () => {
      it('rejects return if outbound manifest was never created/received', () => {
        expect(isReturnTransitEligible(baseOrder, CENTRAL_B, OUTLET_A, [])).toBe(false);
      });

      it('rejects return if outbound manifest is still IN_TRANSIT', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'EXPECTED',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'IN_TRANSIT',
            },
          },
        ];
        expect(isReturnTransitEligible(baseOrder, CENTRAL_B, OUTLET_A, history)).toBe(false);
      });

      it('rejects return if outbound manifest was CANCELLED', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'EXPECTED',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'CANCELLED',
            },
          },
        ];
        expect(isReturnTransitEligible(baseOrder, CENTRAL_B, OUTLET_A, history)).toBe(false);
      });

      it('rejects return if outbound item was marked MISSING', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'MISSING',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'RECEIVED',
              received_at: '2026-09-18T10:00:00.000Z',
            },
          },
        ];
        expect(isReturnTransitEligible(baseOrder, CENTRAL_B, OUTLET_A, history)).toBe(false);
      });

      it('approves return when outbound was received with RECEIVED_OK', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'RECEIVED_OK',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'RECEIVED',
              received_at: '2026-09-18T10:00:00.000Z',
            },
          },
        ];
        expect(isReturnTransitEligible(baseOrder, CENTRAL_B, OUTLET_A, history)).toBe(true);
      });

      it('rejects duplicate return if order was already returned to outlet', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'RECEIVED_OK',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'RECEIVED',
              received_at: '2026-09-18T10:00:00.000Z',
            },
          },
          {
            order_id: baseOrder.id,
            received_status: 'RECEIVED_OK',
            manifest: {
              source_branch_id: CENTRAL_B,
              destination_branch_id: OUTLET_A,
              status: 'RECEIVED',
              received_at: '2026-09-18T14:00:00.000Z',
            },
          },
        ];
        expect(isReturnTransitEligible(baseOrder, CENTRAL_B, OUTLET_A, history)).toBe(false);
      });
    });

    describe('assertOrderEligibleForManifest with directed routing', () => {
      const validOutboundManifest = {
        organization_id: 'org-1',
        source_branch_id: OUTLET_A,
        destination_branch_id: CENTRAL_B,
        status: 'DRAFT' as const,
      };

      const validReturnManifest = {
        organization_id: 'org-1',
        source_branch_id: CENTRAL_B,
        destination_branch_id: OUTLET_A,
        status: 'DRAFT' as const,
      };

      it('accepts valid outbound order', () => {
        expect(() =>
          assertOrderEligibleForManifest(validOutboundManifest, baseOrder, [])
        ).not.toThrow();
      });

      it('rejects outbound with invalid destination (A -> C)', () => {
        expect(() =>
          assertOrderEligibleForManifest(
            { ...validOutboundManifest, destination_branch_id: OUTLET_C },
            baseOrder,
            []
          )
        ).toThrow(/Cross-branch violation|Outbound route violation/);
      });

      it('rejects return if outbound was not received', () => {
        expect(() =>
          assertOrderEligibleForManifest(validReturnManifest, baseOrder, [])
        ).toThrow(/Return route violation/);
      });

      it('accepts return if outbound was received', () => {
        const history: HistoricalTransitItem[] = [
          {
            order_id: baseOrder.id,
            received_status: 'RECEIVED_OK',
            manifest: {
              source_branch_id: OUTLET_A,
              destination_branch_id: CENTRAL_B,
              status: 'RECEIVED',
              received_at: '2026-09-18T10:00:00.000Z',
            },
          },
        ];
        expect(() =>
          assertOrderEligibleForManifest(validReturnManifest, baseOrder, history)
        ).not.toThrow();
      });
    });
  });

  // ==========================================================================
  // 11. REWORK GATE & MULTI-CYCLE TRANSIT DOMAIN LOGIC (STEP 4B.6.2)
  // ==========================================================================
  describe('11. Rework Gate & Multi-Cycle Transit Domain Logic (STEP 4B.6.2)', () => {
    const OUTLET_A = 'branch-outlet-a';
    const CENTRAL_B = 'branch-central-b';

    const order1 = {
      id: 'ord-multi-1',
      organization_id: 'org-1',
      branch_id: OUTLET_A,
      production_branch_id: CENTRAL_B,
      status: 'RECEIVED' as OrderStatus,
      order_number: 'ORD-M1',
    };

    const outboundCycle1Receipt: HistoricalTransitItem = {
      order_id: order1.id,
      received_status: 'RECEIVED_OK',
      received_at: '2026-09-18T08:00:00.000Z',
      manifest: {
        source_branch_id: OUTLET_A,
        destination_branch_id: CENTRAL_B,
        status: 'RECEIVED',
        received_at: '2026-09-18T08:00:00.000Z',
      },
    };

    const returnCycle1Receipt: HistoricalTransitItem = {
      order_id: order1.id,
      received_status: 'RECEIVED_OK',
      received_at: '2026-09-18T10:00:00.000Z',
      manifest: {
        source_branch_id: CENTRAL_B,
        destination_branch_id: OUTLET_A,
        status: 'RECEIVED',
        received_at: '2026-09-18T10:00:00.000Z',
      },
    };

    it('allows Cycle 1 outbound dispatch without rework authorization', () => {
      expect(isOutboundTransitEligible(order1, OUTLET_A, CENTRAL_B, [], false)).toBe(true);
    });

    it('rejects Cycle 2 outbound dispatch when order has not yet returned to origin outlet', () => {
      const history = [outboundCycle1Receipt];
      expect(isOutboundTransitEligible(order1, OUTLET_A, CENTRAL_B, history, false)).toBe(false);
      expect(isOutboundTransitEligible(order1, OUTLET_A, CENTRAL_B, history, true)).toBe(false);
    });

    it('rejects Cycle 2 outbound dispatch without an active APPROVED rework authorization', () => {
      const history = [outboundCycle1Receipt, returnCycle1Receipt];
      // hasApprovedRework = false
      expect(isOutboundTransitEligible(order1, OUTLET_A, CENTRAL_B, history, false)).toBe(false);

      expect(() =>
        assertOrderEligibleForManifest(
          {
            organization_id: 'org-1',
            source_branch_id: OUTLET_A,
            destination_branch_id: CENTRAL_B,
            status: 'DRAFT',
          },
          order1,
          history,
          false
        )
      ).toThrow(/requires an active approved rework request/);
    });

    it('allows Cycle 2 outbound dispatch when an active APPROVED rework authorization is present', () => {
      const history = [outboundCycle1Receipt, returnCycle1Receipt];
      // hasApprovedRework = true
      expect(isOutboundTransitEligible(order1, OUTLET_A, CENTRAL_B, history, true)).toBe(true);

      expect(() =>
        assertOrderEligibleForManifest(
          {
            organization_id: 'org-1',
            source_branch_id: OUTLET_A,
            destination_branch_id: CENTRAL_B,
            status: 'DRAFT',
          },
          order1,
          history,
          true
        )
      ).not.toThrow();
    });

    it('permits return transit when outbound item was received DAMAGED (Rule 15)', () => {
      const damagedOutbound: HistoricalTransitItem = {
        order_id: order1.id,
        received_status: 'DAMAGED',
        received_at: '2026-09-18T08:00:00.000Z',
        manifest: {
          source_branch_id: OUTLET_A,
          destination_branch_id: CENTRAL_B,
          status: 'RECEIVED',
          received_at: '2026-09-18T08:00:00.000Z',
        },
      };
      expect(isReturnTransitEligible(order1, CENTRAL_B, OUTLET_A, [damagedOutbound])).toBe(true);
    });

    it('strictly forbids return transit when outbound item was received MISSING (Rule 16)', () => {
      const missingOutbound: HistoricalTransitItem = {
        order_id: order1.id,
        received_status: 'MISSING',
        received_at: '2026-09-18T08:00:00.000Z',
        manifest: {
          source_branch_id: OUTLET_A,
          destination_branch_id: CENTRAL_B,
          status: 'RECEIVED',
          received_at: '2026-09-18T08:00:00.000Z',
        },
      };
      expect(isReturnTransitEligible(order1, CENTRAL_B, OUTLET_A, [missingOutbound])).toBe(false);
    });

    it('strictly forbids normal return transit when outbound item was marked WRONG_BRANCH (Rule 17)', () => {
      const wrongBranchOutbound: HistoricalTransitItem = {
        order_id: order1.id,
        received_status: 'WRONG_BRANCH',
        received_at: '2026-09-18T08:00:00.000Z',
        manifest: {
          source_branch_id: OUTLET_A,
          destination_branch_id: CENTRAL_B,
          status: 'RECEIVED',
          received_at: '2026-09-18T08:00:00.000Z',
        },
      };
      expect(isReturnTransitEligible(order1, CENTRAL_B, OUTLET_A, [wrongBranchOutbound])).toBe(false);
    });

    it('correctly resolves latest directional evidence via max timestamp (deterministic)', () => {
      const olderOutbound: HistoricalTransitItem = {
        order_id: order1.id,
        received_status: 'RECEIVED_OK',
        received_at: '2026-09-18T07:00:00.000Z',
        manifest: {
          source_branch_id: OUTLET_A,
          destination_branch_id: CENTRAL_B,
          status: 'RECEIVED',
          received_at: '2026-09-18T07:00:00.000Z',
        },
      };
      const newerOutbound: HistoricalTransitItem = {
        order_id: order1.id,
        received_status: 'DAMAGED',
        received_at: '2026-09-18T09:00:00.000Z',
        manifest: {
          source_branch_id: OUTLET_A,
          destination_branch_id: CENTRAL_B,
          status: 'RECEIVED',
          received_at: '2026-09-18T09:00:00.000Z',
        },
      };

      const latest = getLatestCompletedOutbound(order1.id, [olderOutbound, newerOutbound], OUTLET_A, CENTRAL_B);
      expect(latest?.received_status).toBe('DAMAGED');
      expect(latest?.manifest.received_at).toBe('2026-09-18T09:00:00.000Z');
    });

    describe('deriveOrderCustodyState', () => {
      it('returns AT_ORIGIN for local order at origin outlet', () => {
        const localOrder = { ...order1, production_branch_id: OUTLET_A };
        expect(deriveOrderCustodyState(localOrder, [])).toBe('AT_ORIGIN');
      });

      it('returns AT_ORIGIN for external order before any outbound transit', () => {
        expect(deriveOrderCustodyState(order1, [])).toBe('AT_ORIGIN');
      });

      it('returns OUTBOUND_IN_TRANSIT when order is assigned to active outbound manifest', () => {
        const inTransitItem: HistoricalTransitItem = {
          order_id: order1.id,
          received_status: 'EXPECTED',
          manifest: {
            source_branch_id: OUTLET_A,
            destination_branch_id: CENTRAL_B,
            status: 'IN_TRANSIT',
          },
        };
        expect(deriveOrderCustodyState(order1, [inTransitItem])).toBe('OUTBOUND_IN_TRANSIT');
      });

      it('returns AT_WORKSHOP when order is received at workshop with RECEIVED_OK', () => {
        expect(deriveOrderCustodyState(order1, [outboundCycle1Receipt])).toBe('AT_WORKSHOP');
      });

      it('returns AT_WORKSHOP_DAMAGED when order is received at workshop with DAMAGED', () => {
        const damagedItem: HistoricalTransitItem = {
          ...outboundCycle1Receipt,
          received_status: 'DAMAGED',
        };
        expect(deriveOrderCustodyState(order1, [damagedItem])).toBe('AT_WORKSHOP_DAMAGED');
      });

      it('returns CUSTODY_UNKNOWN_MISSING when order is marked MISSING', () => {
        const missingItem: HistoricalTransitItem = {
          ...outboundCycle1Receipt,
          received_status: 'MISSING',
        };
        expect(deriveOrderCustodyState(order1, [missingItem])).toBe('CUSTODY_UNKNOWN_MISSING');
      });

      it('returns CUSTODY_EXCEPTION_WRONG_BRANCH when order is marked WRONG_BRANCH', () => {
        const wrongBranchItem: HistoricalTransitItem = {
          ...outboundCycle1Receipt,
          received_status: 'WRONG_BRANCH',
        };
        expect(deriveOrderCustodyState(order1, [wrongBranchItem])).toBe('CUSTODY_EXCEPTION_WRONG_BRANCH');
      });

      it('returns AT_ORIGIN after return transit is completed with RECEIVED_OK', () => {
        expect(deriveOrderCustodyState(order1, [outboundCycle1Receipt, returnCycle1Receipt])).toBe('AT_ORIGIN');
      });
    });
  });
});


