import { describe, it, expect, beforeEach } from 'vitest';
import { repository, RepositoryError } from '../core/services/repository';
import { Order } from '../core/types/database';

describe('Transit Manifest Repository — Sandbox Operations', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const OUTLET_BKS = '22222222-2222-2222-2222-222222222221';
  const OUTLET_TBN = '22222222-2222-2222-2222-222222222222';
  const CENTRAL_PROD = '22222222-2222-2222-2222-222222222223';
  const DRIVER_ID = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    repository.resetSandbox();
  });

  describe('1. Create Manifest', () => {
    it('successfully creates a draft manifest with valid orders', async () => {
      // Find an eligible order at Outlet BKS
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      expect(eligible.length).toBeGreaterThan(0);
      const testOrderId = eligible[0].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        driverUserId: DRIVER_ID,
        vehicleIdentifier: 'B 9999 KRO',
        notes: 'Pagi hari batch 1',
        orderIds: [testOrderId],
      });

      expect(manifest.id).toBeDefined();
      expect(manifest.manifest_number).toMatch(/^TRX-BKS-CP0?-\d{6}-\d{3}$/);
      expect(manifest.status).toBe('DRAFT');
      expect(manifest.source_branch_id).toBe(OUTLET_BKS);
      expect(manifest.destination_branch_id).toBe(CENTRAL_PROD);
      expect(manifest.total_expected_orders).toBe(1);
      expect(manifest.items).toHaveLength(1);
      expect(manifest.items![0].order_id).toBe(testOrderId);
      expect(manifest.items![0].received_status).toBe('EXPECTED');
    });

    it('rejects manifest creation when source and destination are identical', async () => {
      await expect(
        repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: OUTLET_BKS, // Self-routing
          orderIds: [],
        })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: OUTLET_BKS,
          orderIds: [],
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(RepositoryError);
        expect(err.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects order already assigned to an active manifest (Double-Dispatch Prevention)', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      expect(eligible.length).toBeGreaterThan(0);
      const testOrderId = eligible[0].id;

      // 1. Create first active manifest with order
      await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      // 2. Attempt to create second manifest with same order
      await expect(
        repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [testOrderId],
        })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [testOrderId],
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(RepositoryError);
        expect(err.code).toBe('CONFLICT');
      }
    });
  });

  describe('2. Get & List Manifests', () => {
    it('retrieves manifest with joined branches, driver, and items', async () => {
      const manifests = await repository.listTransitManifests();
      expect(manifests.length).toBeGreaterThan(0);
      const first = manifests[0];

      const detailed = await repository.getTransitManifest(first.id);
      expect(detailed).not.toBeNull();
      expect(detailed!.id).toBe(first.id);
      expect(detailed!.source_branch).toBeDefined();
      expect(detailed!.destination_branch).toBeDefined();
      expect(Array.isArray(detailed!.items)).toBe(true);
    });

    it('returns null for non-existent manifest id', async () => {
      const nonExistent = await repository.getTransitManifest('non-existent-id-0000');
      expect(nonExistent).toBeNull();
    });

    it('filters manifests by status and branch', async () => {
      const drafts = await repository.listTransitManifests({ status: 'DRAFT' });
      expect(drafts.every((m) => m.status === 'DRAFT')).toBe(true);

      const inTransit = await repository.listTransitManifests({ status: 'IN_TRANSIT' });
      expect(inTransit.every((m) => m.status === 'IN_TRANSIT')).toBe(true);

      const bksManifests = await repository.listTransitManifests({ branchId: OUTLET_BKS });
      expect(
        bksManifests.every(
          (m) => m.source_branch_id === OUTLET_BKS || m.destination_branch_id === OUTLET_BKS
        )
      ).toBe(true);
    });
  });

  describe('3. Transition Manifest', () => {
    it('transitions DRAFT -> READY_TO_DISPATCH -> IN_TRANSIT with audit history', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      const created = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      // Step 1: DRAFT -> READY_TO_DISPATCH
      const ready = await repository.transitionTransitManifest(
        created.id,
        'READY_TO_DISPATCH',
        'Semua cucian sudah dimuat ke karung'
      );
      expect(ready.status).toBe('READY_TO_DISPATCH');

      // Step 2: READY_TO_DISPATCH -> IN_TRANSIT
      const inTransit = await repository.transitionTransitManifest(
        created.id,
        'IN_TRANSIT',
        'Driver berangkat membawa armada'
      );
      expect(inTransit.status).toBe('IN_TRANSIT');
      expect(inTransit.dispatched_at).toBeDefined();

      // Verify audit history
      const history = await repository.getTransitManifestHistory(created.id);
      expect(history.length).toBeGreaterThanOrEqual(3); // DRAFT + READY + IN_TRANSIT
      expect(history[0].to_status).toBe('IN_TRANSIT');
      expect(history[1].to_status).toBe('READY_TO_DISPATCH');
    });

    it('rejects READY_TO_DISPATCH transition when manifest has zero orders', async () => {
      const emptyDraft = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [],
      });

      await expect(
        repository.transitionTransitManifest(emptyDraft.id, 'READY_TO_DISPATCH')
      ).rejects.toThrowError(RepositoryError);
    });

    it('rejects direct transition to RECEIVED via transitionTransitManifest', async () => {
      const inTransitManifests = await repository.listTransitManifests({ status: 'IN_TRANSIT' });
      expect(inTransitManifests.length).toBeGreaterThan(0);
      const manifest = inTransitManifests[0];

      await expect(
        repository.transitionTransitManifest(manifest.id, 'RECEIVED')
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.transitionTransitManifest(manifest.id, 'RECEIVED');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('receiveTransitManifest()');
      }
    });

    it('rejects illegal transition e.g. IN_TRANSIT -> DRAFT', async () => {
      const inTransitManifests = await repository.listTransitManifests({ status: 'IN_TRANSIT' });
      const manifest = inTransitManifests[0];

      await expect(
        repository.transitionTransitManifest(manifest.id, 'DRAFT')
      ).rejects.toThrowError(RepositoryError);
    });
  });

  describe('4. Receive Manifest & Discrepancy Tracking', () => {
    it('receives manifest with clean RECEIVED_OK items', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      await repository.transitionTransitManifest(manifest.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(manifest.id, 'IN_TRANSIT');

      const received = await repository.receiveTransitManifest({
        manifestId: manifest.id,
        itemsReview: [
          {
            orderId: testOrderId,
            status: 'RECEIVED_OK',
            notes: 'Kondisi cucian baik',
          },
        ],
        summaryNotes: 'Semua item lengkap diterima di workshop',
      });

      expect(received.status).toBe('RECEIVED');
      expect(received.has_discrepancy).toBe(false);
      expect(received.total_received_orders).toBe(1);
      expect(received.received_at).toBeDefined();

      const items = await repository.getTransitManifestItems(manifest.id);
      expect(items[0].received_status).toBe('RECEIVED_OK');
    });

    it('automatically marks omitted items as MISSING on final receiving (DB RPC Parity)', async () => {
      // Create manifest with 2 orders: Order A & Order B
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      expect(eligible.length).toBeGreaterThanOrEqual(2);
      const orderA = eligible[0].id;
      const orderB = eligible[1].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [orderA, orderB],
      });

      await repository.transitionTransitManifest(manifest.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(manifest.id, 'IN_TRANSIT');

      // Operator only reviews Order A as RECEIVED_OK; Order B is omitted from inspection
      const received = await repository.receiveTransitManifest({
        manifestId: manifest.id,
        itemsReview: [
          {
            orderId: orderA,
            status: 'RECEIVED_OK',
          },
        ],
      });

      expect(received.status).toBe('RECEIVED');
      expect(received.has_discrepancy).toBe(true);
      expect(received.total_received_orders).toBe(1);

      const items = await repository.getTransitManifestItems(manifest.id);
      const itemA = items.find((i) => i.order_id === orderA);
      const itemB = items.find((i) => i.order_id === orderB);

      expect(itemA?.received_status).toBe('RECEIVED_OK');
      // Omitted item B MUST be converted from EXPECTED to MISSING
      expect(itemB?.received_status).toBe('MISSING');
      expect(itemB?.discrepancy_notes).toContain('Tidak ditemukan');
    });

    it('flags manifest has_discrepancy = true when item is DAMAGED or WRONG_BRANCH', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const orderA = eligible[0].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [orderA],
      });

      await repository.transitionTransitManifest(manifest.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(manifest.id, 'IN_TRANSIT');

      const received = await repository.receiveTransitManifest({
        manifestId: manifest.id,
        itemsReview: [
          {
            orderId: orderA,
            status: 'DAMAGED',
            notes: 'Plastik pembungkus robek dan pakaian basah terkena hujan',
          },
        ],
      });

      expect(received.status).toBe('RECEIVED');
      expect(received.has_discrepancy).toBe(true);
      expect(received.total_received_orders).toBe(0);
    });

    it('rejects receiving a manifest that is not IN_TRANSIT', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [eligible[0].id],
      });

      // Manifest is currently DRAFT
      await expect(
        repository.receiveTransitManifest({
          manifestId: manifest.id,
          itemsReview: [{ orderId: eligible[0].id, status: 'RECEIVED_OK' }],
        })
      ).rejects.toThrowError(RepositoryError);
    });
  });
});
