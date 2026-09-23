// ============================================================================
// LaundryFlow — Workshop-Wide Production Kanban View (STEP 4C.4C-B.2.5)
// Manufacturing Stage Board: Workshop Read Model -> 5 Stages -> Work Items -> Mutations
// Dependency Direction: UI -> useProductionHooks -> ApplicationService -> Repository
// ============================================================================

import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Layers,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Scissors,
  X,
  Search,
  RefreshCw,
  ShieldCheck,
  ClipboardList,
  Store,
} from 'lucide-react';
import {
  WorkshopProductionWorkItem,
  WorkshopProductionJobSummary,
  ProductionStage,
  SplitReason,
} from '../../core/types/database';
import {
  useWorkshopProduction,
  useAdvanceWorkItem,
  useSplitWorkItem,
  useEvaluateQC,
  useCompleteProduction,
  formatPresentationError,
} from '../../core/presentation/query';
import { usePosStore } from '../../core/store/posStore';

export interface ProductionKanbanViewProps {
  workshopBranchId?: string;
  orderId?: string;
  jobId?: string;
}

export const PRODUCTION_STAGES: {
  id: ProductionStage;
  label: string;
  color: string;
  badgeColor: string;
}[] = [
  { id: 'WASHING', label: '1. Pencucian', color: 'border-t-sky-500', badgeColor: 'bg-sky-100 text-sky-800' },
  { id: 'DRYING', label: '2. Pengeringan', color: 'border-t-amber-500', badgeColor: 'bg-amber-100 text-amber-800' },
  { id: 'IRONING', label: '3. Setrika Uap', color: 'border-t-indigo-500', badgeColor: 'bg-indigo-100 text-indigo-800' },
  { id: 'PACKED', label: '4. Packed & QC', color: 'border-t-emerald-500', badgeColor: 'bg-emerald-100 text-emerald-800' },
  { id: 'SPECIAL_TREATMENT', label: '5. Treatment Khusus', color: 'border-t-purple-500', badgeColor: 'bg-purple-100 text-purple-800' },
];

export const QC_REMEDIATION_STAGES: { id: ProductionStage; label: string }[] = [
  { id: 'WASHING', label: 'Cuci Ulang (WASHING)' },
  { id: 'DRYING', label: 'Keringkan Ulang (DRYING)' },
  { id: 'IRONING', label: 'Setrika Ulang (IRONING)' },
  { id: 'SPECIAL_TREATMENT', label: 'Treatment Khusus (SPECIAL_TREATMENT)' },
];

export const SPLIT_REASONS: { id: SplitReason; label: string }[] = [
  { id: 'CAPACITY_OVERFLOW', label: 'Kapasitas Mesin Penuh (CAPACITY_OVERFLOW)' },
  { id: 'QC_DEFECT_ISOLATION', label: 'Isolasi Cacat/Noda (QC_DEFECT_ISOLATION)' },
  { id: 'TREATMENT_SEGREGATION', label: 'Pemisahan Treatment Khusus (TREATMENT_SEGREGATION)' },
];

export const ProductionKanbanView: React.FC<ProductionKanbanViewProps> = ({
  workshopBranchId: propWorkshopBranchId,
  orderId: propOrderId,
  jobId: propJobId,
}) => {
  const { currentBranch } = usePosStore();
  const [searchParams] = useSearchParams();

  // Primary authoritative workshop branch ID:
  // 1. prop workshopBranchId
  // 2. query param ?workshopBranchId=...
  // 3. active currentBranch from usePosStore()
  const activeWorkshopBranchId =
    propWorkshopBranchId ||
    searchParams.get('workshopBranchId') ||
    currentBranch?.id ||
    '';

  // Optional presentation filter / drill-down state
  const initialOrderId = propOrderId || searchParams.get('orderId') || '';
  const initialJobId = propJobId || searchParams.get('jobId') || '';
  const [orderIdFilter, setOrderIdFilter] = useState<string>(initialOrderId);
  const [jobIdFilter, setJobIdFilter] = useState<string>(initialJobId);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Active modal targets
  const [splitItem, setSplitItem] = useState<WorkshopProductionWorkItem | null>(null);
  const [qcItem, setQCItem] = useState<WorkshopProductionWorkItem | null>(null);
  const [isJobModalOpen, setIsJobModalOpen] = useState<boolean>(false);

  // Split Form State
  const [splitQty1, setSplitQty1] = useState<string>('');
  const [splitQty2, setSplitQty2] = useState<string>('');
  const [splitReason, setSplitReason] = useState<SplitReason>('CAPACITY_OVERFLOW');
  const [splitNotes, setSplitNotes] = useState<string>('');

  // QC Form State
  const [qcPassed, setQCPassed] = useState<boolean>(true);
  const [qcRemediation, setQCRemediation] = useState<ProductionStage>('WASHING');
  const [qcNotes, setQCNotes] = useState<string>('');

  // Authoritative Workshop Read Model Hook (1 single bulk aggregation)
  const {
    data: readModel,
    isLoading,
    error: queryError,
  } = useWorkshopProduction(activeWorkshopBranchId || undefined);

  // Mutation Hooks
  const advanceMutation = useAdvanceWorkItem();
  const splitMutation = useSplitWorkItem();
  const evaluateQCMutation = useEvaluateQC();
  const completeProdMutation = useCompleteProduction();

  // Error banners from any mutation
  const activeMutationError =
    advanceMutation.error ||
    splitMutation.error ||
    evaluateQCMutation.error ||
    completeProdMutation.error;

  // Extract active leaf work items (defense-in-depth against SPLIT parent items)
  const allActiveWorkItems = useMemo(() => {
    if (!readModel?.work_items) return [];
    return readModel.work_items.filter((item) => item.status !== 'SPLIT');
  }, [readModel]);

  // Client-side presentation filter (zero network calls on search/filter)
  const filteredWorkItems = useMemo(() => {
    let items = allActiveWorkItems;

    if (orderIdFilter) {
      const q = orderIdFilter.toLowerCase().trim();
      items = items.filter(
        (item) =>
          item.order_id === orderIdFilter ||
          item.order_number.toLowerCase().includes(q)
      );
    }

    if (jobIdFilter) {
      items = items.filter((item) => item.job_id === jobIdFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      items = items.filter(
        (item) =>
          item.order_number.toLowerCase().includes(q) ||
          (item.customer_name && item.customer_name.toLowerCase().includes(q)) ||
          item.item_code.toLowerCase().includes(q) ||
          item.service_name_snap.toLowerCase().includes(q) ||
          item.service_name.toLowerCase().includes(q)
      );
    }

    return items;
  }, [allActiveWorkItems, orderIdFilter, jobIdFilter, searchQuery]);

  const handleAdvance = (workItemId: string) => {
    advanceMutation.mutate({ workItemId });
  };

  const handleOpenSplit = (item: WorkshopProductionWorkItem) => {
    setSplitItem(item);
    const half = (item.quantity / 2).toFixed(1);
    setSplitQty1(half);
    setSplitQty2((item.quantity - parseFloat(half)).toFixed(1));
    setSplitReason('CAPACITY_OVERFLOW');
    setSplitNotes('');
  };

  const handleSubmitSplit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!splitItem) return;

    const q1 = parseFloat(splitQty1);
    const q2 = parseFloat(splitQty2);
    if (isNaN(q1) || isNaN(q2) || q1 <= 0 || q2 <= 0) {
      return;
    }

    splitMutation.mutate(
      {
        workItemId: splitItem.id,
        splitQuantities: [q1, q2],
        splitReason,
        notes: splitNotes.trim() || undefined,
      },
      {
        onSuccess: () => setSplitItem(null),
      }
    );
  };

  const handleOpenQC = (item: WorkshopProductionWorkItem) => {
    setQCItem(item);
    setQCPassed(true);
    setQCRemediation('WASHING');
    setQCNotes('');
  };

  const handleSubmitQC = (e: React.FormEvent) => {
    e.preventDefault();
    if (!qcItem) return;

    evaluateQCMutation.mutate(
      {
        workItemId: qcItem.id,
        passed: qcPassed,
        remediationStage: qcPassed ? undefined : qcRemediation,
        notes: qcNotes.trim() || undefined,
      },
      {
        onSuccess: () => setQCItem(null),
      }
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              Papan Produksi (Kanban)
            </h1>
            <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800">
              Workshop Board
            </span>
            {currentBranch?.branch_type && (
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                {currentBranch.branch_type === 'CENTRAL_PRODUCTION' ? 'Workshop Pusat' : 'Outlet & Workshop Lokal'}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {readModel?.workshop_branch_name || currentBranch?.name || 'Workshop'} — Lacak antrean cucian aktif di 5 tahapan stasiun kerja
          </p>
        </div>

        {/* Controls: Search, Job Summary button */}
        <div className="flex items-center gap-2">
          {/* Client-side Search */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              aria-label="Cari nomor order, pelanggan, atau kode item"
              placeholder="Cari order, pelanggan, kode..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-8 py-1.5 text-xs rounded-xl border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-sky-500 bg-white shadow-2xs w-48 sm:w-64"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label="Hapus pencarian"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Job Summary Modal Button */}
          <button
            onClick={() => setIsJobModalOpen(true)}
            className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold shadow-2xs transition flex items-center gap-1.5 shrink-0"
          >
            <ClipboardList className="w-3.5 h-3.5" />
            <span>Kelola Job ({readModel?.jobs_count || 0})</span>
          </button>
        </div>
      </div>

      {/* Workshop Summary & Filter Bar */}
      {readModel && (
        <div className="p-3.5 rounded-2xl bg-white border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Store className="w-4 h-4 text-sky-600" />
              <span className="font-bold text-slate-800">
                {readModel.workshop_branch_name || currentBranch?.name || 'Workshop Produksi'}
              </span>
            </div>
            <div className="h-4 w-px bg-slate-200" />
            <div className="flex items-center gap-1.5 text-slate-600">
              <span className="font-bold text-slate-900">{readModel.jobs_count}</span> Job Aktif
            </div>
            <div className="h-4 w-px bg-slate-200" />
            <div className="flex items-center gap-1.5 text-slate-600">
              <span className="font-bold text-slate-900">{readModel.work_items_count}</span> Work Item di Stasiun Kerja
            </div>
          </div>

          {(orderIdFilter || jobIdFilter) && (
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-sky-100 text-sky-800 font-bold text-[11px] flex items-center gap-1">
                Filter: {orderIdFilter || jobIdFilter}
                <button
                  onClick={() => {
                    setOrderIdFilter('');
                    setJobIdFilter('');
                  }}
                  className="hover:text-sky-950 ml-1"
                  aria-label="Reset filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error Banners */}
      {queryError && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-3 text-rose-800 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
          <span>{formatPresentationError(queryError).message}</span>
        </div>
      )}

      {activeMutationError && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-3 text-rose-800 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
          <span>{formatPresentationError(activeMutationError).message}</span>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div
          data-testid="production-kanban-loading"
          className="p-12 text-center text-slate-500 text-xs flex flex-col items-center justify-center gap-3 bg-white rounded-2xl border border-slate-200"
        >
          <div className="w-6 h-6 border-2 border-slate-300 border-t-sky-600 rounded-full animate-spin" />
          <span>Memuat antrean produksi workshop...</span>
        </div>
      )}

      {/* Empty State when workshop has zero active items */}
      {!isLoading && (!readModel || readModel.work_items.length === 0) && (
        <div
          data-testid="production-kanban-empty"
          className="p-12 text-center text-slate-400 text-xs bg-slate-50 rounded-2xl border border-dashed border-slate-300 space-y-2"
        >
          <Layers className="w-8 h-8 text-slate-300 mx-auto" />
          <p className="font-semibold text-slate-600">
            {currentBranch?.branch_type === 'OUTLET'
              ? 'Outlet ini tidak memiliki antrean produksi lokal.'
              : 'Tidak ada antrean produksi aktif di workshop ini.'}
          </p>
          {currentBranch?.branch_type === 'OUTLET' ? (
            <p className="text-[11px] text-slate-500 max-w-md mx-auto">
              Papan produksi ini menampilkan fasilitas fisik yang aktif. Jika cucian diproses di Workshop Pusat, silakan pilih Workshop Pusat pada pilihan cabang di atas untuk melihat antrean produksi.
            </p>
          ) : (
            <p className="text-[11px] text-slate-400">
              Semua cucian telah selesai atau belum ada pesanan yang masuk ke tahap produksi workshop.
            </p>
          )}
        </div>
      )}

      {/* Kanban Board Columns (5 Authoritative Stages) */}
      {!isLoading && readModel && readModel.work_items.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 overflow-x-auto pb-4">
          {PRODUCTION_STAGES.map((stage) => {
            const stageItems = filteredWorkItems.filter(
              (item) => item.current_stage === stage.id
            );

            return (
              <div
                key={stage.id}
                data-testid={`stage-column-${stage.id}`}
                className={`bg-slate-100/70 rounded-2xl border border-slate-200 p-3 flex flex-col min-h-[550px] border-t-4 ${stage.color}`}
              >
                {/* Column Header */}
                <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-slate-200 text-xs font-bold text-slate-700">
                  <span>{stage.label}</span>
                  <span className="px-2 py-0.5 rounded-full bg-white text-slate-700 text-[11px] shadow-2xs font-mono">
                    {stageItems.length}
                  </span>
                </div>

                {/* Cards Container */}
                <div className="space-y-3 flex-1 overflow-y-auto pr-1">
                  {stageItems.length === 0 ? (
                    <div className="text-center py-10 text-slate-400 text-[11px]">
                      Kosong
                    </div>
                  ) : (
                    stageItems.map((item) => {
                      const isPacked = item.current_stage === 'PACKED';
                      const isComplete = item.status === 'COMPLETED';
                      const canAdvance = item.status === 'IN_PROGRESS' && !isPacked;
                      const canQC = isPacked && item.status === 'IN_PROGRESS';
                      const canSplit = item.status === 'IN_PROGRESS' && !isPacked && item.quantity > 1;

                      return (
                        <div
                          key={item.id}
                          className="p-3 bg-white rounded-xl border border-slate-200 shadow-2xs hover:shadow-md transition space-y-2 text-xs"
                        >
                          {/* Item Header: Order Number, Item Code, & Status Badges */}
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="font-mono font-black text-slate-900 text-xs">
                                {item.order_number}
                              </span>
                              <span className="font-mono text-[10px] text-slate-400">
                                {item.item_code}
                              </span>
                            </div>

                            <div className="flex items-center gap-1 flex-wrap">
                              {item.is_rework && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 flex items-center gap-0.5">
                                  <RefreshCw className="w-2.5 h-2.5" /> Rework
                                </span>
                              )}
                              {item.parent_item_id && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 flex items-center gap-0.5">
                                  <Scissors className="w-2.5 h-2.5" /> Pecahan
                                </span>
                              )}
                              {isComplete && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 flex items-center gap-0.5">
                                  <CheckCircle2 className="w-2.5 h-2.5" /> QC Lolos
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Customer Name */}
                          {item.customer_name && (
                            <p className="text-[11px] text-slate-500 font-medium truncate">
                              Pelanggan: <span className="font-bold text-slate-800">{item.customer_name}</span>
                            </p>
                          )}

                          {/* Service Snapshot & Quantity */}
                          <div>
                            <p className="font-bold text-slate-800 truncate">
                              {item.service_name_snap || item.service_name}
                            </p>
                            <p className="text-[11px] font-extrabold text-slate-700 mt-0.5">
                              {item.quantity} {item.unit}
                            </p>
                          </div>

                          {/* Notes */}
                          {item.notes && (
                            <div className="p-1.5 bg-slate-50 rounded text-[10px] text-slate-600 italic">
                              "{item.notes}"
                            </div>
                          )}

                          {/* Work Item Workflow Actions */}
                          <div className="pt-2 flex items-center justify-between gap-1 border-t border-slate-100">
                            {/* Split Action */}
                            {canSplit && (
                              <button
                                onClick={() => handleOpenSplit(item)}
                                className="px-2 py-1 text-[10px] font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg flex items-center gap-1 transition"
                              >
                                <Scissors className="w-3 h-3" />
                                <span>Pecah</span>
                              </button>
                            )}

                            {/* Normal Stage Advancement */}
                            {canAdvance && (
                              <button
                                onClick={() => handleAdvance(item.id)}
                                disabled={advanceMutation.isPending}
                                className="ml-auto px-2.5 py-1 text-[10px] font-bold text-white bg-sky-600 hover:bg-sky-700 rounded-lg flex items-center gap-1 transition shadow-2xs disabled:opacity-50"
                              >
                                <span>Lanjut Tahap</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}

                            {/* QC Evaluation Action */}
                            {canQC && (
                              <button
                                onClick={() => handleOpenQC(item)}
                                className="ml-auto px-2.5 py-1 text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg flex items-center gap-1 transition shadow-2xs"
                              >
                                <ShieldCheck className="w-3 h-3" />
                                <span>Evaluasi QC</span>
                              </button>
                            )}

                            {/* Packed & Complete Ready Badge */}
                            {isPacked && isComplete && (
                              <span className="ml-auto text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Siap
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ======================================================================
          Split Work Item Modal
          ====================================================================== */}
      {splitItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-purple-100 text-purple-700">
                  <Scissors className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Pecah Batch Work Item</h3>
                  <p className="text-[11px] text-slate-500 font-mono">{splitItem.item_code}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSplitItem(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitSplit} className="space-y-4 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-slate-500">Layanan:</span>
                <p className="font-bold text-slate-800">{splitItem.service_name_snap || splitItem.service_name}</p>
                <p className="text-slate-600 mt-1">
                  Total kuantitas saat ini: <b>{splitItem.quantity} {splitItem.unit}</b>
                </p>
              </div>

              {/* Quantities */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="split-qty-1" className="block text-slate-700 font-semibold mb-1">
                    Porsi Batch 1 ({splitItem.unit}) *
                  </label>
                  <input
                    id="split-qty-1"
                    type="number"
                    step="0.01"
                    required
                    value={splitQty1}
                    onChange={(e) => setSplitQty1(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-semibold"
                  />
                </div>
                <div>
                  <label htmlFor="split-qty-2" className="block text-slate-700 font-semibold mb-1">
                    Porsi Batch 2 ({splitItem.unit}) *
                  </label>
                  <input
                    id="split-qty-2"
                    type="number"
                    step="0.01"
                    required
                    value={splitQty2}
                    onChange={(e) => setSplitQty2(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-semibold"
                  />
                </div>
              </div>

              {/* Reason */}
              <div>
                <label htmlFor="split-reason-select" className="block text-slate-700 font-semibold mb-1">
                  Alasan Pemecahan (Split Reason) *
                </label>
                <select
                  id="split-reason-select"
                  value={splitReason}
                  onChange={(e) => setSplitReason(e.target.value as SplitReason)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 font-semibold bg-white"
                >
                  {SPLIT_REASONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Notes */}
              <div>
                <label htmlFor="split-notes-input" className="block text-slate-700 font-semibold mb-1">
                  Catatan Tambahan (Opsional)
                </label>
                <textarea
                  id="split-notes-input"
                  rows={2}
                  value={splitNotes}
                  onChange={(e) => setSplitNotes(e.target.value)}
                  placeholder="Contoh: Mesin cuci 1 penuh, 2 kg dipisah ke mesin 2..."
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 font-medium"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setSplitItem(null)}
                  className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={splitMutation.isPending}
                  className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold shadow-2xs transition disabled:opacity-50"
                >
                  {splitMutation.isPending ? 'Memproses Split...' : 'Konfirmasi Pecah Batch'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================
          QC Evaluation Modal
          ====================================================================== */}
      {qcItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-emerald-100 text-emerald-700">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Evaluasi Quality Control (QC)</h3>
                  <p className="text-[11px] text-slate-500 font-mono">{qcItem.item_code}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setQCItem(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitQC} className="space-y-4 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-slate-500">Layanan:</span>
                <p className="font-bold text-slate-800">{qcItem.service_name_snap || qcItem.service_name}</p>
                <p className="text-slate-600 mt-1">
                  Kuantitas: <b>{qcItem.quantity} {qcItem.unit}</b>
                </p>
              </div>

              {/* QC Result Decision */}
              <div>
                <label className="block text-slate-700 font-semibold mb-2">Hasil Pemeriksaan Mutu *</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setQCPassed(true)}
                    className={`p-3 rounded-xl border flex flex-col items-center gap-1 transition ${
                      qcPassed
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-500'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    <span className="font-bold">Lolos QC (PASS)</span>
                    <span className="text-[10px] text-slate-500">Siap dipacking</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setQCPassed(false)}
                    className={`p-3 rounded-xl border flex flex-col items-center gap-1 transition ${
                      !qcPassed
                        ? 'border-rose-500 bg-rose-50 text-rose-800 ring-2 ring-rose-500'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <AlertTriangle className="w-5 h-5 text-rose-600" />
                    <span className="font-bold">Gagal QC (FAIL)</span>
                    <span className="text-[10px] text-slate-500">Perlu remediasi</span>
                  </button>
                </div>
              </div>

              {/* Remediation Stage Dropdown (MANDATORY on FAIL, PACKED is strictly excluded!) */}
              {!qcPassed && (
                <div className="p-3 rounded-xl bg-rose-50/70 border border-rose-200 space-y-2">
                  <label htmlFor="remediation-stage-select" className="block text-rose-900 font-bold">
                    Tahapan Remediasi (Wajib Dipilih) *
                  </label>
                  <select
                    id="remediation-stage-select"
                    value={qcRemediation}
                    onChange={(e) => setQCRemediation(e.target.value as ProductionStage)}
                    required
                    className="w-full px-3 py-2 rounded-xl border border-rose-300 font-bold bg-white text-slate-800"
                  >
                    {QC_REMEDIATION_STAGES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-rose-700">
                    Work item akan dimundurkan ke tahapan ini untuk pengerjaan ulang.
                  </p>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Catatan QC (Opsional)</label>
                <textarea
                  rows={2}
                  value={qcNotes}
                  onChange={(e) => setQCNotes(e.target.value)}
                  placeholder="Contoh: Ditemukan noda minyak di kerah kemeja..."
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 font-medium"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setQCItem(null)}
                  className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={evaluateQCMutation.isPending}
                  className={`px-4 py-2 rounded-xl font-bold shadow-2xs transition disabled:opacity-50 text-white ${
                    qcPassed
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-rose-600 hover:bg-rose-700'
                  }`}
                >
                  {evaluateQCMutation.isPending ? 'Menyimpan QC...' : 'Simpan Evaluasi QC'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================
          Active Jobs Summary Modal (Job-Level Context & Completion)
          ====================================================================== */}
      {isJobModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-sky-100 text-sky-700">
                  <ClipboardList className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Daftar Job Produksi Aktif</h3>
                  <p className="text-[11px] text-slate-500">
                    {readModel?.workshop_branch_name || currentBranch?.name || 'Workshop'} — Total {readModel?.jobs_count || 0} job
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsJobModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
                aria-label="Tutup modal job"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto space-y-3 flex-1 pr-1 text-xs">
              {!readModel?.jobs || readModel.jobs.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">
                  Tidak ada job aktif saat ini.
                </div>
              ) : (
                readModel.jobs.map((j) => (
                  <div
                    key={j.id}
                    className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-black text-slate-900 text-xs">
                          Order: {j.order_number}
                        </span>
                        <span
                          className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                            j.status === 'COMPLETED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-sky-100 text-sky-800'
                          }`}
                        >
                          {j.status === 'COMPLETED' ? 'SELESAI' : 'DALAM PRODUKSI'}
                        </span>
                        {j.is_rework && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 flex items-center gap-0.5">
                            <RefreshCw className="w-2.5 h-2.5" /> Rework
                          </span>
                        )}
                      </div>
                      <div className="text-slate-500 text-[11px] flex items-center gap-3">
                        <span>Pelanggan: <b>{j.customer_name || 'Umum'}</b></span>
                        <span>•</span>
                        <span>{j.work_items_count} Work Item</span>
                      </div>
                    </div>

                    {j.status === 'IN_PROGRESS' && (
                      <button
                        onClick={() => {
                          completeProdMutation.mutate(j.id);
                        }}
                        disabled={completeProdMutation.isPending}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-2xs transition disabled:opacity-50 shrink-0"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{completeProdMutation.isPending ? 'Menyelesaikan...' : 'Selesaikan Produksi'}</span>
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsJobModalOpen(false)}
                className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold text-xs"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
