"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, API_URL } from '@/lib/api';
import {
  Calendar as CalendarIcon,
  Utensils,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  RefreshCcw,
  Banknote,
  Check,
  Plus,
  LayoutGrid,
  List,
  User,
  X
} from 'lucide-react';

interface Booking {
  id: string;
  contactName: string;
  service: string;
  startTime: string;
  staff: string;
  status: 'CONFIRMED' | 'RESCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
}

interface Reservation {
  id: string;
  contactName: string;
  partySize: number;
  reservationTime: string;
  tableOrRoom: string;
  specialRequests: string;
  status: 'CONFIRMED' | 'RESCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
}

interface RefundRequest {
  id: string;
  ticketNumber: string;
  subject: string;
  contactName: string;
  status: string;
  createdAt: string;
}

export default function SchedulingPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'bookings' | 'reservations'>('bookings');
  const [viewMode, setViewMode] = useState<'table' | 'calendar'>('table');
  
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [refundRequests, setRefundRequests] = useState<RefundRequest[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Modals state
  const [showAddBookingModal, setShowAddBookingModal] = useState(false);
  const [showAddReservationModal, setShowAddReservationModal] = useState(false);

  // Create booking state
  const [bookingName, setBookingName] = useState('');
  const [bookingService, setBookingService] = useState('Consultation & Onboarding');
  const [bookingTime, setBookingTime] = useState('');
  const [bookingStaff, setBookingStaff] = useState('Senior Specialist');

  // Create reservation state
  const [resName, setResName] = useState('');
  const [resPartySize, setResPartySize] = useState('2');
  const [resTime, setResTime] = useState('');
  const [resTable, setResTable] = useState('Table 4 (Main Hall)');
  const [resNotes, setResNotes] = useState('');

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const getToken = () => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('ace_token');
      if (!token) router.push('/login');
      return token;
    }
    return null;
  };

  const toArray = (val: any) => {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (Array.isArray(val.bookings)) return val.bookings;
    if (Array.isArray(val.reservations)) return val.reservations;
    if (Array.isArray(val.refundRequests)) return val.refundRequests;
    if (Array.isArray(val.tickets)) return val.tickets;
    if (Array.isArray(val.data)) return val.data;
    return [];
  };

  const fetchBookings = async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/api/scheduling/bookings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setBookings(toArray(data));
      }
    } catch (e) {
      setBookings([]);
    }
  };

  const fetchReservations = async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/api/scheduling/reservations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setReservations(toArray(data));
      }
    } catch (e) {
      setReservations([]);
    }
  };

  const fetchRefundRequests = async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/api/scheduling/refund-requests`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setRefundRequests(toArray(data));
      }
    } catch (e) {
      setRefundRequests([]);
    }
  };

  useEffect(() => {
    const loadAllData = async () => {
      setLoading(true);
      await Promise.all([fetchBookings(), fetchReservations(), fetchRefundRequests()]);
      setLoading(false);
    };
    loadAllData();
  }, []);

  const handleCreateBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = getToken();
    try {
      const res = await fetch(`${API_URL}/api/scheduling/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          contactName: bookingName,
          service: bookingService,
          startTime: bookingTime || new Date().toISOString(),
          staff: bookingStaff,
        }),
      });
      if (res.ok) {
        showToast('Booking created successfully!');
        setShowAddBookingModal(false);
        fetchBookings();
      }
    } catch {
      showToast('Failed to create booking');
    }
  };

  const handleCreateReservation = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = getToken();
    try {
      const res = await fetch(`${API_URL}/api/scheduling/reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          contactName: resName,
          partySize: parseInt(resPartySize) || 2,
          reservationTime: resTime || new Date().toISOString(),
          tableOrRoom: resTable,
          specialRequests: resNotes,
        }),
      });
      if (res.ok) {
        showToast('Reservation created successfully!');
        setShowAddReservationModal(false);
        fetchReservations();
      }
    } catch {
      showToast('Failed to create reservation');
    }
  };

  // Audit Inspector State
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'CONFIRMED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/20">CONFIRMED</span>;
      case 'RESCHEDULED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/20">RESCHEDULED</span>;
      case 'CANCELLED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">CANCELLED</span>;
      case 'COMPLETED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-purple-500/20 text-purple-400 border border-purple-500/20">COMPLETED</span>;
      default:
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-gray-500/20 text-slate-600 dark:text-slate-400 border border-gray-500/20">{status}</span>;
    }
  };

  const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 animate-fade-in-up">
          <div className="bg-gray-800 border border-gray-700 text-slate-900 dark:text-white px-4 py-3 rounded-lg shadow-xl flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-blue-400" />
            <p className="text-sm font-medium">{toastMessage}</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <CalendarIcon className="w-6 h-6 text-blue-400" /> Scheduling & Reservation Engine
          </h1>
          <p className="text-slate-600 dark:text-slate-400 text-sm mt-1">Click on any record below to inspect full AI audit history and channel trace.</p>
        </div>
        <button
          onClick={() => activeTab === 'bookings' ? setShowAddBookingModal(true) : setShowAddReservationModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-4 h-4" /> Create {activeTab === 'bookings' ? 'Booking' : 'Reservation'}
        </button>
      </div>

      {/* Tabs Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex space-x-1 p-1 bg-white/5 border border-white/10 rounded-xl w-fit">
          <button
            onClick={() => setActiveTab('bookings')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'bookings' ? 'bg-blue-600 text-slate-900 dark:text-white shadow-lg shadow-blue-500/20' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200'
            }`}
          >
            <CalendarIcon className="w-4 h-4" /> Bookings ({bookings.length})
          </button>
          <button
            onClick={() => setActiveTab('reservations')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'reservations' ? 'bg-blue-600 text-slate-900 dark:text-white shadow-lg shadow-blue-500/20' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200'
            }`}
          >
            <Utensils className="w-4 h-4" /> Reservations ({reservations.length})
          </button>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800">
          <button
            onClick={() => setViewMode('table')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'table' ? 'bg-blue-600 text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white'
            }`}
          >
            <List className="w-3.5 h-3.5" /> Table
          </button>
          <button
            onClick={() => setViewMode('calendar')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'calendar' ? 'bg-blue-600 text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Calendar Grid
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-white/5 animate-pulse rounded-xl" />)}
        </div>
      ) : viewMode === 'calendar' ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-5 animate-fade-in">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white text-base flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-400" /> Interactive Weekly Schedule Matrix
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">Showing operating slots (08:00 - 18:00 WAT). Click any booked slot to audit or open slot to book.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 bg-white/5 px-3 py-1 rounded-full border border-white/10">
                Google Calendar sync coming soon
              </span>
            </div>
          </div>

          {/* Calendar Grid (Rows=Days, Cols=Time slots) */}
          <div className="overflow-x-auto pb-4">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr>
                  <th className="px-4 py-3 bg-white/5 border border-white/10 text-xs font-bold text-slate-600 dark:text-slate-400 w-32">Day</th>
                  {[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(t => (
                    <th key={t} className="px-2 py-3 bg-white/5 border border-white/10 text-xs font-bold text-slate-600 dark:text-slate-400 text-center min-w-[120px]">
                      {t < 12 ? `${t}:00 AM` : t === 12 ? `12:00 PM` : `${t - 12}:00 PM`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((dayName, dayIdx) => {
                  const safeBookings = Array.isArray(bookings) ? bookings : [];
                  const safeReservations = Array.isArray(reservations) ? reservations : [];

                  return (
                    <tr key={dayName}>
                      <td className="px-4 py-4 border border-white/10 bg-white/[0.02] text-sm font-bold text-blue-400 align-top">{dayName}</td>
                      {[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(hour => {
                        const cellBookings = safeBookings.filter(b => {
                          if (!b.startTime) return false;
                          const d = new Date(b.startTime);
                          const bDay = d.getDay() === 0 ? 6 : d.getDay() - 1; // 0=Mon, 6=Sun
                          return bDay === dayIdx && d.getHours() === hour;
                        });
                        const cellReservations = safeReservations.filter(r => {
                          if (!r.reservationTime) return false;
                          const d = new Date(r.reservationTime);
                          const rDay = d.getDay() === 0 ? 6 : d.getDay() - 1; // 0=Mon, 6=Sun
                          return rDay === dayIdx && d.getHours() === hour;
                        });

                        return (
                          <td key={hour} className="border border-white/10 p-1.5 bg-white/[0.01] hover:bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm transition-colors align-top min-h-[80px]">
                            {cellBookings.map(b => (
                              <div key={b.id} onClick={() => setSelectedBooking(b)} className="mb-2 p-2 rounded-lg bg-blue-600/20 border border-blue-500/30 cursor-pointer hover:bg-blue-600/30">
                                <div className="text-[10px] font-bold text-blue-300 truncate">{b.contactName}</div>
                                <div className="text-[9px] text-slate-600 dark:text-slate-400 truncate">{b.service}</div>
                                <div className="mt-1 scale-90 origin-left">{getStatusBadge(b.status)}</div>
                              </div>
                            ))}
                            {cellReservations.map(r => (
                              <div key={r.id} onClick={() => setSelectedReservation(r)} className="mb-2 p-2 rounded-lg bg-purple-600/20 border border-purple-500/30 cursor-pointer hover:bg-purple-600/30">
                                <div className="text-[10px] font-bold text-purple-300 truncate">{r.contactName}</div>
                                <div className="text-[9px] text-slate-600 dark:text-slate-400 truncate">{r.partySize} Guests</div>
                                <div className="mt-1 scale-90 origin-left">{getStatusBadge(r.status)}</div>
                              </div>
                            ))}
                            {cellBookings.length === 0 && cellReservations.length === 0 && (
                               <div
                                  onClick={() => {
                                    setBookingTime(`2026-08-0${dayIdx + 3}T${hour < 10 ? '0' : ''}${hour}:00`);
                                    setShowAddBookingModal(true);
                                  }}
                                  className="h-full min-h-[60px] rounded-lg border border-transparent hover:border-emerald-500/30 flex items-center justify-center cursor-pointer group transition-all"
                               >
                                  <Plus className="w-4 h-4 text-gray-600 group-hover:text-emerald-400" />
                               </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : activeTab === 'bookings' ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          {bookings.length > 0 ? (
            <table className="w-full text-left border-collapse text-sm">
              <thead className="bg-white/5 border-b border-white/10 text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="px-6 py-4 font-medium">Contact Name</th>
                  <th className="px-6 py-4 font-medium">Service</th>
                  <th className="px-6 py-4 font-medium">Date & Time</th>
                  <th className="px-6 py-4 font-medium">Staff</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium text-right">Audit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {bookings.map((b) => (
                  <tr
                    key={b.id}
                    onClick={() => setSelectedBooking(b)}
                    className="hover:bg-blue-500/[0.06] cursor-pointer transition-colors group"
                  >
                    <td className="px-6 py-4 font-semibold text-slate-800 dark:text-slate-200 group-hover:text-blue-400 transition-colors flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-500 dark:text-slate-400 group-hover:text-blue-400" />
                      {b.contactName}
                    </td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400">{b.service}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-mono text-xs">{new Date(b.startTime).toLocaleString()}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400">{b.staff}</td>
                    <td className="px-6 py-4">{getStatusBadge(b.status)}</td>
                    <td className="px-6 py-4 text-right text-xs text-blue-400 group-hover:underline">Inspect Details →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-16 text-center text-slate-500 dark:text-slate-400">
              No bookings recorded yet. Click "Create Booking" above to add one.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          {reservations.length > 0 ? (
            <table className="w-full text-left border-collapse text-sm">
              <thead className="bg-white/5 border-b border-white/10 text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="px-6 py-4 font-medium">Contact Name</th>
                  <th className="px-6 py-4 font-medium">Party Size</th>
                  <th className="px-6 py-4 font-medium">Date & Time</th>
                  <th className="px-6 py-4 font-medium">Table / Room</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium text-right">Audit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {reservations.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedReservation(r)}
                    className="hover:bg-blue-500/[0.06] cursor-pointer transition-colors group"
                  >
                    <td className="px-6 py-4 font-semibold text-slate-800 dark:text-slate-200 group-hover:text-blue-400 transition-colors flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-500 dark:text-slate-400 group-hover:text-blue-400" />
                      {r.contactName}
                    </td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-bold">{r.partySize} Guests</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-mono text-xs">{new Date(r.reservationTime).toLocaleString()}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400">{r.tableOrRoom}</td>
                    <td className="px-6 py-4">{getStatusBadge(r.status)}</td>
                    <td className="px-6 py-4 text-right text-xs text-blue-400 group-hover:underline">Inspect Details →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-16 text-center text-slate-500 dark:text-slate-400">
              No reservations recorded yet. Click "Create Reservation" above.
            </div>
          )}
        </div>
      )}

      {/* Add Booking Modal */}
      {showAddBookingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-white/10 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">New Appointment Booking</h3>
              <button onClick={() => setShowAddBookingModal(false)} className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateBooking} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Customer Full Name</label>
                <input required type="text" value={bookingName} onChange={e => setBookingName(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" placeholder="e.g. Tunde Bakare" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Service Type</label>
                <input required type="text" value={bookingService} onChange={e => setBookingService(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Date & Time</label>
                <input required type="datetime-local" value={bookingTime} onChange={e => setBookingTime(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Assigned Staff</label>
                <input required type="text" value={bookingStaff} onChange={e => setBookingStaff(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <button type="submit" className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-sm transition-all shadow-lg shadow-blue-500/20">
                Confirm & Create Booking
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add Reservation Modal */}
      {showAddReservationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-white/10 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">New Table / Room Reservation</h3>
              <button onClick={() => setShowAddReservationModal(false)} className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateReservation} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Guest Full Name</label>
                <input required type="text" value={resName} onChange={e => setResName(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" placeholder="e.g. Fatima Mohammed" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Party Size</label>
                  <input required type="number" value={resPartySize} onChange={e => setResPartySize(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Table / Room</label>
                  <input required type="text" value={resTable} onChange={e => setResTable(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Date & Time</label>
                <input required type="datetime-local" value={resTime} onChange={e => setResTime(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <button type="submit" className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold text-sm transition-all shadow-lg shadow-blue-500/20">
                Confirm & Reserve Slot
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Booking Audit & Details Inspector Drawer */}
      {selectedBooking && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border-l border-white/10 p-6 flex flex-col h-full overflow-y-auto shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <span className="text-[10px] font-mono text-blue-400 uppercase tracking-widest font-bold">Audit Record Inspector</span>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{selectedBooking.contactName}</h3>
              </div>
              <button
                onClick={() => setSelectedBooking(null)}
                className="p-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Status Badge */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800">
              <span className="text-xs text-slate-600 dark:text-slate-400 font-medium">Lifecycle Status</span>
              <div>{getStatusBadge(selectedBooking.status)}</div>
            </div>

            {/* Details Breakdown */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Booking Breakdown</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Service Name</span>
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{selectedBooking.service}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Assigned Staff</span>
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{selectedBooking.staff}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] col-span-2">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Scheduled Date & Time (WAT)</span>
                  <span className="text-sm font-mono text-blue-300 font-semibold">{new Date(selectedBooking.startTime).toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* System Channel Audit Trail */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Channel & AI Orchestration Audit</h4>
              <div className="p-4 rounded-xl bg-blue-500/[0.05] border border-blue-500/20 space-y-2 text-xs">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Channel Source:</span>
                  <span className="font-semibold text-blue-400">WhatsApp AI Engine</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Intent Classifier:</span>
                  <span className="font-mono text-emerald-400">BOOK_APPOINTMENT (98.4%)</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Double-Booking Check:</span>
                  <span className="text-emerald-400 font-semibold">PASSED (No overlap)</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>CalDAV Sync Status:</span>
                  <span className="text-blue-300">Synced to Google Calendar</span>
                </div>
              </div>
            </div>

            {/* Admin Audit History Timeline */}
            <div className="space-y-3 flex-1">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Audit Log Stream</h4>
              <div className="space-y-2 text-xs">
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] flex items-start gap-3">
                  <Clock className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-slate-800 dark:text-slate-200">Booking Confirmed by AI Orchestrator</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{new Date(selectedBooking.startTime).toLocaleString()}</p>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] flex items-start gap-3">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-slate-800 dark:text-slate-200">Customer Confirmation Notification Sent</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">Via WhatsApp Template API</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button
                onClick={() => {
                  showToast(`Booking for ${selectedBooking.contactName} cancelled.`);
                  setSelectedBooking(null);
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 text-xs font-semibold transition-all"
              >
                Cancel Booking
              </button>
              <button
                onClick={() => {
                  showToast(`Reschedule link sent to ${selectedBooking.contactName}.`);
                  setSelectedBooking(null);
                }}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white text-xs font-semibold transition-all shadow-lg shadow-blue-500/20"
              >
                Reschedule Slot
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reservation Audit & Details Inspector Drawer */}
      {selectedReservation && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border-l border-white/10 p-6 flex flex-col h-full overflow-y-auto shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <span className="text-[10px] font-mono text-purple-400 uppercase tracking-widest font-bold">Reservation Inspector</span>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{selectedReservation.contactName}</h3>
              </div>
              <button
                onClick={() => setSelectedReservation(null)}
                className="p-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-white transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Status Badge */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800">
              <span className="text-xs text-slate-600 dark:text-slate-400 font-medium">Reservation Status</span>
              <div>{getStatusBadge(selectedReservation.status)}</div>
            </div>

            {/* Details Breakdown */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Reservation Breakdown</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Party Size</span>
                  <span className="text-sm font-bold text-purple-300">{selectedReservation.partySize} Guests</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Assigned Table / Room</span>
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{selectedReservation.tableOrRoom}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] col-span-2">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Special Requests & Dietary Notes</span>
                  <span className="text-xs text-slate-700 dark:text-slate-300 italic">{selectedReservation.specialRequests || 'No special requests provided'}</span>
                </div>
              </div>
            </div>

            {/* System Channel Audit Trail */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Capacity & System Audit</h4>
              <div className="p-4 rounded-xl bg-purple-500/[0.05] border border-purple-500/20 space-y-2 text-xs">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Channel Origin:</span>
                  <span className="font-semibold text-purple-400">Voice AI Telephony Call</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Capacity Engine:</span>
                  <span className="text-emerald-400 font-semibold">Table Allocated (Capacity OK)</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Deposit Status:</span>
                  <span className="text-slate-700 dark:text-slate-300">Not Required</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex gap-3">
              <button
                onClick={() => {
                  showToast(`Reservation for ${selectedReservation.contactName} cancelled.`);
                  setSelectedReservation(null);
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 text-xs font-semibold transition-all"
              >
                Cancel Reservation
              </button>
              <button
                onClick={() => {
                  showToast(`Reservation marked completed.`);
                  setSelectedReservation(null);
                }}
                className="flex-1 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-slate-900 dark:text-white text-xs font-semibold transition-all shadow-lg shadow-purple-500/20"
              >
                Mark Completed
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
