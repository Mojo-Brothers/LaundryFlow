import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  useTransitManifest,
  useTransitManifestHistory,
  useTransitionTransitManifest,
  formatPresentationError,
} from '../../core/presentation/query';
import { usePosStore } from '../../core/store/posStore';
import { ManifestStatusBadge } from './components/ManifestStatusBadge';
import { ReceiveManifestModal } from './ReceiveManifestModal';
import {
  ArrowLeft,
  Truck,
  Building2,
  Calendar,
  User,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  AlertCircle,
  PackageCheck,
  Send,
  RotateCcw,
  Ban,
} from 'lucide-react';

interface TransitDetailViewProps {
  manifestId?: string;
}

export const TransitDetailView: React.FC<TransitDetailViewProps> = ({ manifestId: propId }) => {
  const { id: routeId } = useParams<{ id: string }>();
  const manifestId = propId || routeId || '';
  const navigate = useNavigate();
  const { currentUser } = usePosStore();

  const [isReceiveModalOpen, setIsReceiveModalOpen] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: manifest,
    isLoading,
    isError,
    error,
    refetch,
  } = useTransitManifest(manifestId);

  const { data: history = [] } = useTransitManifestHistory(manifestId);

  const transitionMutation = useTransitionTransitManifest();

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-center text-slate-500">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-sky-600 mb-3" />
        <p className="text-sm font-semibold">Memuat rincian surat jalan transit...</p>
      </div>
    );
  }

  if (isError || !manifest) {
    const formatted = formatPresentationError(error);
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="p-6 bg-white rounded-2xl border border-rose-200 text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
          <h2 className="text-base font-extrabold text-slate-900">{formatted.title}</h2>
          <p className="text-xs text-slate-600 max-w-md mx-auto">{formatted.message}</p>
          <div className="flex justify-center gap-3 pt-2">
            <Link
              to="/transit"
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
            >
              Kembali ke Daftar
            </Link>
            <button
              onClick={() => refetch()}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-bold transition"
            >
              Coba Lagi
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleTransition = async (targetStatus: any, notes?: string) => {
    setActionError(null);
    try {
      await transitionMutation.mutateAsync({
        manifestId: manifest.id,
        targetStatus,
        notes: notes || undefined,
        actorId: currentUser?.id,
      });
    } catch (err) {
      const formatted = formatPresentationError(err);
      setActionError(`${formatted.title}: ${formatted.message}`);
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Top Breadcrumb & Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to="/transit"
            className="p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition"
            title="Kembali ke Daftar Manifest"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight font-mono">
                {manifest.manifest_number}
              </h1>
              <ManifestStatusBadge status={manifest.status} size="md" />
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Surat Jalan Pengiriman Antar-Cabang LaundryFlow
            </p>
          </div>
        </div>

        {/* State Machine Transition Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {manifest.status === 'DRAFT' && (
            <>
              <button
                onClick={() => handleTransition('CANCELLED', 'Dibatalkan oleh operator')}
                disabled={transitionMutation.isPending}
                className="px-3.5 py-2 border border-slate-300 text-slate-700 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 rounded-xl text-xs font-bold transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <Ban className="w-3.5 h-3.5" />
                <span>Batalkan</span>
              </button>

              <button
                onClick={() => handleTransition('READY_TO_DISPATCH')}
                disabled={transitionMutation.isPending}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold shadow-xs transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Siapkan Pengiriman</span>
              </button>
            </>
          )}

          {manifest.status === 'READY_TO_DISPATCH' && (
            <>
              <button
                onClick={() => handleTransition('DRAFT')}
                disabled={transitionMutation.isPending}
                className="px-3.5 py-2 border border-slate-300 text-slate-700 hover:bg-slate-100 rounded-xl text-xs font-bold transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Kembali ke Draft</span>
              </button>

              <button
                onClick={() => handleTransition('CANCELLED', 'Dibatalkan sebelum kirim')}
                disabled={transitionMutation.isPending}
                className="px-3.5 py-2 border border-slate-300 text-slate-700 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 rounded-xl text-xs font-bold transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <Ban className="w-3.5 h-3.5" />
                <span>Batalkan</span>
              </button>

              <button
                onClick={() => handleTransition('IN_TRANSIT')}
                disabled={transitionMutation.isPending}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-xs transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Kirim Armada Sekarang</span>
              </button>
            </>
          )}

          {manifest.status === 'IN_TRANSIT' && (
            <button
              onClick={() => setIsReceiveModalOpen(true)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-extrabold shadow-md shadow-emerald-500/20 transition flex items-center gap-2"
            >
              <PackageCheck className="w-4 h-4" />
              <span>Terima & Periksa Manifest</span>
            </button>
          )}
        </div>
      </div>

      {/* Action Error Banner */}
      {actionError && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-800">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1">{actionError}</div>
        </div>
      )}

      {/* Overview Metadata Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Route Card */}
        <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase tracking-wider">
            <Building2 className="w-3.5 h-3.5 text-sky-600" />
            <span>Rute Pengiriman</span>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-slate-500">
              Dari:{' '}
              <span className="font-bold text-slate-900">
                {manifest.source_branch?.name || manifest.source_branch_id}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              Ke:{' '}
              <span className="font-bold text-slate-900">
                {manifest.destination_branch?.name || manifest.destination_branch_id}
              </span>
            </div>
          </div>
        </div>

        {/* Logistics & Driver Card */}
        <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase tracking-wider">
            <Truck className="w-3.5 h-3.5 text-indigo-600" />
            <span>Armada & Pengantar</span>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-slate-500">
              Driver:{' '}
              <span className="font-bold text-slate-900">
                {manifest.driver?.full_name || 'Belum Ditugaskan'}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              Kendaraan:{' '}
              <span className="font-bold text-slate-900 font-mono">
                {manifest.vehicle_identifier || '-'}
              </span>
            </div>
          </div>
        </div>

        {/* Cargo & Discrepancy Summary Card */}
        <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase tracking-wider">
            <PackageCheck className="w-3.5 h-3.5 text-emerald-600" />
            <span>Muatan & Rekonsiliasi</span>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-slate-500">
              Total Nota Dikirim:{' '}
              <span className="font-extrabold text-slate-900">
                {manifest.total_expected_orders} Nota
              </span>
            </div>
            <div className="text-xs text-slate-500">
              Nota Diterima:{' '}
              <span className="font-extrabold text-slate-900">
                {manifest.status === 'RECEIVED'
                  ? `${manifest.total_received_orders} Nota`
                  : '-'}
              </span>
            </div>
            {manifest.status === 'RECEIVED' && (
              <div className="pt-0.5">
                {manifest.has_discrepancy ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                    <AlertTriangle className="w-3 h-3" />
                    <span>{manifest.discrepancy_summary || 'Ada Selisih Fisik'}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Lengkap & Sesuai</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Grid: Orders List & Forensic Timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Manifest Orders Table */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-base font-extrabold text-slate-900">
                Daftar Nota Cucian dalam Manifest
              </h2>
              <p className="text-xs text-slate-500">
                {manifest.items?.length || 0} nota cucian terlampir
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="px-4 py-3">Nomor Nota</th>
                  <th className="px-4 py-3">Pelanggan</th>
                  <th className="px-4 py-3">Status Order</th>
                  <th className="px-4 py-3">Hasil Inspeksi</th>
                  <th className="px-4 py-3">Catatan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(manifest.items || []).map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/70 transition">
                    <td className="px-4 py-3 font-mono font-bold text-slate-900">
                      {item.order?.order_number || item.order_id}
                    </td>
                    <td className="px-4 py-3 text-slate-700 font-medium">
                      {item.order?.customer?.name || 'Umum'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                        {item.order?.status || 'RECEIVED'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          item.received_status === 'RECEIVED_OK'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : item.received_status === 'MISSING'
                            ? 'bg-rose-50 text-rose-700 border-rose-200'
                            : item.received_status === 'DAMAGED'
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : item.received_status === 'WRONG_BRANCH'
                            ? 'bg-purple-50 text-purple-700 border-purple-200'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}
                      >
                        {item.received_status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-[11px]">
                      {item.discrepancy_notes || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Timeline Audit Log */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
            <Clock className="w-4 h-4 text-sky-600" />
            <h2 className="text-sm font-extrabold text-slate-900">
              Riwayat Transisi (Audit Trail)
            </h2>
          </div>

          {history.length === 0 ? (
            <p className="text-xs text-slate-400 py-4 text-center">Belum ada aktivitas tercatat.</p>
          ) : (
            <div className="space-y-4 relative before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-100">
              {history.map((h, idx) => (
                <div key={`${h.id || 'hist'}-${idx}`} className="relative pl-6 space-y-0.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-sky-500 absolute left-1 top-1 ring-4 ring-white" />
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-900">
                      {h.from_status ? `${h.from_status} → ` : ''}{h.to_status}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {formatDate(h.created_at)}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Aktor: <span className="font-medium text-slate-700">{h.actor?.full_name || h.actor_id}</span>
                  </div>
                  {h.notes && (
                    <p className="text-[11px] text-slate-600 bg-slate-50 p-1.5 rounded border border-slate-200 mt-1">
                      "{h.notes}"
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Modal Receiving */}
      {isReceiveModalOpen && (
        <ReceiveManifestModal
          isOpen={isReceiveModalOpen}
          manifest={manifest}
          onClose={() => setIsReceiveModalOpen(false)}
          onSuccess={() => {
            setIsReceiveModalOpen(false);
            refetch();
          }}
        />
      )}
    </div>
  );
};
