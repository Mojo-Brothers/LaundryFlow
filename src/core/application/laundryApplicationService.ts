// ============================================================================
// LaundryFlow — Application Service Layer (Phase 2 Master Use-Case Orchestrator)
// Architecture Boundary: UI -> Application Service -> Repository -> DB RPC
// Pure Application Logic: Zero UI imports, Strict Error Translation & Normalization
// ============================================================================

import {
  TransitManifest,
  TransitManifestItem,
  TransitManifestHistory,
  TransitManifestStatus,
  TransitManifestItemStatus,
  CashierShift,
  Order,
  Customer,
  Service,
  PublicTrackingData,
  RoundingRule,
  OrderReworkRequest,
  ReworkReasonCode,
  ProductionJob,
  ProductionWorkItem,
  ProductionStage,
  SplitReason,
} from '../types/database';
import {
  repository,
  RepositoryError,
  RepositoryErrorCode,
  CreateOrderReworkRequestDTO,
} from '../services/repository';
import {
  productionRepository,
  IProductionRepository,
} from '../services/productionRepository';
import {
  calculateItemPrice,
  CalculationInput,
  CalculationResult,
} from '../services/pricing';
import { ShiftReconciliationResult } from '../services/shiftReconciliation';

// ============================================================================
// 1. Application-Level Error Translation
// ============================================================================

export type ApplicationErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'FINANCIAL_ERROR'
  | 'DATABASE_ERROR';

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly cause?: unknown;

  constructor(code: ApplicationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, ApplicationError.prototype);
  }
}

/**
 * Translates lower-level RepositoryError / Domain exceptions into stable,
 * actionable ApplicationErrors suitable for presentation and use-case handling.
 */
export function translateRepositoryError(err: unknown): ApplicationError {
  if (err instanceof ApplicationError) return err;

  if (err instanceof RepositoryError) {
    switch (err.code) {
      case 'VALIDATION_ERROR':
        return new ApplicationError('VALIDATION_ERROR', err.message, err);
      case 'CONFLICT':
        return new ApplicationError('CONFLICT', err.message, err);
      case 'FORBIDDEN':
      case 'UNAUTHORIZED':
        return new ApplicationError('FORBIDDEN', err.message, err);
      case 'NOT_FOUND':
        return new ApplicationError('NOT_FOUND', err.message, err);
      case 'INVALID_STATE_TRANSITION':
        return new ApplicationError('INVALID_STATE', err.message, err);
      case 'FINANCIAL_VALIDATION_ERROR':
        return new ApplicationError('FINANCIAL_ERROR', err.message, err);
      case 'DATABASE_ERROR':
      default:
        return new ApplicationError('DATABASE_ERROR', err.message, err);
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return new ApplicationError('DATABASE_ERROR', message, err);
}

// ============================================================================
// 2. Use-Case DTOs (Data Transfer Objects)
// ============================================================================

export interface CreateTransitManifestDTO {
  organizationId?: string;
  sourceBranchId: string;
  destinationBranchId: string;
  driverUserId?: string;
  vehicleIdentifier?: string;
  notes?: string;
  orderIds: string[];
}

export interface TransitManifestFiltersDTO {
  organizationId?: string;
  branchId?: string;
  sourceBranchId?: string;
  destinationBranchId?: string;
  status?: TransitManifestStatus;
  driverUserId?: string;
  search?: string;
}

export interface TransitionTransitManifestDTO {
  manifestId: string;
  targetStatus: TransitManifestStatus;
  notes?: string;
  actorId?: string;
}

export interface ReceiveItemReviewDTO {
  orderId: string;
  status: TransitManifestItemStatus;
  notes?: string;
}

export interface ReceiveTransitManifestDTO {
  manifestId: string;
  itemsReview: ReceiveItemReviewDTO[];
  summaryNotes?: string;
  actorId?: string;
}

export interface OpenShiftDTO {
  organizationId: string;
  branchId: string;
  cashierId: string;
  openingCash: number;
  notes?: string;
}

export interface CloseShiftDTO {
  shiftId: string;
  actualCash: number;
  varianceNote?: string;
}

export interface CreateCustomerDTO {
  organizationId: string;
  name: string;
  phone: string;
  whatsapp?: string;
  address?: string;
  membershipTier?: 'REGULAR' | 'VIP';
}

export interface CreateOrderDTO {
  organizationId: string;
  branchId: string;
  productionBranchId?: string;
  customerId: string;
  items: Array<{
    serviceId: string;
    itemType: 'KILOAN' | 'SATUAN';
    serviceNameSnap: string;
    unitPriceSnap: number;
    quantityOrWeight: number;
    billableWeight: number;
    subtotal: number;
    notes?: string;
  }>;
  operatingMode?: 'SIMPLE' | 'ADVANCED';
  subtotal: number;
  discountAmount?: number;
  deliveryFee?: number;
  payment?: {
    method: 'CASH' | 'QRIS_MANUAL' | 'BANK_TRANSFER' | 'EDC' | 'OTHER';
    amount: number;
  };
  notes?: string;
  createdBy: string;
}

// ============================================================================
// 3. Repository Port Contract
// ============================================================================

export type LaundryRepositoryPort = typeof repository;

// ============================================================================
// 4. Application Service Implementation
// ============================================================================

export class LaundryApplicationService {
  constructor(
    private readonly repo: LaundryRepositoryPort = repository,
    private readonly prodRepo: IProductionRepository = productionRepository
  ) {}

  // --------------------------------------------------------------------------
  // A. Multi-Outlet Transit Manifest Use Cases
  // --------------------------------------------------------------------------

  /**
   * Orchestrates the creation of a new transit manifest draft.
   * Performs basic use-case normalization and validation before delegating to
   * the repository, where PostgreSQL RPC enforces row locks and tenant checks.
   */
  async createTransitManifest(input: CreateTransitManifestDTO): Promise<TransitManifest> {
    try {
      // 1. Input Normalization
      const sourceBranchId = (input.sourceBranchId || '').trim();
      const destinationBranchId = (input.destinationBranchId || '').trim();
      const driverUserId = input.driverUserId?.trim() || undefined;
      const vehicleIdentifier = input.vehicleIdentifier?.trim() || undefined;
      const notes = input.notes?.trim() || undefined;
      const rawOrderIds = Array.isArray(input.orderIds) ? input.orderIds : [];
      
      // Clean and deduplicate order IDs
      const orderIds = Array.from(
        new Set(rawOrderIds.map(id => (id || '').trim()).filter(id => id.length > 0))
      );

      // 2. Basic Use-Case Pre-Validation
      if (!sourceBranchId) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Cabang asal (sourceBranchId) wajib dipilih.'
        );
      }
      if (!destinationBranchId) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Cabang tujuan (destinationBranchId) wajib dipilih.'
        );
      }
      if (sourceBranchId === destinationBranchId) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Cabang asal dan cabang tujuan tidak boleh sama (self-routing ditolak).'
        );
      }
      if (orderIds.length === 0) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Manifest wajib menyertakan minimal 1 ID order cucian.'
        );
      }
      if (orderIds.length < rawOrderIds.length) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Terdapat duplikasi ID order dalam daftar pengiriman manifest.'
        );
      }

      // 3. Delegation to Repository (DB RPC authoritative concurrency locking)
      return await this.repo.createTransitManifest({
        organizationId: input.organizationId,
        sourceBranchId,
        destinationBranchId,
        driverUserId,
        vehicleIdentifier,
        notes,
        orderIds,
      });
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Retrieves full manifest details by ID, including items and related branches.
   */
  async getTransitManifest(id: string): Promise<TransitManifest | null> {
    try {
      const normalizedId = (id || '').trim();
      if (!normalizedId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID manifest wajib diisi.');
      }
      return await this.repo.getTransitManifest(normalizedId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Lists manifests with optional branch, status, or search filters.
   */
  async listTransitManifests(filters?: TransitManifestFiltersDTO): Promise<TransitManifest[]> {
    try {
      const normalizedFilters = filters
        ? {
            organizationId: filters.organizationId?.trim() || undefined,
            branchId: filters.branchId?.trim() || undefined,
            sourceBranchId: filters.sourceBranchId?.trim() || undefined,
            destinationBranchId: filters.destinationBranchId?.trim() || undefined,
            status: filters.status,
            driverUserId: filters.driverUserId?.trim() || undefined,
            search: filters.search?.trim() || undefined,
          }
        : undefined;

      return await this.repo.listTransitManifests(normalizedFilters);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Orchestrates lifecycle transitions for a transit manifest.
   * Disallows direct transitions to RECEIVED (which require item inspection).
   */
  async transitionTransitManifest(input: TransitionTransitManifestDTO): Promise<TransitManifest> {
    try {
      const manifestId = (input.manifestId || '').trim();
      if (!manifestId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID manifest wajib diisi.');
      }

      if (input.targetStatus === 'RECEIVED') {
        throw new ApplicationError(
          'INVALID_STATE',
          'Gunakan use-case receiveTransitManifest untuk menyelesaikan penerimaan manifest beserta inspeksi item.'
        );
      }

      const notes = input.notes?.trim() || undefined;
      const actorId = input.actorId?.trim() || undefined;

      return await this.repo.transitionTransitManifest(
        manifestId,
        input.targetStatus,
        notes,
        actorId
      );
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Orchestrates the receiving and inspection of incoming manifest items.
   * DB RPC remains authoritative for converting omitted items (EXPECTED -> MISSING)
   * and calculating discrepancies.
   */
  async receiveTransitManifest(input: ReceiveTransitManifestDTO): Promise<TransitManifest> {
    try {
      const manifestId = (input.manifestId || '').trim();
      if (!manifestId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID manifest wajib diisi.');
      }

      if (!Array.isArray(input.itemsReview)) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Data inspeksi item manifest harus berupa array.'
        );
      }

      // Normalize reviews
      const normalizedItemsReview = input.itemsReview.map(item => ({
        orderId: (item.orderId || '').trim(),
        status: item.status,
        notes: item.notes?.trim() || undefined,
      }));

      // Validate that all reviewed order IDs are non-empty
      for (const item of normalizedItemsReview) {
        if (!item.orderId) {
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'Setiap item inspeksi wajib menyertakan orderId yang valid.'
          );
        }
      }

      const summaryNotes = input.summaryNotes?.trim() || undefined;

      return await this.repo.receiveTransitManifest(
        {
          manifestId,
          itemsReview: normalizedItemsReview,
          summaryNotes,
        },
        input.actorId
      );
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Fetches eligible orders at a source branch that are not assigned to any active manifest.
   */
  async getEligibleTransitOrders(
    sourceBranchId: string,
    destinationBranchId?: string
  ): Promise<Order[]> {
    try {
      const src = (sourceBranchId || '').trim();
      const dst = destinationBranchId?.trim() || undefined;

      if (!src) {
        throw new ApplicationError('VALIDATION_ERROR', 'Cabang asal wajib ditentukan.');
      }

      return await this.repo.getEligibleOrdersForTransit(src, dst);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Retrieves the immutable audit log for a given manifest.
   */
  async getTransitManifestHistory(manifestId: string): Promise<TransitManifestHistory[]> {
    try {
      const id = (manifestId || '').trim();
      if (!id) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID manifest wajib diisi.');
      }
      return await this.repo.getTransitManifestHistory(id);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  // --------------------------------------------------------------------------
  // B. Cashier Shift & Reconciliation Use Cases
  // --------------------------------------------------------------------------

  /**
   * Provides a READ-ONLY preview of the current shift's cash reconciliation.
   * Excludes non-cash payment methods from the drawer expected cash calculation.
   * NOTE: This is a preview snapshot; authoritative closing occurs via closeShift.
   */
  async getShiftSummary(
    shiftId: string
  ): Promise<ShiftReconciliationResult & { shift: CashierShift; paymentsCount: number }> {
    try {
      const id = (shiftId || '').trim();
      if (!id) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID shift wajib diisi.');
      }
      return await this.repo.getShiftSummary(id);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Opens a new cashier shift with an initial physical cash amount.
   */
  async openShift(input: OpenShiftDTO): Promise<CashierShift> {
    try {
      const branchId = (input.branchId || '').trim();
      const cashierId = (input.cashierId || '').trim();
      const organizationId = (input.organizationId || '').trim();
      const openingCash = Math.max(0, Number(input.openingCash) || 0);

      if (!branchId) {
        throw new ApplicationError('VALIDATION_ERROR', 'Cabang shift wajib diisi.');
      }
      if (!cashierId) {
        throw new ApplicationError('VALIDATION_ERROR', 'Kasir pelaksana shift wajib diisi.');
      }
      if (!organizationId) {
        throw new ApplicationError('VALIDATION_ERROR', 'Organization ID wajib diisi.');
      }

      return await this.repo.openShift({
        organization_id: organizationId,
        branch_id: branchId,
        cashier_id: cashierId,
        opening_cash: openingCash,
        expected_cash: openingCash,
        status: 'OPEN',
        notes: input.notes?.trim() || undefined,
      });
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Closes a cashier shift with physical drawer reconciliation.
   * Enforces variance_note if actualCash != expectedCash.
   * PostgreSQL RPC close_cashier_shift_reconciled remains the sole authoritative transaction.
   */
  async closeShift(input: CloseShiftDTO): Promise<CashierShift> {
    try {
      const shiftId = (input.shiftId || '').trim();
      if (!shiftId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID shift wajib diisi.');
      }

      if (typeof input.actualCash !== 'number' || isNaN(input.actualCash) || input.actualCash < 0) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Nominal uang fisik kas aktual harus berupa angka non-negatif yang valid.'
        );
      }

      const varianceNote = input.varianceNote?.trim() || undefined;

      return await this.repo.closeShift(shiftId, input.actualCash, varianceNote);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Retrieves the currently active OPEN shift for a specific branch.
   */
  async getActiveShift(branchId: string): Promise<CashierShift | null> {
    try {
      const id = (branchId || '').trim();
      if (!id) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID cabang wajib diisi.');
      }
      return await this.repo.getActiveShift(id);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  // --------------------------------------------------------------------------
  // C. Customer & POS / Fast Checkout Use Cases
  // --------------------------------------------------------------------------

  /**
   * Searches customers by name or phone query.
   */
  async searchCustomers(query = ''): Promise<Customer[]> {
    try {
      return await this.repo.getCustomers(query.trim());
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Registers a new customer with normalized contact details.
   */
  async createCustomer(input: CreateCustomerDTO): Promise<Customer> {
    try {
      const name = (input.name || '').trim();
      const phone = (input.phone || '').trim().replace(/[^0-9+]/g, '');

      if (!name || name.length < 2) {
        throw new ApplicationError('VALIDATION_ERROR', 'Nama pelanggan minimal 2 karakter.');
      }
      if (!phone || phone.length < 8) {
        throw new ApplicationError('VALIDATION_ERROR', 'Nomor telepon minimal 8 digit.');
      }

      return await this.repo.createCustomer({
        organization_id: input.organizationId,
        name,
        phone,
        whatsapp: input.whatsapp?.trim() || phone,
        address: input.address?.trim() || undefined,
        membership_tier: input.membershipTier || 'REGULAR',
      });
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Calculates order line price using the core domain pricing engine.
   */
  calculateOrderPricing(input: CalculationInput): CalculationResult {
    return calculateItemPrice(input);
  }

  /**
   * Orchestrates order placement and initial payment capture.
   */
  async createOrder(input: CreateOrderDTO): Promise<Order> {
    try {
      if (!input.organizationId || !input.branchId || !input.customerId) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Data organisasi, cabang, dan pelanggan wajib dilengkapi.'
        );
      }
      if (!input.items || input.items.length === 0) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Order harus memiliki minimal 1 item layanan.'
        );
      }

      const discountAmount = input.discountAmount || 0;
      const deliveryFee = input.deliveryFee || 0;
      const finalAmount = Math.max(0, input.subtotal - discountAmount + deliveryFee);
      const paidAmount = input.payment && input.payment.amount > 0 ? input.payment.amount : 0;
      const remainingAmount = Math.max(0, finalAmount - paidAmount);
      const paymentStatus =
        paidAmount >= finalAmount ? ('PAID' as const) : paidAmount > 0 ? ('PARTIAL' as const) : ('UNPAID' as const);

      const orderPayload = {
        organization_id: input.organizationId,
        branch_id: input.branchId,
        production_branch_id: input.productionBranchId || input.branchId,
        customer_id: input.customerId,
        status: 'RECEIVED' as const,
        operating_mode: input.operatingMode || 'SIMPLE',
        subtotal: input.subtotal,
        discount_amount: discountAmount,
        delivery_fee: deliveryFee,
        final_amount: finalAmount,
        paid_amount: paidAmount,
        remaining_amount: remainingAmount,
        payment_status: paymentStatus,
        promised_ready_at: new Date(Date.now() + 48 * 3600000).toISOString(),
        created_by: input.createdBy,
        notes: input.notes?.trim() || undefined,
      };

      const itemsPayload = input.items.map(item => ({
        service_id: item.serviceId,
        item_type: item.itemType,
        service_name_snap: item.serviceNameSnap,
        unit_price_snap: item.unitPriceSnap,
        quantity_or_weight: item.quantityOrWeight,
        billable_weight: item.billableWeight,
        subtotal: item.subtotal,
        notes: item.notes?.trim() || undefined,
      }));

      return await this.repo.createOrder(
        orderPayload,
        itemsPayload,
        input.payment
      );
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  // --------------------------------------------------------------------------
  // D. Public Tracking Use Case (Security-Isolated)
  // --------------------------------------------------------------------------

  /**
   * Fetches sanitized, non-PII order tracking information for customer self-service.
   * Does NOT query raw orders or customer tables directly; delegates exclusively to
   * the sanitized public tracking view / RPC.
   */
  async getPublicOrderTracking(token: string): Promise<PublicTrackingData | null> {
    try {
      const cleanToken = (token || '').trim();
      if (!cleanToken || cleanToken.length < 5) {
        return null;
      }
      return await this.repo.getOrderByTrackingToken(cleanToken);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  // --------------------------------------------------------------------------
  // E. Multi-Cycle Rework Authorization Use Cases (Phase 4B)
  // --------------------------------------------------------------------------

  async createOrderReworkRequest(
    dto: CreateOrderReworkRequestDTO,
    actorId?: string
  ): Promise<OrderReworkRequest> {
    try {
      if (!dto.order_id) {
        throw new ApplicationError('VALIDATION_ERROR', 'order_id wajib diisi.');
      }
      if (!dto.reason) {
        throw new ApplicationError('VALIDATION_ERROR', 'Alasan rework (reason) wajib diisi.');
      }
      return await this.repo.createOrderReworkRequest(dto, actorId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  async cancelOrderReworkRequest(
    requestId: string,
    notes?: string,
    actorId?: string
  ): Promise<OrderReworkRequest> {
    try {
      if (!requestId) {
        throw new ApplicationError('VALIDATION_ERROR', 'requestId wajib diisi.');
      }
      return await this.repo.cancelOrderReworkRequest(requestId, notes, actorId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  async getOrderReworkRequests(orderId: string): Promise<OrderReworkRequest[]> {
    try {
      if (!orderId) return [];
      return await this.repo.getOrderReworkRequests(orderId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  async getActiveOrderReworkRequest(orderId: string): Promise<OrderReworkRequest | null> {
    try {
      if (!orderId) return null;
      return await this.repo.getActiveOrderReworkRequest(orderId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  // --------------------------------------------------------------------------
  // F. Production Domain Orchestration Use Cases (Phase 4C)
  // Architecture Boundary: UI -> Application Service -> ProductionRepository -> SQL RPC
  // Invariant Compliance:
  // - Zero duplicate database state machine or custody calculation
  // - Zero direct orders.status mutation (all status projections owned by SQL RPC)
  // - Pure use-case parameter normalization and structured error translation
  // --------------------------------------------------------------------------

  /**
   * Orchestrates the initialization of a production job for an order.
   * Performs basic parameter validation before delegating to the ProductionRepository.
   * Authoritative custody gates, rework token verification, RLS, and WASHING projection
   * are strictly owned and executed by the database RPC (start_production_job).
   */
  async startProduction(orderId: string): Promise<ProductionJob> {
    try {
      const cleanOrderId = (orderId || '').trim();
      if (!cleanOrderId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID order wajib diisi untuk memulai produksi.');
      }
      return await this.prodRepo.startProductionJob(cleanOrderId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Advances a work item sequentially to its next standard service stage.
   * The database RPC determines current_stage -> next_stage and detects terminal PACKED stage.
   * The Application Service does NOT compute the next stage.
   */
  async advanceWorkItem(workItemId: string, notes?: string): Promise<void> {
    try {
      const cleanWorkItemId = (workItemId || '').trim();
      if (!cleanWorkItemId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID work item wajib diisi.');
      }
      const cleanNotes = notes?.trim() || undefined;
      await this.prodRepo.advanceWorkItemStage(cleanWorkItemId, cleanNotes);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Splits a work item into child batches due to capacity overflow, QC defect isolation,
   * or treatment segregation.
   * Basic input shape is validated at the application boundary (>= 2 quantities, all > 0, valid reason).
   * Exact quantity conservation, lineage depth (max 1), integer constraints, and atomic child
   * creation are strictly enforced by the PostgreSQL RPC (split_work_item).
   */
  async splitWorkItem(
    workItemId: string,
    splitQuantities: number[],
    splitReason: SplitReason,
    notes?: string
  ): Promise<void> {
    try {
      const cleanWorkItemId = (workItemId || '').trim();
      if (!cleanWorkItemId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID work item wajib diisi.');
      }

      if (!Array.isArray(splitQuantities) || splitQuantities.length < 2) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Pemisahan work item (split) membutuhkan minimal 2 porsi kuantitas.'
        );
      }

      for (const qty of splitQuantities) {
        if (typeof qty !== 'number' || isNaN(qty) || qty <= 0) {
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'Setiap kuantitas pecahan split harus berupa angka positif yang lebih besar dari 0.'
          );
        }
      }

      const validReasons: SplitReason[] = [
        'CAPACITY_OVERFLOW',
        'QC_DEFECT_ISOLATION',
        'TREATMENT_SEGREGATION',
      ];
      if (!splitReason || !validReasons.includes(splitReason)) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          `Alasan split tidak valid. Pilihan valid: ${validReasons.join(', ')}.`
        );
      }

      const cleanNotes = notes?.trim() || undefined;
      await this.prodRepo.splitWorkItem(cleanWorkItemId, splitQuantities, splitReason, cleanNotes);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Evaluates quality control for a work item at the terminal PACKED stage.
   * If QC fails, a remediation stage is strictly required.
   * If QC passes, remediation stage is omitted.
   * Authoritative stage rewind or completion marking and audit logs are recorded by the RPC.
   */
  async evaluateQC(
    workItemId: string,
    passed: boolean,
    remediationStage?: ProductionStage,
    notes?: string
  ): Promise<void> {
    try {
      const cleanWorkItemId = (workItemId || '').trim();
      if (!cleanWorkItemId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID work item wajib diisi.');
      }

      if (typeof passed !== 'boolean') {
        throw new ApplicationError('VALIDATION_ERROR', 'Status kelulusan QC (passed) wajib berupa boolean.');
      }

      if (!passed && !remediationStage) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Tahapan remediasi (remediationStage) wajib ditentukan saat evaluasi QC tidak lolos (FAIL).'
        );
      }

      const cleanNotes = notes?.trim() || undefined;
      const targetRemediation = passed ? undefined : remediationStage;

      await this.prodRepo.qcEvaluateWorkItem(
        cleanWorkItemId,
        passed,
        targetRemediation,
        cleanNotes
      );
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Completes a granular production job.
   * All active work items must have reached terminal COMPLETED status.
   * The database RPC handles atomic completion, rework token status, and projects local orders to READY.
   * The Application Service does NOT call repository.updateOrderStatus().
   */
  async completeProduction(jobId: string): Promise<void> {
    try {
      const cleanJobId = (jobId || '').trim();
      if (!cleanJobId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID production job wajib diisi.');
      }
      await this.prodRepo.completeProductionJob(cleanJobId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Completes production for an order operating in SIMPLE mode.
   * The database RPC executes complete_simple_production_job: creating/completing the job,
   * advancing all items, and projecting local orders to READY.
   * The Application Service does NOT call repository.updateOrderStatus().
   */
  async completeSimpleProduction(orderId: string): Promise<void> {
    try {
      const cleanOrderId = (orderId || '').trim();
      if (!cleanOrderId) {
        throw new ApplicationError('VALIDATION_ERROR', 'ID order wajib diisi.');
      }
      await this.prodRepo.completeSimpleProductionJob(cleanOrderId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Retrieves the production job (with nested work items and stage logs) for a given order ID.
   */
  async getProductionJob(orderId: string): Promise<ProductionJob | null> {
    try {
      const cleanOrderId = (orderId || '').trim();
      if (!cleanOrderId) {
        return null;
      }
      return await this.prodRepo.getProductionJobWithItems(cleanOrderId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }

  /**
   * Retrieves the production job by its primary key job ID.
   */
  async getProductionJobById(jobId: string): Promise<ProductionJob | null> {
    try {
      const cleanJobId = (jobId || '').trim();
      if (!cleanJobId) {
        return null;
      }
      return await this.prodRepo.getProductionJobById(cleanJobId);
    } catch (err) {
      throw translateRepositoryError(err);
    }
  }
}

// Singleton Application Service Instance
export const applicationService = new LaundryApplicationService(repository, productionRepository);
