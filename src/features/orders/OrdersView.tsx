import React, { useState, useEffect } from 'react';
import { repository } from '../../core/services/repository';
import { Order, OrderStatus, OrderReworkRequest, ReworkReasonCode } from '../../core/types/database';
import { formatIDR } from '../../core/utils/currency';
import { notificationService } from '../../core/services/notification';
import { usePosStore } from '../../core/store/posStore';
import {
  Search,
  CheckCircle2,
  Clock,
  Printer,
  Share2,
  ExternalLink,
  ChevronRight,
  Filter,
  RotateCcw,
  X,
  AlertCircle,
} from 'lucide-react';
import { ThermalReceipt } from '../../components/pos/ThermalReceipt';

export const OrdersView: React.FC = () => {
  const { currentBranch, currentUser } = usePosStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [activeReceiptOrder, setActiveReceiptOrder] = useState<Order | null>(null);

  // Rework Request State
  const [reworkModalOrder, setReworkModalOrder] = useState<Order | null>(null);
  const [reworkReason, setReworkReason] = useState<ReworkReasonCode>('CUSTOMER_COMPLAINT');
  const [reworkNotes, setReworkNotes] = useState('');
  const [reworkError, setReworkError] = useState<string | null>(null);
  const [reworkSuccess, setReworkSuccess] = useState<string | null>(null);
  const [activeReworkMap, setActiveReworkMap] = useState<Record<string, OrderReworkRequest | null>>({});

  const loadOrders = async () => {
    const list = await repository.getOrders();
    setOrders(list);

    // Load active rework requests for orders
    const map: Record<string, OrderReworkRequest | null> = {};
    for (const o of list) {
      map[o.id] = await repository.getActiveOrderReworkRequest(o.id);
    }
    setActiveReworkMap(map);
  };

  useEffect(() => {
    loadOrders();
  }, [currentBranch]);

  const handleAdvanceStatus = async (order: Order, nextStatus: OrderStatus) => {
    await repository.updateOrderStatus(order.id, nextStatus, currentUser.id);
    await loadOrders();
  };

  const handleSendWhatsApp = (order: Order) => {
    if (!order.customer) return;
    const msg = order.status === 'READY'
      ? notificationService.buildOrderReadyMessage(order, order.customer, order.branch?.name || currentBranch.name)
      : notificationService.buildNewOrderMessage(order, order.customer, order.branch?.name || currentBranch.name);
    notificationService.launchWhatsApp(order.customer.phone, msg);
  };

  const filteredOrders = orders.filter((o) => {
    const matchesSearch =
      o.order_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      o.customer?.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      o.customer?.phone.includes(searchQuery);

    const matchesStatus = selectedStatus === 'ALL' || o.status === selectedStatus;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'RECEIVED':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'WASHING':
      case 'SORTING':
      case 'DRYING':
      case 'IRONING':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'READY':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'PICKED_UP':
      case 'COMPLETED':
        return 'bg-slate-100 text-slate-700 border-slate-200';
      case 'CANCELLED':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const handleOpenReworkModal = (order: Order) => {
    setReworkModalOrder(order);
    setReworkReason('CUSTOMER_COMPLAINT');
    setReworkNotes('');
    setReworkError(null);
    setReworkSuccess(null);
  };

  const handleCreateReworkRequest = async () => {
    if (!reworkModalOrder) return;
    setReworkError(null);
    try {
      await repository.createOrderReworkRequest(
        {
          order_id: reworkModalOrder.id,
          reason: reworkReason,
          notes: reworkNotes.trim() || null,
        },
        currentUser.id
      );
      setReworkSuccess('Otorisasi Rework berhasil diterbitkan (APPROVED). Order siap dikirim outbound.');
      await loadOrders();
      setTimeout(() => {
        setReworkModalOrder(null);
        setReworkSuccess(null);
      }, 1500);
    } catch (err: any) {
      setReworkError(err.message || 'Gagal mengajukan rework.');
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
            Daftar Pesanan & Status Nota
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Kelola status cucian, lacak SLA, dan kirim notifikasi WhatsApp ke pelanggan
          </p>
        </div>

        {/* Status Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full">
          {['ALL', 'RECEIVED', 'WASHING', 'READY', 'COMPLETED'].map((st) => (
            <button
              key={st}
              onClick={() => setSelectedStatus(st)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition shrink-0 ${
                selectedStatus === st
                  ? 'bg-sky-600 text-white border-sky-600 shadow-xs'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {st === 'ALL' ? 'Semua' : st}
            </button>
          ))}
        </div>
      </div>

      {/* Search Input Bar */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Cari nomor nota (BKS-...), nama pelanggan, atau nomor HP..."
          className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 text-sm bg-white focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden shadow-2xs"
        />
      </div>

      {/* Orders Table & Cards */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        {filteredOrders.length === 0 ? (
          <div className="py-16 text-center text-slate-400 text-xs">
            Tidak ada pesanan yang sesuai dengan filter.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredOrders.map((order) => (
              <div
                key={order.id}
                className="p-4 sm:p-5 hover:bg-slate-50 transition flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs"
              >
                {/* Left: Order Info & Customer */}
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm text-slate-900">{order.order_number}</span>
                    <span className={`px-2 py-0.5 rounded-md font-bold text-[10px] border ${getStatusBadge(order.status)}`}>
                      {order.status}
                    </span>
                    <span className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${order.payment_status === 'PAID' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                      {order.payment_status}
                    </span>
                    {activeReworkMap[order.id] && (
                      <span className="px-2 py-0.5 rounded-md font-bold text-[10px] bg-purple-100 text-purple-800 border border-purple-200 flex items-center gap-1">
                        <RotateCcw className="w-2.5 h-2.5" /> Rework Approved
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-slate-600">
                    <span className="font-semibold text-slate-800">{order.customer?.name}</span>
                    <span>•</span>
                    <span>{order.customer?.phone}</span>
                    <span>•</span>
                    <span>Masuk: {new Date(order.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>

                  {/* Order Items Preview */}
                  <div className="text-[11px] text-slate-500">
                    {order.items?.map((i) => `${i.service_name_snap} (${i.billable_weight} ${i.item_type === 'KILOAN' ? 'KG' : 'PCS'})`).join(', ')}
                  </div>
                </div>

                {/* Right: Amounts & Quick Actions */}
                <div className="flex items-center justify-between md:justify-end gap-4 shrink-0">
                  <div className="text-right">
                    <p className="font-mono font-bold text-sm text-slate-900">{formatIDR(order.final_amount)}</p>
                    <p className="text-[10px] text-slate-400">
                      SLA: {new Date(order.promised_ready_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>

                  {/* Actions Bar */}
                  <div className="flex items-center gap-2">
                    {/* Status Stepper Button */}
                    {order.status === 'RECEIVED' && (
                      <button
                        onClick={() => handleAdvanceStatus(order, 'WASHING')}
                        className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs transition"
                      >
                        Cuci
                      </button>
                    )}
                    {order.status === 'WASHING' && (
                      <button
                        onClick={() => handleAdvanceStatus(order, 'READY')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition"
                      >
                        Set Selesai
                      </button>
                    )}
                    {order.status === 'READY' && (
                      <button
                        onClick={() => handleAdvanceStatus(order, 'COMPLETED')}
                        className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition"
                      >
                        Diambil
                      </button>
                    )}

                    {/* Rework Button for non-terminal orders without active rework */}
                    {!activeReworkMap[order.id] &&
                      ['OWNER', 'ADMIN', 'MANAGER', 'BRANCH_MANAGER', 'CASHIER'].includes(currentUser?.role) &&
                      !['CANCELLED', 'COMPLETED'].includes(order.status) && (
                        <button
                          onClick={() => handleOpenReworkModal(order)}
                          className="px-2 py-1.5 rounded-lg text-purple-700 hover:bg-purple-50 border border-purple-200 transition flex items-center gap-1 text-xs font-semibold"
                          title="Ajukan Cuci Ulang / Rework"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Rework</span>
                        </button>
                      )}

                    {/* WhatsApp Launcher */}
                    <button
                      onClick={() => handleSendWhatsApp(order)}
                      className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 border border-emerald-200 transition"
                      title="Kirim Pesan WhatsApp"
                    >
                      <Share2 className="w-4 h-4" />
                    </button>

                    {/* Reprint Receipt */}
                    <button
                      onClick={() => setActiveReceiptOrder(order)}
                      className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 border border-slate-200 transition"
                      title="Cetak Ulang Struk"
                    >
                      <Printer className="w-4 h-4" />
                    </button>

                    {/* Public Tracking Link */}
                    <a
                      href={`/track/${order.tracking_token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg text-indigo-600 hover:bg-indigo-50 border border-indigo-200 transition"
                      title="Buka Halaman Tracking Publik"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rework Request Modal */}
      {reworkModalOrder && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl border border-slate-100">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-purple-100 text-purple-700">
                  <RotateCcw className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Ajukan Cuci Ulang / Rework</h3>
                  <p className="text-xs text-slate-500 font-mono">{reworkModalOrder.order_number}</p>
                </div>
              </div>
              <button
                onClick={() => setReworkModalOrder(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {reworkError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{reworkError}</span>
              </div>
            )}

            {reworkSuccess && (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{reworkSuccess}</span>
              </div>
            )}

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Alasan Cuci Ulang / Rework</label>
                <select
                  value={reworkReason}
                  onChange={(e) => setReworkReason(e.target.value as ReworkReasonCode)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 bg-white font-medium text-slate-800 focus:ring-2 focus:ring-purple-500 outline-hidden"
                >
                  <option value="CUSTOMER_COMPLAINT">Komplain Pelanggan (CUSTOMER_COMPLAINT)</option>
                  <option value="STAIN_REMAINS">Noda Masih Tertinggal (STAIN_REMAINS)</option>
                  <option value="ODOR_REMAINS">Aroma Kurang Bersih / Apek (ODOR_REMAINS)</option>
                  <option value="WRONG_TREATMENT">Penanganan Salah / Terlewat (WRONG_TREATMENT)</option>
                  <option value="OUTLET_QC_REJECT">Ditolak QC Outlet (OUTLET_QC_REJECT)</option>
                  <option value="OTHER">Lainnya (OTHER)</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Catatan Tambahan (Opsional)</label>
                <textarea
                  value={reworkNotes}
                  onChange={(e) => setReworkNotes(e.target.value)}
                  placeholder="Deskripsikan noda atau komplain pelanggan secara spesifik..."
                  rows={3}
                  className="w-full p-2.5 rounded-xl border border-slate-300 bg-white text-slate-800 focus:ring-2 focus:ring-purple-500 outline-hidden"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setReworkModalOrder(null)}
                className="px-4 py-2 rounded-xl text-slate-600 font-bold hover:bg-slate-100 transition text-xs"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleCreateReworkRequest}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold transition text-xs flex items-center gap-1.5 shadow-xs"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Terbitkan Otorisasi Rework</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reprint Receipt Modal */}
      {activeReceiptOrder && (
        <ThermalReceipt
          order={activeReceiptOrder}
          branch={activeReceiptOrder.branch || currentBranch}
          customer={activeReceiptOrder.customer!}
          isOpen={Boolean(activeReceiptOrder)}
          onClose={() => setActiveReceiptOrder(null)}
        />
      )}
    </div>
  );
};
