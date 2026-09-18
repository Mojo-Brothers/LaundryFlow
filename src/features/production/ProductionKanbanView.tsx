import React, { useState, useEffect } from 'react';
import { repository } from '../../core/services/repository';
import { Order, OrderStatus } from '../../core/types/database';
import { usePosStore } from '../../core/store/posStore';
import {
  Layers,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Sparkles,
  Shirt,
} from 'lucide-react';

export const ProductionKanbanView: React.FC = () => {
  const { currentBranch, currentUser } = usePosStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [damagedOrders, setDamagedOrders] = useState<Order[]>([]);

  const loadProductionOrders = async () => {
    if (!currentBranch?.id) return;
    const { washQueue, damagedQueue } = await repository.getWorkshopOrders(currentBranch.id);
    setOrders(washQueue);
    setDamagedOrders(damagedQueue);
  };

  useEffect(() => {
    loadProductionOrders();
  }, [currentBranch]);

  const stages: { id: OrderStatus; label: string; color: string }[] = [
    { id: 'RECEIVED', label: '1. Antrean Cuci', color: 'border-t-blue-500' },
    { id: 'WASHING', label: '2. Pencucian', color: 'border-t-sky-500' },
    { id: 'DRYING', label: '3. Pengeringan', color: 'border-t-amber-500' },
    { id: 'IRONING', label: '4. Setrika Uap', color: 'border-t-indigo-500' },
    { id: 'READY', label: '5. Selesai & QC', color: 'border-t-emerald-500' },
  ];

  const handleMoveStage = async (orderId: string, nextStatus: OrderStatus) => {
    await repository.updateOrderStatus(orderId, nextStatus, currentUser.id);
    await loadProductionOrders();
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              Papan Produksi &amp; Workshop (Kanban)
            </h1>
            <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800">
              Central Production Ready
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Lacak pergerakan cucian per tahapan mesin cuci, pengering, setrika, hingga QC akhir (Physical Custody Confirmed)
          </p>
        </div>
      </div>

      {/* Exception Panel: DAMAGED Orders (Excluded from normal wash queue, available for inspection/return) */}
      {damagedOrders.length > 0 && (
        <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 space-y-2">
          <div className="flex items-center gap-2 text-amber-900 font-bold text-xs">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>Panel Inspeksi &amp; Discrepancy (Barang Rusak / DAMAGED): {damagedOrders.length} Order</span>
          </div>
          <p className="text-[11px] text-amber-700">
            Order berikut diterima dalam kondisi rusak/defect di workshop. Dikeluarkan dari antrean cuci normal dan siap dikembalikan ke outlet asal via Return Transit.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1">
            {damagedOrders.map((dOrder) => (
              <div key={dOrder.id} className="p-2.5 bg-white rounded-xl border border-amber-200 shadow-2xs text-xs space-y-1">
                <div className="flex justify-between items-center font-mono font-bold text-slate-800 text-[11px]">
                  <span>{dOrder.order_number}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold">DAMAGED</span>
                </div>
                <p className="text-[11px] font-semibold text-slate-700 truncate">{dOrder.customer?.name}</p>
                <p className="text-[10px] text-slate-500">Asal: {dOrder.branch?.name || 'Outlet'}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kanban Columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const stageOrders = orders.filter((o) => {
            if (stage.id === 'WASHING') {
              return o.status === 'WASHING' || o.status === 'SORTING';
            }
            return o.status === stage.id;
          });

          return (
            <div
              key={stage.id}
              className={`bg-slate-100/70 rounded-2xl border border-slate-200 p-3 flex flex-col h-[700px] border-t-4 ${stage.color}`}
            >
              {/* Column Header */}
              <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-slate-200 text-xs font-bold text-slate-700">
                <span>{stage.label}</span>
                <span className="px-2 py-0.5 rounded-full bg-white text-slate-700 text-[11px] shadow-2xs font-mono">
                  {stageOrders.length}
                </span>
              </div>

              {/* Cards Container */}
              <div className="space-y-3 flex-1 overflow-y-auto pr-1">
                {stageOrders.length === 0 ? (
                  <div className="text-center py-10 text-slate-400 text-[11px]">
                    Kosong
                  </div>
                ) : (
                  stageOrders.map((order) => {
                    const isOverdue = new Date(order.promised_ready_at).getTime() < Date.now() && order.status !== 'READY';
                    return (
                      <div
                        key={order.id}
                        className="p-3 bg-white rounded-xl border border-slate-200 shadow-2xs hover:shadow-md transition space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-slate-900 text-[11px]">
                            {order.order_number}
                          </span>
                          {isOverdue && (
                            <span className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">
                              <AlertTriangle className="w-2.5 h-2.5" /> Overdue
                            </span>
                          )}
                        </div>

                        <div>
                          <p className="font-bold text-slate-800 truncate">{order.customer?.name}</p>
                          <p className="text-[10px] text-slate-500">
                            Masuk dari: <b>{order.branch?.name || 'Outlet'}</b>
                          </p>
                        </div>

                        {/* Items in order */}
                        <div className="text-[10px] text-slate-600 bg-slate-50 p-2 rounded-lg space-y-0.5">
                          {order.items?.map((item, idx) => (
                            <div key={idx} className="flex justify-between">
                              <span className="truncate pr-1">• {item.service_name_snap}</span>
                              <span className="font-bold shrink-0">{item.billable_weight} {item.item_type === 'KILOAN' ? 'kg' : 'pcs'}</span>
                            </div>
                          ))}
                        </div>

                        {/* Action advance stage button */}
                        <div className="pt-1 flex justify-end">
                          {stage.id === 'RECEIVED' && (
                            <button
                              onClick={() => handleMoveStage(order.id, 'WASHING')}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-sky-600 hover:bg-sky-700 text-white font-semibold text-[10px] transition"
                            >
                              <span>Mulai Cuci</span>
                              <ArrowRight className="w-3 h-3" />
                            </button>
                          )}
                          {stage.id === 'WASHING' && (
                            <button
                              onClick={() => handleMoveStage(order.id, 'DRYING')}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-semibold text-[10px] transition"
                            >
                              <span>Keringkan</span>
                              <ArrowRight className="w-3 h-3" />
                            </button>
                          )}
                          {stage.id === 'DRYING' && (
                            <button
                              onClick={() => handleMoveStage(order.id, 'IRONING')}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-[10px] transition"
                            >
                              <span>Setrika</span>
                              <ArrowRight className="w-3 h-3" />
                            </button>
                          )}
                          {stage.id === 'IRONING' && (
                            <button
                              onClick={() => handleMoveStage(order.id, 'READY')}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[10px] transition"
                            >
                              <span>QC &amp; Siap</span>
                              <CheckCircle2 className="w-3 h-3" />
                            </button>
                          )}
                          {stage.id === 'READY' && (
                            <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Siap di Rak
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
    </div>
  );
};
