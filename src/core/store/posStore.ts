// ============================================================================
// Zustand POS Store: Fast Checkout Engine & Shift Management
// ============================================================================

import { create } from 'zustand';
import { Customer, Service, UserProfile, Branch, PaymentMethod, Order } from '../types/database';
import { calculateItemPrice } from '../services/pricing';

export interface CartItem {
  id: string;
  service: Service;
  itemType: 'KILOAN' | 'SATUAN';
  actualWeightOrQty: number;
  billableWeightOrQty: number;
  unitPrice: number;
  subtotal: number;
  notes?: string;
}

export interface HoldCart {
  id: string;
  timestamp: string;
  customer: Customer | null;
  items: CartItem[];
  discount: number;
  notes: string;
}

interface PosState {
  // Session & Branch
  currentUser: UserProfile;
  currentBranch: Branch;
  allBranches: Branch[];
  allUsers: UserProfile[];

  // Active Transaction Cart
  selectedCustomer: Customer | null;
  items: CartItem[];
  discountAmount: number;
  deliveryFee: number;
  orderNotes: string;
  operatingMode: 'SIMPLE' | 'STANDARD' | 'ADVANCED';
  
  // Payment
  paymentMethod: PaymentMethod;
  amountPaid: number;

  // Held Carts
  heldCarts: HoldCart[];

  // Receipt & Modal
  lastCompletedOrder: Order | null;
  isReceiptModalOpen: boolean;

  // Actions
  setUser: (user: UserProfile) => void;
  setBranch: (branch: Branch) => void;
  setCustomer: (customer: Customer | null) => void;
  setOperatingMode: (mode: 'SIMPLE' | 'STANDARD' | 'ADVANCED') => void;
  setDiscountAmount: (discount: number) => void;
  setDeliveryFee: (fee: number) => void;
  setOrderNotes: (notes: string) => void;
  setPaymentMethod: (method: PaymentMethod) => void;
  setAmountPaid: (amount: number) => void;

  // Cart Mutators
  addKiloanItem: (service: Service, weightKg: number, notes?: string) => void;
  addSatuanItem: (service: Service, quantity: number, notes?: string) => void;
  updateItemQuantity: (itemId: string, newQty: number) => void;
  removeItem: (itemId: string) => void;
  clearCart: () => void;

  // Hold / Resume
  holdCurrentCart: () => boolean;
  resumeHeldCart: (heldId: string) => void;
  discardHeldCart: (heldId: string) => void;

  // Receipt Modal
  setLastCompletedOrder: (order: Order | null) => void;
  setReceiptModalOpen: (open: boolean) => void;

  // Computed Totals
  getSubtotal: () => number;
  getFinalAmount: () => number;
}

export const usePosStore = create<PosState>((set, get) => ({
  currentUser: {
    id: '33333333-3333-3333-3333-333333333332',
    organization_id: '11111111-1111-1111-1111-111111111111',
    email: 'kasir@demo.laundryflow.id',
    full_name: 'Rina Kasir',
    role: 'CASHIER',
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  currentBranch: {
    id: '22222222-2222-2222-2222-222222222221',
    organization_id: '11111111-1111-1111-1111-111111111111',
    code: 'BKS-01',
    name: 'Outlet Bekasi Timur',
    branch_type: 'OUTLET',
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  allBranches: [],
  allUsers: [],

  selectedCustomer: null,
  items: [],
  discountAmount: 0,
  deliveryFee: 0,
  orderNotes: '',
  operatingMode: 'SIMPLE',

  paymentMethod: 'CASH',
  amountPaid: 0,

  heldCarts: [],
  lastCompletedOrder: null,
  isReceiptModalOpen: false,

  setUser: (user) => set({ currentUser: user }),
  setBranch: (branch) => set({ currentBranch: branch }),
  setCustomer: (customer) => set({ selectedCustomer: customer }),
  setOperatingMode: (mode) => set({ operatingMode: mode }),
  setDiscountAmount: (discount) => set({ discountAmount: Math.max(0, discount) }),
  setDeliveryFee: (fee) => set({ deliveryFee: Math.max(0, fee) }),
  setOrderNotes: (notes) => set({ orderNotes: notes }),
  setPaymentMethod: (method) => set({ paymentMethod: method }),
  setAmountPaid: (amount) => set({ amountPaid: Math.max(0, amount) }),

  addKiloanItem: (service, weightKg, notes) => {
    const calc = calculateItemPrice({
      service,
      actualQuantityOrWeight: weightKg,
    });

    const newItem: CartItem = {
      id: 'item_' + Date.now(),
      service,
      itemType: 'KILOAN',
      actualWeightOrQty: calc.actualQuantityOrWeight,
      billableWeightOrQty: calc.billableQuantityOrWeight,
      unitPrice: calc.unitPrice,
      subtotal: calc.subtotal,
      notes,
    };

    set((state) => ({ items: [...state.items, newItem] }));
  },

  addSatuanItem: (service, quantity, notes) => {
    const calc = calculateItemPrice({
      service,
      actualQuantityOrWeight: quantity,
    });

    const newItem: CartItem = {
      id: 'item_' + Date.now(),
      service,
      itemType: 'SATUAN',
      actualWeightOrQty: calc.actualQuantityOrWeight,
      billableWeightOrQty: calc.billableQuantityOrWeight,
      unitPrice: calc.unitPrice,
      subtotal: calc.subtotal,
      notes,
    };

    set((state) => ({ items: [...state.items, newItem] }));
  },

  updateItemQuantity: (itemId, newQty) => {
    set((state) => ({
      items: state.items.map((item) => {
        if (item.id !== itemId) return item;
        const calc = calculateItemPrice({
          service: item.service,
          actualQuantityOrWeight: newQty,
        });
        return {
          ...item,
          actualWeightOrQty: calc.actualQuantityOrWeight,
          billableWeightOrQty: calc.billableQuantityOrWeight,
          subtotal: calc.subtotal,
        };
      }),
    }));
  },

  removeItem: (itemId) => {
    set((state) => ({ items: state.items.filter((i) => i.id !== itemId) }));
  },

  clearCart: () => {
    set({
      selectedCustomer: null,
      items: [],
      discountAmount: 0,
      deliveryFee: 0,
      orderNotes: '',
      amountPaid: 0,
    });
  },

  holdCurrentCart: () => {
    const state = get();
    if (state.items.length === 0) return false;

    const newHold: HoldCart = {
      id: 'hold_' + Date.now(),
      timestamp: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      customer: state.selectedCustomer,
      items: state.items,
      discount: state.discountAmount,
      notes: state.orderNotes,
    };

    set((s) => ({
      heldCarts: [newHold, ...s.heldCarts],
      selectedCustomer: null,
      items: [],
      discountAmount: 0,
      deliveryFee: 0,
      orderNotes: '',
      amountPaid: 0,
    }));
    return true;
  },

  resumeHeldCart: (heldId) => {
    const state = get();
    const target = state.heldCarts.find((h) => h.id === heldId);
    if (!target) return;

    set((s) => ({
      heldCarts: s.heldCarts.filter((h) => h.id !== heldId),
      selectedCustomer: target.customer,
      items: target.items,
      discountAmount: target.discount,
      orderNotes: target.notes,
    }));
  },

  discardHeldCart: (heldId) => {
    set((state) => ({ heldCarts: state.heldCarts.filter((h) => h.id !== heldId) }));
  },

  setLastCompletedOrder: (order) => set({ lastCompletedOrder: order }),
  setReceiptModalOpen: (open) => set({ isReceiptModalOpen: open }),

  getSubtotal: () => {
    return get().items.reduce((acc, item) => acc + item.subtotal, 0);
  },

  getFinalAmount: () => {
    const subtotal = get().getSubtotal();
    const discount = get().discountAmount;
    const delivery = get().deliveryFee;
    return Math.max(0, subtotal - discount + delivery);
  },
}));
