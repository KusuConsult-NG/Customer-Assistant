/**
 * Suite 04 — Scheduling: bookings, reservations, double-booking, reschedule,
 * cancellation, refunds and note preservation.
 */
const H = require('../harness');
const { api, prisma, check, suite, state, uniq, seedSession } = H;

const soon = (hoursAhead) => new Date(Date.now() + hoursAhead * 3600e3);

/** Next weekday 10:00 West Africa Time (UTC+1) at least `minDays` out. */
function nextBusinessSlot(minDays = 1, hourWat = 10) {
  const d = new Date(Date.now() + minDays * 864e5);
  d.setUTCHours(hourWat - 1, 0, 0, 0); // WAT = UTC+1
  while ([0, 6].includes(new Date(d.getTime() + 3600e3).getUTCDay())) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

module.exports = async function () {
  suite('04 · Scheduling & Reservations');

  const T = await seedSession('sched');
  const token = T.token;
  const orgId = T.orgId;

  const contact = await prisma.contact.create({
    data: { organizationId: orgId, fullName: 'Booking Customer', phoneNumber: `+234801${Date.now().toString().slice(-7)}`, email: `book.${uniq('b')}@e2e.test` },
  });

  let bookingId;

  await check('SCH-001', 'Create booking persists with correct times and CONFIRMED status', async () => {
    const start = nextBusinessSlot(2);
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: contact.id, serviceName: 'Dental Cleaning', staffName: 'Dr Ade', startTime: start.toISOString() },
    });
    if (res.status !== 201 && res.status !== 200) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 180)}` };
    bookingId = res.body.id;
    const row = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (row.status !== 'CONFIRMED') return { expected: 'CONFIRMED', actual: row.status };
    if (Math.abs(row.startTime.getTime() - start.getTime()) > 1000) return { expected: start.toISOString(), actual: row.startTime.toISOString() };
    if (row.endTime <= row.startTime) return { expected: 'end after start', actual: `${row.endTime.toISOString()} <= ${row.startTime.toISOString()}` };
    return { ok: true, evidence: `${row.startTime.toISOString()} → ${row.endTime.toISOString()}` };
  }, 'CRITICAL');

  await check('SCH-002', 'Exact double-booking of the same staff and slot is refused', async () => {
    const row = await prisma.booking.findUnique({ where: { id: bookingId } });
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: contact.id, serviceName: 'Clashing Service', staffName: 'Dr Ade', startTime: row.startTime.toISOString() },
    });
    const count = await prisma.booking.count({ where: { organizationId: orgId, staffName: 'Dr Ade', startTime: row.startTime, status: { in: ['CONFIRMED', 'RESCHEDULED'] } } });
    if (count > 1) return { expected: '1 booking in the slot', actual: `${count} bookings — DOUBLE BOOKED (http ${res.status})` };
    return res.status === 409 ? { ok: true, evidence: '409 Conflict' } : { expected: '409', actual: `${res.status} (no duplicate written)` };
  }, 'CRITICAL');

  await check('SCH-003', 'Partially overlapping booking for the same staff is refused', async () => {
    const row = await prisma.booking.findUnique({ where: { id: bookingId } });
    const overlap = new Date(row.startTime.getTime() + 10 * 60000); // 10 min into a 30 min slot
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: contact.id, serviceName: 'Overlapping', staffName: 'Dr Ade', startTime: overlap.toISOString() },
    });
    const clashes = await prisma.booking.count({
      where: { organizationId: orgId, staffName: 'Dr Ade', status: { in: ['CONFIRMED', 'RESCHEDULED'] }, startTime: { lt: row.endTime }, endTime: { gt: row.startTime } },
    });
    if (clashes > 1) return { expected: 'no overlap', actual: `${clashes} overlapping bookings (http ${res.status})` };
    return res.status === 409 ? { ok: true } : { expected: '409', actual: `${res.status} (no overlap written)` };
  }, 'CRITICAL');

  await check('SCH-004', 'Back-to-back bookings ARE allowed (half-open intervals)', async () => {
    const row = await prisma.booking.findUnique({ where: { id: bookingId } });
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: contact.id, serviceName: 'Immediately After', staffName: 'Dr Ade', startTime: row.endTime.toISOString() },
    });
    return (res.status === 200 || res.status === 201)
      ? { ok: true, evidence: 'adjacent slot accepted' }
      : { expected: '201', actual: `${res.status} — adjacent bookings wrongly treated as a clash` };
  }, 'HIGH');

  await check('SCH-005', 'A different staff member CAN take the same slot', async () => {
    const row = await prisma.booking.findUnique({ where: { id: bookingId } });
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: contact.id, serviceName: 'Parallel Staff', staffName: 'Dr Bola', startTime: row.startTime.toISOString() },
    });
    return (res.status === 200 || res.status === 201)
      ? { ok: true, evidence: 'per-staff conflict scoping works' }
      : { expected: '201', actual: `${res.status} — one staff member's booking blocks the whole business` };
  }, 'HIGH');

  await check('SCH-006', 'Concurrent identical booking requests produce at most one booking', async () => {
    const start = nextBusinessSlot(5, 14);
    const body = { contactId: contact.id, serviceName: 'Race Service', staffName: 'Dr Race', startTime: start.toISOString() };
    // Regression guard for a race that was empirically demonstrated: 8 simultaneous
    // identical requests all passed the application-level conflict check before any
    // committed, producing 8 CONFIRMED bookings in one slot. A PostgreSQL exclusion
    // constraint (bookings_no_staff_overlap) now enforces this at commit time.
    const results = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/api/scheduling/bookings', { token, body, noRetry: true })));
    const created = await prisma.booking.count({ where: { organizationId: orgId, staffName: 'Dr Race', status: { in: ['CONFIRMED', 'RESCHEDULED'] } } });
    const accepted = results.filter(r => r.status < 300).length;
    const conflicts = results.filter(r => r.status === 409).length;
    const fivexx = results.filter(r => r.status >= 500 && r.status !== 503).length;

    if (created > 1) {
      return { expected: 'exactly 1 booking', actual: `${created} bookings from 8 simultaneous requests (${accepted} accepted) — DOUBLE BOOKING under concurrency` };
    }
    if (fivexx) return { expected: 'losers get 409, not 5xx', actual: `${fivexx}/8 returned 5xx — constraint violation leaked as a server error` };
    return { ok: true, evidence: `${created} booking from 8 concurrent requests; ${accepted} accepted, ${conflicts} rejected with 409` };
  }, 'HIGH');

  await check('SCH-010', 'Booking in the past is refused', async () => {
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: contact.id, serviceName: 'Time Travel', startTime: soon(-48).toISOString() },
    });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: `${res.status} — past-dated booking accepted` };
  }, 'HIGH');

  await check('SCH-011', 'Invalid date string is refused with 400, not 500', async () => {
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: contact.id, serviceName: 'Bad Date', startTime: 'not-a-date' },
    });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'HIGH');

  await check('SCH-012', 'Booking against an unknown contact is refused', async () => {
    const res = await api('POST', '/api/scheduling/bookings', {
      token, body: { contactId: '00000000-0000-0000-0000-000000000000', serviceName: 'Ghost', startTime: nextBusinessSlot(9).toISOString() },
    });
    return res.status === 404 ? { ok: true } : { expected: '404', actual: String(res.status) };
  }, 'HIGH');

  // ── Cancellation ──────────────────────────────────────────────────────────
  await check('SCH-020', 'Cancel sets CANCELLED and preserves existing notes', async () => {
    const b = await prisma.booking.create({
      data: { organizationId: orgId, contactId: contact.id, serviceName: 'Cancel Me', startTime: nextBusinessSlot(11), endTime: new Date(nextBusinessSlot(11).getTime() + 18e5), notes: 'IMPORTANT: customer is allergic to latex [REMINDED_72H]' },
    });
    const res = await api('PATCH', `/api/scheduling/bookings/${b.id}/cancel`, { token, body: { reason: 'Customer rescheduled by phone' } });
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const row = await prisma.booking.findUnique({ where: { id: b.id } });
    if (row.status !== 'CANCELLED') return { expected: 'CANCELLED', actual: row.status };
    if (!row.notes.includes('allergic to latex')) return { expected: 'original clinical note kept', actual: `NOTE DESTROYED: "${row.notes}"` };
    if (!row.notes.includes('[REMINDED_72H]')) return { expected: 'reminder marker kept', actual: 'reminder idempotency marker lost — customer may be re-notified' };
    if (!row.notes.includes('Customer rescheduled by phone')) return { expected: 'reason appended', actual: row.notes };
    return { ok: true, evidence: row.notes.replace(/\n/g, ' | ').slice(0, 110) };
  }, 'HIGH');

  await check('SCH-021', 'Cancelling an already-cancelled booking is refused', async () => {
    const b = await prisma.booking.findFirst({ where: { organizationId: orgId, status: 'CANCELLED' } });
    const res = await api('PATCH', `/api/scheduling/bookings/${b.id}/cancel`, { token, body: { reason: 'again' } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'MEDIUM');

  await check('SCH-022', 'Cancelling frees the slot for a new booking', async () => {
    const start = nextBusinessSlot(12, 11);
    const first = await api('POST', '/api/scheduling/bookings', { token, body: { contactId: contact.id, serviceName: 'Will Cancel', staffName: 'Dr Free', startTime: start.toISOString() } });
    if (first.status >= 300) return { expected: '201', actual: String(first.status) };
    await api('PATCH', `/api/scheduling/bookings/${first.body.id}/cancel`, { token, body: { reason: 'freeing slot' } });
    const second = await api('POST', '/api/scheduling/bookings', { token, body: { contactId: contact.id, serviceName: 'Takes The Slot', staffName: 'Dr Free', startTime: start.toISOString() } });
    return (second.status === 200 || second.status === 201)
      ? { ok: true, evidence: 'cancelled bookings no longer block the slot' }
      : { expected: '201', actual: `${second.status} — cancelled booking still holds the slot` };
  }, 'HIGH');

  // ── Reschedule ────────────────────────────────────────────────────────────
  await check('SCH-030', 'Reschedule moves the booking and sets RESCHEDULED', async () => {
    const b = await prisma.booking.create({
      data: { organizationId: orgId, contactId: contact.id, serviceName: 'Move Me', startTime: nextBusinessSlot(13), endTime: new Date(nextBusinessSlot(13).getTime() + 18e5) },
    });
    const newStart = nextBusinessSlot(14, 15);
    const res = await api('PATCH', `/api/scheduling/bookings/${b.id}/reschedule`, { token, body: { newStartTime: newStart.toISOString() } });
    if (res.status !== 200) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const row = await prisma.booking.findUnique({ where: { id: b.id } });
    if (row.status !== 'RESCHEDULED') return { expected: 'RESCHEDULED', actual: row.status };
    if (Math.abs(row.startTime.getTime() - newStart.getTime()) > 1000) return { expected: newStart.toISOString(), actual: row.startTime.toISOString() };
    return { ok: true, evidence: `moved to ${row.startTime.toISOString()}` };
  }, 'HIGH');

  await check('SCH-031', 'Reschedule into an occupied slot is refused', async () => {
    const slot = nextBusinessSlot(15, 9);
    const holder = await prisma.booking.create({
      data: { organizationId: orgId, contactId: contact.id, serviceName: 'Holder', staffName: 'Dr Busy', startTime: slot, endTime: new Date(slot.getTime() + 18e5) },
    });
    const mover = await prisma.booking.create({
      data: { organizationId: orgId, contactId: contact.id, serviceName: 'Mover', staffName: 'Dr Busy', startTime: nextBusinessSlot(16), endTime: new Date(nextBusinessSlot(16).getTime() + 18e5) },
    });
    const res = await api('PATCH', `/api/scheduling/bookings/${mover.id}/reschedule`, { token, body: { newStartTime: slot.toISOString() } });
    const row = await prisma.booking.findUnique({ where: { id: mover.id } });
    if (row.startTime.getTime() === slot.getTime()) return { expected: 'refused', actual: `RESCHEDULED ONTO OCCUPIED SLOT (http ${res.status})` };
    return res.status === 409 ? { ok: true, evidence: '409' } : { expected: '409', actual: `${res.status} (not moved)` };
  }, 'CRITICAL');

  await check('SCH-032', 'Reschedule into the past is refused', async () => {
    const b = await prisma.booking.findFirst({ where: { organizationId: orgId, status: 'CONFIRMED' } });
    const res = await api('PATCH', `/api/scheduling/bookings/${b.id}/reschedule`, { token, body: { newStartTime: soon(-5).toISOString() } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'HIGH');

  await check('SCH-033', 'Rescheduling a cancelled booking is refused', async () => {
    const b = await prisma.booking.findFirst({ where: { organizationId: orgId, status: 'CANCELLED' } });
    const res = await api('PATCH', `/api/scheduling/bookings/${b.id}/reschedule`, { token, body: { newStartTime: nextBusinessSlot(17).toISOString() } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'MEDIUM');

  // ── Refunds ───────────────────────────────────────────────────────────────
  await check('SCH-040', 'Refund request opens a HIGH ticket and cancels the booking', async () => {
    const b = await prisma.booking.create({
      data: { organizationId: orgId, contactId: contact.id, serviceName: 'Refundable', startTime: nextBusinessSlot(18), endTime: new Date(nextBusinessSlot(18).getTime() + 18e5) },
    });
    const res = await api('POST', `/api/scheduling/bookings/${b.id}/refund-request`, { token, body: { reason: 'Service was not delivered' } });
    if (res.status !== 201 && res.status !== 200) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const ticket = await prisma.ticket.findUnique({ where: { id: res.body.ticketId } });
    if (!ticket) return { expected: 'ticket row', actual: 'none' };
    if (ticket.priority !== 'HIGH') return { expected: 'HIGH', actual: ticket.priority };
    if (!ticket.ticketNumber.startsWith('REF-BK-')) return { expected: 'REF-BK- prefix', actual: ticket.ticketNumber };
    if (!ticket.description.includes('Service was not delivered')) return { expected: 'reason recorded', actual: 'reason missing from ticket' };
    const row = await prisma.booking.findUnique({ where: { id: b.id } });
    if (row.status !== 'CANCELLED') return { expected: 'booking cancelled', actual: row.status };
    return { ok: true, evidence: `${ticket.ticketNumber}, booking ${row.status}` };
  }, 'HIGH');

  await check('SCH-041', 'Refund queue lists REF-* tickets only', async () => {
    const res = await api('GET', '/api/scheduling/refund-requests', { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const bad = (res.body || []).filter(t => !/^REF-(BK|RS)-/.test(t.ticketNumber));
    if (bad.length) return { expected: 'only REF-* tickets', actual: `${bad.length} unrelated tickets leaked into the refund queue` };
    return { ok: true, evidence: `${res.body.length} refund requests` };
  }, 'HIGH');

  // ── Reservations ──────────────────────────────────────────────────────────
  await check('SCH-050', 'Create reservation persists party size and time', async () => {
    const when = nextBusinessSlot(19, 19);
    const res = await api('POST', '/api/scheduling/reservations', {
      token, body: { contactId: contact.id, partySize: 6, reservationTime: when.toISOString(), tableOrRoomNumber: 'T-12', specialRequests: 'Window seat' },
    });
    if (res.status !== 201 && res.status !== 200) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const row = await prisma.reservation.findUnique({ where: { id: res.body.id } });
    if (row.partySize !== 6) return { expected: '6', actual: String(row.partySize) };
    if (row.status !== 'CONFIRMED') return { expected: 'CONFIRMED', actual: row.status };
    return { ok: true, evidence: `party=${row.partySize} table=${row.tableOrRoomNumber}` };
  }, 'HIGH');

  await check('SCH-051', 'Absurd party size is refused', async () => {
    const res = await api('POST', '/api/scheduling/reservations', {
      token, body: { contactId: contact.id, partySize: 100000, reservationTime: nextBusinessSlot(20).toISOString() },
    });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: `${res.status} — reservation for 100,000 guests accepted` };
  }, 'MEDIUM');

  await check('SCH-052', 'Zero / negative party size is refused', async () => {
    for (const partySize of [0, -3]) {
      const res = await api('POST', '/api/scheduling/reservations', { token, body: { contactId: contact.id, partySize, reservationTime: nextBusinessSlot(21).toISOString() } });
      if (res.status !== 400) return { expected: '400', actual: `partySize=${partySize} => ${res.status}` };
    }
    return { ok: true };
  }, 'MEDIUM');

  await check('SCH-053', 'Reservation cancel preserves the original special requests', async () => {
    const r = await prisma.reservation.create({
      data: { organizationId: orgId, contactId: contact.id, partySize: 4, reservationTime: nextBusinessSlot(22), specialRequests: 'Peanut allergy — critical', updatedAt: new Date() },
    });
    const res = await api('PATCH', `/api/scheduling/reservations/${r.id}/cancel`, { token, body: { reason: 'Party cancelled' } });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const row = await prisma.reservation.findUnique({ where: { id: r.id } });
    if (!row.specialRequests.includes('Peanut allergy')) return { expected: 'allergy note kept', actual: `NOTE DESTROYED: "${row.specialRequests}"` };
    return { ok: true, evidence: row.specialRequests.replace(/\n/g, ' | ').slice(0, 100) };
  }, 'HIGH');

  await check('SCH-054', 'Reservation refund opens a REF-RS-* ticket', async () => {
    const r = await prisma.reservation.create({
      data: { organizationId: orgId, contactId: contact.id, partySize: 2, reservationTime: nextBusinessSlot(23), updatedAt: new Date() },
    });
    const res = await api('POST', `/api/scheduling/reservations/${r.id}/refund-request`, { token, body: { reason: 'Double charged' } });
    if (res.status >= 300) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const ticket = await prisma.ticket.findUnique({ where: { id: res.body.ticketId } });
    if (!ticket.ticketNumber.startsWith('REF-RS-')) return { expected: 'REF-RS-', actual: ticket.ticketNumber };
    return { ok: true, evidence: ticket.ticketNumber };
  }, 'HIGH');

  await check('SCH-060', 'Booking list is scoped to the organization and ordered by start time', async () => {
    const res = await api('GET', '/api/scheduling/bookings', { token });
    if (res.status !== 200) return { expected: '200', actual: String(res.status) };
    const foreign = res.body.filter(b => b.organizationId !== orgId);
    if (foreign.length) return { expected: 'own org only', actual: `${foreign.length} foreign bookings` };
    const times = res.body.map(b => new Date(b.startTime).getTime());
    const sorted = [...times].sort((a, b) => a - b);
    if (JSON.stringify(times) !== JSON.stringify(sorted)) return { expected: 'ascending by startTime', actual: 'unordered' };
    return { ok: true, evidence: `${res.body.length} bookings, ordered` };
  }, 'MEDIUM');
};
