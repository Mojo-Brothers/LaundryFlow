// ============================================================================
// Core Domain Types (PostgreSQL / Supabase Schema Mappings)
// ============================================================================

export type UserRole = 
  | 'OWNER' 
  | 'ADMIN' 
  | 'MANAGER' 
  | 'BRANCH_MANAGER' 
  | 'CASHIER' 
  | 'OPERATOR' 
  | 'DRIVER' 
  | 'VIEWER';

export type BranchType = 'OUTLET' | 'CENTRAL_PRODUCTION' | 'HYBRID';

export type ServiceUnit = 'KG' | 'PCS' | 'SET' | 'METER' | 'OTHER';

export type RoundingRule = 'EXACT' | 'ROUND_HALF_UP_0_5' | 'CEIL_1_0' | 'FLOOR';

export type OrderStatus = 
  | 'DRAFT'
  | 'RECEIVED' 
  | 'SORTING' 
  | 'WASHING' 
  | 'DRYING' 
  | 'IRONING' 
  | 'PACKING' 
  | 'QC' 
  | 'READY' 
  | 'PICKED_UP' 
  | 'DELIVERED' 
  | 'COMPLETED' 
  | 'CANCELLED';

export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED';

export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'QRIS_MANUAL' | 'EDC' | 'OTHER';

export type ShiftStatus = 'OPEN' | 'CLOSED' | 'RECONCILED';

export type OperatingMode = 'SIMPLE' | 'STANDARD' | 'ADVANCED';

export type TransitManifestStatus = 
  | 'DRAFT' 
  | 'READY_TO_DISPATCH' 
  | 'IN_TRANSIT' 
  | 'RECEIVED' 
  | 'CANCELLED';

export type TransitManifestItemStatus = 
  | 'EXPECTED' 
  | 'RECEIVED_OK' 
  | 'MISSING' 
  | 'DAMAGED' 
  | 'WRONG_BRANCH';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  subscription_tier: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Branch {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  branch_type: BranchType;
  address?: string;
  phone?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  role: UserRole;
  default_branch_id?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: string;
  organization_id: string;
  name: string;
  phone: string;
  whatsapp?: string;
  address?: string;
  notes?: string;
  membership_tier: string;
  created_at: string;
  updated_at: string;
}

export interface Service {
  id: string;
  organization_id: string;
  name: string;
  category: string;
  unit: ServiceUnit;
  base_price: number;
  min_charge_unit: number;
  rounding_rule: RoundingRule;
  estimated_duration_hours: number;
  is_active: boolean;
  standard_stages?: ProductionStage[];
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  service_id: string;
  item_type: 'KILOAN' | 'SATUAN';
  service_name_snap: string;
  unit_price_snap: number;
  quantity_or_weight: number;
  billable_weight: number;
  subtotal: number;
  notes?: string;
  created_at: string;
}

export interface Order {
  id: string;
  organization_id: string;
  branch_id: string;
  production_branch_id: string;
  customer_id: string;
  order_number: string;
  tracking_token: string;
  status: OrderStatus;
  operating_mode: OperatingMode;
  subtotal: number;
  discount_amount: number;
  delivery_fee: number;
  final_amount: number;
  paid_amount: number;
  remaining_amount: number;
  payment_status: PaymentStatus;
  notes?: string;
  promised_ready_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;

  // Joined relations (optional in views)
  customer?: Customer;
  branch?: Branch;
  production_branch?: Branch;
  items?: OrderItem[];
  payments?: Payment[];
}

export interface PublicTrackingData {
  order_number: string;
  status: OrderStatus;
  operating_mode: OperatingMode;
  subtotal: number;
  discount_amount: number;
  delivery_fee: number;
  final_amount: number;
  paid_amount: number;
  remaining_amount: number;
  payment_status: PaymentStatus;
  promised_ready_at: string;
  created_at: string;
  branch_name: string;
  branch_address?: string;
  branch_phone?: string;
  items: Array<{
    service_name: string;
    quantity_or_weight: number;
    billable_weight: number;
    item_type: string;
    subtotal: number;
  }>;
}

export interface Payment {
  id: string;
  organization_id: string;
  branch_id: string;
  order_id: string;
  cashier_shift_id?: string;
  payment_method: PaymentMethod;
  amount: number;
  reference_number?: string;
  status: string;
  received_by: string;
  created_at: string;
}

export interface CashierShift {
  id: string;
  organization_id: string;
  branch_id: string;
  cashier_id: string;
  opening_cash: number;
  expected_cash: number;
  actual_cash?: number;
  difference?: number;
  status: ShiftStatus;
  notes?: string;
  cash_sales?: number;
  qris_sales?: number;
  transfer_sales?: number;
  cash_in?: number;
  cash_out?: number;
  refund_amount?: number;
  transaction_count?: number;
  variance_note?: string;
  opened_at: string;
  closed_at?: string;
  closed_by?: string;
}

export interface TransitManifest {
  id: string;
  organization_id: string;
  manifest_number: string;
  source_branch_id: string;
  destination_branch_id: string;
  status: TransitManifestStatus;
  driver_user_id?: string;
  vehicle_identifier?: string;
  notes?: string;
  discrepancy_summary?: string;
  total_expected_orders: number;
  total_received_orders: number;
  has_discrepancy: boolean;
  created_by: string;
  dispatched_by?: string;
  received_by?: string;
  cancelled_by?: string;
  created_at: string;
  dispatched_at?: string;
  received_at?: string;
  cancelled_at?: string;
  updated_at: string;

  // Joined relations
  source_branch?: Branch;
  destination_branch?: Branch;
  driver?: UserProfile;
  items?: TransitManifestItem[];
}

export interface TransitManifestItem {
  id: string;
  manifest_id: string;
  organization_id: string;
  order_id: string;
  received_status: TransitManifestItemStatus;
  discrepancy_notes?: string;
  added_at: string;
  received_at?: string;
  inspected_by?: string;

  // Joined relations
  order?: Order;
}

export interface TransitManifestHistory {
  id: string;
  manifest_id: string;
  organization_id: string;
  from_status?: TransitManifestStatus;
  to_status: TransitManifestStatus;
  actor_id: string;
  notes?: string;
  created_at: string;
  actor?: UserProfile;
}

export interface OrderStatusHistory {
  id: string;
  order_id: string;
  from_status?: OrderStatus;
  to_status: OrderStatus;
  changed_by: string;
  notes?: string;
  created_at: string;
}

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_data?: Record<string, any>;
  after_data?: Record<string, any>;
  created_at: string;
}

export type ReworkRequestStatus = 'APPROVED' | 'CONSUMED' | 'CANCELLED';

export type ReworkReasonCode =
  | 'CUSTOMER_COMPLAINT'
  | 'STAIN_REMAINS'
  | 'ODOR_REMAINS'
  | 'WRONG_TREATMENT'
  | 'OUTLET_QC_REJECT'
  | 'OTHER';

export interface OrderReworkRequest {
  id: string;
  organization_id: string;
  order_id: string;
  requested_by: string;
  reason: ReworkReasonCode;
  notes?: string | null;
  status: ReworkRequestStatus;
  consumed_manifest_id?: string | null;
  created_at: string;
  consumed_at?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;

  // Joined relations
  order?: Order;
  requested_by_user?: UserProfile;
}

// ----------------------------------------------------------------------------
// Production Domain Types (Step 4C.3 Implementation & Step 4C.3.3 Reconciliation)
// ----------------------------------------------------------------------------

export type ProductionJobStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type WorkItemStatus = 'IN_PROGRESS' | 'SPLIT' | 'COMPLETED' | 'CANCELLED';

export type ProductionStage =
  | 'WASHING'
  | 'DRYING'
  | 'IRONING'
  | 'PACKED'
  | 'SPECIAL_TREATMENT';

export type ProductionStageTransitionType =
  | 'START'
  | 'ADVANCE'
  | 'QC_PASS'
  | 'QC_FAIL'
  | 'SPLIT'
  | 'CANCEL';

export type SplitReason =
  | 'CAPACITY_OVERFLOW'
  | 'QC_DEFECT_ISOLATION'
  | 'TREATMENT_SEGREGATION';

export interface ProductionJob {
  id: string;
  organization_id: string;
  order_id: string;
  branch_id: string;
  rework_request_id?: string | null;
  status: ProductionJobStatus;
  notes?: string | null;
  created_by: string;
  created_at: string;
  completed_at?: string | null;
  completed_by?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  updated_at: string;

  // Joined relations
  order?: Order;
  branch?: Branch;
  work_items?: ProductionWorkItem[];
  rework_request?: OrderReworkRequest | null;
}

export interface ProductionWorkItem {
  id: string;
  job_id: string;
  organization_id: string;
  order_item_id: string;
  service_id: string;
  parent_item_id?: string | null;
  item_code: string;
  service_name_snap: string;
  unit: ServiceUnit;
  quantity: number;
  service_stages: ProductionStage[];
  current_stage: ProductionStage;
  stage_index: number;
  status: WorkItemStatus;
  split_reason?: SplitReason | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;

  // Joined relations
  order_item?: OrderItem;
  service?: Service;
  parent_item?: ProductionWorkItem | null;
  child_items?: ProductionWorkItem[];
  stage_logs?: ProductionStageLog[];
}

export interface ProductionStageLog {
  id: string;
  work_item_id: string;
  organization_id: string;
  from_stage?: ProductionStage | null;
  to_stage: ProductionStage;
  transition_type: ProductionStageTransitionType;
  actor_id: string;
  notes?: string | null;
  created_at: string;

  // Joined relations
  actor?: UserProfile;
}

// ============================================================================
// Workshop Production Read Model Types (Step 4C.4C-B.2)
// High-performance, bulk-aggregated read contract for Workshop Kanban boards
// ============================================================================

export interface WorkshopProductionWorkItem {
  id: string; // work_item_id
  job_id: string;
  order_id: string;
  order_number: string;
  customer_name?: string;
  order_item_id: string;
  service_id: string;
  item_code: string;
  service_name: string;
  service_name_snap: string;
  unit: ServiceUnit;
  quantity: number;
  service_stages: ProductionStage[];
  current_stage: ProductionStage;
  stage_index: number;
  status: WorkItemStatus;
  parent_item_id?: string | null;
  split_reason?: SplitReason | null;
  job_status: ProductionJobStatus;
  rework_request_id?: string | null;
  is_rework: boolean;
  job_created_at: string;
  workshop_branch_id: string;
  workshop_branch_name?: string;
  notes?: string | null;
  created_at: string;
}

export interface WorkshopProductionJobSummary {
  id: string;
  order_id: string;
  order_number: string;
  customer_name?: string;
  branch_id: string;
  rework_request_id?: string | null;
  is_rework: boolean;
  status: ProductionJobStatus;
  created_at: string;
  work_items_count: number;
}

export interface WorkshopProductionReadModel {
  workshop_branch_id: string;
  workshop_branch_name?: string;
  jobs_count: number;
  work_items_count: number;
  jobs: WorkshopProductionJobSummary[];
  work_items: WorkshopProductionWorkItem[];
}
