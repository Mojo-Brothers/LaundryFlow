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
} from '../types/database';
import { supabase, isLiveSupabaseConfigured } from '../supabase/client';
import { isValidOrderTransition } from './stateMachine';

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
  statusHistory: OrderStatusHistory[] = [];
  payments: Payment[] = [];

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

      const savedHist = localStorage.getItem('lf_status_history');
      if (savedHist) this.statusHistory = JSON.parse(savedHist);

      const savedPays = localStorage.getItem('lf_payments');
      if (savedPays) this.payments = JSON.parse(savedPays);
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
    } catch {
      // storage quota or incognito
    }
  }

  reset() {
    this.customers = [...DEMO_CUSTOMERS];
    this.services = [...DEMO_SERVICES];
    this.orders = [...DEMO_ORDERS];
    this.shifts = [{ ...DEMO_SHIFT, opened_at: new Date().toISOString() }];
    this.statusHistory = [];
    this.payments = [];
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
      const { data, error } = await supabase
        .from('cashier_shifts')
        .update({
          actual_cash: actualCash,
          status: 'CLOSED',
          closed_at: new Date().toISOString(),
          notes,
        })
        .eq('id', shiftId)
        .select()
        .single();
      if (error) throw error;
      return data as CashierShift;
    }

    const shift = sandbox.shifts.find(s => s.id === shiftId);
    if (!shift) throw new Error('Shift tidak ditemukan.');
    if (shift.status === 'CLOSED') {
      throw new Error('Shift sudah berstatus CLOSED dan tidak dapat dimodifikasi ulang.');
    }

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

  resetSandbox() {
    sandbox.reset();
  },
};
