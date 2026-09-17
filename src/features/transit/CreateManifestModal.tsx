import React, { useState, useMemo, useEffect } from 'react';
import { usePosStore } from '../../core/store/posStore';
import {
  useEligibleTransitOrders,
  useCreateTransitManifest,
  formatPresentationError,
} from '../../core/presentation/query';
import { TransitManifest } from '../../core/types/database';
import {
  X,
  Truck,
  Search,
  CheckCircle2,
  AlertCircle,
  Loader2,
  CheckSquare,
  Square,
  ArrowRight,
} from 'lucide-react';
import { Branch, UserProfile } from '../../core/types/database';

const FALLBACK_BRANCHES: Branch[] = [
  {
    id: '22222222-2222-2222-2222-222222222221',
    organization_id: '11111111-1111-1111-1111-111111111111',
    code: 'BKS-01',
    name: 'Outlet Bekasi Timur',
    branch_type: 'OUTLET',
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    organization_id: '11111111-1111-1111-1111-111111111111',
    code: 'TBN-01',
    name: 'Outlet Tambun Selatan',
    branch_type: 'OUTLET',
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  {
    id: '22222222-2222-2222-2222-222222222223',
    organization_id: '11111111-1111-1111-1111-111111111111',
    code: 'CP-01',
    name: 'Central Production Unit Tambun',
    branch_type: 'CENTRAL_PRODUCTION',
    is_active: true,
    created_at: '',
    updated_at: '',
  },
];

const FALLBACK_USERS: UserProfile[] = [
  {
    id: '33333333-3333-3333-3333-333333333333',
    organization_id: '11111111-1111-1111-1111-111111111111',
    email: 'driver@demo.laundryflow.id',
    full_name: 'Budi Driver',
    role: 'DRIVER',
    is_active: true,
    created_at: '',
    updated_at: '',
  },
];

interface CreateManifestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (manifest: TransitManifest) => void;
  branches?: Branch[];
  users?: UserProfile[];
}

export const CreateManifestModal: React.FC<CreateManifestModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  branches,
  users,
}) => {
  const { currentBranch, allBranches, allUsers } = usePosStore();

  const effectiveBranches =
    branches && branches.length > 0
      ? branches
      : allBranches && allBranches.length > 0
      ? allBranches
      : FALLBACK_BRANCHES;

  const effectiveUsers =
    users && users.length > 0
      ? users
      : allUsers && allUsers.length > 0
      ? allUsers
      : FALLBACK_USERS;

  // Filter available destination branches (cannot send to current branch)
  // Prioritize Central Production workshops as the primary destination
  const availableDestinations = useMemo(() => {
    return effectiveBranches
      .filter((b) => b.id !== currentBranch?.id)
      .sort(
        (a, b) =>
          (b.branch_type === 'CENTRAL_PRODUCTION' ? 1 : 0) -
          (a.branch_type === 'CENTRAL_PRODUCTION' ? 1 : 0)
      );
  }, [effectiveBranches, currentBranch?.id]);

  const [destinationBranchId, setDestinationBranchId] = useState<string>(() =>
    availableDestinations.length > 0 ? availableDestinations[0].id : ''
  );
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [driverUserId, setDriverUserId] = useState<string>('');
  const [vehicleIdentifier, setVehicleIdentifier] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [orderSearch, setOrderSearch] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  // Set default destination if not chosen
  useEffect(() => {
    if (
      (!destinationBranchId ||
        !availableDestinations.some((b) => b.id === destinationBranchId)) &&
      availableDestinations.length > 0
    ) {
      setDestinationBranchId(availableDestinations[0].id);
    }
  }, [availableDestinations, destinationBranchId]);

  // Load eligible orders from application service via hook
  const {
    data: eligibleOrders = [],
    isLoading: isLoadingOrders,
    isError: isOrdersError,
    error: ordersError,
  } = useEligibleTransitOrders(
    currentBranch?.id,
    destinationBranchId || undefined
  );

  const createMutation = useCreateTransitManifest();

  // Reset form when modal opens
  React.useEffect(() => {
    if (isOpen) {
      setSelectedOrderIds(new Set());
      setNotes('');
      setVehicleIdentifier('');
      setDriverUserId('');
      setFormError(null);
      setOrderSearch('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Filter orders by search term
  const filteredOrders = eligibleOrders.filter((o) => {
    const q = orderSearch.toLowerCase();
    const matchesNumber = o.order_number.toLowerCase().includes(q);
    const matchesCustomer = o.customer?.name?.toLowerCase().includes(q) || false;
    return matchesNumber || matchesCustomer;
  });

  const handleToggleOrder = (orderId: string) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    const allFiltered = new Set(filteredOrders.map((o) => o.id));
    setSelectedOrderIds(allFiltered);
  };

  const handleDeselectAll = () => {
    setSelectedOrderIds(new Set());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!currentBranch) {
      setFormError('Cabang asal belum ditentukan.');
      return;
    }
    if (!destinationBranchId) {
      setFormError('Cabang tujuan wajib dipilih.');
      return;
    }
    if (destinationBranchId === currentBranch.id) {
      setFormError('Cabang asal dan tujuan tidak boleh sama.');
      return;
    }
    if (selectedOrderIds.size === 0) {
      setFormError('Pilih minimal 1 nota cucian untuk dimasukkan ke manifest.');
      return;
    }

    try {
      const result = await createMutation.mutateAsync({
        organizationId: currentBranch.organization_id,
        sourceBranchId: currentBranch.id,
        destinationBranchId,
        orderIds: Array.from(selectedOrderIds),
        driverUserId: driverUserId || undefined,
        vehicleIdentifier: vehicleIdentifier.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      onClose();
      if (onSuccess) {
        onSuccess(result);
      }
    } catch (err) {
      const formatted = formatPresentationError(err);
      setFormError(`${formatted.title}: ${formatted.message}`);
    }
  };

  const selectedCount = selectedOrderIds.size;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-manifest-modal-title"
    >
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-sky-100 text-sky-700 flex items-center justify-center font-bold">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="create-manifest-modal-title"
                className="font-extrabold text-slate-900 text-base sm:text-lg"
              >
                Buat Pengiriman Antar-Cabang
              </h2>
              <p className="text-xs text-slate-500">
                Surat Jalan Transit Cucian (Manifest Draft)
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

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Route Section */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200/80">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                Cabang Asal (Outlet)
              </label>
              <div className="px-3 py-2 bg-white rounded-lg border border-slate-300 text-sm font-semibold text-slate-800">
                {currentBranch?.name || 'Cabang Aktif'}
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                Pengiriman selalu bermula dari cabang aktif Anda.
              </p>
            </div>

            <div>
              <label
                htmlFor="destination-branch-select"
                className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
              >
                Cabang Tujuan (Workshop / Outlet) *
              </label>
              <select
                id="destination-branch-select"
                value={destinationBranchId}
                onChange={(e) => setDestinationBranchId(e.target.value)}
                className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-sm font-semibold text-slate-800 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden"
                required
              >
                <option value="" disabled>
                  Pilih Cabang Tujuan...
                </option>
                {availableDestinations.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} (
                    {b.branch_type === 'CENTRAL_PRODUCTION'
                      ? 'Workshop Pusat'
                      : 'Outlet'}
                    )
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-1">
                Tentukan workshop atau cabang penerima cucian.
              </p>
            </div>
          </div>

          {/* Orders Checklist Section */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900">
                  Pilih Nota Cucian Siap Kirim *
                </h3>
                <p className="text-xs text-slate-500">
                  Hanya menampilkan nota yang belum terikat surat jalan aktif.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  disabled={filteredOrders.length === 0}
                  className="px-2.5 py-1 text-xs font-bold text-sky-700 bg-sky-50 hover:bg-sky-100 rounded-lg transition disabled:opacity-50"
                >
                  Pilih Semua
                </button>
                <button
                  type="button"
                  onClick={handleDeselectAll}
                  disabled={selectedCount === 0}
                  className="px-2.5 py-1 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition disabled:opacity-50"
                >
                  Hapus Semua
                </button>
              </div>
            </div>

            {/* Order Search Filter */}
            <div className="relative mb-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                placeholder="Cari nomor nota atau nama pelanggan..."
                className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:ring-1 focus:ring-sky-500 outline-hidden"
              />
            </div>

            {/* Orders Container */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              {isLoadingOrders ? (
                <div className="p-8 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                  <span>Memuat nota cucian yang siap dikirim...</span>
                </div>
              ) : isOrdersError ? (
                <div className="p-6 text-center text-rose-600 text-xs">
                  Gagal memuat nota eligible:{' '}
                  {formatPresentationError(ordersError).message}
                </div>
              ) : eligibleOrders.length === 0 ? (
                <div className="p-8 text-center text-slate-400">
                  <CheckCircle2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-xs font-semibold text-slate-600">
                    Tidak ada nota yang siap dikirim dari cabang ini.
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Semua cucian telah dialokasikan atau selesai diproses.
                  </p>
                </div>
              ) : filteredOrders.length === 0 ? (
                <div className="p-6 text-center text-slate-400 text-xs">
                  Tidak ditemukan nota dengan kata kunci "{orderSearch}".
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
                  {filteredOrders.map((order) => {
                    const isSelected = selectedOrderIds.has(order.id);
                    return (
                      <div
                        key={order.id}
                        onClick={() => handleToggleOrder(order.id)}
                        className={`flex items-center justify-between p-3 cursor-pointer select-none transition ${
                          isSelected
                            ? 'bg-sky-50/70 hover:bg-sky-100/70'
                            : 'hover:bg-slate-50'
                        }`}
                        data-testid={`order-row-${order.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            aria-label={`Pilih nota ${order.order_number}`}
                            className="text-sky-600 shrink-0"
                          >
                            {isSelected ? (
                              <CheckSquare className="w-4 h-4 text-sky-600" />
                            ) : (
                              <Square className="w-4 h-4 text-slate-300" />
                            )}
                          </button>
                          <div>
                            <div className="text-xs font-bold text-slate-900 flex items-center gap-2">
                              <span>{order.order_number}</span>
                              <span className="text-[10px] font-semibold px-1.5 py-0.2 bg-slate-100 text-slate-600 rounded">
                                {order.status}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500">
                              Pelanggan:{' '}
                              <span className="font-semibold text-slate-700">
                                {order.customer?.name || 'Umum'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="text-right text-xs">
                          <span className="text-slate-400 text-[11px]">
                            {new Date(order.created_at).toLocaleDateString('id-ID', {
                              day: 'numeric',
                              month: 'short',
                            })}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selection Counter */}
            <div className="flex justify-between items-center mt-2 px-1 text-xs">
              <span className="text-slate-500">
                Total Tersedia: {eligibleOrders.length} nota
              </span>
              <span
                className={`font-bold ${
                  selectedCount > 0 ? 'text-sky-700' : 'text-slate-400'
                }`}
              >
                Jumlah Nota Dipilih: {selectedCount}
              </span>
            </div>
          </div>

          {/* Logistics Metadata (Driver, Vehicle, Notes) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
            <div>
              <label
                htmlFor="driver-user-select"
                className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
              >
                Driver / Kurir Pengantar (Opsional)
              </label>
              <select
                id="driver-user-select"
                value={driverUserId}
                onChange={(e) => setDriverUserId(e.target.value)}
                className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs font-medium text-slate-800 focus:ring-1 focus:ring-sky-500 outline-hidden"
              >
                <option value="">Pilih Driver / Belum Ditugaskan...</option>
                {effectiveUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.role})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="vehicle-identifier-input"
                className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
              >
                Nomor Armada / Plat Nomor (Opsional)
              </label>
              <input
                id="vehicle-identifier-input"
                type="text"
                value={vehicleIdentifier}
                onChange={(e) => setVehicleIdentifier(e.target.value)}
                maxLength={60}
                placeholder="Contoh: B 1234 SAA (Blind Van)"
                className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs font-medium text-slate-800 focus:ring-1 focus:ring-sky-500 outline-hidden"
              />
            </div>

            <div className="sm:col-span-2">
              <label
                htmlFor="manifest-notes-input"
                className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
              >
                Catatan Pengiriman (Opsional)
              </label>
              <input
                id="manifest-notes-input"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Contoh: Pengiriman pagi, prioritaskan cuci kilat paket VIP"
                className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs font-medium text-slate-800 focus:ring-1 focus:ring-sky-500 outline-hidden"
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={createMutation.isPending}
              className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition disabled:opacity-50"
            >
              Batal
            </button>

            <button
              type="submit"
              disabled={createMutation.isPending || selectedCount === 0}
              className="px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-extrabold shadow-md shadow-sky-500/20 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Membuat Manifest...</span>
                </>
              ) : (
                <>
                  <span>Buat Surat Jalan ({selectedCount} Nota)</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
