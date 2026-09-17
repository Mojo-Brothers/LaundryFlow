import React, { useState, useEffect } from 'react';
import { usePosStore } from '../../core/store/posStore';
import { repository } from '../../core/services/repository';
import { Customer, Service, PaymentMethod } from '../../core/types/database';
import { formatIDR, parseIDR } from '../../core/utils/currency';
import { calculateItemPrice } from '../../core/services/pricing';
import {
  Scale,
  Zap,
  ShoppingBag,
  Plus,
  Trash2,
  PauseCircle,
  PlayCircle,
  Search,
  UserPlus,
  CheckCircle2,
  Clock,
  Sparkles,
  CreditCard,
  QrCode,
  Banknote,
  Percent,
} from 'lucide-react';
import { ThermalReceipt } from '../../components/pos/ThermalReceipt';

export const FastCheckoutView: React.FC = () => {
  const {
    currentUser,
    currentBranch,
    selectedCustomer,
    items,
    discountAmount,
    deliveryFee,
    orderNotes,
    paymentMethod,
    amountPaid,
    heldCarts,
    lastCompletedOrder,
    isReceiptModalOpen,
    setCustomer,
    setDiscountAmount,
    setDeliveryFee,
    setOrderNotes,
    setPaymentMethod,
    setAmountPaid,
    addKiloanItem,
    addSatuanItem,
    removeItem,
    clearCart,
    holdCurrentCart,
    resumeHeldCart,
    discardHeldCart,
    setLastCompletedOrder,
    setReceiptModalOpen,
    getSubtotal,
    getFinalAmount,
  } = usePosStore();

  const [services, setServices] = useState<Service[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [searchCustQuery, setSearchCustQuery] = useState('');
  const [isCustomerDropdownOpen, setIsCustomerDropdownOpen] = useState(false);

  // Quick Customer Creation modal
  const [isNewCustomerModalOpen, setIsNewCustomerModalOpen] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [newCustAddress, setNewCustAddress] = useState('');

  // Kiloan Fast Keypad State
  const [kiloWeightInput, setKiloWeightInput] = useState('3.5');
  const [selectedKiloService, setSelectedKiloService] = useState<Service | null>(null);
  const [kiloNotes, setKiloNotes] = useState('');

  // Active Tab: Kiloan vs Satuan
  const [posTab, setPosTab] = useState<'KILOAN' | 'SATUAN'>('KILOAN');

  // Submitting state
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    repository.getServices().then((svcs) => {
      setServices(svcs);
      const defaultKilo = svcs.find((s) => s.unit === 'KG' && s.is_active);
      if (defaultKilo) setSelectedKiloService(defaultKilo);
    });
    repository.getCustomers().then(setCustomers);
  }, []);

  // Quick search customers
  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(searchCustQuery.toLowerCase()) ||
      c.phone.includes(searchCustQuery)
  );

  const subtotal = getSubtotal();
  const finalAmount = getFinalAmount();

  // Instant calculation preview for active Kiloan input
  const weightNum = parseFloat(kiloWeightInput) || 0;
  const activeKiloCalc = selectedKiloService
    ? calculateItemPrice({
        service: selectedKiloService,
        actualQuantityOrWeight: weightNum,
      })
    : null;

  const handleAddKiloanToCart = () => {
    if (!selectedKiloService || weightNum <= 0) return;
    addKiloanItem(selectedKiloService, weightNum, kiloNotes);
    setKiloNotes('');
    setKiloWeightInput('3.0'); // reset to default
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustName || !newCustPhone) return;

    const created = await repository.createCustomer({
      organization_id: currentBranch.organization_id,
      name: newCustName,
      phone: newCustPhone,
      whatsapp: newCustPhone,
      address: newCustAddress,
      membership_tier: 'REGULAR',
    });

    setCustomers((prev) => [created, ...prev]);
    setCustomer(created);
    setIsNewCustomerModalOpen(false);
    setNewCustName('');
    setNewCustPhone('');
    setNewCustAddress('');
  };

  const handleCreateOrder = async (isPaidImmediately: boolean) => {
    if (items.length === 0) {
      alert('Pilih minimal satu layanan sebelum memproses order.');
      return;
    }

    // Default walk-in customer if none selected
    let customerToUse = selectedCustomer;
    if (!customerToUse) {
      const walkIn = customers.find((c) => c.phone === '081234567890') || customers[0];
      customerToUse = walkIn;
    }

    setIsSubmitting(true);
    try {
      const paidAmt = isPaidImmediately ? finalAmount : amountPaid;
      const order = await repository.createOrder(
        {
          organization_id: currentBranch.organization_id,
          branch_id: currentBranch.id,
          production_branch_id: currentBranch.id,
          customer_id: customerToUse.id,
          status: 'RECEIVED',
          operating_mode: 'SIMPLE',
          subtotal,
          discount_amount: discountAmount,
          delivery_fee: deliveryFee,
          final_amount: finalAmount,
          paid_amount: paidAmt,
          remaining_amount: Math.max(0, finalAmount - paidAmt),
          payment_status: paidAmt >= finalAmount ? 'PAID' : paidAmt > 0 ? 'PARTIAL' : 'UNPAID',
          promised_ready_at: new Date(Date.now() + 48 * 3600000).toISOString(),
          created_by: currentUser.id,
          notes: orderNotes,
        },
        items.map((item) => ({
          service_id: item.service.id,
          item_type: item.itemType,
          service_name_snap: item.service.name,
          unit_price_snap: item.unitPrice,
          quantity_or_weight: item.actualWeightOrQty,
          billable_weight: item.billableWeightOrQty,
          subtotal: item.subtotal,
          notes: item.notes,
        })),
        paidAmt > 0 ? { method: paymentMethod, amount: paidAmt } : undefined
      );

      setLastCompletedOrder(order);
      setReceiptModalOpen(true);
      clearCart();
    } catch (err: any) {
      alert('Gagal membuat pesanan: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Top Banner: Fast Checkout Title & Hold Counter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              Fast Checkout Kasir
            </h1>
            <span className="flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
              <Zap className="w-3 h-3 text-emerald-600" />
              Target &lt; 20 Detik
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Outlet: <span className="font-semibold text-slate-700">{currentBranch?.name}</span> | Kasir: <span className="font-semibold text-slate-700">{currentUser?.full_name}</span>
          </p>
        </div>

        {/* Hold Transactions Bar */}
        {heldCarts.length > 0 && (
          <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-xl text-xs text-amber-900">
            <PauseCircle className="w-4 h-4 text-amber-600" />
            <span className="font-bold">{heldCarts.length} Pesanan Ditahan (Hold):</span>
            <div className="flex gap-1.5 overflow-x-auto max-w-xs">
              {heldCarts.map((h) => (
                <button
                  key={h.id}
                  onClick={() => resumeHeldCart(h.id)}
                  className="px-2 py-1 rounded bg-white hover:bg-amber-100 border border-amber-300 font-semibold text-[11px] text-amber-800 transition shadow-2xs"
                >
                  {h.customer?.name || 'Umum'} ({h.timestamp})
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Main Grid: Left = Input POS, Right = Cart & Payment */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* =================================================================== */}
        {/* LEFT COLUMN: CUSTOMER & SERVICE SELECTOR (7 Cols) */}
        {/* =================================================================== */}
        <div className="lg:col-span-7 space-y-5">
          {/* 1. CUSTOMER SELECTOR */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                1. Pelanggan (Cari HP / Nama)
              </label>
              <button
                type="button"
                onClick={() => setIsNewCustomerModalOpen(true)}
                className="flex items-center gap-1 text-xs font-semibold text-sky-600 hover:text-sky-700 transition"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>+ Tambah Baru</span>
              </button>
            </div>

            {selectedCustomer ? (
              <div className="flex items-center justify-between p-3 rounded-xl bg-sky-50 border border-sky-200">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-sky-600 text-white flex items-center justify-center font-bold text-sm">
                    {selectedCustomer.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-900">{selectedCustomer.name}</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-sky-200 text-sky-800">
                        {selectedCustomer.membership_tier}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">{selectedCustomer.phone}</p>
                    {selectedCustomer.notes && (
                      <p className="text-[10px] text-amber-700 italic">Catatan: {selectedCustomer.notes}</p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setCustomer(null)}
                  className="px-2.5 py-1 text-xs font-semibold text-slate-500 hover:text-rose-600 rounded-lg hover:bg-white transition"
                >
                  Ganti
                </button>
              </div>
            ) : (
              <div className="relative">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    placeholder="Ketik nama atau no HP (cth: Budi / 0812...)"
                    value={searchCustQuery}
                    onChange={(e) => {
                      setSearchCustQuery(e.target.value);
                      setIsCustomerDropdownOpen(true);
                    }}
                    onFocus={() => setIsCustomerDropdownOpen(true)}
                    className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden"
                  />
                </div>

                {isCustomerDropdownOpen && searchCustQuery && (
                  <div className="absolute left-0 right-0 top-12 z-30 bg-white rounded-xl border border-slate-200 shadow-xl max-h-56 overflow-y-auto divide-y divide-slate-100">
                    {filteredCustomers.length > 0 ? (
                      filteredCustomers.map((c) => (
                        <div
                          key={c.id}
                          onClick={() => {
                            setCustomer(c);
                            setSearchCustQuery('');
                            setIsCustomerDropdownOpen(false);
                          }}
                          className="p-3 hover:bg-sky-50 cursor-pointer transition flex items-center justify-between text-xs"
                        >
                          <div>
                            <span className="font-bold text-slate-900">{c.name}</span>
                            <span className="text-slate-500 ml-2">({c.phone})</span>
                            <p className="text-[11px] text-slate-500 truncate max-w-xs">{c.address}</p>
                          </div>
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                            {c.membership_tier}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="p-4 text-center text-xs text-slate-500">
                        Tidak ditemukan. Tekan <b>+ Tambah Baru</b> di atas.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 2. MODE SELECTOR: KILOAN (FASTEST) vs SATUAN */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex border-b border-slate-200 mb-4">
              <button
                type="button"
                onClick={() => setPosTab('KILOAN')}
                className={`flex-1 py-2.5 text-center text-sm font-bold border-b-2 flex items-center justify-center gap-2 transition ${
                  posTab === 'KILOAN'
                    ? 'border-sky-600 text-sky-700 bg-sky-50/50 rounded-t-xl'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Scale className="w-4 h-4" />
                <span>Cucian Kiloan (Fast Workflow)</span>
              </button>
              <button
                type="button"
                onClick={() => setPosTab('SATUAN')}
                className={`flex-1 py-2.5 text-center text-sm font-bold border-b-2 flex items-center justify-center gap-2 transition ${
                  posTab === 'SATUAN'
                    ? 'border-sky-600 text-sky-700 bg-sky-50/50 rounded-t-xl'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <ShoppingBag className="w-4 h-4" />
                <span>Cucian Satuan (Bed Cover / Jas / Sepatu)</span>
              </button>
            </div>

            {posTab === 'KILOAN' ? (
              /* KILOAN FAST CHECKOUT SECTION */
              <div className="space-y-4">
                {/* Weight Input */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <Scale className="w-3.5 h-3.5 text-sky-600" />
                      Timbang Berat (KG)
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Min. Charge: {selectedKiloService?.min_charge_unit || 3} KG
                    </span>
                  </div>

                  <div className="grid grid-cols-12 gap-3">
                    <div className="col-span-7 relative">
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={kiloWeightInput}
                        onChange={(e) => setKiloWeightInput(e.target.value)}
                        placeholder="0.0"
                        className="w-full px-4 py-3 text-2xl font-black font-mono rounded-xl border border-slate-300 text-slate-900 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden"
                      />
                      <span className="absolute right-4 top-4 font-bold text-slate-400 text-sm">KG</span>
                    </div>

                    {/* Weight Quick Buttons */}
                    <div className="col-span-5 grid grid-cols-3 gap-1.5">
                      {['3.0', '4.0', '5.0', '6.0', '7.0', '10.0'].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setKiloWeightInput(preset)}
                          className={`py-1.5 text-xs font-mono font-bold rounded-lg border transition ${
                            kiloWeightInput === preset
                              ? 'bg-sky-600 text-white border-sky-600'
                              : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Service Selection Cards */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                    Pilih Paket Kiloan
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {services
                      .filter((s) => s.unit === 'KG')
                      .map((svc) => {
                        const isSelected = selectedKiloService?.id === svc.id;
                        return (
                          <div
                            key={svc.id}
                            onClick={() => setSelectedKiloService(svc)}
                            className={`p-3 rounded-xl border cursor-pointer transition ${
                              isSelected
                                ? 'bg-sky-50 border-sky-500 ring-2 ring-sky-500/20 shadow-xs'
                                : 'bg-white border-slate-200 hover:border-slate-300'
                            }`}
                          >
                            <div className="flex justify-between items-start">
                              <span className="font-bold text-xs text-slate-900">{svc.name}</span>
                              <span className="font-mono font-bold text-xs text-sky-700">
                                {formatIDR(svc.base_price)}/kg
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-2 text-[10px] text-slate-500">
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3 text-slate-400" />
                                {svc.estimated_duration_hours} Jam
                              </span>
                              <span>•</span>
                              <span>Min {svc.min_charge_unit} KG</span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>

                {/* Notes Input */}
                <div>
                  <input
                    type="text"
                    value={kiloNotes}
                    onChange={(e) => setKiloNotes(e.target.value)}
                    placeholder="Catatan pakaian (cth: Baju putih dipisah, parfum lavender)"
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 outline-hidden"
                  />
                </div>

                {/* Realtime Calculation Bar & Add Button */}
                {activeKiloCalc && (
                  <div className="flex items-center justify-between p-3.5 bg-slate-900 text-white rounded-xl">
                    <div>
                      <p className="text-[11px] text-slate-400">
                        Berat Tagihan: <b>{activeKiloCalc.billableQuantityOrWeight} KG</b> (Aktual: {activeKiloCalc.actualQuantityOrWeight} kg)
                      </p>
                      <p className="text-base font-black font-mono text-emerald-400">
                        {formatIDR(activeKiloCalc.subtotal)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleAddKiloanToCart}
                      disabled={weightNum <= 0}
                      className="px-5 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:bg-slate-700 text-white font-bold text-xs transition shadow-sm flex items-center gap-1.5"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Tambah ke Keranjang</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* SATUAN SECTION */
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {services
                  .filter((s) => s.unit !== 'KG')
                  .map((svc) => (
                    <div
                      key={svc.id}
                      className="p-3.5 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex justify-between items-start">
                          <span className="font-bold text-xs text-slate-900">{svc.name}</span>
                          <span className="font-mono font-bold text-xs text-sky-700">
                            {formatIDR(svc.base_price)}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">Estimasi: {svc.estimated_duration_hours} Jam</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => addSatuanItem(svc, 1)}
                        className="mt-3 w-full py-1.5 rounded-lg bg-slate-100 hover:bg-sky-50 hover:text-sky-700 text-slate-700 font-semibold text-xs transition flex items-center justify-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Tambah (1 {svc.unit})</span>
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* =================================================================== */}
        {/* RIGHT COLUMN: ACTIVE CART, TOTALS & PAYMENT (5 Cols) */}
        {/* =================================================================== */}
        <div className="lg:col-span-5 space-y-5">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex flex-col h-full">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-sky-600" />
                <h2 className="font-bold text-sm text-slate-900">Keranjang Transaksi</h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 font-bold text-slate-700">
                  {items.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={holdCurrentCart}
                  disabled={items.length === 0}
                  className="flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-800 disabled:text-slate-300 transition"
                  title="Tahan transaksi sementara"
                >
                  <PauseCircle className="w-3.5 h-3.5" />
                  <span>Hold</span>
                </button>
                <button
                  type="button"
                  onClick={clearCart}
                  disabled={items.length === 0}
                  className="flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:text-slate-300 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Kosongkan</span>
                </button>
              </div>
            </div>

            {/* Cart Items List */}
            <div className="divide-y divide-slate-100 my-3 flex-1 overflow-y-auto max-h-72">
              {items.length === 0 ? (
                <div className="py-12 text-center text-slate-400 text-xs">
                  <ShoppingBag className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                  Keranjang kosong. Masukkan berat atau pilih layanan di samping.
                </div>
              ) : (
                items.map((item) => (
                  <div key={item.id} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                    <div className="flex-1">
                      <p className="font-bold text-slate-900">{item.service.name}</p>
                      <p className="text-[11px] text-slate-500">
                        {item.billableWeightOrQty} {item.itemType === 'KILOAN' ? 'KG' : 'PCS'} @ {formatIDR(item.unitPrice)}
                      </p>
                      {item.notes && <p className="text-[10px] text-slate-400 italic">“{item.notes}”</p>}
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <span className="font-mono font-bold text-slate-900">{formatIDR(item.subtotal)}</span>
                      <button
                        type="button"
                        onClick={() => removeItem(item.id)}
                        className="p-1 text-slate-300 hover:text-rose-600 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Price Calculations Breakdown */}
            <div className="pt-3 border-t border-slate-200 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal Layanan:</span>
                <span className="font-mono font-semibold">{formatIDR(subtotal)}</span>
              </div>

              <div className="flex items-center justify-between text-slate-600">
                <span className="flex items-center gap-1">
                  <Percent className="w-3 h-3 text-slate-400" />
                  Diskon:
                </span>
                <div className="w-24">
                  <input
                    type="number"
                    min="0"
                    value={discountAmount || ''}
                    onChange={(e) => setDiscountAmount(Number(e.target.value))}
                    placeholder="0"
                    className="w-full px-2 py-0.5 text-right font-mono rounded border border-slate-300 text-xs outline-hidden"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-slate-600">
                <span>Ongkos Kirim (Opsional):</span>
                <div className="w-24">
                  <input
                    type="number"
                    min="0"
                    value={deliveryFee || ''}
                    onChange={(e) => setDeliveryFee(Number(e.target.value))}
                    placeholder="0"
                    className="w-full px-2 py-0.5 text-right font-mono rounded border border-slate-300 text-xs outline-hidden"
                  />
                </div>
              </div>

              <div className="flex justify-between items-baseline pt-2 border-t border-slate-200 font-black text-slate-900">
                <span className="text-sm">TOTAL TAGIHAN:</span>
                <span className="text-xl font-mono text-sky-700">{formatIDR(finalAmount)}</span>
              </div>
            </div>

            {/* Payment Method Selector */}
            <div className="mt-4 pt-3 border-t border-slate-200">
              <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-2">
                Metode Pembayaran
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'CASH', label: 'Tunai', icon: Banknote },
                  { id: 'QRIS_MANUAL', label: 'QRIS', icon: QrCode },
                  { id: 'BANK_TRANSFER', label: 'Transfer', icon: CreditCard },
                ].map((pm) => {
                  const Icon = pm.icon;
                  const isSelected = paymentMethod === pm.id;
                  return (
                    <button
                      key={pm.id}
                      type="button"
                      onClick={() => setPaymentMethod(pm.id as PaymentMethod)}
                      className={`py-2 px-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                        isSelected
                          ? 'bg-sky-600 text-white border-sky-600 shadow-xs'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{pm.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Quick Action Checkout Buttons */}
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button
                type="button"
                onClick={() => handleCreateOrder(false)}
                disabled={items.length === 0 || isSubmitting}
                className="py-3 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-800 font-bold text-xs transition"
              >
                Bayar Nanti (Ambil)
              </button>
              <button
                type="button"
                onClick={() => handleCreateOrder(true)}
                disabled={items.length === 0 || isSubmitting}
                className="py-3 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs transition shadow-md shadow-emerald-600/20 flex items-center justify-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Bayar Lunas (F1)</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Customer Creation Modal */}
      {isNewCustomerModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="font-bold text-slate-900 text-base">Tambah Pelanggan Cepat</h2>
            <form onSubmit={handleCreateCustomer} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Nama Lengkap *</label>
                <input
                  type="text"
                  required
                  placeholder="Misal: Ibu Ratih"
                  value={newCustName}
                  onChange={(e) => setNewCustName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Nomor WhatsApp / HP *</label>
                <input
                  type="tel"
                  required
                  placeholder="08123456789"
                  value={newCustPhone}
                  onChange={(e) => setNewCustPhone(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Alamat (Opsional)</label>
                <input
                  type="text"
                  placeholder="Nama jalan / komplek / blok"
                  value={newCustAddress}
                  onChange={(e) => setNewCustAddress(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewCustomerModalOpen(false)}
                  className="flex-1 py-2.5 rounded-lg bg-slate-100 font-semibold text-slate-700 hover:bg-slate-200 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-lg bg-sky-600 text-white font-semibold hover:bg-sky-700 transition"
                >
                  Simpan & Pilih
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Completed Order Thermal Receipt Modal */}
      {lastCompletedOrder && (
        <ThermalReceipt
          order={lastCompletedOrder}
          branch={lastCompletedOrder.branch || currentBranch}
          customer={lastCompletedOrder.customer || selectedCustomer || customers[0]}
          isOpen={isReceiptModalOpen}
          onClose={() => setReceiptModalOpen(false)}
        />
      )}
    </div>
  );
};
