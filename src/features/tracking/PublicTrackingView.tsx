import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { repository } from '../../core/services/repository';
import { PublicTrackingData, OrderStatus } from '../../core/types/database';
import { formatIDR } from '../../core/utils/currency';
import {
  Sparkles,
  CheckCircle2,
  Clock,
  Shirt,
  ShieldCheck,
  MapPin,
  Store,
} from 'lucide-react';

export const PublicTrackingView: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [order, setOrder] = useState<PublicTrackingData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      repository.getOrderByTrackingToken(token).then((res) => {
        setOrder(res);
        setLoading(false);
      });
    }
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 text-sm">
        Memuat status cucian...
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold text-xl mb-4">
          ?
        </div>
        <h1 className="text-xl font-bold text-slate-900">Pesanan Tidak Ditemukan</h1>
        <p className="text-xs text-slate-500 mt-2 max-w-sm">
          Token pelacakan tidak valid atau telah kedaluwarsa. Silakan hubungi kasir outlet laundry Anda.
        </p>
        <Link
          to="/"
          className="mt-6 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 transition"
        >
          Kembali ke Beranda
        </Link>
      </div>
    );
  }

  const steps: { status: OrderStatus; label: string; desc: string }[] = [
    { status: 'RECEIVED', label: 'Diterima', desc: 'Pakaian ditimbang dan diberi tag nota' },
    { status: 'WASHING', label: 'Sedang Dicuci', desc: 'Pencucian higienis & pengeringan suhu terkontrol' },
    { status: 'READY', label: 'Siap Diambil', desc: 'Pakaian sudah disetrika rapi & dipacking' },
    { status: 'COMPLETED', label: 'Selesai', desc: 'Sudah diserahkan kepada pelanggan' },
  ];

  const getStepState = (stepStatus: OrderStatus) => {
    const orderRanks: Record<string, number> = {
      RECEIVED: 1,
      SORTING: 2,
      WASHING: 2,
      DRYING: 2,
      IRONING: 2,
      PACKING: 2,
      QC: 2,
      READY: 3,
      PICKED_UP: 4,
      DELIVERED: 4,
      COMPLETED: 4,
    };

    const currentRank = orderRanks[order.status] || 1;
    const stepRank = orderRanks[stepStatus] || 1;

    if (currentRank > stepRank) return 'COMPLETED';
    if (currentRank === stepRank) return 'CURRENT';
    return 'PENDING';
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50/50 via-slate-50 to-white text-slate-900 py-10 px-4 sm:px-6">
      <div className="max-w-xl mx-auto space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-1">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-lg shadow-sky-600/20 mb-2">
            <Sparkles className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-black text-slate-900">LaundryFlow Tracking</h1>
          <p className="text-xs text-slate-500 font-medium">
            Layanan Pelacakan Cucian Transparan &amp; Realtime
          </p>
        </div>

        {/* Status Card */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
          {/* Top Banner Status */}
          <div className={`p-6 text-center ${order.status === 'READY' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-white'}`}>
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-300">
              No. Nota Cucian
            </span>
            <h2 className="text-2xl font-black font-mono mt-1 tracking-tight">{order.order_number}</h2>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 mt-3 rounded-full text-xs font-bold bg-white/20 backdrop-blur-xs">
              <Clock className="w-3.5 h-3.5" />
              <span>
                {order.status === 'READY'
                  ? 'Siap Diambil di Outlet'
                  : `Estimasi Selesai: ${new Date(order.promised_ready_at).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' })}`}
              </span>
            </div>
          </div>

          {/* Timeline Lifecycle */}
          <div className="p-6 space-y-6">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Progres Pengerjaan
            </h3>
            <div className="space-y-6 relative before:absolute before:left-3.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
              {steps.map((step, idx) => {
                const state = getStepState(step.status);
                return (
                  <div key={idx} className="relative flex items-start gap-4">
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 font-bold text-xs transition ${
                        state === 'COMPLETED'
                          ? 'bg-emerald-600 text-white shadow-xs'
                          : state === 'CURRENT'
                          ? 'bg-sky-600 text-white ring-4 ring-sky-100 shadow-xs'
                          : 'bg-slate-200 text-slate-400'
                      }`}
                    >
                      {state === 'COMPLETED' ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
                    </div>
                    <div>
                      <h4 className={`text-sm font-bold ${state === 'CURRENT' ? 'text-sky-700' : 'text-slate-800'}`}>
                        {step.label}
                      </h4>
                      <p className="text-xs text-slate-500 mt-0.5">{step.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Order Items & Price Snapshot */}
            <div className="pt-6 border-t border-slate-100 space-y-3">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Detail Item Pakaian
              </h3>
              <div className="divide-y divide-slate-100 bg-slate-50 rounded-2xl p-4 text-xs">
                {order.items?.map((item: any, i: number) => (
                  <div key={i} className="py-2 first:pt-0 last:pb-0 flex justify-between">
                    <div>
                      <p className="font-bold text-slate-900">{item.service_name || item.service_name_snap}</p>
                      <p className="text-[11px] text-slate-500">
                        {item.billable_weight} {item.item_type === 'KILOAN' ? 'KG' : 'PCS'}
                      </p>
                    </div>
                    <span className="font-mono font-bold text-slate-800">{formatIDR(item.subtotal)}</span>
                  </div>
                ))}
              </div>

              {/* Tagihan Summary */}
              <div className="p-4 bg-slate-100 rounded-2xl space-y-1.5 text-xs">
                <div className="flex justify-between font-bold text-sm text-slate-900">
                  <span>Total Tagihan:</span>
                  <span className="font-mono text-sky-700">{formatIDR(order.final_amount)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Status Pembayaran:</span>
                  <span className={`font-bold ${order.payment_status === 'PAID' ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {order.payment_status === 'PAID' ? 'LUNAS' : `BELUM LUNAS (Sisa: ${formatIDR(order.remaining_amount)})`}
                  </span>
                </div>
              </div>
            </div>

            {/* Location & Safe Verification */}
            <div className="p-4 rounded-2xl border border-slate-200 flex items-center gap-3 text-xs text-slate-600">
              <Store className="w-5 h-5 text-sky-600 shrink-0" />
              <div>
                <p className="font-bold text-slate-900">{order.branch_name || 'Outlet Bekasi Timur'}</p>
                <p className="text-[11px] text-slate-500">{order.branch_address || 'Bekasi, Jawa Barat'}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Security / Privacy notice */}
        <div className="text-center text-[11px] text-slate-400 flex items-center justify-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>Informasi pribadi pelanggan dienkripsi dan dilindungi UU Perlindungan Data Pribadi</span>
        </div>
      </div>
    </div>
  );
};
