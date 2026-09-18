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

  describe('5. Cross-Branch & Cross-Tenant Order Injection Protection (P0-A)', () => {
    it('Case 1: Rejects creating manifest when order belongs to different branch (same org)', async () => {
      // Create an order belonging to OUTLET_TBN
      const orderInTbn = await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_TBN,
          production_branch_id: OUTLET_TBN,
          customer_id: 'cust-1',
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal: 20000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 20000,
          paid_amount: 20000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: 'user-1',
        },
        []
      );

      // Attempt to create manifest with source = OUTLET_BKS but order from OUTLET_TBN
      await expect(
        repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [orderInTbn.id],
        })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [orderInTbn.id],
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(RepositoryError);
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.message).toContain('Cross-branch violation');
      }
    });

    it('Case 2: Rejects creating manifest when order belongs to different organization', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const testOrderId = eligible[0].id;
      const foreignOrgId = '99999999-9999-9999-9999-999999999999';

      await expect(
        repository.createTransitManifest({
          organizationId: foreignOrgId, // Cross-tenant
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [testOrderId],
        })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.createTransitManifest({
          organizationId: foreignOrgId,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [testOrderId],
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(RepositoryError);
        expect(err.code).toBe('FORBIDDEN');
        expect(err.message).toContain('Cross-tenant violation');
      }
    });

    it('Case 3: Accepts creating manifest when order belongs to same organization and source branch', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      expect(manifest.id).toBeDefined();
      expect(manifest.source_branch_id).toBe(OUTLET_BKS);
      expect(manifest.items![0].order_id).toBe(testOrderId);
    });

    it('Rejects addTransitManifestItem with cross-branch order on existing draft', async () => {
      const eligibleBks = await repository.getEligibleOrdersForTransit(OUTLET_BKS);

      const orderInTbn = await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_TBN,
          production_branch_id: OUTLET_TBN,
          customer_id: 'cust-1',
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal: 20000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 20000,
          paid_amount: 20000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: 'user-1',
        },
        []
      );

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [eligibleBks[0].id],
      });

      await expect(
        repository.addTransitManifestItem(manifest.id, orderInTbn.id)
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.addTransitManifestItem(manifest.id, orderInTbn.id);
      } catch (err: any) {
        expect(err).toBeInstanceOf(RepositoryError);
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.message).toContain('Cross-branch violation');
      }
    });
  });

  describe('6. RECEIVED & Terminal Manifest Immutability (P0-B)', () => {
    let receivedManifestId: string;
    let receivedOrderId: string;

    beforeEach(async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      receivedOrderId = eligible[0].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [receivedOrderId],
        vehicleIdentifier: 'B 1234 ABC',
        notes: 'Original notes',
      });

      await repository.transitionTransitManifest(manifest.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(manifest.id, 'IN_TRANSIT');

      const received = await repository.receiveTransitManifest({
        manifestId: manifest.id,
        itemsReview: [{ orderId: receivedOrderId, status: 'RECEIVED_OK' }],
      });

      expect(received.status).toBe('RECEIVED');
      receivedManifestId = received.id;
    });

    it('Manifest: RECEIVED -> change driver -> REJECTED', async () => {
      await expect(
        repository.updateTransitManifest(receivedManifestId, { driver_user_id: DRIVER_ID })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.updateTransitManifest(receivedManifestId, { driver_user_id: DRIVER_ID });
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('strictly immutable');
      }
    });

    it('Manifest: RECEIVED -> change vehicle -> REJECTED', async () => {
      await expect(
        repository.updateTransitManifest(receivedManifestId, { vehicle_identifier: 'B 9999 HACK' })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.updateTransitManifest(receivedManifestId, { vehicle_identifier: 'B 9999 HACK' });
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('strictly immutable');
      }
    });

    it('Manifest: RECEIVED -> change notes -> REJECTED', async () => {
      await expect(
        repository.updateTransitManifest(receivedManifestId, { notes: 'Tampered notes' })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.updateTransitManifest(receivedManifestId, { notes: 'Tampered notes' });
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('strictly immutable');
      }
    });

    it('Item: RECEIVED parent -> change received_status -> REJECTED', async () => {
      await expect(
        repository.updateTransitManifestItem(receivedManifestId, receivedOrderId, {
          received_status: 'DAMAGED',
        })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.updateTransitManifestItem(receivedManifestId, receivedOrderId, {
          received_status: 'DAMAGED',
        });
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('strictly immutable');
      }
    });

    it('Item: RECEIVED parent -> change discrepancy_notes -> REJECTED', async () => {
      await expect(
        repository.updateTransitManifestItem(receivedManifestId, receivedOrderId, {
          discrepancy_notes: 'Tampered inspection note',
        })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.updateTransitManifestItem(receivedManifestId, receivedOrderId, {
          discrepancy_notes: 'Tampered inspection note',
        });
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('strictly immutable');
      }
    });

    it('Item: RECEIVED parent -> INSERT new item -> REJECTED', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const newOrderId = eligible.find((o) => o.id !== receivedOrderId)?.id;
      expect(newOrderId).toBeDefined();

      await expect(
        repository.addTransitManifestItem(receivedManifestId, newOrderId!)
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.addTransitManifestItem(receivedManifestId, newOrderId!);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('Cannot attach order');
      }
    });

    it('Item: RECEIVED parent -> DELETE item -> REJECTED', async () => {
      await expect(
        repository.removeTransitManifestItem(receivedManifestId, receivedOrderId)
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.removeTransitManifestItem(receivedManifestId, receivedOrderId);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('Items can only be removed while in DRAFT');
      }
    });

    it('Manifest: CANCELLED -> change notes or items -> REJECTED', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const orderId = eligible[0].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [orderId],
      });

      const cancelled = await repository.transitionTransitManifest(manifest.id, 'CANCELLED');
      expect(cancelled.status).toBe('CANCELLED');

      await expect(
        repository.updateTransitManifest(manifest.id, { notes: 'Attempt update after cancel' })
      ).rejects.toThrowError(RepositoryError);

      await expect(
        repository.updateTransitManifestItem(manifest.id, orderId, { discrepancy_notes: 'note' })
      ).rejects.toThrowError(RepositoryError);

      await expect(
        repository.removeTransitManifestItem(manifest.id, orderId)
      ).rejects.toThrowError(RepositoryError);
    });
  });

  // ==========================================================================
  // 7. PARENT SOURCE BRANCH ROUTE INTEGRITY (STEP 4B.3.3 / O-01)
  // ==========================================================================
  describe('7. Parent Source Branch Route Integrity (O-01 Remediation)', () => {
    it('Case A: DRAFT manifest with items -> UPDATE source_branch_id -> REJECTED', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      expect(eligible.length).toBeGreaterThan(0);
      const testOrderId = eligible[0].id;

      // Manifest at OUTLET_BKS with items
      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [testOrderId],
      });

      // Attempt to switch source_branch to OUTLET_TBN while items exist
      await expect(
        repository.updateTransitManifest(manifest.id, { source_branch_id: OUTLET_TBN })
      ).rejects.toThrowError(RepositoryError);

      try {
        await repository.updateTransitManifest(manifest.id, { source_branch_id: OUTLET_TBN });
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('while items are attached');
      }

      // Verify manifest source_branch_id remained unchanged
      const current = await repository.getTransitManifest(manifest.id);
      expect(current?.source_branch_id).toBe(OUTLET_BKS);
    });

    it('Case B: Invariant preservation — cannot mismatch parent route with child order branch', async () => {
      // 1. Cross-branch injection is rejected
      const newOrder = await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_TBN,
          production_branch_id: CENTRAL_PROD,
          customer_id: '55555555-5555-5555-5555-555555555551',
          operating_mode: 'SIMPLE',
          status: 'RECEIVED',
          subtotal: 20000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 20000,
          paid_amount: 20000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: '33333333-3333-3333-3333-333333333332',
        },
        []
      );

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [],
      });

      // Cannot add order from OUTLET_TBN to manifest at OUTLET_BKS
      await expect(
        repository.addTransitManifestItem(manifest.id, newOrder.id)
      ).rejects.toThrowError(RepositoryError);

      // 2. Cannot alter parent route to bypass item boundary
      const bksEligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      await repository.addTransitManifestItem(manifest.id, bksEligible[0].id);

      await expect(
        repository.updateTransitManifest(manifest.id, { source_branch_id: OUTLET_TBN })
      ).rejects.toThrowError(RepositoryError);
    });

    it('Case C: DRAFT manifest WITHOUT items -> UPDATE source_branch_id -> ACCEPTED', async () => {
      // Create empty DRAFT manifest at OUTLET_BKS
      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [],
      });
      expect(manifest.source_branch_id).toBe(OUTLET_BKS);
      expect(manifest.total_expected_orders).toBe(0);

      // Changing source branch on empty manifest is allowed by domain semantics
      const updated = await repository.updateTransitManifest(manifest.id, {
        source_branch_id: OUTLET_TBN,
      });
      expect(updated.source_branch_id).toBe(OUTLET_TBN);

      // Now OUTLET_TBN order can be attached
      const tbnOrder = await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_TBN,
          production_branch_id: CENTRAL_PROD,
          customer_id: '55555555-5555-5555-5555-555555555551',
          operating_mode: 'SIMPLE',
          status: 'RECEIVED',
          subtotal: 20000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 20000,
          paid_amount: 20000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: '33333333-3333-3333-3333-333333333332',
        },
        []
      );

      const item = await repository.addTransitManifestItem(manifest.id, tbnOrder.id);
      expect(item.order_id).toBe(tbnOrder.id);
    });
  });

  // ==========================================================================
  // 8. MANIFEST DELETION GUARD (STEP 4B.3.3 / M-01)
  // ==========================================================================
  describe('8. Manifest Deletion Guard (M-01 Remediation)', () => {
    it('Case D: RECEIVED manifest -> DELETE -> REJECTED', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      const testOrderId = eligible[0].id;

      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        driverUserId: DRIVER_ID,
        vehicleIdentifier: 'B 1234 XYZ',
        orderIds: [testOrderId],
      });

      await repository.transitionTransitManifest(manifest.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(manifest.id, 'IN_TRANSIT');
      await repository.receiveTransitManifest({
        manifestId: manifest.id,
        itemsReview: [{ orderId: testOrderId, status: 'RECEIVED_OK' }],
      });

      const received = await repository.getTransitManifest(manifest.id);
      expect(received?.status).toBe('RECEIVED');

      await expect(repository.deleteTransitManifest(manifest.id)).rejects.toThrowError(RepositoryError);

      try {
        await repository.deleteTransitManifest(manifest.id);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('already RECEIVED and cannot be deleted');
      }
    });

    it('Case E: CANCELLED manifest -> DELETE -> REJECTED', async () => {
      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [],
      });

      await repository.transitionTransitManifest(manifest.id, 'CANCELLED');
      const cancelled = await repository.getTransitManifest(manifest.id);
      expect(cancelled?.status).toBe('CANCELLED');

      await expect(repository.deleteTransitManifest(manifest.id)).rejects.toThrowError(RepositoryError);

      try {
        await repository.deleteTransitManifest(manifest.id);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('is CANCELLED and cannot be deleted');
      }
    });

    it('Case F: Legitimate receiving flow end-to-end regression (IN_TRANSIT -> RECEIVED -> SUCCESS)', async () => {
      const eligible = await repository.getEligibleOrdersForTransit(OUTLET_BKS);
      expect(eligible.length).toBeGreaterThan(0);
      const testOrderId = eligible[0].id;

      // 1. Create DRAFT
      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        driverUserId: DRIVER_ID,
        vehicleIdentifier: 'B 8888 FTR',
        notes: 'Batch sore reguler',
        orderIds: [testOrderId],
      });
      expect(manifest.status).toBe('DRAFT');

      // 2. DRAFT -> READY_TO_DISPATCH
      const ready = await repository.transitionTransitManifest(manifest.id, 'READY_TO_DISPATCH');
      expect(ready.status).toBe('READY_TO_DISPATCH');

      // 3. READY_TO_DISPATCH -> IN_TRANSIT
      const inTransit = await repository.transitionTransitManifest(manifest.id, 'IN_TRANSIT');
      expect(inTransit.status).toBe('IN_TRANSIT');
      expect(inTransit.dispatched_at).toBeDefined();

      // 4. IN_TRANSIT -> receiveTransitManifest -> RECEIVED
      const received = await repository.receiveTransitManifest({
        manifestId: manifest.id,
        itemsReview: [{ orderId: testOrderId, status: 'RECEIVED_OK', notes: 'Kondisi rapi' }],
        summaryNotes: 'Diterima lengkap & sesuai SOP',
      });

      expect(received.status).toBe('RECEIVED');
      expect(received.received_at).toBeDefined();
      expect(received.total_received_orders).toBe(1);
      expect(received.has_discrepancy).toBe(false);
      expect(received.discrepancy_summary).toBe('Diterima lengkap & sesuai SOP');

      // 5. Post-receipt immutability confirmed
      await expect(
        repository.updateTransitManifest(manifest.id, { notes: 'Attempt hack' })
      ).rejects.toThrowError(RepositoryError);

      await expect(
        repository.deleteTransitManifest(manifest.id)
      ).rejects.toThrowError(RepositoryError);
    });

    it('Active & DRAFT manifests -> DELETE -> REJECTED (Preserving Audit Trail)', async () => {
      const manifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [],
      });
      expect(manifest.status).toBe('DRAFT');

      // DRAFT deletion is rejected
      await expect(repository.deleteTransitManifest(manifest.id)).rejects.toThrowError(RepositoryError);

      try {
        await repository.deleteTransitManifest(manifest.id);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('in DRAFT status and cannot be deleted');
      }
    });
  });

  // ==========================================================================
  // 9. DIRECTED TRANSIT ROUTING (STEP 4B.5 / MODEL C INTEGRATION)
  // ==========================================================================
  describe('9. Directed Transit Routing (STEP 4B.5 / Model C Integration)', () => {
    it('executes full round-trip transit lifecycle preserving origin anchor and financial invariants', async () => {
      // 1. Create Order at OUTLET_BKS with CENTRAL_PROD as fulfillment target
      const createdOrder = await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_BKS,
          production_branch_id: CENTRAL_PROD,
          customer_id: '55555555-5555-5555-5555-555555555551',
          operating_mode: 'SIMPLE',
          status: 'RECEIVED',
          subtotal: 50000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 50000,
          paid_amount: 50000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date(Date.now() + 86400000).toISOString(),
          created_by: '33333333-3333-3333-3333-333333333332',
        },
        [
          {
            service_id: 'srv-1',
            item_type: 'KILOAN',
            service_name_snap: 'Cuci Komplit Reguler',
            unit_price_snap: 10000,
            quantity_or_weight: 5,
            billable_weight: 5,
            subtotal: 50000,
          },
        ],
        { method: 'CASH', amount: 50000 }
      );

      expect(createdOrder.branch_id).toBe(OUTLET_BKS);
      expect(createdOrder.production_branch_id).toBe(CENTRAL_PROD);

      // Verify payment was credited to OUTLET_BKS
      const payments = await repository.getPayments(createdOrder.id);
      expect(payments.length).toBe(1);
      expect(payments[0].branch_id).toBe(OUTLET_BKS);

      // 2. OUTBOUND: Verify initial eligibility at OUTLET_BKS
      const eligibleOutbound = await repository.getEligibleOrdersForTransit(OUTLET_BKS, CENTRAL_PROD);
      expect(eligibleOutbound.some((o) => o.id === createdOrder.id)).toBe(true);

      // Verify return is NOT eligible yet at CENTRAL_PROD
      const eligibleEarlyReturn = await repository.getEligibleOrdersForTransit(CENTRAL_PROD, OUTLET_BKS);
      expect(eligibleEarlyReturn.some((o) => o.id === createdOrder.id)).toBe(false);

      // 3. Create Outbound Manifest: OUTLET_BKS -> CENTRAL_PROD
      const outboundManifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        driverUserId: DRIVER_ID,
        vehicleIdentifier: 'B 1010 OUT',
        orderIds: [createdOrder.id],
      });

      // Dispatch Outbound
      await repository.transitionTransitManifest(outboundManifest.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(outboundManifest.id, 'IN_TRANSIT');

      // 4. Receive Outbound at CENTRAL_PROD
      await repository.receiveTransitManifest({
        manifestId: outboundManifest.id,
        itemsReview: [{ orderId: createdOrder.id, status: 'RECEIVED_OK' }],
        summaryNotes: 'Diterima lengkap di workshop',
      });

      // 5. Verify Invariant after Outbound Receive:
      // orders.branch_id MUST remain OUTLET_BKS!
      // orders.production_branch_id MUST remain CENTRAL_PROD!
      // orders.status is NOT mutated by transit!
      const postOutboundOrders = await repository.getOrders(OUTLET_BKS);
      const postOutboundOrder = postOutboundOrders.find((o) => o.id === createdOrder.id);
      expect(postOutboundOrder).toBeDefined();
      expect(postOutboundOrder!.branch_id).toBe(OUTLET_BKS);
      expect(postOutboundOrder!.production_branch_id).toBe(CENTRAL_PROD);
      expect(postOutboundOrder!.status).toBe('RECEIVED');

      // 6. Verify Re-eligibility Gap is solved:
      // Order must NOT reappear as outbound candidate from OUTLET_BKS!
      const eligibleOutboundAfterReceipt = await repository.getEligibleOrdersForTransit(OUTLET_BKS, CENTRAL_PROD);
      expect(eligibleOutboundAfterReceipt.some((o) => o.id === createdOrder.id)).toBe(false);

      // 7. RETURN ELIGIBILITY:
      // Order IS now eligible for Return from CENTRAL_PROD to OUTLET_BKS!
      const eligibleReturn = await repository.getEligibleOrdersForTransit(CENTRAL_PROD, OUTLET_BKS);
      expect(eligibleReturn.some((o) => o.id === createdOrder.id)).toBe(true);

      // 8. Workshop updates production status to READY (driven by production, not transit)
      await repository.updateOrderStatus(createdOrder.id, 'WASHING', 'user-op');
      await repository.updateOrderStatus(createdOrder.id, 'READY', 'user-op');

      // 9. Create Return Manifest: CENTRAL_PROD -> OUTLET_BKS
      const returnManifest = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: CENTRAL_PROD,
        destinationBranchId: OUTLET_BKS,
        driverUserId: DRIVER_ID,
        vehicleIdentifier: 'B 2020 RET',
        orderIds: [createdOrder.id],
      });

      // Dispatch Return
      await repository.transitionTransitManifest(returnManifest.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(returnManifest.id, 'IN_TRANSIT');

      // 10. Receive Return at OUTLET_BKS
      await repository.receiveTransitManifest({
        manifestId: returnManifest.id,
        itemsReview: [{ orderId: createdOrder.id, status: 'RECEIVED_OK' }],
        summaryNotes: 'Cucian bersih kembali ke outlet',
      });

      // 11. Verify Post-Return State:
      // orders.branch_id STILL remains OUTLET_BKS!
      // orders.status remains READY (production-controlled)!
      const finalOrders = await repository.getOrders(OUTLET_BKS);
      const finalOrder = finalOrders.find((o) => o.id === createdOrder.id);
      expect(finalOrder).toBeDefined();
      expect(finalOrder!.branch_id).toBe(OUTLET_BKS);
      expect(finalOrder!.production_branch_id).toBe(CENTRAL_PROD);
      expect(finalOrder!.status).toBe('READY');

      // 12. Financial Invariants:
      // payments.branch_id still OUTLET_BKS!
      const finalPayments = await repository.getPayments(createdOrder.id);
      expect(finalPayments[0].branch_id).toBe(OUTLET_BKS);

      // 13. Audit Trail: Both Outbound and Return manifests exist and are RECEIVED
      const finalOutbound = await repository.getTransitManifest(outboundManifest.id);
      const finalReturn = await repository.getTransitManifest(returnManifest.id);
      expect(finalOutbound?.status).toBe('RECEIVED');
      expect(finalReturn?.status).toBe('RECEIVED');

      // 14. Cannot return again (duplicate return rejected)
      const eligibleReturnAfterReceipt = await repository.getEligibleOrdersForTransit(CENTRAL_PROD, OUTLET_BKS);
      expect(eligibleReturnAfterReceipt.some((o) => o.id === createdOrder.id)).toBe(false);
    });
  });

  // ==========================================================================
  // MULTI-CYCLE REWORK GATE & WORKSHOP PHYSICAL CUSTODY (STEP 4B.6.2)
  // ==========================================================================
  describe('Multi-Cycle Rework Gate & Workshop Physical Custody (STEP 4B.6.2)', () => {
    const OWNER_ID = '33333333-3333-3333-3333-333333333331';
    const CASHIER_ID = '33333333-3333-3333-3333-333333333332';
    const OPERATOR_ID = '33333333-3333-3333-3333-333333333333';
    const CUSTOMER_ID = '55555555-5555-5555-5555-555555555551';
    const SERVICE_ID = '44444444-4444-4444-4444-444444444441';

    const createTestOrder = async () => {
      return await repository.createOrder(
        {
          organization_id: ORG_ID,
          branch_id: OUTLET_BKS,
          production_branch_id: CENTRAL_PROD,
          customer_id: CUSTOMER_ID,
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal: 30000,
          discount_amount: 0,
          delivery_fee: 0,
          final_amount: 30000,
          paid_amount: 30000,
          remaining_amount: 0,
          payment_status: 'PAID',
          promised_ready_at: new Date().toISOString(),
          created_by: OWNER_ID,
          notes: 'Test Rework Order',
        },
        [
          {
            service_id: SERVICE_ID,
            item_type: 'KILOAN',
            service_name_snap: 'Cuci Komplit',
            unit_price_snap: 10000,
            quantity_or_weight: 3.0,
            billable_weight: 3.0,
            subtotal: 30000,
          },
        ]
      );
    };

    it('Rework Request RBAC: permits OWNER and CASHIER, strictly rejects OPERATOR', async () => {
      const testOrder = await createTestOrder();

      // Cashier creates rework request
      const req = await repository.createOrderReworkRequest(
        {
          order_id: testOrder.id,
          reason: 'CUSTOMER_COMPLAINT',
          notes: 'Noda minyak belum hilang',
        },
        CASHIER_ID
      );
      expect(req.id).toBeDefined();
      expect(req.status).toBe('APPROVED');

      // Cancel to clean up
      await repository.cancelOrderReworkRequest(req.id, 'Test cancel', CASHIER_ID);

      // Operator attempt should fail
      await expect(
        repository.createOrderReworkRequest(
          {
            order_id: testOrder.id,
            reason: 'STAIN_REMAINS',
          },
          OPERATOR_ID
        )
      ).rejects.toThrow(/Access denied: User role 'OPERATOR' is not authorized/);
    });

    it('Rework Invariant: rejects multiple active APPROVED rework requests for same order', async () => {
      const testOrder = await createTestOrder();

      const req1 = await repository.createOrderReworkRequest(
        {
          order_id: testOrder.id,
          reason: 'STAIN_REMAINS',
        },
        CASHIER_ID
      );
      expect(req1.status).toBe('APPROVED');

      // Second attempt must fail with CONFLICT
      await expect(
        repository.createOrderReworkRequest(
          {
            order_id: testOrder.id,
            reason: 'CUSTOMER_COMPLAINT',
          },
          CASHIER_ID
        )
      ).rejects.toThrow(/already has an active approved rework request/);

      // Clean up
      await repository.cancelOrderReworkRequest(req1.id, 'Clean up', CASHIER_ID);
    });

    it('Full Multi-Cycle End-to-End: Cycle 1 -> Return -> Cycle 2 blocked -> Rework Gate -> Cycle 2 Outbound & Consume', async () => {
      // 1. Create a fresh order at OUTLET_BKS
      const newOrder = await createTestOrder();

      // 2. Cycle 1 Outbound: OUTLET_BKS -> CENTRAL_PROD
      const mOut1 = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [newOrder.id],
      });
      await repository.transitionTransitManifest(mOut1.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(mOut1.id, 'IN_TRANSIT');
      await repository.receiveTransitManifest({
        manifestId: mOut1.id,
        itemsReview: [{ orderId: newOrder.id, status: 'RECEIVED_OK' }],
      });

      // 3. Workshop processes order
      await repository.updateOrderStatus(newOrder.id, 'WASHING', OPERATOR_ID);
      await repository.updateOrderStatus(newOrder.id, 'READY', OPERATOR_ID);

      // 4. Cycle 1 Return: CENTRAL_PROD -> OUTLET_BKS
      const mRet1 = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: CENTRAL_PROD,
        destinationBranchId: OUTLET_BKS,
        orderIds: [newOrder.id],
      });
      await repository.transitionTransitManifest(mRet1.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(mRet1.id, 'IN_TRANSIT');
      await repository.receiveTransitManifest({
        manifestId: mRet1.id,
        itemsReview: [{ orderId: newOrder.id, status: 'RECEIVED_OK' }],
      });

      // 5. Order is now back at origin outlet.
      // Attempting Cycle 2 Outbound WITHOUT rework authorization MUST FAIL!
      await expect(
        repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [newOrder.id],
        })
      ).rejects.toThrow(/requires an active approved rework request/);

      // 6. Create Rework Authorization (Rework Gate)
      const reworkReq = await repository.createOrderReworkRequest(
        {
          order_id: newOrder.id,
          reason: 'CUSTOMER_COMPLAINT',
          notes: 'Pelanggan minta cuci ulang noda kerah',
        },
        CASHIER_ID
      );
      expect(reworkReq.status).toBe('APPROVED');

      // 7. Cycle 2 Outbound WITH Rework Authorization MUST SUCCEED!
      const mOut2 = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: OUTLET_BKS,
        destinationBranchId: CENTRAL_PROD,
        orderIds: [newOrder.id],
      });
      expect(mOut2.id).toBeDefined();

      // 8. Invariant: Rework Authorization MUST BE ATOMICALLY CONSUMED!
      const activeAfterOutbound = await repository.getActiveOrderReworkRequest(newOrder.id);
      expect(activeAfterOutbound).toBeNull(); // No active approved rework remains

      const reworkList = await repository.getOrderReworkRequests(newOrder.id);
      const consumedReq = reworkList.find((r) => r.id === reworkReq.id);
      expect(consumedReq?.status).toBe('CONSUMED');
      expect(consumedReq?.consumed_manifest_id).toBe(mOut2.id);

      // 9. Reusing consumed authorization for another dispatch is strictly rejected
      await repository.transitionTransitManifest(mOut2.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(mOut2.id, 'IN_TRANSIT');
      await repository.receiveTransitManifest({
        manifestId: mOut2.id,
        itemsReview: [{ orderId: newOrder.id, status: 'RECEIVED_OK' }],
      });

      // Return Cycle 2
      const mRet2 = await repository.createTransitManifest({
        organizationId: ORG_ID,
        sourceBranchId: CENTRAL_PROD,
        destinationBranchId: OUTLET_BKS,
        orderIds: [newOrder.id],
      });
      await repository.transitionTransitManifest(mRet2.id, 'READY_TO_DISPATCH');
      await repository.transitionTransitManifest(mRet2.id, 'IN_TRANSIT');
      await repository.receiveTransitManifest({
        manifestId: mRet2.id,
        itemsReview: [{ orderId: newOrder.id, status: 'RECEIVED_OK' }],
      });

      // Cycle 3 Outbound without new rework request is blocked!
      await expect(
        repository.createTransitManifest({
          organizationId: ORG_ID,
          sourceBranchId: OUTLET_BKS,
          destinationBranchId: CENTRAL_PROD,
          orderIds: [newOrder.id],
        })
      ).rejects.toThrow(/requires an active approved rework request/);
    });

    it('Workshop Physical Custody: segregates washQueue and damagedQueue', async () => {
      // Query workshop orders for CENTRAL_PROD
      const { washQueue, damagedQueue } = await repository.getWorkshopOrders(CENTRAL_PROD);
      expect(Array.isArray(washQueue)).toBe(true);
      expect(Array.isArray(damagedQueue)).toBe(true);

      // Local orders (branch_id = CENTRAL_PROD) appear directly
      // External orders without physical arrival do not appear
      for (const o of washQueue) {
        if (o.branch_id !== CENTRAL_PROD) {
          // external order in washQueue must not be damaged
          expect(damagedQueue.some((d) => d.id === o.id)).toBe(false);
        }
      }
    });
  });
});

