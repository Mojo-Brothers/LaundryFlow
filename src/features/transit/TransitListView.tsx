import React, { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePosStore } from '../../core/store/posStore';
import {
  useTransitManifests,
  formatPresentationError,
} from '../../core/presentation/query';
import { TransitManifestStatus, TransitManifest } from '../../core/types/database';
import { ManifestStatusBadge } from './components/ManifestStatusBadge';
import { CreateManifestModal } from './CreateManifestModal';
import {
  Truck,
  Plus,
  Search,
  Filter,
  ArrowRight,
  Building2,
  Calendar,
  AlertCircle,
  Loader2,
  ChevronRight,
  PackageCheck,
  Send,
} from 'lucide-react';

export const TransitListView: React.FC = () => {
  const { currentBranch } = usePosStore();
  const navigate = useNavigate();

  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [directionFilter, setDirectionFilter] = useState<'ALL' | 'OUTGOING' | 'INCOMING'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);

  // Query hook to fetch manifests
  const {
    data: manifests = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useTransitManifests();

  // Filter manifests by status, direction, and search query
  const filteredManifests = useMemo(() => {
    return manifests.filter((m) => {
      // Status filter
      if (selectedStatus !== 'ALL' && m.status !== selectedStatus) {
        return false;
      }

      // Direction filter
      if (directionFilter === 'OUTGOING' && currentBranch) {
        if (m.source_branch_id !== currentBranch.id) return false;
      } else if (directionFilter === 'INCOMING' && currentBranch) {
        if (m.destination_branch_id !== currentBranch.id) return false;
      }

      // Search filter (manifest number, driver name, vehicle)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesNumber = m.manifest_number.toLowerCase().includes(q);
        const matchesDriver = m.driver?.full_name?.toLowerCase().includes(q) || false;
        const matchesVehicle = m.vehicle_identifier?.toLowerCase().includes(q) || false;
        const matchesSource = m.source_branch?.name?.toLowerCase().includes(q) || false;
        const matchesDest = m.destination_branch?.name?.toLowerCase().includes(q) || false;
        if (!matchesNumber && !matchesDriver && !matchesVehicle && !matchesSource && !matchesDest) {
          return false;
        }
      }

      return true;
    });
  }, [manifests, selectedStatus, directionFilter, searchQuery, currentBranch]);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('id-ID', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header & Main Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-sky-600 text-white flex items-center justify-center shadow-md shadow-sky-500/20">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Logistik & Transit Antar-Cabang
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Surat jalan pengiriman cucian antara outlet dan workshop produksi
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-extrabold shadow-md shadow-sky-500/20 transition flex items-center justify-center gap-2 shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Buat Pengiriman Baru</span>
        </button>
      </div>

      {/* Filter Toolbar */}
      <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-3">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          {/* Search Bar */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nomor manifest (TR-...), nama driver, nopol armada, atau cabang..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-xs bg-white focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden"
            />
          </div>

          {/* Direction Filter Segmented Control */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl shrink-0 text-xs font-semibold text-slate-600">
            <button
              onClick={() => setDirectionFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg transition ${
                directionFilter === 'ALL'
                  ? 'bg-white text-slate-900 shadow-2xs font-bold'
                  : 'hover:text-slate-900'
              }`}
            >
              Semua Rute
            </button>
            <button
              onClick={() => setDirectionFilter('OUTGOING')}
              className={`px-3 py-1.5 rounded-lg transition ${
                directionFilter === 'OUTGOING'
                  ? 'bg-white text-slate-900 shadow-2xs font-bold'
                  : 'hover:text-slate-900'
              }`}
            >
              Keluar (Outgoing)
            </button>
            <button
              onClick={() => setDirectionFilter('INCOMING')}
              className={`px-3 py-1.5 rounded-lg transition ${
                directionFilter === 'INCOMING'
                  ? 'bg-white text-slate-900 shadow-2xs font-bold'
                  : 'hover:text-slate-900'
              }`}
            >
              Masuk (Incoming)
            </button>
          </div>
        </div>

        {/* Status Pills Filter */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full text-xs">
          {[
            { id: 'ALL', label: 'Semua Status' },
            { id: 'DRAFT', label: 'Draft' },
            { id: 'READY_TO_DISPATCH', label: 'Siap Kirim' },
            { id: 'IN_TRANSIT', label: 'Dalam Perjalanan' },
            { id: 'RECEIVED', label: 'Diterima' },
            { id: 'CANCELLED', label: 'Dibatalkan' },
          ].map((st) => (
            <button
              key={st.id}
              onClick={() => setSelectedStatus(st.id)}
              className={`px-3 py-1 rounded-xl text-xs font-bold border transition shrink-0 ${
                selectedStatus === st.id
                  ? 'bg-sky-600 text-white border-sky-600 shadow-2xs'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {st.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      {isLoading ? (
        <div className="p-12 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">
          <Loader2 className="w-7 h-7 animate-spin mx-auto text-sky-600 mb-2" />
          <p className="text-xs font-semibold">Memuat manifest pengiriman...</p>
        </div>
      ) : isError ? (
        <div className="p-8 text-center bg-white rounded-2xl border border-rose-200 space-y-3">
          <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
          <h2 className="text-sm font-extrabold text-slate-900">
            {formatPresentationError(error).title}
          </h2>
          <p className="text-xs text-slate-600 max-w-md mx-auto">
            {formatPresentationError(error).message}
          </p>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-bold transition"
          >
            Coba Lagi
          </button>
        </div>
      ) : filteredManifests.length === 0 ? (
        <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
            <Truck className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-extrabold text-slate-800">
            Belum ada manifest pengiriman.
          </h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            {searchQuery || selectedStatus !== 'ALL' || directionFilter !== 'ALL'
              ? 'Tidak ditemukan manifest yang cocok dengan filter yang Anda pilih.'
              : 'Mulai kirim cucian dari cabang ini ke workshop pusat produksi.'}
          </p>
          {(!searchQuery && selectedStatus === 'ALL' && directionFilter === 'ALL') && (
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-bold transition"
            >
              + Buat Pengiriman Pertama
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
          {/* Desktop Table View (Hidden on mobile) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="px-4 py-3">Nomor Surat Jalan</th>
                  <th className="px-4 py-3">Rute (Asal → Tujuan)</th>
                  <th className="px-4 py-3">Armada & Driver</th>
                  <th className="px-4 py-3 text-center">Total Nota</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Tanggal Dibuat</th>
                  <th className="px-4 py-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredManifests.map((m) => (
                  <tr
                    key={m.id}
                    onClick={() => navigate(`/transit/${m.id}`)}
                    className="hover:bg-slate-50/80 cursor-pointer transition"
                    data-testid={`manifest-row-${m.id}`}
                  >
                    <td className="px-4 py-3 font-mono font-bold text-sky-700">
                      {m.manifest_number}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 font-medium text-slate-900">
                        <span>{m.source_branch?.name || m.source_branch_id}</span>
                        <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="font-semibold text-slate-900">
                          {m.destination_branch?.name || m.destination_branch_id}
                        </span>
                      </div>
                    </td>

                    <td className="px-4 py-3 text-slate-600">
                      <div>{m.driver?.full_name || 'Belum Ditugaskan'}</div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {m.vehicle_identifier || '-'}
                      </div>
                    </td>

                    <td className="px-4 py-3 text-center font-extrabold text-slate-900">
                      {m.total_expected_orders}
                    </td>

                    <td className="px-4 py-3">
                      <ManifestStatusBadge status={m.status} size="sm" />
                    </td>

                    <td className="px-4 py-3 text-slate-500 font-mono text-[11px]">
                      {formatDate(m.created_at)}
                    </td>

                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/transit/${m.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] transition"
                      >
                        <span>Detail</span>
                        <ChevronRight className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Card List View (Shown on small screens) */}
          <div className="md:hidden divide-y divide-slate-100">
            {filteredManifests.map((m) => (
              <div
                key={m.id}
                onClick={() => navigate(`/transit/${m.id}`)}
                className="p-4 space-y-2.5 cursor-pointer hover:bg-slate-50 transition"
                data-testid={`manifest-card-${m.id}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-xs text-sky-700">
                    {m.manifest_number}
                  </span>
                  <ManifestStatusBadge status={m.status} size="sm" />
                </div>

                <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                  <span>{m.source_branch?.name || m.source_branch_id}</span>
                  <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                  <span>{m.destination_branch?.name || m.destination_branch_id}</span>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-100">
                  <div>
                    Muatan: <strong className="text-slate-800">{m.total_expected_orders} Nota</strong>
                  </div>
                  <div>Driver: {m.driver?.full_name || '-'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create Manifest Modal */}
      {isCreateModalOpen && (
        <CreateManifestModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          onSuccess={(created) => {
            setIsCreateModalOpen(false);
            navigate(`/transit/${created.id}`);
          }}
        />
      )}
    </div>
  );
};
