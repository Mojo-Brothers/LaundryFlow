import React from 'react';
import { Order, Branch, Customer } from '../../core/types/database';
import { formatIDR } from '../../core/utils/currency';
import { Printer, Share2, X, CheckCircle2 } from 'lucide-react';
import { notificationService } from '../../core/services/notification';

interface ThermalReceiptProps {
  order: Order;
  branch: Branch;
  customer: Customer;
  isOpen: boolean;
  onClose: () => void;
}

export const ThermalReceipt: React.FC<ThermalReceiptProps> = ({
  order,
  branch,
  customer,
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  const handleSendWhatsApp = () => {
    const msg = notificationService.buildNewOrderMessage(order, customer, branch.name);
    notificationService.launchWhatsApp(customer.phone, msg);
  };

  const trackingUrl = `${window.location.origin}/track/${order.tracking_token}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-8">
        {/* Header Action Bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2 text-emerald-600 font-semibold text-sm">
            <CheckCircle2 className="w-5 h-5" />
            <span>Transaksi Berhasil</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Printable Thermal Receipt Box */}
        <div className="p-6 overflow-x-hidden">
          <div
            id="thermal-receipt"
            className="bg-white p-4 border border-dashed border-slate-300 rounded-xl font-mono text-xs text-slate-800"
          >
            {/* Business Header */}
            <div className="text-center pb-3 border-b border-dashed border-slate-300">
              <h2 className="text-base font-bold tracking-tight text-slate-900 uppercase">
                LaundryFlow
              </h2>
              <p className="font-semibold text-slate-700">{branch.name}</p>
              <p className="text-[10px] text-slate-500">{branch.address || 'Bekasi, Jawa Barat'}</p>
              <p className="text-[10px] text-slate-500">WA: {branch.phone || '0812-9988-7711'}</p>
            </div>

            {/* Order Metadata */}
            <div className="py-2.5 border-b border-dashed border-slate-300 space-y-0.5 text-[11px]">
              <div className="flex justify-between font-bold">
                <span>No. Nota:</span>
                <span>{order.order_number}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Tanggal:</span>
                <span>{new Date(order.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Pelanggan:</span>
                <span className="font-semibold">{customer.name}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>No. HP:</span>
                <span>{customer.phone}</span>
              </div>
            </div>

            {/* Items List */}
            <div className="py-3 border-b border-dashed border-slate-300 space-y-2">
              <div className="flex justify-between font-bold text-[10px] text-slate-500 uppercase border-b border-slate-200 pb-1">
                <span>Layanan / Item</span>
                <span>Subtotal</span>
              </div>
              {order.items?.map((item, idx) => (
                <div key={idx} className="space-y-0.5">
                  <div className="flex justify-between font-semibold">
                    <span className="truncate pr-2">{item.service_name_snap}</span>
                    <span>{formatIDR(item.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>
                      {item.billable_weight} {item.item_type === 'KILOAN' ? 'KG' : 'PCS'} @ {formatIDR(item.unit_price_snap)}
                    </span>
                    {item.notes && <span className="italic text-[9px]">({item.notes})</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* Financial Summary */}
            <div className="py-2.5 border-b border-dashed border-slate-300 space-y-1 text-[11px]">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal:</span>
                <span>{formatIDR(order.subtotal)}</span>
              </div>
              {order.discount_amount > 0 && (
                <div className="flex justify-between text-emerald-600">
                  <span>Diskon:</span>
                  <span>-{formatIDR(order.discount_amount)}</span>
                </div>
              )}
              {order.delivery_fee > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Ongkos Kirim:</span>
                  <span>+{formatIDR(order.delivery_fee)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-sm text-slate-900 pt-1 border-t border-slate-200">
                <span>TOTAL:</span>
                <span>{formatIDR(order.final_amount)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Bayar:</span>
                <span>{formatIDR(order.paid_amount)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Sisa Tagihan:</span>
                <span className={order.remaining_amount === 0 ? 'text-emerald-600' : 'text-rose-600'}>
                  {order.remaining_amount === 0 ? 'LUNAS' : formatIDR(order.remaining_amount)}
                </span>
              </div>
            </div>

            {/* Estimated SLA & QR Tracking */}
            <div className="pt-3 text-center space-y-2">
              <div className="bg-slate-50 p-2 rounded border border-slate-200">
                <p className="text-[10px] text-slate-500">Estimasi Selesai:</p>
                <p className="font-bold text-xs text-sky-700">
                  {new Date(order.promised_ready_at).toLocaleDateString('id-ID', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })} WIB
                </p>
              </div>

              <div className="text-[9px] text-slate-500 pt-1">
                <p>Lacak cucian Anda online:</p>
                <p className="font-mono text-slate-700 font-semibold truncate select-all">{trackingUrl}</p>
              </div>

              <p className="text-[8px] text-slate-400 pt-1 leading-tight">
                * Pakaian tidak diambil &gt; 30 hari di luar tanggung jawab laundry.
                <br />
                Terima kasih atas kepercayaan Anda!
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-3 mt-5">
            <button
              onClick={handlePrint}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-slate-900 text-white hover:bg-slate-800 font-medium text-sm transition shadow-sm active:scale-98"
            >
              <Printer className="w-4 h-4" />
              <span>Cetak Struk (58mm)</span>
            </button>
            <button
              onClick={handleSendWhatsApp}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 font-medium text-sm transition shadow-sm active:scale-98"
            >
              <Share2 className="w-4 h-4" />
              <span>Kirim WhatsApp</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
