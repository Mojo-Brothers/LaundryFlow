// ============================================================================
// Repository & Data Access Layer (Supabase PostgREST & Demo Sandbox Provider)
// (Phase 1.5 Hardened: Live Data Mutations, State Machine, & Sanitized Tracking)
// ============================================================================

import {
  Organization,
  Branch,
  UserProfile,
  Customer,
  Service,
  Order,
  OrderItem,
  Payment,
  CashierShift,
  OrderStatus,
  OrderStatusHistory,
  TransitManifest,
  TransitManifestItem,
  TransitManifestHistory,
  TransitManifestStatus,
  TransitManifestItemStatus,
  OrderReworkRequest,
  ReworkRequestStatus,
  ReworkReasonCode,
} from '../types/database';
import { supabase, isLiveSupabaseConfigured } from '../supabase/client';
import { isValidOrderTransition } from './stateMachine';
import {
  canTransitionManifest,
  assertManifestTransition,
  transitionManifest,
  validateManifestDraft,
  calculateManifestDiscrepancy,
  isOrderEligibleForTransit,
  assertOrderEligibleForManifest,
  assertManifestMutable,
  assertManifestItemMutable,
  assertManifestCanRemoveItem,
  assertManifestRouteMutable,
  assertManifestDeletable,
  isOutboundTransitEligible,
  isReturnTransitEligible,
  determineTransitRouteDirection,
  getLatestCompletedOutbound,
  getLatestCompletedReturn,
  getLatestOutboundItem,
  deriveOrderCustodyState,
  OrderCustodyState,
  HistoricalTransitItem,
} from './transitStateMachine';

export interface CreateOrderReworkRequestDTO {
  order_id: string;
  reason: ReworkReasonCode;
  notes?: string | null;
}
import {
  calculateShiftReconciliation,
  ShiftReconciliationResult,
} from './shiftReconciliation';

// ============================================================================
// Normalized Repository Errors
// ============================================================================

export type RepositoryErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'FINANCIAL_VALIDATION_ERROR'
  | 'DATABASE_ERROR';

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly originalError?: unknown;

  constructor(code: RepositoryErrorCode, message: string, originalError?: unknown) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.originalError = originalError;
    Object.setPrototypeOf(this, RepositoryError.prototype);
  }
}

export function normalizeRepositoryError(err: unknown): RepositoryError {
  if (err instanceof RepositoryError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes('manifest aktif') ||
    lower.includes('already assigned') ||
    lower.includes('duplicate') ||
    lower.includes('uq_') ||
    lower.includes('already exists')
  ) {
    return new RepositoryError('CONFLICT', message, err);
  }
  if (
    lower.includes('selisih kas') ||
    lower.includes('variance_note') ||
    lower.includes('closed shift')
  ) {
    return new RepositoryError('FINANCIAL_VALIDATION_ERROR', message, err);
  }
  if (
    lower.includes('transisi manifest ilegal') ||
    lower.includes('illegal') ||
    lower.includes('cannot transition') ||
    lower.includes('cannot modify') ||
    lower.includes('cannot be deleted') ||
    lower.includes('cannot delete') ||
    lower.includes('while items are attached') ||
    lower.includes('already received') ||
    lower.includes('is cancelled') ||
    lower.includes('must be in_transit') ||
    lower.includes('strictly immutable')
  ) {
    return new RepositoryError('INVALID_STATE_TRANSITION', message, err);
  }
  if (
    lower.includes('cross-tenant') ||
    lower.includes('access denied') ||
    lower.includes('unauthorized') ||
    lower.includes('permission') ||
    lower.includes('forbidden')
  ) {
    return new RepositoryError('FORBIDDEN', message, err);
  }
  if (
    lower.includes('cross-branch') ||
    lower.includes('tidak eligible') ||
    lower.includes('not eligible') ||
    lower.includes('different') ||
    lower.includes('validation') ||
    lower.includes('required') ||
    lower.includes('wajib')
  ) {
    return new RepositoryError('VALIDATION_ERROR', message, err);
  }
  if (lower.includes('not found') || lower.includes('tidak ditemukan')) {
    return new RepositoryError('NOT_FOUND', message, err);
  }

  return new RepositoryError('DATABASE_ERROR', message, err);
}

// ============================================================================
// Transit Manifest Contracts & Helpers
// ============================================================================

export interface CreateTransitManifestInput {
  organizationId?: string;
  sourceBranchId: string;
  destinationBranchId: string;
  driverUserId?: string;
  vehicleIdentifier?: string;
  notes?: string;
  orderIds?: string[];
}

export interface TransitManifestFilters {
  organizationId?: string;
  branchId?: string;
  sourceBranchId?: string;
  destinationBranchId?: string;
  status?: TransitManifestStatus;
  driverUserId?: string;
  search?: string;
}

export interface ReceiveTransitManifestInput {
  manifestId: string;
  itemsReview: Array<{
    orderId: string;
    status: TransitManifestItemStatus;
    notes?: string;
  }>;
  summaryNotes?: string;
}

function generateManifestNumber(sourceCode: string, destCode: string): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const randomSuffix = Math.floor(100 + Math.random() * 900);
  const src = sourceCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'SRC';
  const dst = destCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'DST';
  return `TRX-${src}-${dst}-${yy}${mm}${dd}-${randomSuffix}`;
}

// Initial Demo Seed Data
const DEMO_ORG: Organization = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Laundry Sejahtera Group',
  slug: 'laundry-sejahtera',
  subscription_tier: 'ENTERPRISE_DEMO',
  status: 'ACTIVE',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const DEMO_BRANCHES: Branch[] = [
  {
    id: '22222222-2222-2222-2222-222222222221',
    organization_id: DEMO_ORG.id,
    code: 'BKS-01',
    name: 'Outlet Bekasi Timur',
    branch_type: 'OUTLET',
    address: 'Jl. Ir. H. Juanda No. 88, Bekasi Timur',
    phone: '081299887711',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    organization_id: DEMO_ORG.id,
    code: 'TBN-01',
    name: 'Outlet Tambun Selatan',
    branch_type: 'OUTLET',
    address: 'Jl. Sultan Hasanudin No. 45, Tambun',
    phone: '081299887722',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '22222222-2222-2222-2222-222222222223',
    organization_id: DEMO_ORG.id,
    code: 'CP-01',
    name: 'Central Production Unit Tambun',
    branch_type: 'CENTRAL_PRODUCTION',
    address: 'Kawasan Industri Tambun Blok C No. 12',
    phone: '081299887733',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const DEMO_USERS: UserProfile[] = [
  {
    id: '33333333-3333-3333-3333-333333333331',
    organization_id: DEMO_ORG.id,
    email: 'owner@demo.laundryflow.id',
    full_name: 'Haji Hendra (Owner)',
    role: 'OWNER',
    default_branch_id: DEMO_BRANCHES[0].id,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '33333333-3333-3333-3333-333333333332',
    organization_id: DEMO_ORG.id,
    email: 'kasir@demo.laundryflow.id',
    full_name: 'Rina Kasir',
    role: 'CASHIER',
    default_branch_id: DEMO_BRANCHES[0].id,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    organization_id: DEMO_ORG.id,
    email: 'operator@demo.laundryflow.id',
    full_name: 'Joko Operator',
    role: 'OPERATOR',
    default_branch_id: DEMO_BRANCHES[2].id,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const DEMO_SERVICES: Service[] = [
  {
    id: '44444444-4444-4444-4444-444444444441',
    organization_id: DEMO_ORG.id,
    name: 'Cuci Komplit Reguler (Cuci + Kering + Setrika)',
    category: 'Kiloan',
    unit: 'KG',
    base_price: 8000,
    min_charge_unit: 3.0,
    rounding_rule: 'ROUND_HALF_UP_0_5',
    estimated_duration_hours: 48,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '44444444-4444-4444-4444-444444444442',
    organization_id: DEMO_ORG.id,
    name: 'Cuci Komplit Express 6 Jam',
    category: 'Kiloan',
    unit: 'KG',
    base_price: 15000,
    min_charge_unit: 3.0,
    rounding_rule: 'ROUND_HALF_UP_0_5',
    estimated_duration_hours: 6,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '44444444-4444-4444-4444-444444444443',
    organization_id: DEMO_ORG.id,
    name: 'Cuci Kering Lipat (Non Setrika)',
    category: 'Kiloan',
    unit: 'KG',
    base_price: 6000,
    min_charge_unit: 3.0,
    rounding_rule: 'ROUND_HALF_UP_0_5',
    estimated_duration_hours: 24,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    organization_id: DEMO_ORG.id,
    name: 'Bed Cover King Size',
    category: 'Satuan',
    unit: 'PCS',
    base_price: 35000,
    min_charge_unit: 1.0,
    rounding_rule: 'EXACT',
    estimated_duration_hours: 48,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '44444444-4444-4444-4444-444444444445',
    organization_id: DEMO_ORG.id,
    name: 'Jas Formal 2-Piece',
    category: 'Satuan',
    unit: 'SET',
    base_price: 40000,
    min_charge_unit: 1.0,
    rounding_rule: 'EXACT',
    estimated_duration_hours: 72,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '44444444-4444-4444-4444-444444444446',
    organization_id: DEMO_ORG.id,
    name: 'Deep Clean Sepatu Sneakers',
    category: 'Satuan',
    unit: 'PCS',
    base_price: 35000,
    min_charge_unit: 1.0,
    rounding_rule: 'EXACT',
    estimated_duration_hours: 48,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const DEMO_CUSTOMERS: Customer[] = [
  {
    id: '55555555-5555-5555-5555-555555555551',
    organization_id: DEMO_ORG.id,
    name: 'Budi Santoso',
    phone: '081234567890',
    whatsapp: '081234567890',
    address: 'Perumahan Grand Galaxy City Blok B2 No. 10',
    notes: 'Alergi deterjen keras, suka pewangi lavender',
    membership_tier: 'REGULAR',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '55555555-5555-5555-5555-555555555552',
    organization_id: DEMO_ORG.id,
    name: 'Siti Rahmawati',
    phone: '085712345678',
    whatsapp: '085712345678',
    address: 'Apartemen Lagoon Resort Tower A 12-05',
    notes: 'Member VIP, pakaian sering jas/blazer',
    membership_tier: 'VIP',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '55555555-5555-5555-5555-555555555553',
    organization_id: DEMO_ORG.id,
    name: 'Agus Prasetyo',
    phone: '087812345678',
    whatsapp: '087812345678',
    address: 'Jl. Melati Raya No. 15, Bekasi',
    membership_tier: 'REGULAR',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '55555555-5555-5555-5555-555555555554',
    organization_id: DEMO_ORG.id,
    name: 'Dewi Lestari',
    phone: '089612345678',
    whatsapp: '089612345678',
    address: 'Perumahan Kemang Pratama 2 Blok C1',
    membership_tier: 'VIP',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const DEMO_SHIFT: CashierShift = {
  id: '66666666-6666-6666-6666-666666666661',
  organization_id: DEMO_ORG.id,
  branch_id: DEMO_BRANCHES[0].id,
  cashier_id: DEMO_USERS[1].id,
  opening_cash: 150000,
  expected_cash: 186000,
  status: 'OPEN',
  notes: 'Shift Pagi (08:00 - 16:00)',
  opened_at: new Date(Date.now() - 4 * 3600000).toISOString(),
};

const DEMO_ORDERS: Order[] = [
  {
    id: '77777777-7777-7777-7777-777777777771',
    organization_id: DEMO_ORG.id,
    branch_id: DEMO_BRANCHES[0].id,
    production_branch_id: DEMO_BRANCHES[2].id,
    customer_id: DEMO_CUSTOMERS[0].id,
    order_number: 'BKS-2609-0001',
    tracking_token: 'trk_live_bks01_budi9988',
    status: 'WASHING',
    operating_mode: 'ADVANCED',
    subtotal: 36000,
    discount_amount: 0,
    delivery_fee: 0,
    final_amount: 36000,
    paid_amount: 36000,
    remaining_amount: 0,
    payment_status: 'PAID',
    promised_ready_at: new Date(Date.now() + 24 * 3600000).toISOString(),
    created_by: DEMO_USERS[1].id,
    created_at: new Date(Date.now() - 6 * 3600000).toISOString(),
    updated_at: new Date().toISOString(),
    customer: DEMO_CUSTOMERS[0],
    branch: DEMO_BRANCHES[0],
    items: [
      {
        id: 'item-1',
        order_id: '77777777-7777-7777-7777-777777777771',
        service_id: DEMO_SERVICES[0].id,
        item_type: 'KILOAN',
        service_name_snap: 'Cuci Komplit Reguler (Cuci + Kering + Setrika)',
        unit_price_snap: 8000,
        quantity_or_weight: 4.2,
        billable_weight: 4.5,
        subtotal: 36000,
        notes: 'Pewangi Lavender, baju putih dipisah',
        created_at: new Date().toISOString(),
      },
    ],
  },
  {
    id: '77777777-7777-7777-7777-777777777772',
    organization_id: DEMO_ORG.id,
    branch_id: DEMO_BRANCHES[0].id,
    production_branch_id: DEMO_BRANCHES[0].id,
    customer_id: DEMO_CUSTOMERS[1].id,
    order_number: 'BKS-2609-0002',
    tracking_token: 'trk_live_bks01_siti7721',
    status: 'READY',
    operating_mode: 'SIMPLE',
    subtotal: 80000,
    discount_amount: 0,
    delivery_fee: 0,
    final_amount: 80000,
    paid_amount: 80000,
    remaining_amount: 0,
    payment_status: 'PAID',
    promised_ready_at: new Date(Date.now() - 2 * 3600000).toISOString(),
    created_by: DEMO_USERS[1].id,
    created_at: new Date(Date.now() - 28 * 3600000).toISOString(),
    updated_at: new Date().toISOString(),
    customer: DEMO_CUSTOMERS[1],
    branch: DEMO_BRANCHES[0],
    items: [
      {
        id: 'item-2',
        order_id: '77777777-7777-7777-7777-777777777772',
        service_id: DEMO_SERVICES[3].id,
        item_type: 'SATUAN',
        service_name_snap: 'Bed Cover King Size',
        unit_price_snap: 35000,
        quantity_or_weight: 1,
        billable_weight: 1,
        subtotal: 35000,
        notes: 'Warna biru tua',
        created_at: new Date().toISOString(),
      },
      {
        id: 'item-3',
        order_id: '77777777-7777-7777-7777-777777777772',
        service_id: DEMO_SERVICES[1].id,
        item_type: 'KILOAN',
        service_name_snap: 'Cuci Komplit Express 6 Jam',
        unit_price_snap: 15000,
        quantity_or_weight: 3.0,
        billable_weight: 3.0,
        subtotal: 45000,
        notes: 'Kemeja kantor',
        created_at: new Date().toISOString(),
      },
    ],
  },
  {
    id: '77777777-7777-7777-7777-777777777773',
    organization_id: DEMO_ORG.id,
    branch_id: DEMO_BRANCHES[0].id,
    production_branch_id: DEMO_BRANCHES[2].id,
    customer_id: DEMO_CUSTOMERS[0].id,
    order_number: 'BKS-2609-0003',
    tracking_token: 'trk_live_bks01_budi9989',
    status: 'RECEIVED',
    operating_mode: 'ADVANCED',
    subtotal: 24000,
    discount_amount: 0,
    delivery_fee: 0,
    final_amount: 24000,
    paid_amount: 24000,
    remaining_amount: 0,
    payment_status: 'PAID',
    promised_ready_at: new Date(Date.now() + 48 * 3600000).toISOString(),
    created_by: DEMO_USERS[1].id,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    updated_at: new Date().toISOString(),
    customer: DEMO_CUSTOMERS[0],
    branch: DEMO_BRANCHES[0],
    production_branch: DEMO_BRANCHES[2],
    items: [
      {
        id: 'item-4',
        order_id: '77777777-7777-7777-7777-777777777773',
        service_id: DEMO_SERVICES[0].id,
        item_type: 'KILOAN',
        service_name_snap: 'Cuci Komplit Reguler (Cuci + Kering + Setrika)',
        unit_price_snap: 8000,
        quantity_or_weight: 3.0,
        billable_weight: 3.0,
        subtotal: 24000,
        notes: 'Cucian siap dikirim ke Central Production',
        created_at: new Date().toISOString(),
      },
    ],
  },
  {
    id: '77777777-7777-7777-7777-777777777774',
    organization_id: DEMO_ORG.id,
    branch_id: DEMO_BRANCHES[0].id,
    production_branch_id: DEMO_BRANCHES[2].id,
    customer_id: DEMO_CUSTOMERS[1].id,
    order_number: 'BKS-2609-0004',
    tracking_token: 'trk_live_bks01_siti7722',
    status: 'SORTING',
    operating_mode: 'ADVANCED',
    subtotal: 35000,
    discount_amount: 0,
    delivery_fee: 0,
    final_amount: 35000,
    paid_amount: 35000,
    remaining_amount: 0,
    payment_status: 'PAID',
    promised_ready_at: new Date(Date.now() + 48 * 3600000).toISOString(),
    created_by: DEMO_USERS[1].id,
    created_at: new Date(Date.now() - 1800000).toISOString(),
    updated_at: new Date().toISOString(),
    customer: DEMO_CUSTOMERS[1],
    branch: DEMO_BRANCHES[0],
    production_branch: DEMO_BRANCHES[2],
    items: [
      {
        id: 'item-5',
        order_id: '77777777-7777-7777-7777-777777777774',
        service_id: DEMO_SERVICES[3].id,
        item_type: 'SATUAN',
        service_name_snap: 'Bed Cover King Size',
        unit_price_snap: 35000,
        quantity_or_weight: 1,
        billable_weight: 1,
        subtotal: 35000,
        notes: 'Sudah disortir',
        created_at: new Date().toISOString(),
      },
    ],
  },
];

const DEMO_MANIFESTS: TransitManifest[] = [
  {
    id: 'man-99999999-9999-9999-9999-999999999991',
    organization_id: DEMO_ORG.id,
    manifest_number: 'TRX-BKS-CP-260917-001',
    source_branch_id: DEMO_BRANCHES[0].id,
    destination_branch_id: DEMO_BRANCHES[2].id,
    status: 'IN_TRANSIT',
    driver_user_id: DEMO_USERS[2].id,
    vehicle_identifier: 'B 1234 KRO (Pickup)',
    notes: 'Pengiriman cucian kiloan pagi',
    total_expected_orders: 1,
    total_received_orders: 0,
    has_discrepancy: false,
    created_by: DEMO_USERS[1].id,
    dispatched_by: DEMO_USERS[2].id,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    dispatched_at: new Date(Date.now() - 1800000).toISOString(),
    updated_at: new Date(Date.now() - 1800000).toISOString(),
  },
  {
    id: 'man-99999999-9999-9999-9999-999999999992',
    organization_id: DEMO_ORG.id,
    manifest_number: 'TRX-TBN-CP-260917-002',
    source_branch_id: DEMO_BRANCHES[1].id,
    destination_branch_id: DEMO_BRANCHES[2].id,
    status: 'DRAFT',
    total_expected_orders: 1,
    total_received_orders: 0,
    has_discrepancy: false,
    created_by: DEMO_USERS[1].id,
    created_at: new Date(Date.now() - 7200000).toISOString(),
    updated_at: new Date(Date.now() - 7200000).toISOString(),
  },
];

const DEMO_MANIFEST_ITEMS: TransitManifestItem[] = [
  {
    id: 'mitem-1',
    manifest_id: 'man-99999999-9999-9999-9999-999999999991',
    organization_id: DEMO_ORG.id,
    order_id: DEMO_ORDERS[0].id,
    received_status: 'EXPECTED',
    added_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'mitem-2',
    manifest_id: 'man-99999999-9999-9999-9999-999999999992',
    organization_id: DEMO_ORG.id,
    order_id: DEMO_ORDERS[1].id,
    received_status: 'EXPECTED',
    added_at: new Date(Date.now() - 7200000).toISOString(),
  },
];

const DEMO_MANIFEST_HISTORY: TransitManifestHistory[] = [
  {
    id: 'mhist-1',
    manifest_id: 'man-99999999-9999-9999-9999-999999999991',
    organization_id: DEMO_ORG.id,
    from_status: undefined,
    to_status: 'DRAFT',
    actor_id: DEMO_USERS[1].id,
    notes: 'Manifest draft dibuat oleh kasir',
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'mhist-2',
    manifest_id: 'man-99999999-9999-9999-9999-999999999991',
    organization_id: DEMO_ORG.id,
    from_status: 'DRAFT',
    to_status: 'READY_TO_DISPATCH',
    actor_id: DEMO_USERS[1].id,
    notes: 'Manifest siap diberangkatkan',
    created_at: new Date(Date.now() - 2700000).toISOString(),
  },
  {
    id: 'mhist-3',
    manifest_id: 'man-99999999-9999-9999-9999-999999999991',
    organization_id: DEMO_ORG.id,
    from_status: 'READY_TO_DISPATCH',
    to_status: 'IN_TRANSIT',
    actor_id: DEMO_USERS[2].id,
    notes: 'Manifest diberangkatkan menuju cabang tujuan',
    created_at: new Date(Date.now() - 1800000).toISOString(),
  },
];

// In-Memory Storage Cache with localStorage persistence for Sandbox mode
class LocalSandboxStorage {
  customers: Customer[] = [...DEMO_CUSTOMERS];
  services: Service[] = [...DEMO_SERVICES];
  orders: Order[] = [...DEMO_ORDERS];
  shifts: CashierShift[] = [DEMO_SHIFT];
  statusHistory: OrderStatusHistory[] = [];
  payments: Payment[] = [];
  manifests: TransitManifest[] = [...DEMO_MANIFESTS];
  manifestItems: TransitManifestItem[] = [...DEMO_MANIFEST_ITEMS];
  manifestHistory: TransitManifestHistory[] = [...DEMO_MANIFEST_HISTORY];
  orderReworkRequests: OrderReworkRequest[] = [];

  constructor() {
    this.loadFromStorage();
  }

  getHistoricalTransitItems(): HistoricalTransitItem[] {
    return this.manifestItems.map(item => {
      const m = this.manifests.find(man => man.id === item.manifest_id);
      return {
        order_id: item.order_id,
        received_status: item.received_status,
        received_at: item.received_at,
        manifest: {
          source_branch_id: m?.source_branch_id || '',
          destination_branch_id: m?.destination_branch_id || '',
          status: m?.status || 'DRAFT',
          received_at: m?.received_at,
        },
      };
    });
  }

  private loadFromStorage() {
    try {
      const savedOrders = localStorage.getItem('lf_orders');
      if (savedOrders) this.orders = JSON.parse(savedOrders);

      const savedCusts = localStorage.getItem('lf_customers');
      if (savedCusts) this.customers = JSON.parse(savedCusts);

      const savedShifts = localStorage.getItem('lf_shifts');
      if (savedShifts) this.shifts = JSON.parse(savedShifts);

      const savedHist = localStorage.getItem('lf_status_history');
      if (savedHist) this.statusHistory = JSON.parse(savedHist);

      const savedPays = localStorage.getItem('lf_payments');
      if (savedPays) this.payments = JSON.parse(savedPays);

      const savedManifests = localStorage.getItem('lf_manifests');
      if (savedManifests) this.manifests = JSON.parse(savedManifests);

      const savedMItems = localStorage.getItem('lf_manifest_items');
      if (savedMItems) this.manifestItems = JSON.parse(savedMItems);

      const savedMHist = localStorage.getItem('lf_manifest_history');
      if (savedMHist) this.manifestHistory = JSON.parse(savedMHist);

      const savedRework = localStorage.getItem('lf_order_rework_requests');
      if (savedRework) this.orderReworkRequests = JSON.parse(savedRework);
    } catch {
      // fallback to initial in-memory state
    }
  }

  save() {
    try {
      localStorage.setItem('lf_orders', JSON.stringify(this.orders));
      localStorage.setItem('lf_customers', JSON.stringify(this.customers));
      localStorage.setItem('lf_shifts', JSON.stringify(this.shifts));
      localStorage.setItem('lf_status_history', JSON.stringify(this.statusHistory));
      localStorage.setItem('lf_payments', JSON.stringify(this.payments));
      localStorage.setItem('lf_manifests', JSON.stringify(this.manifests));
      localStorage.setItem('lf_manifest_items', JSON.stringify(this.manifestItems));
      localStorage.setItem('lf_manifest_history', JSON.stringify(this.manifestHistory));
      localStorage.setItem('lf_order_rework_requests', JSON.stringify(this.orderReworkRequests));
    } catch {
      // storage quota or incognito
    }
  }

  private lastTimestamp = 0;

  now(): string {
    const current = Date.now();
    if (current <= this.lastTimestamp) {
      this.lastTimestamp += 1;
    } else {
      this.lastTimestamp = current;
    }
    return new Date(this.lastTimestamp).toISOString();
  }

  reset() {
    this.lastTimestamp = 0;
    this.customers = JSON.parse(JSON.stringify(DEMO_CUSTOMERS));
    this.services = JSON.parse(JSON.stringify(DEMO_SERVICES));
    this.orders = JSON.parse(JSON.stringify(DEMO_ORDERS));
    this.shifts = [{ ...DEMO_SHIFT, opened_at: this.now() }];
    this.statusHistory = [];
    this.payments = [];
    this.manifests = JSON.parse(JSON.stringify(DEMO_MANIFESTS));
    this.manifestItems = JSON.parse(JSON.stringify(DEMO_MANIFEST_ITEMS));
    this.manifestHistory = JSON.parse(JSON.stringify(DEMO_MANIFEST_HISTORY));
    this.orderReworkRequests = [];
    this.save();
  }
}

const sandbox = new LocalSandboxStorage();

// ============================================================================
// Repository Methods
// ============================================================================

export const repository = {
  // --- Demo / Organization / Branches ---
  async getOrganization(): Promise<Organization> {
    return DEMO_ORG;
  },

  async getBranches(): Promise<Branch[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase.from('branches').select('*').eq('is_active', true);
      if (error) throw error;
      return data as Branch[];
    }
    return DEMO_BRANCHES;
  },

  async getUsers(): Promise<UserProfile[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase.from('users').select('*').eq('is_active', true);
      if (error) throw error;
      return data as UserProfile[];
    }
    return DEMO_USERS;
  },

  // --- Customers ---
  async getCustomers(query = ''): Promise<Customer[]> {
    if (isLiveSupabaseConfigured && supabase) {
      let req = supabase.from('customers').select('*').order('name');
      if (query) {
        req = req.or(`name.ilike.%${query}%,phone.ilike.%${query}%`);
      }
      const { data, error } = await req;
      if (error) throw error;
      return data as Customer[];
    }

    const q = query.toLowerCase().trim();
    if (!q) return sandbox.customers;
    return sandbox.customers.filter(
      c => c.name.toLowerCase().includes(q) || c.phone.includes(q)
    );
  },

  async createCustomer(customer: Omit<Customer, 'id' | 'created_at' | 'updated_at'>): Promise<Customer> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('customers')
        .insert(customer)
        .select()
        .single();
      if (error) throw error;
      return data as Customer;
    }

    const newCustomer: Customer = {
      ...customer,
      id: 'cust-' + Date.now(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    sandbox.customers.unshift(newCustomer);
    sandbox.save();
    return newCustomer;
  },

  // --- Services ---
  async getServices(): Promise<Service[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('services')
        .select('*')
        .eq('is_active', true)
        .order('category');
      if (error) throw error;
      return data as Service[];
    }
    return sandbox.services;
  },

  // --- Cashier Shifts ---
  async getActiveShift(branchId: string): Promise<CashierShift | null> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('cashier_shifts')
        .select('*')
        .eq('branch_id', branchId)
        .eq('status', 'OPEN')
        .maybeSingle();
      if (error) throw error;
      return data as CashierShift | null;
    }

    return sandbox.shifts.find(s => s.branch_id === branchId && s.status === 'OPEN') || null;
  },

  async openShift(shift: Omit<CashierShift, 'id' | 'opened_at'>): Promise<CashierShift> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('cashier_shifts')
        .insert(shift)
        .select()
        .single();
      if (error) throw error;
      return data as CashierShift;
    }

    const newShift: CashierShift = {
      ...shift,
      id: 'shift-' + Date.now(),
      opened_at: new Date().toISOString(),
    };
    sandbox.shifts.unshift(newShift);
    sandbox.save();
    return newShift;
  },

  async closeShift(shiftId: string, actualCash: number, notes?: string): Promise<CashierShift> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('close_cashier_shift_reconciled', {
        p_shift_id: shiftId,
        p_actual_cash: actualCash,
        p_variance_note: notes || null,
      });
      if (error) throw normalizeRepositoryError(error);

      const { data: updated, error: fetchErr } = await supabase
        .from('cashier_shifts')
        .select('*')
        .eq('id', shiftId)
        .single();
      if (fetchErr) throw normalizeRepositoryError(fetchErr);
      return updated as CashierShift;
    }

    const shift = sandbox.shifts.find(s => s.id === shiftId);
    if (!shift) throw new RepositoryError('NOT_FOUND', 'Shift tidak ditemukan.');
    if (shift.status === 'CLOSED') {
      throw new RepositoryError(
        'CONFLICT',
        'Shift sudah berstatus CLOSED dan tidak dapat dimodifikasi ulang.'
      );
    }

    // Filter successful payments tied to this shift
    const shiftPayments = sandbox.payments.filter(
      p => p.cashier_shift_id === shiftId && p.status === 'SUCCESS'
    );
    const cashPayments = shiftPayments
      .filter(p => p.payment_method === 'CASH')
      .reduce((sum, p) => sum + p.amount, 0);
    const qrisPayments = shiftPayments
      .filter(p => p.payment_method === 'QRIS_MANUAL')
      .reduce((sum, p) => sum + p.amount, 0);
    const transferPayments = shiftPayments
      .filter(p => p.payment_method === 'BANK_TRANSFER')
      .reduce((sum, p) => sum + p.amount, 0);
    const edcPayments = shiftPayments
      .filter(p => p.payment_method === 'EDC')
      .reduce((sum, p) => sum + p.amount, 0);
    const otherPayments = shiftPayments
      .filter(p => p.payment_method === 'OTHER')
      .reduce((sum, p) => sum + p.amount, 0);

    const reconciliation = calculateShiftReconciliation({
      openingCash: shift.opening_cash,
      cashPayments,
      cashIn: shift.cash_in || 0,
      cashOut: shift.cash_out || 0,
      cashRefunds: shift.refund_amount || 0,
      actualCash,
      varianceNote: notes,
      nonCashPayments: {
        qris: qrisPayments,
        transfer: transferPayments,
        edc: edcPayments,
        other: otherPayments,
      },
    });

    if (reconciliation.requiresVarianceNote && !reconciliation.isVarianceNoteValid) {
      throw new RepositoryError(
        'FINANCIAL_VALIDATION_ERROR',
        `Selisih kas terdeteksi (${reconciliation.difference}). Wajib mencantumkan variance_note minimal 5 karakter.`
      );
    }

    shift.actual_cash = actualCash;
    shift.expected_cash = reconciliation.expectedCash;
    shift.difference = reconciliation.difference;
    shift.cash_sales = cashPayments;
    shift.qris_sales = qrisPayments;
    shift.transfer_sales = transferPayments;
    shift.transaction_count = shiftPayments.length;
    shift.variance_note = notes;
    shift.status = 'CLOSED';
    shift.closed_at = new Date().toISOString();

    sandbox.save();
    return shift;
  },

  async getShiftSummary(
    shiftId: string
  ): Promise<ShiftReconciliationResult & { shift: CashierShift; paymentsCount: number }> {
    let shift: CashierShift | null = null;
    let payments: Payment[] = [];

    if (isLiveSupabaseConfigured && supabase) {
      const { data: shiftData, error: shiftErr } = await supabase
        .from('cashier_shifts')
        .select('*')
        .eq('id', shiftId)
        .single();
      if (shiftErr) throw normalizeRepositoryError(shiftErr);
      shift = shiftData as CashierShift;

      const { data: payData, error: payErr } = await supabase
        .from('payments')
        .select('*')
        .eq('cashier_shift_id', shiftId)
        .eq('status', 'SUCCESS');
      if (payErr) throw normalizeRepositoryError(payErr);
      payments = (payData || []) as Payment[];
    } else {
      shift = sandbox.shifts.find(s => s.id === shiftId) || null;
      if (!shift) throw new RepositoryError('NOT_FOUND', 'Shift tidak ditemukan.');
      payments = sandbox.payments.filter(
        p => p.cashier_shift_id === shiftId && p.status === 'SUCCESS'
      );
    }

    const cashPayments = payments
      .filter(p => p.payment_method === 'CASH')
      .reduce((sum, p) => sum + p.amount, 0);
    const qrisPayments = payments
      .filter(p => p.payment_method === 'QRIS_MANUAL')
      .reduce((sum, p) => sum + p.amount, 0);
    const transferPayments = payments
      .filter(p => p.payment_method === 'BANK_TRANSFER')
      .reduce((sum, p) => sum + p.amount, 0);
    const edcPayments = payments
      .filter(p => p.payment_method === 'EDC')
      .reduce((sum, p) => sum + p.amount, 0);
    const otherPayments = payments
      .filter(p => p.payment_method === 'OTHER')
      .reduce((sum, p) => sum + p.amount, 0);

    const actual =
      shift.actual_cash !== undefined ? shift.actual_cash : shift.opening_cash + cashPayments;

    const recon = calculateShiftReconciliation({
      openingCash: shift.opening_cash,
      cashPayments,
      cashIn: shift.cash_in || 0,
      cashOut: shift.cash_out || 0,
      cashRefunds: shift.refund_amount || 0,
      actualCash: actual,
      varianceNote: shift.variance_note,
      nonCashPayments: {
        qris: qrisPayments,
        transfer: transferPayments,
        edc: edcPayments,
        other: otherPayments,
      },
    });

    return {
      ...recon,
      shift,
      paymentsCount: payments.length,
    };
  },

  // --- Orders ---
  async getOrders(
    branchId?: string,
    status?: OrderStatus,
    options?: { productionBranchId?: string }
  ): Promise<Order[]> {
    if (isLiveSupabaseConfigured && supabase) {
      let query = supabase
        .from('orders')
        .select('*, customer:customers(*), items:order_items(*)')
        .order('created_at', { ascending: false });

      if (branchId) query = query.eq('branch_id', branchId);
      if (options?.productionBranchId) query = query.eq('production_branch_id', options.productionBranchId);
      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) throw error;
      return data as Order[];
    }

    let list = [...sandbox.orders];
    if (branchId) list = list.filter(o => o.branch_id === branchId || o.production_branch_id === branchId);
    if (options?.productionBranchId) {
      const prodBranchId = options.productionBranchId;
      const history = sandbox.getHistoricalTransitItems();
      list = list.filter(o => {
        if (o.production_branch_id !== prodBranchId) return false;
        // Local order: originating branch is the workshop itself -> visible directly
        if (o.branch_id === prodBranchId) return true;
        // External order: only visible if physically present at workshop with RECEIVED_OK
        const custodyState = deriveOrderCustodyState(o, history);
        return custodyState === 'AT_WORKSHOP';
      });
    }
    if (status) list = list.filter(o => o.status === status);
    return list;
  },

  async createOrder(
    orderData: Omit<Order, 'id' | 'order_number' | 'tracking_token' | 'created_at' | 'updated_at'>,
    itemsData: Array<Omit<OrderItem, 'id' | 'order_id' | 'created_at'>>,
    paymentData?: { method: Payment['payment_method']; amount: number }
  ): Promise<Order> {
    const timestamp = Date.now().toString().slice(-4);
    const orderNumber = `BKS-${new Date().toISOString().slice(2, 4)}${new Date().toISOString().slice(5, 7)}-${timestamp}`;
    const trackingToken = `trk_${orderNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Math.random().toString(36).slice(2, 8)}`;

    const paidAmt = paymentData && paymentData.amount > 0 ? paymentData.amount : 0;
    const finalAmount = Math.max(0, orderData.subtotal - orderData.discount_amount + orderData.delivery_fee);
    const remainingAmount = Math.max(0, finalAmount - paidAmt);
    const paymentStatus = paidAmt >= finalAmount ? 'PAID' : paidAmt > 0 ? 'PARTIAL' : 'UNPAID';

    if (isLiveSupabaseConfigured && supabase) {
      // 1. Insert Order
      const { data: createdOrder, error: orderErr } = await supabase
        .from('orders')
        .insert({
          ...orderData,
          order_number: orderNumber,
          tracking_token: trackingToken,
          final_amount: finalAmount,
          paid_amount: paidAmt,
          remaining_amount: remainingAmount,
          payment_status: paymentStatus,
        })
        .select()
        .single();
      if (orderErr) throw orderErr;

      // 2. Insert Order Items
      const itemsPayload = itemsData.map(item => ({
        ...item,
        order_id: createdOrder.id,
      }));
      const { error: itemsErr } = await supabase.from('order_items').insert(itemsPayload);
      if (itemsErr) throw itemsErr;

      // 3. Insert Payment if paid
      if (paidAmt > 0 && paymentData) {
        const activeShift = await this.getActiveShift(orderData.branch_id);
        const { error: payErr } = await supabase.from('payments').insert({
          organization_id: orderData.organization_id,
          branch_id: orderData.branch_id,
          order_id: createdOrder.id,
          cashier_shift_id: activeShift?.id,
          payment_method: paymentData.method,
          amount: paidAmt,
          received_by: orderData.created_by,
        });
        if (payErr) throw payErr;
      }

      // 4. Insert Initial Status History
      await supabase.from('order_status_history').insert({
        order_id: createdOrder.id,
        from_status: null,
        to_status: 'RECEIVED',
        changed_by: orderData.created_by,
        notes: 'Pesanan diterima kasir',
      });

      return createdOrder as Order;
    }

    // Local Sandbox Path
    const newOrder: Order = {
      ...orderData,
      id: 'order-' + Date.now(),
      order_number: orderNumber,
      tracking_token: trackingToken,
      final_amount: finalAmount,
      paid_amount: paidAmt,
      remaining_amount: remainingAmount,
      payment_status: paymentStatus,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items: itemsData.map((item, idx) => ({
        ...item,
        id: `item-${Date.now()}-${idx}`,
        order_id: 'order-' + Date.now(),
        created_at: new Date().toISOString(),
      })),
      customer: sandbox.customers.find(c => c.id === orderData.customer_id),
      branch: DEMO_BRANCHES.find(b => b.id === orderData.branch_id),
      production_branch: DEMO_BRANCHES.find(b => b.id === orderData.production_branch_id),
    };

    // Record payment in sandbox payments
    if (paidAmt > 0 && paymentData) {
      const activeShift = sandbox.shifts.find(s => s.branch_id === orderData.branch_id && s.status === 'OPEN');
      const newPayment: Payment = {
        id: 'pay-' + Date.now(),
        organization_id: orderData.organization_id,
        branch_id: orderData.branch_id,
        order_id: newOrder.id,
        cashier_shift_id: activeShift?.id,
        payment_method: paymentData.method,
        amount: paidAmt,
        status: 'SUCCESS',
        received_by: orderData.created_by,
        created_at: new Date().toISOString(),
      };
      sandbox.payments.unshift(newPayment);

      if (activeShift && paymentData.method === 'CASH') {
        activeShift.expected_cash += paidAmt;
      }
    }

    // Record initial status history in sandbox
    sandbox.statusHistory.unshift({
      id: 'hist-' + Date.now(),
      order_id: newOrder.id,
      from_status: undefined,
      to_status: 'RECEIVED',
      changed_by: orderData.created_by,
      notes: 'Pesanan diterima di kasir',
      created_at: new Date().toISOString(),
    });

    sandbox.orders.unshift(newOrder);
    sandbox.save();
    return newOrder;
  },

  async updateOrderStatus(
    orderId: string,
    nextStatus: OrderStatus,
    userId: string,
    notes?: string
  ): Promise<Order> {
    let order: Order | undefined;

    if (isLiveSupabaseConfigured && supabase) {
      const { data: currentOrder, error: fetchErr } = await supabase
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .single();
      if (fetchErr || !currentOrder) throw new Error('Order tidak ditemukan');

      // 1. Strict State Machine Validation
      const validation = isValidOrderTransition(
        currentOrder.status,
        nextStatus,
        currentOrder.operating_mode
      );
      if (!validation.isValid) {
        throw new Error(validation.reason);
      }

      // 2. Update Order
      const { data: updated, error: updateErr } = await supabase
        .from('orders')
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .select()
        .single();
      if (updateErr) throw updateErr;

      // 3. Record Immutable Status History
      await supabase.from('order_status_history').insert({
        order_id: orderId,
        from_status: currentOrder.status,
        to_status: nextStatus,
        changed_by: userId,
        notes: notes || `Status diubah menjadi ${nextStatus}`,
      });

      return updated as Order;
    }

    // Local Sandbox Path
    order = sandbox.orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order tidak ditemukan');

    // 1. Strict State Machine Validation
    const validation = isValidOrderTransition(order.status, nextStatus, order.operating_mode);
    if (!validation.isValid) {
      throw new Error(validation.reason);
    }

    const previousStatus = order.status;
    order.status = nextStatus;
    order.updated_at = new Date().toISOString();

    // 2. Record Status History in Sandbox
    sandbox.statusHistory.unshift({
      id: 'hist-' + Date.now(),
      order_id: order.id,
      from_status: previousStatus,
      to_status: nextStatus,
      changed_by: userId,
      notes: notes || `Status diubah dari ${previousStatus} menjadi ${nextStatus}`,
      created_at: new Date().toISOString(),
    });

    sandbox.save();
    return order;
  },

  async getPayments(orderId: string): Promise<Payment[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('order_id', orderId);
      if (error) throw normalizeRepositoryError(error);
      return (data || []) as Payment[];
    }
    return sandbox.payments.filter(p => p.order_id === orderId);
  },

  /**
   * Public tracking fetcher: strictly queries non-PII tracking view/RPC
   */
  async getOrderByTrackingToken(token: string): Promise<any | null> {
    if (!token || token.trim().length < 5) return null;

    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase.rpc('get_public_order_tracking', {
        p_tracking_token: token,
      });
      if (error) {
        console.error('Error fetching public tracking RPC:', error);
        return null;
      }
      return data;
    }

    // Local Sandbox RPC Simulation: Sanitized object with ZERO PII
    const order = sandbox.orders.find(o => o.tracking_token === token);
    if (!order) return null;

    return {
      order_number: order.order_number,
      status: order.status,
      operating_mode: order.operating_mode,
      subtotal: order.subtotal,
      discount_amount: order.discount_amount,
      delivery_fee: order.delivery_fee,
      final_amount: order.final_amount,
      paid_amount: order.paid_amount,
      remaining_amount: order.remaining_amount,
      payment_status: order.payment_status,
      promised_ready_at: order.promised_ready_at,
      created_at: order.created_at,
      branch_name: order.branch?.name || 'Outlet Bekasi Timur',
      branch_address: order.branch?.address || 'Bekasi, Jawa Barat',
      branch_phone: order.branch?.phone || '0812-9988-7711',
      items: order.items?.map(i => ({
        service_name: i.service_name_snap,
        quantity_or_weight: i.quantity_or_weight,
        billable_weight: i.billable_weight,
        item_type: i.item_type,
        subtotal: i.subtotal,
      })) || [],
    };
  },

  async getOrderStatusHistory(orderId: string): Promise<OrderStatusHistory[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('order_status_history')
        .select('*')
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as OrderStatusHistory[];
    }
    return sandbox.statusHistory.filter(h => h.order_id === orderId);
  },

  // --- Transit Manifests (Phase 2 Multi-Outlet Chain of Custody) ---

  async createTransitManifest(input: CreateTransitManifestInput): Promise<TransitManifest> {
    // 1. Client fast-feedback validation using pure domain logic
    const draftValidation = validateManifestDraft({
      organization_id: input.organizationId || DEMO_ORG.id,
      source_branch_id: input.sourceBranchId,
      destination_branch_id: input.destinationBranchId,
      driver_user_id: input.driverUserId,
    });
    if (!draftValidation.isValid) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        draftValidation.errors.join(' ') || 'Data manifest draft tidak valid.'
      );
    }

    if (isLiveSupabaseConfigured && supabase) {
      const branches = await this.getBranches();
      const src = branches.find(b => b.id === input.sourceBranchId)?.code || 'SRC';
      const dst = branches.find(b => b.id === input.destinationBranchId)?.code || 'DST';
      const manifestNumber = generateManifestNumber(src, dst);

      // RPC handles deterministic row-level locks on target orders (ORDER BY id FOR UPDATE)
      // preventing bulk order deadlocks and ensuring double-dispatch atomicity at DB layer
      const { data, error } = await supabase.rpc('create_manifest_with_orders', {
        p_manifest_number: manifestNumber,
        p_source_branch_id: input.sourceBranchId,
        p_destination_branch_id: input.destinationBranchId,
        p_driver_user_id: input.driverUserId || null,
        p_vehicle_identifier: input.vehicleIdentifier || null,
        p_notes: input.notes || null,
        p_order_ids: input.orderIds || [],
      });
      if (error) throw normalizeRepositoryError(error);

      const created = await this.getTransitManifest(data.manifest_id);
      if (!created) {
        throw new RepositoryError('NOT_FOUND', 'Manifest berhasil dibuat tetapi gagal dimuat kembali.');
      }
      return created;
    }

    // Sandbox Path: Double-dispatch prevention across active manifests
    const orgId = input.organizationId || DEMO_ORG.id;
    const activeStatuses: TransitManifestStatus[] = ['DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT'];
    const activeManifestIds = new Set(
      sandbox.manifests.filter(m => activeStatuses.includes(m.status)).map(m => m.id)
    );

    if (input.orderIds && input.orderIds.length > 0) {
      for (const orderId of input.orderIds) {
        const existingItem = sandbox.manifestItems.find(
          item => item.order_id === orderId && activeManifestIds.has(item.manifest_id)
        );
        if (existingItem) {
          const activeManifest = sandbox.manifests.find(m => m.id === existingItem.manifest_id);
          throw new RepositoryError(
            'CONFLICT',
            `Order ${orderId} sudah terdaftar dalam manifest aktif ${activeManifest?.manifest_number || activeManifest?.id} (${activeManifest?.status}).`
          );
        }

        const order = sandbox.orders.find(o => o.id === orderId);
        if (!order) {
          throw new RepositoryError('VALIDATION_ERROR', `Order ${orderId} tidak ditemukan.`);
        }
        if (order.organization_id && order.organization_id !== orgId) {
          throw new RepositoryError(
            'FORBIDDEN',
            `Cross-tenant violation: Order ${order.order_number || order.id} belongs to a different organization.`
          );
        }
        const hasApprovedRework = sandbox.orderReworkRequests.some(
          r => r.order_id === orderId && r.status === 'APPROVED'
        );
        const history: HistoricalTransitItem[] = sandbox.getHistoricalTransitItems();

        try {
          assertOrderEligibleForManifest(
            {
              organization_id: orgId,
              source_branch_id: input.sourceBranchId,
              destination_branch_id: input.destinationBranchId,
              status: 'DRAFT',
            },
            order,
            history,
            hasApprovedRework
          );
        } catch (err: any) {
          if (err.message && err.message.includes('Cross-tenant')) {
            throw new RepositoryError('FORBIDDEN', err.message);
          }
          throw new RepositoryError('VALIDATION_ERROR', err.message);
        }
      }
    }

    const branches = DEMO_BRANCHES;
    const src = branches.find(b => b.id === input.sourceBranchId)?.code || 'SRC';
    const dst = branches.find(b => b.id === input.destinationBranchId)?.code || 'DST';
    const manifestNumber = generateManifestNumber(src, dst);
    const now = sandbox.now();
    const manifestId = 'man-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const orderCount = input.orderIds ? input.orderIds.length : 0;

    const newManifest: TransitManifest = {
      id: manifestId,
      organization_id: orgId,
      manifest_number: manifestNumber,
      source_branch_id: input.sourceBranchId,
      destination_branch_id: input.destinationBranchId,
      status: 'DRAFT',
      driver_user_id: input.driverUserId,
      vehicle_identifier: input.vehicleIdentifier,
      notes: input.notes,
      total_expected_orders: orderCount,
      total_received_orders: 0,
      has_discrepancy: false,
      created_by: input.driverUserId || DEMO_USERS[1].id,
      created_at: now,
      updated_at: now,
    };

    sandbox.manifests.unshift(newManifest);

    if (input.orderIds && input.orderIds.length > 0) {
      for (const orderId of input.orderIds) {
        sandbox.manifestItems.push({
          id: 'mitem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          manifest_id: manifestId,
          organization_id: orgId,
          order_id: orderId,
          received_status: 'EXPECTED',
          added_at: now,
        });

        // Atomic Rework Token Consumption for Cycle 2+ Outbound
        const order = sandbox.orders.find(o => o.id === orderId);
        if (order) {
          const direction = determineTransitRouteDirection({
            order,
            sourceBranchId: input.sourceBranchId,
            destinationBranchId: input.destinationBranchId,
          });
          if (direction === 'OUTBOUND') {
            const effectiveProd = order.production_branch_id || input.destinationBranchId;
            const history = sandbox.getHistoricalTransitItems();
            const latestOutbound = getLatestCompletedOutbound(order.id, history, order.branch_id, effectiveProd);
            if (latestOutbound) {
              const rework = sandbox.orderReworkRequests.find(
                r => r.order_id === order.id && r.status === 'APPROVED'
              );
              if (rework) {
                rework.status = 'CONSUMED';
                rework.consumed_manifest_id = manifestId;
                rework.consumed_at = now;
              }
            }
          }
        }
      }
    }

    sandbox.manifestHistory.unshift({
      id: 'mhist-' + Date.now(),
      manifest_id: manifestId,
      organization_id: orgId,
      from_status: undefined,
      to_status: 'DRAFT',
      actor_id: newManifest.created_by,
      notes: 'Manifest draft dibuat oleh operator',
      created_at: now,
    });

    sandbox.save();
    const created = await this.getTransitManifest(manifestId);
    return created!;
  },

  async getTransitManifest(id: string): Promise<TransitManifest | null> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('transit_manifests')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw normalizeRepositoryError(error);
      if (!data) return null;

      const manifest = data as TransitManifest;
      const { data: itemsData, error: itemsErr } = await supabase
        .from('transit_manifest_items')
        .select('*, order:orders(*, customer:customers(*))')
        .eq('manifest_id', id);
      if (itemsErr) throw normalizeRepositoryError(itemsErr);
      manifest.items = (itemsData || []) as TransitManifestItem[];

      const branches = await this.getBranches();
      const users = await this.getUsers();
      manifest.source_branch = branches.find(b => b.id === manifest.source_branch_id);
      manifest.destination_branch = branches.find(b => b.id === manifest.destination_branch_id);
      if (manifest.driver_user_id) {
        manifest.driver = users.find(u => u.id === manifest.driver_user_id);
      }
      return manifest;
    }

    const manifest = sandbox.manifests.find(m => m.id === id);
    if (!manifest) return null;

    const rawItems = sandbox.manifestItems.filter(i => i.manifest_id === id);
    const populatedItems: TransitManifestItem[] = rawItems.map(item => {
      const order = sandbox.orders.find(o => o.id === item.order_id);
      return {
        ...item,
        order: order
          ? {
              ...order,
              customer: sandbox.customers.find(c => c.id === order.customer_id),
              branch: DEMO_BRANCHES.find(b => b.id === order.branch_id),
            }
          : undefined,
      };
    });

    const branches = DEMO_BRANCHES;
    const users = DEMO_USERS;
    return {
      ...manifest,
      source_branch: branches.find(b => b.id === manifest.source_branch_id),
      destination_branch: branches.find(b => b.id === manifest.destination_branch_id),
      driver: manifest.driver_user_id ? users.find(u => u.id === manifest.driver_user_id) : undefined,
      items: populatedItems,
    };
  },

  async listTransitManifests(filters?: TransitManifestFilters): Promise<TransitManifest[]> {
    if (isLiveSupabaseConfigured && supabase) {
      let query = supabase
        .from('transit_manifests')
        .select('*')
        .order('created_at', { ascending: false });

      if (filters?.organizationId) query = query.eq('organization_id', filters.organizationId);
      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.sourceBranchId) query = query.eq('source_branch_id', filters.sourceBranchId);
      if (filters?.destinationBranchId) query = query.eq('destination_branch_id', filters.destinationBranchId);
      if (filters?.branchId) {
        query = query.or(`source_branch_id.eq.${filters.branchId},destination_branch_id.eq.${filters.branchId}`);
      }
      if (filters?.driverUserId) query = query.eq('driver_user_id', filters.driverUserId);
      if (filters?.search) {
        query = query.or(`manifest_number.ilike.%${filters.search}%,vehicle_identifier.ilike.%${filters.search}%`);
      }

      const { data, error } = await query;
      if (error) throw normalizeRepositoryError(error);

      const branches = await this.getBranches();
      const users = await this.getUsers();

      return (data || []).map(m => ({
        ...(m as TransitManifest),
        source_branch: branches.find(b => b.id === m.source_branch_id),
        destination_branch: branches.find(b => b.id === m.destination_branch_id),
        driver: m.driver_user_id ? users.find(u => u.id === m.driver_user_id) : undefined,
      }));
    }

    let list = [...sandbox.manifests];

    if (filters?.organizationId) {
      list = list.filter(m => m.organization_id === filters.organizationId);
    }
    if (filters?.status) {
      list = list.filter(m => m.status === filters.status);
    }
    if (filters?.sourceBranchId) {
      list = list.filter(m => m.source_branch_id === filters.sourceBranchId);
    }
    if (filters?.destinationBranchId) {
      list = list.filter(m => m.destination_branch_id === filters.destinationBranchId);
    }
    if (filters?.branchId) {
      list = list.filter(
        m => m.source_branch_id === filters.branchId || m.destination_branch_id === filters.branchId
      );
    }
    if (filters?.driverUserId) {
      list = list.filter(m => m.driver_user_id === filters.driverUserId);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase().trim();
      list = list.filter(
        m =>
          m.manifest_number.toLowerCase().includes(q) ||
          (m.vehicle_identifier && m.vehicle_identifier.toLowerCase().includes(q)) ||
          (m.notes && m.notes.toLowerCase().includes(q))
      );
    }

    const branches = DEMO_BRANCHES;
    const users = DEMO_USERS;

    return list
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(m => ({
        ...m,
        source_branch: branches.find(b => b.id === m.source_branch_id),
        destination_branch: branches.find(b => b.id === m.destination_branch_id),
        driver: m.driver_user_id ? users.find(u => u.id === m.driver_user_id) : undefined,
      }));
  },

  async transitionTransitManifest(
    id: string,
    targetStatus: TransitManifestStatus,
    notes?: string,
    actorId?: string
  ): Promise<TransitManifest> {
    if (targetStatus === 'RECEIVED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        'Gunakan receiveTransitManifest() untuk menerima manifest beserta inspeksi item.'
      );
    }

    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('transition_manifest_status', {
        p_manifest_id: id,
        p_target_status: targetStatus,
        p_notes: notes || null,
      });
      if (error) throw normalizeRepositoryError(error);

      const updated = await this.getTransitManifest(id);
      if (!updated) throw new RepositoryError('NOT_FOUND', 'Manifest tidak ditemukan setelah transisi.');
      return updated;
    }

    const manifest = sandbox.manifests.find(m => m.id === id);
    if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${id} tidak ditemukan.`);

    try {
      assertManifestTransition(manifest.status, targetStatus);
    } catch (err: any) {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        err.message || `Transisi dari ${manifest.status} ke ${targetStatus} tidak diizinkan.`,
        err
      );
    }

    if (targetStatus === 'READY_TO_DISPATCH' && manifest.total_expected_orders === 0) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        'Cannot mark manifest READY_TO_DISPATCH without any attached orders.'
      );
    }

    const fromStatus = manifest.status;
    const now = sandbox.now();
    manifest.status = targetStatus;
    manifest.updated_at = now;
    if (notes) manifest.notes = notes;

    if (targetStatus === 'IN_TRANSIT') {
      manifest.dispatched_at = now;
      manifest.dispatched_by = actorId || manifest.driver_user_id || DEMO_USERS[1].id;
    } else if (targetStatus === 'CANCELLED') {
      manifest.cancelled_at = now;
      manifest.cancelled_by = actorId || DEMO_USERS[1].id;
    }

    sandbox.manifestHistory.unshift({
      id: 'mhist-' + Date.now(),
      manifest_id: id,
      organization_id: manifest.organization_id,
      from_status: fromStatus,
      to_status: targetStatus,
      actor_id: actorId || DEMO_USERS[1].id,
      notes: notes || `Transisi status ke ${targetStatus}`,
      created_at: now,
    });

    sandbox.save();
    const updated = await this.getTransitManifest(id);
    return updated!;
  },

  async receiveTransitManifest(
    input: ReceiveTransitManifestInput,
    actorId?: string
  ): Promise<TransitManifest> {
    if (isLiveSupabaseConfigured && supabase) {
      const itemsReviewPayload = input.itemsReview.map(r => ({
        order_id: r.orderId,
        status: r.status,
        notes: r.notes || null,
      }));

      const { error } = await supabase.rpc('receive_manifest_with_discrepancy', {
        p_manifest_id: input.manifestId,
        p_items_review: itemsReviewPayload,
        p_summary_notes: input.summaryNotes || null,
      });
      if (error) throw normalizeRepositoryError(error);

      const updated = await this.getTransitManifest(input.manifestId);
      if (!updated) throw new RepositoryError('NOT_FOUND', 'Manifest tidak ditemukan setelah penerimaan.');
      return updated;
    }

    const manifest = sandbox.manifests.find(m => m.id === input.manifestId);
    if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${input.manifestId} tidak ditemukan.`);

    if (manifest.status !== 'IN_TRANSIT') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Cannot receive manifest ${input.manifestId} with status ${manifest.status}. Manifest must be IN_TRANSIT.`
      );
    }

    const now = sandbox.now();
    const inspectedActorId = actorId || DEMO_USERS[2].id;
    let receivedCount = 0;
    let hasDiscrepancy = false;

    // Process explicit item inspections
    for (const review of input.itemsReview) {
      const item = sandbox.manifestItems.find(
        i => i.manifest_id === input.manifestId && i.order_id === review.orderId
      );
      if (item) {
        item.received_status = review.status;
        item.discrepancy_notes = review.notes;
        item.received_at = now;
        item.inspected_by = inspectedActorId;

        if (review.status === 'RECEIVED_OK') {
          receivedCount++;
        } else {
          hasDiscrepancy = true;
        }
      }
    }

    // Critical: Omitted items still EXPECTED automatically become MISSING (matches PostgreSQL RPC behavior)
    const omittedItems = sandbox.manifestItems.filter(
      i => i.manifest_id === input.manifestId && i.received_status === 'EXPECTED'
    );
    for (const item of omittedItems) {
      item.received_status = 'MISSING';
      item.discrepancy_notes = 'Tidak ditemukan dalam inspeksi kedatangan';
      item.received_at = now;
      item.inspected_by = inspectedActorId;
      hasDiscrepancy = true;
    }

    const summaryMsg =
      input.summaryNotes ||
      (hasDiscrepancy ? 'Diterima dengan selisih/discrepancy item' : 'Diterima lengkap & sesuai');

    manifest.status = 'RECEIVED';
    manifest.received_by = inspectedActorId;
    manifest.received_at = now;
    manifest.total_received_orders = receivedCount;
    manifest.has_discrepancy = hasDiscrepancy;
    manifest.discrepancy_summary = summaryMsg;
    manifest.updated_at = now;

    sandbox.manifestHistory.unshift({
      id: 'mhist-' + Date.now(),
      manifest_id: input.manifestId,
      organization_id: manifest.organization_id,
      from_status: 'IN_TRANSIT',
      to_status: 'RECEIVED',
      actor_id: inspectedActorId,
      notes: summaryMsg,
      created_at: now,
    });

    sandbox.save();
    const updated = await this.getTransitManifest(input.manifestId);
    return updated!;
  },

  async getTransitManifestItems(manifestId: string): Promise<TransitManifestItem[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('transit_manifest_items')
        .select('*, order:orders(*, customer:customers(*))')
        .eq('manifest_id', manifestId);
      if (error) throw normalizeRepositoryError(error);
      return (data || []) as TransitManifestItem[];
    }

    const items = sandbox.manifestItems.filter(i => i.manifest_id === manifestId);
    return items.map(item => {
      const order = sandbox.orders.find(o => o.id === item.order_id);
      return {
        ...item,
        order: order
          ? {
              ...order,
              customer: sandbox.customers.find(c => c.id === order.customer_id),
              branch: DEMO_BRANCHES.find(b => b.id === order.branch_id),
            }
          : undefined,
      };
    });
  },

  async getTransitManifestHistory(manifestId: string): Promise<TransitManifestHistory[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('transit_manifest_history')
        .select('*')
        .eq('manifest_id', manifestId)
        .order('created_at', { ascending: false });
      if (error) throw normalizeRepositoryError(error);
      const users = await this.getUsers();
      return (data || []).map(h => ({
        ...(h as TransitManifestHistory),
        actor: users.find(u => u.id === h.actor_id),
      }));
    }

    const users = DEMO_USERS;
    return sandbox.manifestHistory
      .filter(h => h.manifest_id === manifestId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(h => ({
        ...h,
        actor: users.find(u => u.id === h.actor_id),
      }));
  },

  async getEligibleOrdersForTransit(
    sourceBranchId: string,
    destinationBranchId?: string
  ): Promise<Order[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data: activeItems, error: activeErr } = await supabase
        .from('transit_manifest_items')
        .select('order_id, manifest:transit_manifests!inner(status)')
        .in('manifest.status', ['DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT']);
      if (activeErr) throw normalizeRepositoryError(activeErr);

      const activeOrderIds = new Set((activeItems || []).map((i: any) => i.order_id));

      // Fetch non-terminal candidate orders (either branch_id = sourceBranchId OR production_branch_id = sourceBranchId)
      let query = supabase
        .from('orders')
        .select('*, customer:customers(*), items:order_items(*)')
        .not('status', 'in', '("COMPLETED","CANCELLED")');

      if (destinationBranchId) {
        query = query.or(
          `and(branch_id.eq.${sourceBranchId},production_branch_id.eq.${destinationBranchId}),and(production_branch_id.eq.${sourceBranchId},branch_id.eq.${destinationBranchId})`
        );
      } else {
        query = query.or(
          `branch_id.eq.${sourceBranchId},production_branch_id.eq.${sourceBranchId}`
        );
      }

      const { data: orders, error: ordersErr } = await query;
      if (ordersErr) throw normalizeRepositoryError(ordersErr);

      // Fetch history items to evaluate re-eligibility and prior outbound receipt
      const { data: rawHistory, error: histErr } = await supabase
        .from('transit_manifest_items')
        .select('order_id, received_status, received_at, manifest:transit_manifests!inner(source_branch_id, destination_branch_id, status, received_at)');
      if (histErr) throw normalizeRepositoryError(histErr);

      const history: HistoricalTransitItem[] = (rawHistory || []).map((h: any) => ({
        order_id: h.order_id,
        received_status: h.received_status,
        received_at: h.received_at,
        manifest: {
          source_branch_id: h.manifest.source_branch_id,
          destination_branch_id: h.manifest.destination_branch_id,
          status: h.manifest.status,
          received_at: h.manifest.received_at,
        },
      }));

      return ((orders || []) as Order[]).filter((order) => {
        if (activeOrderIds.has(order.id)) return false;

        // Outbound candidate (Origin Outlet -> Workshop)
        if (order.branch_id === sourceBranchId) {
          const dest = destinationBranchId || order.production_branch_id;
          return isOutboundTransitEligible(order, sourceBranchId, dest, history);
        }

        // Return candidate (Workshop -> Origin Outlet)
        if (order.production_branch_id === sourceBranchId) {
          const dest = destinationBranchId || order.branch_id;
          return isReturnTransitEligible(order, sourceBranchId, dest, history);
        }

        return false;
      });
    }

    const activeStatuses: TransitManifestStatus[] = ['DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT'];
    const activeManifestIds = new Set(
      sandbox.manifests.filter(m => activeStatuses.includes(m.status)).map(m => m.id)
    );
    const activeOrderIds = new Set(
      sandbox.manifestItems.filter(i => activeManifestIds.has(i.manifest_id)).map(i => i.order_id)
    );

    const history: HistoricalTransitItem[] = sandbox.manifestItems.map(item => {
      const m = sandbox.manifests.find(man => man.id === item.manifest_id);
      return {
        order_id: item.order_id,
        received_status: item.received_status,
        received_at: item.received_at,
        manifest: {
          source_branch_id: m?.source_branch_id || '',
          destination_branch_id: m?.destination_branch_id || '',
          status: m?.status || 'DRAFT',
          received_at: m?.received_at,
        },
      };
    });

    return sandbox.orders.filter(order => {
      if (activeOrderIds.has(order.id)) return false;
      if (order.status === 'COMPLETED' || order.status === 'CANCELLED') return false;

      // Outbound candidate (Origin Outlet -> Workshop)
      if (order.branch_id === sourceBranchId) {
        const dest = destinationBranchId || order.production_branch_id;
        return isOutboundTransitEligible(order, sourceBranchId, dest, history);
      }

      // Return candidate (Workshop -> Origin Outlet)
      if (order.production_branch_id === sourceBranchId) {
        const dest = destinationBranchId || order.branch_id;
        return isReturnTransitEligible(order, sourceBranchId, dest, history);
      }

      return false;
    });
  },

  async updateTransitManifest(
    id: string,
    updates: Partial<Pick<TransitManifest, 'driver_user_id' | 'vehicle_identifier' | 'notes' | 'source_branch_id' | 'destination_branch_id'>>
  ): Promise<TransitManifest> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('transit_manifests')
        .update(updates)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw normalizeRepositoryError(error);
      return data as TransitManifest;
    }

    const manifest = sandbox.manifests.find(m => m.id === id);
    if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${id} tidak ditemukan.`);

    if (manifest.status === 'RECEIVED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal operation: Manifest ${id} is already RECEIVED and is strictly immutable.`
      );
    }
    if (manifest.status === 'CANCELLED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal operation: Manifest ${id} is CANCELLED and is strictly immutable.`
      );
    }

    if (manifest.status === 'IN_TRANSIT') {
      if (
        (updates.source_branch_id && updates.source_branch_id !== manifest.source_branch_id) ||
        (updates.destination_branch_id && updates.destination_branch_id !== manifest.destination_branch_id)
      ) {
        throw new RepositoryError(
          'INVALID_STATE_TRANSITION',
          `Cannot alter source or destination branch of manifest ${id} while IN_TRANSIT.`
        );
      }
    }

    const itemsCount = sandbox.manifestItems.filter(i => i.manifest_id === id).length;
    if (updates.source_branch_id && updates.source_branch_id !== manifest.source_branch_id) {
      if (itemsCount > 0) {
        throw new RepositoryError(
          'INVALID_STATE_TRANSITION',
          `Cannot modify source_branch_id of manifest ${id} while items are attached. Remove all items before changing source branch.`
        );
      }
    }

    Object.assign(manifest, updates, { updated_at: new Date().toISOString() });
    sandbox.save();
    return (await this.getTransitManifest(id))!;
  },

  async updateTransitManifestItem(
    manifestId: string,
    orderId: string,
    updates: { received_status?: TransitManifestItemStatus; discrepancy_notes?: string }
  ): Promise<TransitManifestItem> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('transit_manifest_items')
        .update(updates)
        .eq('manifest_id', manifestId)
        .eq('order_id', orderId)
        .select('*')
        .single();
      if (error) throw normalizeRepositoryError(error);
      return data as TransitManifestItem;
    }

    const manifest = sandbox.manifests.find(m => m.id === manifestId);
    if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${manifestId} tidak ditemukan.`);

    if (manifest.status === 'RECEIVED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal operation: Parent manifest ${manifestId} is already RECEIVED. Manifest items are strictly immutable.`
      );
    }
    if (manifest.status === 'CANCELLED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal operation: Parent manifest ${manifestId} is CANCELLED. Manifest items cannot be modified.`
      );
    }

    const item = sandbox.manifestItems.find(i => i.manifest_id === manifestId && i.order_id === orderId);
    if (!item) throw new RepositoryError('NOT_FOUND', `Item dengan order ${orderId} pada manifest ${manifestId} tidak ditemukan.`);

    if (updates.received_status) item.received_status = updates.received_status;
    if (updates.discrepancy_notes !== undefined) item.discrepancy_notes = updates.discrepancy_notes;
    sandbox.save();
    return item;
  },

  async addTransitManifestItem(manifestId: string, orderId: string): Promise<TransitManifestItem> {
    if (isLiveSupabaseConfigured && supabase) {
      const manifest = await this.getTransitManifest(manifestId);
      if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${manifestId} tidak ditemukan.`);

      const { data, error } = await supabase
        .from('transit_manifest_items')
        .insert({
          manifest_id: manifestId,
          organization_id: manifest.organization_id,
          order_id: orderId,
          received_status: 'EXPECTED',
        })
        .select('*')
        .single();
      if (error) throw normalizeRepositoryError(error);
      return data as TransitManifestItem;
    }

    const manifest = sandbox.manifests.find(m => m.id === manifestId);
    if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${manifestId} tidak ditemukan.`);

    if (manifest.status !== 'DRAFT' && manifest.status !== 'READY_TO_DISPATCH') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Cannot attach order to manifest ${manifestId} with status ${manifest.status}. Orders can only be attached to DRAFT or READY_TO_DISPATCH manifests.`
      );
    }

    const order = sandbox.orders.find(o => o.id === orderId);
    if (!order) throw new RepositoryError('VALIDATION_ERROR', `Order ${orderId} tidak ditemukan.`);

    const history: HistoricalTransitItem[] = sandbox.getHistoricalTransitItems();
    const hasApprovedRework = sandbox.orderReworkRequests.some(
      r => r.order_id === orderId && r.status === 'APPROVED'
    );

    try {
      assertOrderEligibleForManifest(manifest, order, history, hasApprovedRework);
    } catch (err: any) {
      if (err.message && err.message.includes('Cross-tenant')) {
        throw new RepositoryError('FORBIDDEN', err.message);
      }
      throw new RepositoryError('VALIDATION_ERROR', err.message);
    }

    // Atomic Rework Token Consumption for Cycle 2+ Outbound
    if (manifest.destination_branch_id) {
      const direction = determineTransitRouteDirection({
        order,
        sourceBranchId: manifest.source_branch_id,
        destinationBranchId: manifest.destination_branch_id,
      });
      if (direction === 'OUTBOUND') {
        const effectiveProd = order.production_branch_id || manifest.destination_branch_id;
        const latestOutbound = getLatestCompletedOutbound(order.id, history, order.branch_id, effectiveProd);
        if (latestOutbound) {
          const rework = sandbox.orderReworkRequests.find(
            r => r.order_id === order.id && r.status === 'APPROVED'
          );
          if (rework) {
            const itemNow = sandbox.now();
            rework.status = 'CONSUMED';
            rework.consumed_manifest_id = manifestId;
            rework.consumed_at = itemNow;
          }
        }
      }
    }

    const itemNow = sandbox.now();
    const newItem: TransitManifestItem = {
      id: 'mitem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      manifest_id: manifestId,
      organization_id: manifest.organization_id,
      order_id: orderId,
      received_status: 'EXPECTED',
      added_at: itemNow,
    };
    sandbox.manifestItems.push(newItem);
    manifest.total_expected_orders = (manifest.total_expected_orders || 0) + 1;
    sandbox.save();
    return newItem;
  },

  async removeTransitManifestItem(manifestId: string, orderId: string): Promise<void> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase
        .from('transit_manifest_items')
        .delete()
        .eq('manifest_id', manifestId)
        .eq('order_id', orderId);
      if (error) throw normalizeRepositoryError(error);
      return;
    }

    const manifest = sandbox.manifests.find(m => m.id === manifestId);
    if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${manifestId} tidak ditemukan.`);

    if (manifest.status !== 'DRAFT') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Cannot delete item from manifest ${manifestId} with status ${manifest.status}. Items can only be removed while in DRAFT.`
      );
    }

    const idx = sandbox.manifestItems.findIndex(i => i.manifest_id === manifestId && i.order_id === orderId);
    if (idx !== -1) {
      sandbox.manifestItems.splice(idx, 1);
      manifest.total_expected_orders = Math.max(0, (manifest.total_expected_orders || 1) - 1);
      sandbox.save();
    }
  },

  async deleteTransitManifest(id: string): Promise<void> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase
        .from('transit_manifests')
        .delete()
        .eq('id', id);
      if (error) throw normalizeRepositoryError(error);
      return;
    }

    const manifest = sandbox.manifests.find(m => m.id === id);
    if (!manifest) throw new RepositoryError('NOT_FOUND', `Manifest ${id} tidak ditemukan.`);

    if (manifest.status === 'RECEIVED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal operation: Manifest ${id} is already RECEIVED and cannot be deleted.`
      );
    }
    if (manifest.status === 'CANCELLED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal operation: Manifest ${id} is CANCELLED and cannot be deleted.`
      );
    }
    if (manifest.status === 'IN_TRANSIT' || manifest.status === 'READY_TO_DISPATCH') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal operation: Manifest ${id} is in active status ${manifest.status} and cannot be deleted.`
      );
    }

    throw new RepositoryError(
      'INVALID_STATE_TRANSITION',
      `Illegal operation: Manifest ${id} is in DRAFT status and cannot be deleted. Cancel manifest to preserve audit trail.`
    );
  },

  // --- Order Rework Requests (Phase 4B Multi-Cycle Rework Gate) ---

  async createOrderReworkRequest(
    dto: CreateOrderReworkRequestDTO,
    actorId?: string
  ): Promise<OrderReworkRequest> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase.rpc('create_order_rework_request', {
        p_order_id: dto.order_id,
        p_reason: dto.reason,
        p_notes: dto.notes || null,
      });
      if (error) throw normalizeRepositoryError(error);

      const { data: reqData, error: reqErr } = await supabase
        .from('order_rework_requests')
        .select('*, order:orders(*), requested_by_user:users(*)')
        .eq('id', data.rework_request_id)
        .single();
      if (reqErr) throw normalizeRepositoryError(reqErr);
      return reqData as OrderReworkRequest;
    }

    const effectiveActorId = actorId || DEMO_USERS[1].id;
    const actor = DEMO_USERS.find(u => u.id === effectiveActorId) || DEMO_USERS[1];

    // RBAC: Allowed: OWNER, ADMIN, MANAGER, BRANCH_MANAGER, CASHIER. Forbid: OPERATOR, DRIVER, VIEWER.
    const allowedRoles: string[] = ['OWNER', 'ADMIN', 'MANAGER', 'BRANCH_MANAGER', 'CASHIER'];
    if (!allowedRoles.includes(actor.role)) {
      throw new RepositoryError(
        'FORBIDDEN',
        `Access denied: User role '${actor.role}' is not authorized to request rework.`
      );
    }

    const order = sandbox.orders.find(o => o.id === dto.order_id);
    if (!order) {
      throw new RepositoryError('NOT_FOUND', `Order ${dto.order_id} tidak ditemukan.`);
    }

    if (actor.organization_id && order.organization_id !== actor.organization_id) {
      throw new RepositoryError(
        'FORBIDDEN',
        'Cross-tenant violation: Order belongs to another organization.'
      );
    }

    // Branch access check: Actor must have access to origin outlet
    if (
      actor.role !== 'OWNER' &&
      actor.role !== 'ADMIN' &&
      actor.default_branch_id &&
      actor.default_branch_id !== order.branch_id
    ) {
      throw new RepositoryError(
        'FORBIDDEN',
        'Access denied: User does not have branch access to order origin branch.'
      );
    }

    // Order Lifecycle: Non-terminal
    if (order.status === 'CANCELLED' || order.status === 'COMPLETED') {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        `Order dengan status '${order.status}' tidak dapat diajukan rework.`
      );
    }

    // Active Manifest check
    const activeManifestIds = new Set(
      sandbox.manifests
        .filter(m => ['DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT'].includes(m.status))
        .map(m => m.id)
    );
    const inActiveManifest = sandbox.manifestItems.some(
      item => item.order_id === order.id && activeManifestIds.has(item.manifest_id)
    );
    if (inActiveManifest) {
      throw new RepositoryError(
        'CONFLICT',
        `Order ${order.order_number || order.id} sedang berada dalam manifest aktif dan tidak dapat diajukan rework.`
      );
    }

    // Physical Custody Check: Order must be physically at origin outlet
    const history = sandbox.getHistoricalTransitItems();
    const effectiveProd = order.production_branch_id || '';
    const latestOutbound = getLatestCompletedOutbound(order.id, history, order.branch_id, effectiveProd);
    if (latestOutbound) {
      const latestReturn = getLatestCompletedReturn(order.id, history, order.branch_id, effectiveProd);
      const outTime = latestOutbound.manifest.received_at || latestOutbound.received_at || '';
      const retTime = latestReturn ? (latestReturn.manifest.received_at || latestReturn.received_at || '') : '';
      if (!latestReturn || retTime < outTime) {
        throw new RepositoryError(
          'VALIDATION_ERROR',
          `Physical custody violation: Order ${order.order_number || order.id} is not physically at origin outlet (awaiting return receipt).`
        );
      }
    }

    // Invariant: Max one APPROVED rework request per order
    const hasActiveApproved = sandbox.orderReworkRequests.some(
      r => r.order_id === order.id && r.status === 'APPROVED'
    );
    if (hasActiveApproved) {
      throw new RepositoryError(
        'CONFLICT',
        `Order ${order.order_number || order.id} already has an active approved rework request.`
      );
    }

    const newRequest: OrderReworkRequest = {
      id: 'rew-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      organization_id: order.organization_id,
      order_id: order.id,
      requested_by: effectiveActorId,
      reason: dto.reason,
      notes: dto.notes || null,
      status: 'APPROVED',
      created_at: sandbox.now(),
      order,
      requested_by_user: actor,
    };

    sandbox.orderReworkRequests.unshift(newRequest);
    sandbox.save();
    return newRequest;
  },

  async getOrderReworkRequests(orderId: string): Promise<OrderReworkRequest[]> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('order_rework_requests')
        .select('*, requested_by_user:users(*)')
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });
      if (error) throw normalizeRepositoryError(error);
      return data as OrderReworkRequest[];
    }

    return sandbox.orderReworkRequests.filter(r => r.order_id === orderId);
  },

  async getActiveOrderReworkRequest(orderId: string): Promise<OrderReworkRequest | null> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('order_rework_requests')
        .select('*, requested_by_user:users(*)')
        .eq('order_id', orderId)
        .eq('status', 'APPROVED')
        .maybeSingle();
      if (error) throw normalizeRepositoryError(error);
      return data as OrderReworkRequest | null;
    }

    return sandbox.orderReworkRequests.find(r => r.order_id === orderId && r.status === 'APPROVED') || null;
  },

  async cancelOrderReworkRequest(
    requestId: string,
    notes?: string,
    actorId?: string
  ): Promise<OrderReworkRequest> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('cancel_order_rework_request', {
        p_request_id: requestId,
        p_notes: notes || null,
      });
      if (error) throw normalizeRepositoryError(error);

      const { data, error: fetchErr } = await supabase
        .from('order_rework_requests')
        .select('*')
        .eq('id', requestId)
        .single();
      if (fetchErr) throw normalizeRepositoryError(fetchErr);
      return data as OrderReworkRequest;
    }

    const req = sandbox.orderReworkRequests.find(r => r.id === requestId);
    if (!req) {
      throw new RepositoryError('NOT_FOUND', `Rework request ${requestId} tidak ditemukan.`);
    }

    if (req.status !== 'APPROVED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Illegal state: Only APPROVED rework requests can be cancelled (current: ${req.status}).`
      );
    }

    req.status = 'CANCELLED';
    req.cancelled_at = sandbox.now();
    req.cancelled_by = actorId || DEMO_USERS[1].id;
    if (notes) {
      req.notes = (req.notes || '') + (req.notes ? ' | ' : '') + 'Batal: ' + notes;
    }

    sandbox.save();
    return req;
  },

  async getWorkshopOrders(workshopBranchId: string): Promise<{
    washQueue: Order[];
    damagedQueue: Order[];
  }> {
    const allOrders = await this.getOrders();
    const history = isLiveSupabaseConfigured
      ? []
      : sandbox.getHistoricalTransitItems();

    const washQueue: Order[] = [];
    const damagedQueue: Order[] = [];

    for (const order of allOrders) {
      if (order.production_branch_id !== workshopBranchId) continue;

      if (order.branch_id === workshopBranchId) {
        washQueue.push(order);
      } else {
        const custodyState = deriveOrderCustodyState(order, history);
        if (custodyState === 'AT_WORKSHOP') {
          washQueue.push(order);
        } else if (custodyState === 'AT_WORKSHOP_DAMAGED') {
          damagedQueue.push(order);
        }
      }
    }

    return { washQueue, damagedQueue };
  },

  resetSandbox() {
    sandbox.reset();
  },
};
