import React, { useState, useEffect } from 'react';
import { repository } from '../../core/services/repository';
import { Order, OrderStatus } from '../../core/types/database';
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
} from 'lucide-react';
import { ThermalReceipt } from '../../components/pos/ThermalReceipt';

export const OrdersView: React.FC = () => {
  const { currentBranch, currentUser } = usePosStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [activeReceiptOrder, setActiveReceiptOrder] = useState<Order | null>(null);

  const loadOrders = async () => {
    const list = await repository.getOrders();
    setOrders(list);
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
