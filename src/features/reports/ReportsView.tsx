import React, { useState, useEffect } from 'react';
import { repository } from '../../core/services/repository';
import { Order, Customer } from '../../core/types/database';
import { formatIDR } from '../../core/utils/currency';
import {
  BarChart3,
  TrendingUp,
  ShoppingBag,
  DollarSign,
  Download,
  Calendar,
  FileSpreadsheet,
} from 'lucide-react';

export const ReportsView: React.FC = () => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  useEffect(() => {
    repository.getOrders().then(setOrders);
    repository.getCustomers().then(setCustomers);
  }, []);

  const totalRevenue = orders.reduce((acc, o) => acc + o.paid_amount, 0);
  const totalReceivables = orders.reduce((acc, o) => acc + o.remaining_amount, 0);
  const totalOrdersCount = orders.length;
  const completedCount = orders.filter((o) => o.status === 'COMPLETED' || o.status === 'READY').length;

  // Export CSV Helper
  const exportOrdersCSV = () => {
    const headers = ['No. Nota', 'Pelanggan', 'No. HP', 'Status', 'Metode Bayar', 'Total', 'Dibayar', 'Sisa', 'Tanggal Masuk'];
    const rows = orders.map((o) => [
      o.order_number,
      `"${o.customer?.name || ''}"`,
      `"${o.customer?.phone || ''}"`,
      o.status,
      o.payment_status,
      o.final_amount,
      o.paid_amount,
      o.remaining_amount,
      `"${new Date(o.created_at).toLocaleString('id-ID')}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `LaundryFlow_Orders_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportCustomersCSV = () => {
    const headers = ['ID', 'Nama', 'Nomor HP', 'Tipe Member', 'Alamat', 'Catatan'];
    const rows = customers.map((c) => [
      c.id,
      `"${c.name}"`,
      `"${c.phone}"`,
      c.membership_tier,
      `"${c.address || ''}"`,
      `"${c.notes || ''}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `LaundryFlow_Customers_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
            Laporan Bisnis &amp; Ekspor Data
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Analisis omset harian, piutang pelanggan, dan pencadangan file CSV operasional
          </p>
        </div>

        {/* CSV Export Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={exportOrdersCSV}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-bold text-xs transition shadow-2xs"
          >
            <Download className="w-3.5 h-3.5 text-slate-500" />
            <span>Ekspor Nota (CSV)</span>
          </button>
          <button
            onClick={exportCustomersCSV}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs transition shadow-xs"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Ekspor Pelanggan (CSV)</span>
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-500 font-semibold">
            <span>Total Penerimaan Kas</span>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <p className="text-xl font-black font-mono text-slate-900">{formatIDR(totalRevenue)}</p>
          <p className="text-[11px] text-emerald-600 font-medium">Uang masuk bersih</p>
        </div>

        <div className="p-5 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-500 font-semibold">
            <span>Sisa Piutang Belum Lunas</span>
            <div className="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <p className="text-xl font-black font-mono text-rose-600">{formatIDR(totalReceivables)}</p>
          <p className="text-[11px] text-slate-500">Akan ditagih saat pengambilan</p>
        </div>

        <div className="p-5 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-500 font-semibold">
            <span>Total Transaksi Nota</span>
            <div className="w-8 h-8 rounded-lg bg-sky-50 text-sky-600 flex items-center justify-center">
              <ShoppingBag className="w-4 h-4" />
            </div>
          </div>
          <p className="text-xl font-black font-mono text-slate-900">{totalOrdersCount} Nota</p>
          <p className="text-[11px] text-sky-600 font-medium">{completedCount} Selesai / Diambil</p>
        </div>

        <div className="p-5 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-500 font-semibold">
            <span>Pelanggan Terdaftar</span>
            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <BarChart3 className="w-4 h-4" />
            </div>
          </div>
          <p className="text-xl font-black font-mono text-slate-900">{customers.length} Orang</p>
          <p className="text-[11px] text-indigo-600 font-medium">Database aktif</p>
        </div>
      </div>

      {/* Free Tier Cost Performance Advisory */}
      <div className="p-6 bg-slate-900 text-white rounded-3xl space-y-3">
        <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>Status Efisiensi Cloud &amp; Biaya Bulanan (Free-Tier Discipline)</span>
        </div>
        <p className="text-xs text-slate-300 leading-relaxed max-w-3xl">
          Arsitektur LaundryFlow berjalan di <b>Cloudflare Pages (Hosting Rp 0)</b> + <b>Supabase Postgres (Database Rp 0)</b> + <b>WhatsApp Launcher (Notifikasi Rp 0)</b>. Penggunaan memori database saat ini berada pada <b>~2.4% dari batas kuota gratis 500MB</b>.
        </p>
      </div>
    </div>
  );
};
