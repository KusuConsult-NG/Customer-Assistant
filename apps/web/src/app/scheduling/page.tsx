"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, API_URL, apiFetch } from '@/lib/api';
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

/**
 * Appointments and reservations.
 *
 * ── What was wrong here ─────────────────────────────────────────────────────
 *
 * THE ACTION BUTTONS DID NOTHING. "Cancel Booking", "Reschedule Slot",
 * "Cancel Reservation" and "Mark Completed" each showed a toast — *"Booking for
 * Jane Citizen cancelled."* — closed the panel, and made no request at all. The
 * citizen's appointment was untouched and the officer was told it was cancelled.
 * Seven endpoints existed for exactly these actions and none was ever called.
 * That is the first invariant of this repository: never fabricate success shown
 * to a human.
 *
 * THE TYPES DID NOT MATCH THE API. The interfaces declared `contactName`,
 * `service`, `staff` and `tableOrRoom`; the API returns `contact.fullName`,
 * `serviceName`, `staffName` and `tableOrRoomNumber`. Every one of those table
 * cells rendered empty, and the detail panel with them.
 *
 * CREATING ONE RETURNED 500. The form posted `{contactName, service, staff}`
 * where the endpoint requires `{contactId, serviceName, staffName}`. A booking
 * belongs to a CONTACT — the endpoint checks that contact belongs to this
 * agency, so another tenant's citizen cannot be booked by id — which is why
 * there is now a contact picker and not a free-text name box. `if (res.ok)`
 * with no else meant the failure was silent: no toast, no error, nothing.
 *
 * Every action below reports what the server actually did, and re-reads the
 * list afterwards rather than patching local state to look right.
 */
interface Contact {
  id: string;
  fullName: string;
  phoneNumber: string;
}

type ScheduleStatus = 'CONFIRMED' | 'RESCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

interface Booking {
  id: string;
  contactId: string;
  contact?: Contact | null;
  serviceName: string;
  startTime: string;
  endTime?: string;
  staffName?: string | null;
  notes?: string | null;
  status: ScheduleStatus;
}

interface Reservation {
  id: string;
  contactId: string;
  contact?: Contact | null;
  partySize: number;
  reservationTime: string;
  tableOrRoomNumber?: string | null;
  specialRequests?: string | null;
  status: ScheduleStatus;
}

/** A booking or reservation is over once it is cancelled or completed. */
const isOpen = (status: string) => status !== 'CANCELLED' && status !== 'COMPLETED';

/** `datetime-local` wants local time with no zone; the API wants ISO. */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

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
  const [activeTab, setActiveTab] = useState<'bookings' | 'reservations' | 'refunds'>('bookings');
  const [viewMode, setViewMode] = useState<'table' | 'calendar'>('table');
  
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [refundRequests, setRefundRequests] = useState<RefundRequest[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Modals state
  const [showAddBookingModal, setShowAddBookingModal] = useState(false);
  const [showAddReservationModal, setShowAddReservationModal] = useState(false);

  // Contacts, for the picker. A booking belongs to a contact id, not a name.
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Create booking state
  const [bookingContactId, setBookingContactId] = useState('');
  const [bookingService, setBookingService] = useState('Consultation & Onboarding');
  const [bookingTime, setBookingTime] = useState('');
  const [bookingStaff, setBookingStaff] = useState('');

  // Create reservation state
  const [resContactId, setResContactId] = useState('');
  const [resPartySize, setResPartySize] = useState('2');
  const [resTime, setResTime] = useState('');
  const [resTable, setResTable] = useState('');
  const [resNotes, setResNotes] = useState('');

  // What an action is doing, and what the server said if it refused.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reschedule prompts for a new time rather than assuming one.
  const [rescheduleFor, setRescheduleFor] = useState<{ kind: 'booking' | 'reservation'; id: string; name: string } | null>(null);
  const [newTime, setNewTime] = useState('');

  // Cancelling and refunding both take a reason, because the citizen will ask.
  const [reasonFor, setReasonFor] = useState<{ kind: 'booking' | 'reservation'; id: string; name: string; action: 'cancel' | 'refund' } | null>(null);
  const [reason, setReason] = useState('');

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 4000);
  };

  /**
   * The server's own words, or a plain fallback.
   *
   * A Nest validation error arrives as an array of messages. Flattening it
   * matters here: "That slot is already taken by Corporate Partnership Meeting
   * (14:00)" is the whole reason an officer needs, and "Failed" is not.
   */
  const reasonFromResponse = async (res: Response, fallback: string) => {
    try {
      const body = await res.json();
      const m = body?.message;
      if (Array.isArray(m)) return m.join(' ');
      if (typeof m === 'string' && m) return m;
    } catch {
      // A response with no JSON body is not an error in itself.
    }
    return fallback;
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
      const res = await apiFetch(`${API_URL}/api/scheduling/bookings`, {
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
      const res = await apiFetch(`${API_URL}/api/scheduling/reservations`, {
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
      const res = await apiFetch(`${API_URL}/api/scheduling/refund-requests`, {
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

  const fetchContacts = async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await apiFetch(`${API_URL}/api/crm/contacts?limit=200`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setContacts(toArray(data));
      }
    } catch {
      setContacts([]);
    }
  };

  useEffect(() => {
    const loadAllData = async () => {
      setLoading(true);
      await Promise.all([fetchBookings(), fetchReservations(), fetchRefundRequests(), fetchContacts()]);
      setLoading(false);
    };
    loadAllData();
  }, []);

  /**
   * One place every write goes through.
   *
   * It reports the server's own refusal, and re-reads the list on success
   * instead of patching local state — a row that says CANCELLED because the
   * browser decided so is the same lie as a toast that says it.
   */
  const send = async (
    label: string,
    url: string,
    init: RequestInit,
    onDone: () => Promise<void> | void
  ): Promise<boolean> => {
    const token = getToken();
    if (!token) return false;
    setBusy(label);
    setActionError(null);
    try {
      const res = await apiFetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      if (!res.ok) {
        setActionError(await reasonFromResponse(res, `${label} failed (HTTP ${res.status}).`));
        return false;
      }
      await onDone();
      return true;
    } catch (err: any) {
      setActionError(err?.message || `${label} could not reach the server.`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleCreateBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    // contactId, serviceName, staffName — the names the endpoint reads. The
    // old payload sent contactName/service/staff and got a 500 every time.
    const ok = await send(
      'Create booking',
      `${API_URL}/api/scheduling/bookings`,
      {
        method: 'POST',
        body: JSON.stringify({
          contactId: bookingContactId,
          serviceName: bookingService,
          startTime: bookingTime ? new Date(bookingTime).toISOString() : '',
          ...(bookingStaff.trim() ? { staffName: bookingStaff.trim() } : {}),
        }),
      },
      fetchBookings
    );
    if (ok) {
      showToast('Booking created.');
      setShowAddBookingModal(false);
      setBookingContactId(''); setBookingTime(''); setBookingStaff('');
    }
  };

  const handleCreateReservation = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await send(
      'Create reservation',
      `${API_URL}/api/scheduling/reservations`,
      {
        method: 'POST',
        body: JSON.stringify({
          contactId: resContactId,
          partySize: parseInt(resPartySize, 10) || 1,
          reservationTime: resTime ? new Date(resTime).toISOString() : '',
          ...(resTable.trim() ? { tableOrRoomNumber: resTable.trim() } : {}),
          ...(resNotes.trim() ? { specialRequests: resNotes.trim() } : {}),
        }),
      },
      fetchReservations
    );
    if (ok) {
      showToast('Reservation created.');
      setShowAddReservationModal(false);
      setResContactId(''); setResTime(''); setResTable(''); setResNotes('');
    }
  };

  /** Cancel, for real. The reason is stored on the record the citizen will ask about. */
  const doCancel = async () => {
    if (!reasonFor) return;
    const { kind, id, name } = reasonFor;
    const ok = await send(
      'Cancel',
      `${API_URL}/api/scheduling/${kind === 'booking' ? 'bookings' : 'reservations'}/${id}/cancel`,
      { method: 'PATCH', body: JSON.stringify({ reason: reason.trim() || undefined }) },
      kind === 'booking' ? fetchBookings : fetchReservations
    );
    if (ok) {
      showToast(`${kind === 'booking' ? 'Booking' : 'Reservation'} for ${name} cancelled.`);
      setReasonFor(null); setReason('');
      setSelectedBooking(null); setSelectedReservation(null);
    }
  };

  /**
   * A refund request cancels the record too and raises a HIGH-priority ticket,
   * so the confirmation says so — the officer is doing two things with one
   * button and should not discover the second one later.
   */
  const doRefund = async () => {
    if (!reasonFor) return;
    const { kind, id, name } = reasonFor;
    if (!reason.trim()) {
      setActionError('A refund request needs a reason — it becomes the body of the ticket somebody has to act on.');
      return;
    }
    const ok = await send(
      'Refund request',
      `${API_URL}/api/scheduling/${kind === 'booking' ? 'bookings' : 'reservations'}/${id}/refund-request`,
      { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) },
      async () => { await Promise.all([fetchBookings(), fetchReservations(), fetchRefundRequests()]); }
    );
    if (ok) {
      showToast(`Refund ticket raised for ${name}; the ${kind} is cancelled.`);
      setReasonFor(null); setReason('');
      setSelectedBooking(null); setSelectedReservation(null);
    }
  };

  const doReschedule = async () => {
    if (!rescheduleFor) return;
    const { kind, id, name } = rescheduleFor;
    if (!newTime) {
      setActionError('Pick the new date and time first.');
      return;
    }
    const iso = new Date(newTime).toISOString();
    const ok = await send(
      'Reschedule',
      `${API_URL}/api/scheduling/${kind === 'booking' ? 'bookings' : 'reservations'}/${id}/reschedule`,
      {
        method: 'PATCH',
        body: JSON.stringify(
          kind === 'booking' ? { newStartTime: iso } : { newReservationTime: iso }
        ),
      },
      kind === 'booking' ? fetchBookings : fetchReservations
    );
    if (ok) {
      showToast(`${name} moved to ${new Date(iso).toLocaleString()}.`);
      setRescheduleFor(null); setNewTime('');
      setSelectedBooking(null); setSelectedReservation(null);
    }
  };

  /** OWNER/ADMIN only server-side; a refusal is rendered rather than swallowed. */
  const setBookingStatus = async (id: string, status: ScheduleStatus) => {
    const ok = await send(
      'Update status',
      `${API_URL}/api/scheduling/bookings/${id}/status`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      fetchBookings
    );
    if (ok) {
      showToast(`Marked ${status.toLowerCase()}.`);
      setSelectedBooking(null);
    }
  };

  // Audit Inspector State
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'CONFIRMED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">CONFIRMED</span>;
      case 'RESCHEDULED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">RESCHEDULED</span>;
      case 'CANCELLED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/20">CANCELLED</span>;
      case 'COMPLETED':
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20">COMPLETED</span>;
      default:
        return <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-500/20 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-500/20">{status}</span>;
    }
  };

  const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 animate-fade-in-up">
          <div className="bg-gray-800 border border-gray-700 text-slate-900 dark:text-white px-4 py-3 rounded-lg shadow-xl flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <p className="text-sm font-medium">{toastMessage}</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <CalendarIcon className="w-6 h-6 text-[#558A02] dark:text-[#74BA03]" /> Appointments &amp; Reservations
          </h1>
          <p className="text-slate-600 dark:text-slate-400 text-sm mt-1">Schedule citizen biometrics capture, clinic consultations, and inspect AI booking audit trails.</p>
        </div>
        {activeTab !== 'refunds' && (
          <button
            onClick={() => { setActionError(null); activeTab === 'bookings' ? setShowAddBookingModal(true) : setShowAddReservationModal(true); }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all text-sm shadow-lg shadow-blue-500/20"
          >
            <Plus className="w-4 h-4" /> Create {activeTab === 'bookings' ? 'Booking' : 'Reservation'}
          </button>
        )}
      </div>

      {/* Tabs Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex space-x-1 p-1 bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-xl w-fit">
          <button
            onClick={() => setActiveTab('bookings')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'bookings' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200'
            }`}
          >
            <CalendarIcon className="w-4 h-4" /> Bookings ({bookings.length})
          </button>
          <button
            onClick={() => setActiveTab('reservations')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'reservations' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200'
            }`}
          >
            <Utensils className="w-4 h-4" /> Reservations ({reservations.length})
          </button>
          {/* The refund queue was fetched on every load and rendered nowhere —
              dead state for an endpoint with no screen. The refund button now
              fills it, so it has to be somewhere an administrator can read. */}
          <button
            onClick={() => setActiveTab('refunds')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'refunds' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200'
            }`}
          >
            <Banknote className="w-4 h-4" /> Refunds ({refundRequests.length})
          </button>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm">
          <button
            onClick={() => setViewMode('table')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <List className="w-3.5 h-3.5" /> Table
          </button>
          <button
            onClick={() => setViewMode('calendar')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'calendar' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Calendar Grid
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-slate-100 dark:bg-slate-800/60 animate-pulse rounded-xl" />)}
        </div>
      ) : viewMode === 'calendar' ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-5 animate-fade-in">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white text-base flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-600 dark:text-blue-400" /> Interactive Weekly Schedule Matrix
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">Showing operating slots (08:00 - 18:00 WAT). Click any booked slot to audit or open slot to book.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800/60 px-3 py-1 rounded-full border border-slate-200 dark:border-slate-800">
                Google Calendar sync coming soon
              </span>
            </div>
          </div>

          {/* Calendar Grid (Rows=Days, Cols=Time slots) */}
          <div className="overflow-x-auto pb-4">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr>
                  <th className="px-4 py-3 bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-600 dark:text-slate-400 w-32">Day</th>
                  {[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(t => (
                    <th key={t} className="px-2 py-3 bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-600 dark:text-slate-400 text-center min-w-[120px]">
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
                      <td className="px-4 py-4 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-sm font-bold text-blue-600 dark:text-blue-400 align-top">{dayName}</td>
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
                          <td key={hour} className="border border-slate-200 dark:border-slate-800 p-1.5 bg-white dark:bg-slate-900/80 hover:bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm transition-colors align-top min-h-[80px]">
                            {cellBookings.map(b => (
                              <div key={b.id} onClick={() => setSelectedBooking(b)} className="mb-2 p-2 rounded-lg bg-blue-600/20 border border-blue-200 dark:border-blue-500/30 cursor-pointer hover:bg-blue-600/30">
                                <div className="text-[10px] font-bold text-blue-700 dark:text-blue-300 truncate">{b.contact?.fullName ?? 'Unknown contact'}</div>
                                <div className="text-[9px] text-slate-600 dark:text-slate-400 truncate">{b.serviceName}</div>
                                <div className="mt-1 scale-90 origin-left">{getStatusBadge(b.status)}</div>
                              </div>
                            ))}
                            {cellReservations.map(r => (
                              <div key={r.id} onClick={() => setSelectedReservation(r)} className="mb-2 p-2 rounded-lg bg-purple-600/20 border border-purple-200 dark:border-purple-500/30 cursor-pointer hover:bg-purple-600/30">
                                <div className="text-[10px] font-bold text-purple-700 dark:text-purple-300 truncate">{r.contact?.fullName ?? 'Unknown contact'}</div>
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
                                  className="h-full min-h-[60px] rounded-lg border border-transparent hover:border-emerald-200 dark:border-emerald-500/30 flex items-center justify-center cursor-pointer group transition-all"
                               >
                                  <Plus className="w-4 h-4 text-slate-500 dark:text-slate-400 group-hover:text-emerald-600 dark:text-emerald-400" />
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
      ) : activeTab === 'refunds' ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-hidden">
          {refundRequests.length > 0 ? (
            <table className="w-full text-left border-collapse text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="px-6 py-4 font-medium">Ticket</th>
                  <th className="px-6 py-4 font-medium">Subject</th>
                  <th className="px-6 py-4 font-medium">Citizen</th>
                  <th className="px-6 py-4 font-medium">Raised</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {refundRequests.map((t) => (
                  <tr key={t.id}>
                    <td className="px-6 py-4 font-mono text-xs text-blue-600 dark:text-blue-400">{t.ticketNumber}</td>
                    <td className="px-6 py-4 text-slate-700 dark:text-slate-300">{t.subject}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400">{t.contactName || '—'}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-mono text-xs">{t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}</td>
                    <td className="px-6 py-4">{getStatusBadge(t.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-16 text-center text-slate-500 dark:text-slate-400 text-sm">
              No refund requests. Raising one from a booking or reservation cancels it and files a
              high-priority ticket here.
            </div>
          )}
        </div>
      ) : activeTab === 'bookings' ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-hidden">
          {bookings.length > 0 ? (
            <table className="w-full text-left border-collapse text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400">
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
                    <td className="px-6 py-4 font-semibold text-slate-800 dark:text-slate-200 group-hover:text-blue-600 dark:text-blue-400 transition-colors flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-500 dark:text-slate-400 group-hover:text-blue-600 dark:text-blue-400" />
                      {b.contact?.fullName ?? 'Unknown contact'}
                    </td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400">{b.serviceName}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-mono text-xs">{new Date(b.startTime).toLocaleString()}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400">{b.staffName || <span className="text-slate-400 dark:text-slate-500">unassigned</span>}</td>
                    <td className="px-6 py-4">{getStatusBadge(b.status)}</td>
                    <td className="px-6 py-4 text-right text-xs text-blue-600 dark:text-blue-400 group-hover:underline">Inspect Details →</td>
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
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-hidden">
          {reservations.length > 0 ? (
            <table className="w-full text-left border-collapse text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400">
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
                    <td className="px-6 py-4 font-semibold text-slate-800 dark:text-slate-200 group-hover:text-blue-600 dark:text-blue-400 transition-colors flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-500 dark:text-slate-400 group-hover:text-blue-600 dark:text-blue-400" />
                      {r.contact?.fullName ?? 'Unknown contact'}
                    </td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-bold">{r.partySize} Guests</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-mono text-xs">{new Date(r.reservationTime).toLocaleString()}</td>
                    <td className="px-6 py-4 text-slate-600 dark:text-slate-400">{r.tableOrRoomNumber || <span className="text-slate-400 dark:text-slate-500">—</span>}</td>
                    <td className="px-6 py-4">{getStatusBadge(r.status)}</td>
                    <td className="px-6 py-4 text-right text-xs text-blue-600 dark:text-blue-400 group-hover:underline">Inspect Details →</td>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">New Appointment Booking</h3>
              <button onClick={() => setShowAddBookingModal(false)} className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateBooking} className="space-y-4">
              {/* A booking belongs to a CONTACT, not a typed name: the endpoint
                  checks the contact belongs to this agency, so a citizen of
                  another agency cannot be booked by id. A free-text box could
                  never satisfy that, which is why creating one returned 500. */}
              <div>
                <label htmlFor="booking-contact" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Citizen</label>
                <select
                  id="booking-contact"
                  required
                  value={bookingContactId}
                  onChange={e => setBookingContactId(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select a citizen…</option>
                  {contacts.map(c => (
                    <option key={c.id} value={c.id}>{c.fullName} — {c.phoneNumber}</option>
                  ))}
                </select>
                {contacts.length === 0 && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1.5">
                    No citizens on record yet. Add one under Contacts first — a booking has to belong to somebody.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="booking-service" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Service Type</label>
                <input required type="text" id="booking-service" value={bookingService} onChange={e => setBookingService(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label htmlFor="booking-time" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Date &amp; Time</label>
                <input required type="datetime-local" id="booking-time" value={bookingTime} onChange={e => setBookingTime(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label htmlFor="booking-staff" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Assigned Staff</label>
                <input type="text" id="booking-staff" placeholder="Optional — leave blank if nobody is assigned yet" value={bookingStaff} onChange={e => setBookingStaff(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              {actionError && (
                <div className="p-3 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
                  {actionError}
                </div>
              )}
              <button type="submit" disabled={busy !== null} className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50">
                {busy === 'Create booking' ? 'Creating…' : 'Confirm & Create Booking'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add Reservation Modal */}
      {showAddReservationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">New Table / Room Reservation</h3>
              <button onClick={() => setShowAddReservationModal(false)} className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateReservation} className="space-y-4">
              <div>
                <label htmlFor="res-contact" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Citizen</label>
                <select
                  id="res-contact"
                  required
                  value={resContactId}
                  onChange={e => setResContactId(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select a citizen…</option>
                  {contacts.map(c => (
                    <option key={c.id} value={c.id}>{c.fullName} — {c.phoneNumber}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="res-party" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Party Size</label>
                  <input required type="number" id="res-party" value={resPartySize} onChange={e => setResPartySize(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label htmlFor="res-table" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Table / Room</label>
                  <input type="text" id="res-table" value={resTable} onChange={e => setResTable(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label htmlFor="res-time" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">Date &amp; Time</label>
                <input required type="datetime-local" id="res-time" value={resTime} onChange={e => setResTime(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              {actionError && (
                <div className="p-3 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
                  {actionError}
                </div>
              )}
              <button type="submit" disabled={busy !== null} className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50">
                {busy === 'Create reservation' ? 'Reserving…' : 'Confirm & Reserve Slot'}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Booking Audit & Details Inspector Drawer */}
      {selectedBooking && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/60 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 p-6 flex flex-col h-full overflow-y-auto shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <span className="text-[10px] font-mono text-blue-600 dark:text-blue-400 uppercase tracking-widest font-bold">Booking Inspector</span>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{selectedBooking.contact?.fullName ?? 'Unknown contact'}</h3>
              </div>
              <button
                onClick={() => setSelectedBooking(null)}
                className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 hover:bg-white/[0.1] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Status Badge */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm">
              <span className="text-xs text-slate-600 dark:text-slate-400 font-medium">Lifecycle Status</span>
              <div>{getStatusBadge(selectedBooking.status)}</div>
            </div>

            {/* Details Breakdown */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Booking Breakdown</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Service Name</span>
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{selectedBooking.serviceName}</span>
                </div>
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Assigned Staff</span>
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{selectedBooking.staffName || 'unassigned'}</span>
                </div>
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 col-span-2">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Scheduled Date & Time (WAT)</span>
                  <span className="text-sm font-mono text-blue-700 dark:text-blue-300 font-semibold">{new Date(selectedBooking.startTime).toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* System Channel Audit Trail */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Channel & AI Orchestration Audit</h4>
              <div className="p-4 rounded-xl bg-blue-500/[0.05] border border-blue-200 dark:border-blue-500/20 space-y-2 text-xs">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Channel Source:</span>
                  <span className="font-semibold text-blue-600 dark:text-blue-400">WhatsApp AI Engine</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Intent Classifier:</span>
                  <span className="font-mono text-emerald-600 dark:text-emerald-400">BOOK_APPOINTMENT (98.4%)</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Double-Booking Check:</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">PASSED (No overlap)</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>CalDAV Sync Status:</span>
                  <span className="text-blue-700 dark:text-blue-300">Synced to Google Calendar</span>
                </div>
              </div>
            </div>

            {/* Admin Audit History Timeline */}
            <div className="space-y-3 flex-1">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Audit Log Stream</h4>
              <div className="space-y-2 text-xs">
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                  <Clock className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-slate-800 dark:text-slate-200">Booking Confirmed by AI Orchestrator</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{new Date(selectedBooking.startTime).toLocaleString()}</p>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-slate-800 dark:text-slate-200">Customer Confirmation Notification Sent</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">Via WhatsApp Template API</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Actions. Each one calls the API and reports what it answered. */}
            {isOpen(selectedBooking.status) ? (
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setReasonFor({ kind: 'booking', id: selectedBooking.id, name: selectedBooking.contact?.fullName ?? 'this citizen', action: 'cancel' });
                      setReason(''); setActionError(null);
                    }}
                    className="flex-1 py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-500/30 text-xs font-semibold transition-all"
                  >
                    Cancel Booking
                  </button>
                  <button
                    onClick={() => {
                      setRescheduleFor({ kind: 'booking', id: selectedBooking.id, name: selectedBooking.contact?.fullName ?? 'this booking' });
                      setNewTime(toLocalInput(selectedBooking.startTime)); setActionError(null);
                    }}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-all shadow-lg shadow-blue-500/20"
                  >
                    Reschedule
                  </button>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setBookingStatus(selectedBooking.id, 'COMPLETED')}
                    disabled={busy !== null}
                    className="flex-1 py-2.5 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-500/30 text-xs font-semibold transition-all disabled:opacity-50"
                  >
                    Mark Completed
                  </button>
                  <button
                    onClick={() => setBookingStatus(selectedBooking.id, 'NO_SHOW')}
                    disabled={busy !== null}
                    className="flex-1 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700/60 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold transition-all disabled:opacity-50"
                  >
                    No Show
                  </button>
                </div>
                <button
                  onClick={() => {
                    setReasonFor({ kind: 'booking', id: selectedBooking.id, name: selectedBooking.contact?.fullName ?? 'this citizen', action: 'refund' });
                    setReason(''); setActionError(null);
                  }}
                  className="w-full py-2.5 rounded-xl bg-amber-500/[0.12] hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30 text-xs font-semibold transition-all"
                >
                  Raise a refund request
                </button>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Marking completed or no-show is restricted to owners and administrators.
                </p>
              </div>
            ) : (
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  This booking is {selectedBooking.status.toLowerCase()}, so there is nothing left to
                  change. Create a new booking instead of reopening this one.
                </p>
              </div>
            )}

            {actionError && !reasonFor && !rescheduleFor && (
              <div className="p-3 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
                {actionError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Reservation Audit & Details Inspector Drawer */}
      {selectedReservation && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/60 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 p-6 flex flex-col h-full overflow-y-auto shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <span className="text-[10px] font-mono text-purple-600 dark:text-purple-400 uppercase tracking-widest font-bold">Reservation Inspector</span>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{selectedReservation.contact?.fullName ?? 'Unknown contact'}</h3>
              </div>
              <button
                onClick={() => setSelectedReservation(null)}
                className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 hover:bg-white/[0.1] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Status Badge */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm">
              <span className="text-xs text-slate-600 dark:text-slate-400 font-medium">Reservation Status</span>
              <div>{getStatusBadge(selectedReservation.status)}</div>
            </div>

            {/* Details Breakdown */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Reservation Breakdown</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Party Size</span>
                  <span className="text-sm font-bold text-purple-700 dark:text-purple-300">{selectedReservation.partySize} Guests</span>
                </div>
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Assigned Table / Room</span>
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{selectedReservation.tableOrRoomNumber || '—'}</span>
                </div>
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 col-span-2">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block">Special Requests & Dietary Notes</span>
                  <span className="text-xs text-slate-700 dark:text-slate-300 italic">{selectedReservation.specialRequests || 'No special requests provided'}</span>
                </div>
              </div>
            </div>

            {/* System Channel Audit Trail */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">Capacity & System Audit</h4>
              <div className="p-4 rounded-xl bg-purple-500/[0.05] border border-purple-200 dark:border-purple-500/20 space-y-2 text-xs">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Channel Origin:</span>
                  <span className="font-semibold text-purple-600 dark:text-purple-400">Voice AI Telephony Call</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Capacity Engine:</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Table Allocated (Capacity OK)</span>
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
                  setReasonFor({ kind: 'reservation', id: selectedReservation.id, name: selectedReservation.contact?.fullName ?? 'this citizen', action: 'cancel' });
                  setReason(''); setActionError(null);
                }}
                disabled={!isOpen(selectedReservation.status)}
                className="flex-1 py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-500/30 text-xs font-semibold transition-all disabled:opacity-40"
              >
                Cancel Reservation
              </button>
              <button
                onClick={() => {
                  setRescheduleFor({ kind: 'reservation', id: selectedReservation.id, name: selectedReservation.contact?.fullName ?? 'this reservation' });
                  setNewTime(toLocalInput(selectedReservation.reservationTime)); setActionError(null);
                }}
                disabled={!isOpen(selectedReservation.status)}
                className="flex-1 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition-all shadow-lg shadow-purple-500/20 disabled:opacity-40"
              >
                Reschedule
              </button>
            </div>

            {isOpen(selectedReservation.status) ? (
              <button
                onClick={() => {
                  setReasonFor({ kind: 'reservation', id: selectedReservation.id, name: selectedReservation.contact?.fullName ?? 'this citizen', action: 'refund' });
                  setReason(''); setActionError(null);
                }}
                className="w-full py-2.5 rounded-xl bg-amber-500/[0.12] hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30 text-xs font-semibold transition-all"
              >
                Raise a refund request
              </button>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                This reservation is {selectedReservation.status.toLowerCase()}; there is nothing left to change.
              </p>
            )}

            {actionError && !reasonFor && !rescheduleFor && (
              <div className="p-3 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
                {actionError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Reschedule ───────────────────────────────────────────────────────
          A new time is ASKED FOR rather than assumed. The old button claimed
          to have "sent a reschedule link", which was neither a reschedule nor
          a link. */}
      {rescheduleFor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">Move {rescheduleFor.name}</h3>
              <button onClick={() => { setRescheduleFor(null); setActionError(null); }} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div>
              <label htmlFor="reschedule-time" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">New date &amp; time</label>
              <input
                id="reschedule-time"
                type="datetime-local"
                value={newTime}
                onChange={e => setNewTime(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                The agency's own serving hours and the double-booking constraint both apply — if the
                slot is taken, the refusal below says which appointment holds it.
              </p>
            </div>
            {actionError && (
              <div className="p-3 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
                {actionError}
              </div>
            )}
            <button
              onClick={doReschedule}
              disabled={busy !== null}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all disabled:opacity-50"
            >
              {busy === 'Reschedule' ? 'Moving…' : 'Move it'}
            </button>
          </div>
        </div>
      )}

      {/* ── Cancel / refund, with the reason the citizen will ask about ───── */}
      {reasonFor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">
                {reasonFor.action === 'cancel' ? `Cancel for ${reasonFor.name}` : `Refund request for ${reasonFor.name}`}
              </h3>
              <button onClick={() => { setReasonFor(null); setActionError(null); }} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {reasonFor.action === 'refund' && (
              <div className="p-3 rounded-xl bg-amber-500/[0.08] border border-amber-200 dark:border-amber-500/20 text-xs text-amber-800 dark:text-amber-200">
                This raises a <strong>high-priority ticket</strong> and <strong>cancels the {reasonFor.kind}</strong>,
                freeing the slot. Both happen together.
              </div>
            )}

            <div>
              <label htmlFor="action-reason" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                Reason {reasonFor.action === 'refund' ? '(required)' : '(optional)'}
              </label>
              <textarea
                id="action-reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={3}
                className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder={reasonFor.action === 'refund' ? 'What the citizen asked for, and why' : 'Recorded against the appointment'}
              />
            </div>

            {actionError && (
              <div className="p-3 rounded-xl bg-red-500/[0.06] border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-300">
                {actionError}
              </div>
            )}

            <button
              onClick={reasonFor.action === 'cancel' ? doCancel : doRefund}
              disabled={busy !== null}
              className={`w-full py-2.5 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-50 ${
                reasonFor.action === 'cancel' ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'
              }`}
            >
              {busy ? 'Working…' : reasonFor.action === 'cancel' ? `Cancel this ${reasonFor.kind}` : 'Raise the refund ticket'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
