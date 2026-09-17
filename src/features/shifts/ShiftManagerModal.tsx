import React, { useState, useEffect } from 'react';
import { usePosStore } from '../../core/store/posStore';
import { repository } from '../../core/services/repository';
import { CashierShift } from '../../core/types/database';
import { formatIDR, parseIDR } from '../../core/utils/currency';
import { X, DollarSign, AlertTriangle, CheckCircle2, Lock } from 'lucide-react';

interface ShiftManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ShiftManagerModal: React.FC<ShiftManagerModalProps> = ({ isOpen, onClose }) => {
  const { currentBranch, currentUser } = usePosStore();
  const [activeShift, setActiveShift] = useState<CashierShift | null>(null);
  const [loading, setLoading] = useState(false);

  // Open Shift Form State
  const [openingCashInput, setOpeningCashInput] = useState('150000');
  
  // Close Shift Form State (Blind Cash Count)
  const [actualCashInput, setActualCashInput] = useState('');
  const [shiftNotes, setShiftNotes] = useState('');
  const [showVariance, setShowVariance] = useState(false);

  const fetchActiveShift = async () => {
    if (!currentBranch) return;
    setLoading(true);
    try {
      const shift = await repository.getActiveShift(currentBranch.id);
      setActiveShift(shift);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchActiveShift();
      setShowVariance(false);
      setActualCashInput('');
    }
  }, [isOpen, currentBranch]);

  if (!isOpen) return null;

  const handleOpenShift = async () => {
    const openingCash = parseIDR(openingCashInput);
    setLoading(true);
    try {
      const newShift = await repository.openShift({
        organization_id: currentBranch.organization_id,
        branch_id: currentBranch.id,
        cashier_id: currentUser.id,
        opening_cash: openingCash,
        expected_cash: openingCash,
        status: 'OPEN',
        notes: 'Shift dimulai oleh ' + currentUser.full_name,
      });
      setActiveShift(newShift);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleCloseShift = async () => {
    if (!activeShift) return;
    const actualCash = parseIDR(actualCashInput);
    setShowVariance(true);

    if (confirm(`Konfirmasi tutup shift?\nUang Fisik Dihitung: ${formatIDR(actualCash)}\nEstimasi Sistem: ${formatIDR(activeShift.expected_cash)}\nSelisih: ${formatIDR(actualCash - activeShift.expected_cash)}`)) {
      setLoading(true);
      try {
        await repository.closeShift(activeShift.id, actualCash, shiftNotes);
        setActiveShift(null);
        onClose();
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center font-bold">
              <DollarSign className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-slate-900 text-base">Manajemen Shift Kasir</h2>
              <p className="text-xs text-slate-500">{currentBranch?.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6">
          {loading ? (
            <div className="text-center py-8 text-slate-500 text-sm">Memuat data shift...</div>
          ) : activeShift ? (
            /* ACTIVE SHIFT VIEW -> CLOSE SHIFT */
            <div className="space-y-5">
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-emerald-800">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    Status: Shift Aktif
                  </span>
                  <span>Mulai: {new Date(activeShift.opened_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB</span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-emerald-100 text-xs">
                  <div>
                    <span className="text-slate-500">Modal Kas Awal:</span>
                    <p className="font-bold text-slate-900 text-sm">{formatIDR(activeShift.opening_cash)}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Estimasi Kas di Laci:</span>
                    <p className="font-bold text-emerald-700 text-sm">{formatIDR(activeShift.expected_cash)}</p>
                  </div>
                </div>
              </div>

              {/* Blind Cash Input */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Hitung Uang Fisik di Laci (Blind Cash Count)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-3 text-slate-400 font-bold text-sm">Rp</span>
                  <input
                    type="number"
                    value={actualCashInput}
                    onChange={(e) => setActualCashInput(e.target.value)}
                    placeholder="Masukkan jumlah uang fisik di laci"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 font-mono font-bold text-base focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden"
                  />
                </div>
                <p className="text-[11px] text-slate-500">
                  * Hitung seluruh uang kertas & logam di kasir sebelum menekan tutup shift.
                </p>
              </div>

              {actualCashInput && (
                <div className="p-3 rounded-lg bg-slate-100 text-xs space-y-1">
                  <div className="flex justify-between text-slate-600">
                    <span>Estimasi Sistem:</span>
                    <span>{formatIDR(activeShift.expected_cash)}</span>
                  </div>
                  <div className="flex justify-between font-bold">
                    <span>Uang Fisik Dihitung:</span>
                    <span>{formatIDR(parseIDR(actualCashInput))}</span>
                  </div>
                  {parseIDR(actualCashInput) - activeShift.expected_cash !== 0 ? (
                    <div className="flex justify-between font-bold text-rose-600 pt-1 border-t border-slate-200">
                      <span>Selisih Kas:</span>
                      <span>{formatIDR(parseIDR(actualCashInput) - activeShift.expected_cash)}</span>
                    </div>
                  ) : (
                    <div className="flex justify-between font-bold text-emerald-600 pt-1 border-t border-slate-200">
                      <span>Status Kas:</span>
                      <span>Sesuai (Seimbang Rp 0)</span>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Catatan Rekonsiliasi (Opsional)</label>
                <input
                  type="text"
                  value={shiftNotes}
                  onChange={(e) => setShiftNotes(e.target.value)}
                  placeholder="Misal: Uang kembalian koin kurang Rp 500"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 outline-hidden"
                />
              </div>

              <button
                onClick={handleCloseShift}
                disabled={!actualCashInput}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-semibold text-sm transition shadow-sm"
              >
                <Lock className="w-4 h-4" />
                <span>Tutup Shift & Rekonsiliasi</span>
              </button>
            </div>
          ) : (
            /* NO ACTIVE SHIFT -> OPEN SHIFT */
            <div className="space-y-5">
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900">
                  <p className="font-bold">Kasir Belum Membuka Shift</p>
                  <p className="text-amber-700 mt-0.5">
                    Buka shift baru dengan memasukkan saldo kas awal laci (uang kembalian) untuk mulai bertransaksi.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Modal Kas Awal Laci (Kembalian)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-3 text-slate-400 font-bold text-sm">Rp</span>
                  <input
                    type="number"
                    value={openingCashInput}
                    onChange={(e) => setOpeningCashInput(e.target.value)}
                    placeholder="150000"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 font-mono font-bold text-base focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  {[100000, 150000, 200000, 300000].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setOpeningCashInput(preset.toString())}
                      className="px-2.5 py-1 text-xs rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition"
                    >
                      {formatIDR(preset)}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleOpenShift}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-semibold text-sm transition shadow-sm"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Buka Shift Sekarang</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
