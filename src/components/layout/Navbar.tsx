import React, { useState, useEffect } from 'react';
import { usePosStore } from '../../core/store/posStore';
import { repository } from '../../core/services/repository';
import { Branch, UserProfile, CashierShift } from '../../core/types/database';
import {
  Sparkles,
  Store,
  UserCheck,
  RotateCcw,
  Clock,
  LogOut,
  ShoppingBag,
  Layers,
  Users,
  BarChart3,
  Search,
  Truck,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { formatIDR } from '../../core/utils/currency';

interface NavbarProps {
  onOpenShiftModal: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenShiftModal }) => {
  const location = useLocation();
  const {
    currentUser,
    currentBranch,
    setUser,
    setBranch,
    allBranches,
    allUsers,
  } = usePosStore();

  const [branches, setBranches] = useState<Branch[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [activeShift, setActiveShift] = useState<CashierShift | null>(null);

  useEffect(() => {
    repository.getBranches().then(setBranches);
    repository.getUsers().then(setUsers);
  }, []);

  useEffect(() => {
    if (currentBranch) {
      repository.getActiveShift(currentBranch.id).then(setActiveShift);
    }
  }, [currentBranch]);

  const navItems = [
    { label: 'Kasir POS', path: '/', icon: ShoppingBag },
    { label: 'Pesanan', path: '/orders', icon: Search },
    { label: 'Produksi', path: '/production', icon: Layers },
    { label: 'Transit', path: '/transit', icon: Truck },
    { label: 'Pelanggan', path: '/customers', icon: Users },
    { label: 'Laporan', path: '/reports', icon: BarChart3 },
  ];

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Logo & Brand */}
          <div className="flex items-center gap-6">
            <Link to="/" className="flex items-center gap-2.5 group">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-600 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-sky-500/20 group-hover:scale-105 transition">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-extrabold text-lg tracking-tight text-slate-900">LaundryFlow</span>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">OS</span>
                </div>
                <p className="text-[10px] text-slate-500 font-medium">Laundry Operating System</p>
              </div>
            </Link>

            {/* Navigation Links */}
            <nav className="hidden md:flex items-center gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive =
                  location.pathname === item.path ||
                  (item.path !== '/' && location.pathname.startsWith(item.path));
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition ${
                      isActive
                        ? 'bg-sky-50 text-sky-700'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Right Action Controls: Branch, Role Switcher, & Shift */}
          <div className="flex items-center gap-3">
            {/* Shift Indicator Button */}
            <button
              onClick={onOpenShiftModal}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                activeShift
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
                  : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
              }`}
              title="Kelola Shift Kasir"
            >
              <Clock className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {activeShift ? `Shift Buka: ${formatIDR(activeShift.expected_cash)}` : 'Shift Tutup'}
              </span>
            </button>

            {/* Branch Switcher */}
            <div className="relative flex items-center">
              <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-700">
                <Store className="w-3.5 h-3.5 text-sky-600" />
                <select
                  aria-label="Pilih Cabang / Outlet"
                  value={currentBranch?.id}
                  onChange={(e) => {
                    const found = (branches.length > 0 ? branches : allBranches).find(b => b.id === e.target.value);
                    if (found) setBranch(found);
                  }}
                  className="bg-transparent font-semibold outline-hidden cursor-pointer"
                >
                  {(branches.length > 0 ? branches : allBranches).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.branch_type === 'CENTRAL_PRODUCTION' ? 'Workshop Pusat' : 'Outlet'})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* User / Role Switcher for Demo */}
            <div className="relative flex items-center">
              <div className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 px-2.5 py-1.5 rounded-lg text-xs text-indigo-900">
                <UserCheck className="w-3.5 h-3.5 text-indigo-600" />
                <select
                  aria-label="Ganti Role Akun Demo"
                  value={currentUser?.id}
                  onChange={(e) => {
                    const found = (users.length > 0 ? users : allUsers).find(u => u.id === e.target.value);
                    if (found) setUser(found);
                  }}
                  className="bg-transparent font-semibold outline-hidden cursor-pointer"
                >
                  {(users.length > 0 ? users : allUsers).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name} ({u.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Reset Sandbox Data Button */}
            <button
              onClick={() => {
                if (confirm('Kembalikan data demo ke kondisi awal (Laundry Sejahtera)?')) {
                  repository.resetSandbox();
                  window.location.reload();
                }
              }}
              className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
              title="Reset Sandbox Data"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
