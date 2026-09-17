import React, { useState, useEffect, useMemo } from 'react';
import { usePosStore } from '../../core/store/posStore';
import {
  useReceiveTransitManifest,
  formatPresentationError,
} from '../../core/presentation/query';
import {
  TransitManifest,
  TransitManifestItemStatus,
} from '../../core/types/database';
import {
  X,
  PackageCheck,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileText,
  HelpCircle,
} from 'lucide-react';

interface ReceiveManifestModalProps {
  isOpen: boolean;
  manifest: TransitManifest;
  onClose: () => void;
  onSuccess?: (updatedManifest: TransitManifest) => void;
}

interface ItemReviewState {
  status: TransitManifestItemStatus;
  notes: string;
}

export const ReceiveManifestModal: React.FC<ReceiveManifestModalProps> = ({
  isOpen,
  manifest,
  onClose,
  onSuccess,
}) => {
  const { currentUser } = usePosStore();
  const items = manifest.items || [];

  // Local review state mapped by orderId
  const [reviews, setReviews] = useState<Record<string, ItemReviewState>>({});
  const [globalSummaryNotes, setGlobalSummaryNotes] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);
  const [showConfirmDiscrepancy, setShowConfirmDiscrepancy] = useState<boolean>(false);

  const receiveMutation = useReceiveTransitManifest();

  // Initialize review items to EXPECTED when modal opens
  useEffect(() => {
    if (isOpen) {
      const initial: Record<string, ItemReviewState> = {};
      items.forEach((item) => {
        initial[item.order_id] = {
          status: 'EXPECTED',
          notes: item.discrepancy_notes || '',
        };
      });
      setReviews(initial);
      setGlobalSummaryNotes('');
      setFormError(null);
      setShowConfirmDiscrepancy(false);
    }
  }, [isOpen, manifest]);

  // Compute breakdown of review statuses
  const counts = useMemo(() => {
    let ok = 0;
    let missing = 0;
    let damaged = 0;
    let wrongBranch = 0;
    let expected = 0;

    Object.values(reviews).forEach((r) => {
      switch (r.status) {
        case 'RECEIVED_OK':
          ok++;
          break;
        case 'MISSING':
          missing++;
          break;
        case 'DAMAGED':
          damaged++;
          break;
        case 'WRONG_BRANCH':
          wrongBranch++;
          break;
        case 'EXPECTED':
        default:
          expected++;
          break;
      }
    });

    const hasDiscrepancy = missing > 0 || damaged > 0 || wrongBranch > 0 || expected > 0;
    return { ok, missing, damaged, wrongBranch, expected, hasDiscrepancy, total: items.length };
  }, [reviews, items.length]);

  if (!isOpen) return null;

  // Quick Action: Mark all items as RECEIVED_OK
  const handleMarkAllOk = () => {
    const next: Record<string, ItemReviewState> = {};
    items.forEach((item) => {
      next[item.order_id] = {
        status: 'RECEIVED_OK',
        notes: '',
      };
    });
    setReviews(next);
  };

  const handleStatusChange = (orderId: string, status: TransitManifestItemStatus) => {
    setReviews((prev) => ({
      ...prev,
      [orderId]: {
        ...prev[orderId],
        status,
      },
    }));
  };

  const handleNotesChange = (orderId: string, notes: string) => {
    setReviews((prev) => ({
      ...prev,
      [orderId]: {
        ...prev[orderId],
        notes,
      },
    }));
  };

  const executeSubmit = async () => {
    setFormError(null);
    try {
      const itemsReviewPayload = items.map((item) => {
        const rev = reviews[item.order_id] || { status: 'EXPECTED', notes: '' };
        return {
          orderId: item.order_id,
          status: rev.status,
          notes: rev.notes.trim() || undefined,
        };
      });

      const updated = await receiveMutation.mutateAsync({
        manifestId: manifest.id,
        itemsReview: itemsReviewPayload,
        summaryNotes: globalSummaryNotes.trim() || undefined,
        actorId: currentUser?.id,
      });

      onClose();
      if (onSuccess) {
        onSuccess(updated);
      }
    } catch (err) {
      const formatted = formatPresentationError(err);
      setFormError(`${formatted.title}: ${formatted.message}`);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // If there is discrepancy or unreviewed items, show confirmation alert first
    if (counts.hasDiscrepancy && !showConfirmDiscrepancy) {
      setShowConfirmDiscrepancy(true);
      return;
    }

    executeSubmit();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="receive-manifest-modal-title"
    >
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
              <PackageCheck className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="receive-manifest-modal-title"
                className="font-extrabold text-slate-900 text-base sm:text-lg"
              >
                Penerimaan & Inspeksi Fisik Cucian
              </h2>
              <p className="text-xs text-slate-500">
                Manifest: <span className="font-mono font-bold text-slate-700">{manifest.manifest_number}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup dialog"
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error Banner */}
        {formError && (
          <div
            className="mx-6 mt-4 p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-800"
            role="alert"
          >
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1">{formError}</div>
          </div>
        )}

        {/* Quick Action & Breakdown Bar */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="font-bold text-slate-700">Total: {counts.total} Nota</span>
            <span className="text-slate-300">|</span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold text-[11px]">
              Sesuai: {counts.ok}
            </span>
            {counts.missing > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-semibold text-[11px]">
                Hilang: {counts.missing}
              </span>
            )}
            {counts.damaged > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold text-[11px]">
                Rusak: {counts.damaged}
              </span>
            )}
            {counts.wrongBranch > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-semibold text-[11px]">
                Salah Cabang: {counts.wrongBranch}
              </span>
            )}
            {counts.expected > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-semibold text-[11px]">
                Belum Diperiksa: {counts.expected}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={handleMarkAllOk}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 shrink-0 shadow-2xs"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Semua Sesuai</span>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Discrepancy Alert Warning */}
          {counts.hasDiscrepancy && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Perhatian Selisih Fisik:</span>
                {counts.expected > 0 ? (
                  <span>
                    {' '}Terdapat {counts.expected} nota yang belum diperiksa. Sesuai aturan sistem, nota yang masih EXPECTED otomatis dicatat sebagai MISSING (Hilang).
                  </span>
                ) : (
                  <span>
                    {' '}Terdapat catatan ketidaksesuaian barang. Manifest akan dicatat memiliki selisih fisik permanen dalam audit trail.
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Items Checklist Table */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
              {items.map((item) => {
                const rev = reviews[item.order_id] || {
                  status: 'EXPECTED',
                  notes: '',
                };
                const isIssue =
                  rev.status === 'MISSING' ||
                  rev.status === 'DAMAGED' ||
                  rev.status === 'WRONG_BRANCH';

                return (
                  <div
                    key={item.id}
                    className={`p-3.5 space-y-2 transition ${
                      isIssue
                        ? 'bg-rose-50/40'
                        : rev.status === 'RECEIVED_OK'
                        ? 'bg-emerald-50/30'
                        : 'bg-white'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-bold text-slate-900 font-mono flex items-center gap-2">
                          <span>{item.order?.order_number || item.order_id}</span>
                          <span className="font-sans font-normal text-slate-500 text-[11px]">
                            Pelanggan: <strong className="text-slate-700">{item.order?.customer?.name || 'Umum'}</strong>
                          </span>
                        </div>
                      </div>

                      {/* Status Selector Button Group */}
                      <div className="flex items-center gap-1 flex-wrap">
                        <button
                          type="button"
                          onClick={() => handleStatusChange(item.order_id, 'RECEIVED_OK')}
                          className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition ${
                            rev.status === 'RECEIVED_OK'
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          Sesuai (OK)
                        </button>

                        <button
                          type="button"
                          onClick={() => handleStatusChange(item.order_id, 'MISSING')}
                          className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition ${
                            rev.status === 'MISSING'
                              ? 'bg-rose-600 text-white border-rose-600'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-rose-50'
                          }`}
                        >
                          Hilang
                        </button>

                        <button
                          type="button"
                          onClick={() => handleStatusChange(item.order_id, 'DAMAGED')}
                          className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition ${
                            rev.status === 'DAMAGED'
                              ? 'bg-amber-600 text-white border-amber-600'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-amber-50'
                          }`}
                        >
                          Rusak
                        </button>

                        <button
                          type="button"
                          onClick={() => handleStatusChange(item.order_id, 'WRONG_BRANCH')}
                          className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition ${
                            rev.status === 'WRONG_BRANCH'
                              ? 'bg-purple-600 text-white border-purple-600'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-purple-50'
                          }`}
                        >
                          Salah Cabang
                        </button>
                      </div>
                    </div>

                    {/* Discrepancy Note Input (Shown if not RECEIVED_OK) */}
                    {rev.status !== 'RECEIVED_OK' && (
                      <div className="pt-1">
                        <input
                          type="text"
                          value={rev.notes}
                          onChange={(e) => handleNotesChange(item.order_id, e.target.value)}
                          placeholder="Catatan kendala (opsional, cth: karung sobek, nota tidak ada di mobil)..."
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:ring-1 focus:ring-sky-500 outline-hidden"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Global Summary Notes */}
          <div>
            <label
              htmlFor="global-receive-notes"
              className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
            >
              Catatan Berita Acara Penerimaan (Opsional)
            </label>
            <input
              id="global-receive-notes"
              type="text"
              value={globalSummaryNotes}
              onChange={(e) => setGlobalSummaryNotes(e.target.value)}
              placeholder="Contoh: Diterima oleh tim shift siang workshop Tambun"
              className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs font-medium text-slate-800 focus:ring-1 focus:ring-sky-500 outline-hidden"
            />
          </div>

          {/* Confirmation Notice for Discrepancy before Final Submit */}
          {showConfirmDiscrepancy && (
            <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl flex items-center justify-between gap-3 text-xs text-rose-900">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>
                  Konfirmasi selisih: Anda yakin ingin menutup surat jalan ini dengan selisih fisik?
                </span>
              </div>
              <button
                type="button"
                onClick={executeSubmit}
                disabled={receiveMutation.isPending}
                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition shrink-0"
              >
                Ya, Konfirmasi Penerimaan
              </button>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={receiveMutation.isPending}
              className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition disabled:opacity-50"
            >
              Batal
            </button>

            {!showConfirmDiscrepancy && (
              <button
                type="submit"
                disabled={receiveMutation.isPending}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-extrabold shadow-md shadow-emerald-500/20 transition flex items-center gap-2 disabled:opacity-50"
              >
                {receiveMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Memproses Penerimaan...</span>
                  </>
                ) : (
                  <>
                    <PackageCheck className="w-4 h-4" />
                    <span>Selesaikan Penerimaan Manifest</span>
                  </>
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
