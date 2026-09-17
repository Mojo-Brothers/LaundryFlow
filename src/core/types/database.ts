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
