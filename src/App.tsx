import React, { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Navbar } from './components/layout/Navbar';
import { FastCheckoutView } from './features/pos/FastCheckoutView';
import { OrdersView } from './features/orders/OrdersView';
import { ProductionKanbanView } from './features/production/ProductionKanbanView';
import { CustomersView } from './features/customers/CustomersView';
import { ReportsView } from './features/reports/ReportsView';
import { PublicTrackingView } from './features/tracking/PublicTrackingView';
import { ShiftManagerModal } from './features/shifts/ShiftManagerModal';

export const App: React.FC = () => {
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public Customer Tracking Route (Clean standalone page without POS navbar) */}
        <Route path="/track/:token" element={<PublicTrackingView />} />

        {/* Core Laundry Operating System POS & Operations Routes */}
        <Route
          path="/*"
          element={
            <div className="min-h-screen bg-slate-50 flex flex-col">
              <Navbar onOpenShiftModal={() => setIsShiftModalOpen(true)} />
              <main className="flex-1">
                <Routes>
                  <Route path="/" element={<FastCheckoutView />} />
                  <Route path="/orders" element={<OrdersView />} />
                  <Route path="/production" element={<ProductionKanbanView />} />
                  <Route path="/customers" element={<CustomersView />} />
                  <Route path="/reports" element={<ReportsView />} />
                </Routes>
              </main>

              {/* Shift Manager Drawer / Modal */}
              <ShiftManagerModal
                isOpen={isShiftModalOpen}
                onClose={() => setIsShiftModalOpen(false)}
              />
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  );
};
