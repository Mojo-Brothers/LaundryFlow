import React, { useState, useEffect } from 'react';
import { repository } from '../../core/services/repository';
import { Customer } from '../../core/types/database';
import { usePosStore } from '../../core/store/posStore';
import {
  Users,
  Search,
  UserPlus,
  Phone,
  MapPin,
  FileText,
  Star,
} from 'lucide-react';

export const CustomersView: React.FC = () => {
  const { currentBranch } = usePosStore();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [tier, setTier] = useState<'REGULAR' | 'VIP'>('REGULAR');

  const loadCustomers = async () => {
    const list = await repository.getCustomers();
    setCustomers(list);
  };

  useEffect(() => {
    loadCustomers();
  }, []);

  const filtered = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.phone.includes(searchQuery) ||
      (c.address && c.address.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !phone) return;

    await repository.createCustomer({
      organization_id: currentBranch.organization_id,
      name,
      phone,
      whatsapp: phone,
      address,
      notes,
      membership_tier: tier,
    });

    setIsModalOpen(false);
    setName('');
    setPhone('');
    setAddress('');
    setNotes('');
    loadCustomers();
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
            Database Pelanggan
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Kelola data kontak, riwayat catatan khusus, dan keanggotaan pelanggan
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs transition shadow-sm self-start sm:self-auto"
        >
          <UserPlus className="w-4 h-4" />
          <span>Tambah Pelanggan</span>
        </button>
      </div>

      {/* Search Input */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Cari pelanggan berdasarkan nama, nomor telepon, atau alamat..."
          className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 text-sm bg-white focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden shadow-2xs"
        />
      </div>

      {/* Customer Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((c) => (
          <div
            key={c.id}
            className="p-5 bg-white rounded-2xl border border-slate-200 shadow-2xs hover:shadow-md transition space-y-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-sky-100 text-sky-700 flex items-center justify-center font-bold text-sm">
                  {c.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-900">{c.name}</h3>
                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-sky-50 text-sky-700 border border-sky-100">
                    {c.membership_tier}
                  </span>
                </div>
              </div>
              <a
                href={`https://wa.me/62${c.phone.replace(/^0/, '')}`}
                target="_blank"
                rel="noreferrer"
                className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
                title="Buka WhatsApp"
              >
                <Phone className="w-4 h-4" />
              </a>
            </div>

            <div className="space-y-1.5 text-xs text-slate-600 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-2">
                <Phone className="w-3.5 h-3.5 text-slate-400" />
                <span className="font-mono">{c.phone}</span>
              </div>
              {c.address && (
                <div className="flex items-start gap-2">
                  <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                  <span className="text-slate-500 truncate">{c.address}</span>
                </div>
              )}
              {c.notes && (
                <div className="flex items-start gap-2 text-amber-800 bg-amber-50 p-2 rounded-lg mt-2 text-[11px]">
                  <FileText className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <span className="italic">{c.notes}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Modal Tambah Pelanggan */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="font-bold text-slate-900 text-base">Tambah Pelanggan Baru</h2>
            <form onSubmit={handleCreate} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Nama Lengkap *</label>
                <input
                  type="text"
                  required
                  placeholder="Misal: Bapak Hendarto"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Nomor WhatsApp *</label>
                <input
                  type="tel"
                  required
                  placeholder="08123456789"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Tipe Keanggotaan</label>
                <select
                  value={tier}
                  onChange={(e) => setTier(e.target.value as any)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                >
                  <option value="REGULAR">REGULAR</option>
                  <option value="VIP">VIP</option>
                </select>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Alamat</label>
                <input
                  type="text"
                  placeholder="Jalan / RT RW / Blok perumahan"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Catatan Khusus (Alergi / Permintaan)</label>
                <input
                  type="text"
                  placeholder="Cth: Jangan pakai parfum menyengat"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 outline-hidden"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 py-2.5 rounded-lg bg-slate-100 font-semibold text-slate-700 hover:bg-slate-200 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-lg bg-sky-600 text-white font-semibold hover:bg-sky-700 transition"
                >
                  Simpan Pelanggan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
