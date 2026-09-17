// ============================================================================
// Repository & Data Access Layer (Supabase PostgREST & Demo Sandbox Provider)
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
} from '../types/database';
import { supabase, isLiveSupabaseConfigured } from '../supabase/client';

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
];

// In-Memory Storage Cache with localStorage persistence for Sandbox mode
class LocalSandboxStorage {
  customers: Customer[] = [...DEMO_CUSTOMERS];
  services: Service[] = [...DEMO_SERVICES];
  orders: Order[] = [...DEMO_ORDERS];
  shifts: CashierShift[] = [DEMO_SHIFT];

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    try {
      const savedOrders = localStorage.getItem('lf_orders');
      if (savedOrders) this.orders = JSON.parse(savedOrders);

      const savedCusts = localStorage.getItem('lf_customers');
      if (savedCusts) this.customers = JSON.parse(savedCusts);

      const savedShifts = localStorage.getItem('lf_shifts');
      if (savedShifts) this.shifts = JSON.parse(savedShifts);
    } catch {
      // fallback to initial in-memory state
    }
  }

  save() {
    try {
      localStorage.setItem('lf_orders', JSON.stringify(this.orders));
      localStorage.setItem('lf_customers', JSON.stringify(this.customers));
      localStorage.setItem('lf_shifts', JSON.stringify(this.shifts));
    } catch {
      // storage quota or incognito
    }
  }

  reset() {
    this.customers = [...DEMO_CUSTOMERS];
    this.services = [...DEMO_SERVICES];
    this.orders = [...DEMO_ORDERS];
    this.shifts = [{ ...DEMO_SHIFT, opened_at: new Date().toISOString() }];
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
    return DEMO_BRANCHES;
  },

  async getUsers(): Promise<UserProfile[]> {
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
    const shift = sandbox.shifts.find(s => s.id === shiftId);
    if (!shift) throw new Error('Shift not found');

    shift.actual_cash = actualCash;
    shift.difference = actualCash - shift.expected_cash;
    shift.status = 'CLOSED';
    shift.closed_at = new Date().toISOString();
    if (notes) shift.notes = notes;

    sandbox.save();
    return shift;
  },

  // --- Orders ---
  async getOrders(branchId?: string, status?: OrderStatus): Promise<Order[]> {
    if (isLiveSupabaseConfigured && supabase) {
      let query = supabase
        .from('orders')
        .select('*, customer:customers(*), items:order_items(*)')
        .order('created_at', { ascending: false });

      if (branchId) query = query.eq('branch_id', branchId);
      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) throw error;
      return data as Order[];
    }

    let list = [...sandbox.orders];
    if (branchId) list = list.filter(o => o.branch_id === branchId || o.production_branch_id === branchId);
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

    const newOrder: Order = {
      ...orderData,
      id: 'order-' + Date.now(),
      order_number: orderNumber,
      tracking_token: trackingToken,
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

    // Update payment status if paid
    if (paymentData && paymentData.amount > 0) {
      newOrder.paid_amount = paymentData.amount;
      newOrder.remaining_amount = Math.max(0, newOrder.final_amount - paymentData.amount);
      newOrder.payment_status = newOrder.paid_amount >= newOrder.final_amount ? 'PAID' : 'PARTIAL';

      // Update active shift expected cash
      const activeShift = sandbox.shifts.find(s => s.branch_id === orderData.branch_id && s.status === 'OPEN');
      if (activeShift && paymentData.method === 'CASH') {
        activeShift.expected_cash += paymentData.amount;
      }
    }

    sandbox.orders.unshift(newOrder);
    sandbox.save();
    return newOrder;
  },

  async updateOrderStatus(orderId: string, nextStatus: OrderStatus, _userId: string, _notes?: string): Promise<Order> {
    const order = sandbox.orders.find(o => o.id === orderId);
    if (!order) throw new Error('Order not found');

    order.status = nextStatus;
    order.updated_at = new Date().toISOString();
    sandbox.save();
    return order;
  },

  async getOrderByTrackingToken(token: string): Promise<Order | null> {
    const order = sandbox.orders.find(o => o.tracking_token === token);
    return order || null;
  },

  resetSandbox() {
    sandbox.reset();
  },
};
