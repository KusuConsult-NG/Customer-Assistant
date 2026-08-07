import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { BookingStatus } from '@ace/shared-types';
import { AppointmentReminderService } from './appointment-reminder.service';

/**
 * True when PostgreSQL rejected a write because of the booking exclusion constraint.
 * SQLSTATE 23P01 is `exclusion_violation`; Prisma surfaces it without a dedicated
 * error code, so the constraint name is matched as well.
 */
function isOverlapViolation(err: any): boolean {
  const code = err?.code ?? err?.meta?.code;
  const message = String(err?.message ?? '');
  return code === '23P01'
    || message.includes('bookings_no_staff_overlap')
    || message.includes('exclusion constraint');
}

@Injectable()
export class SchedulingService {
  constructor(private reminderService: AppointmentReminderService) {}

  // ─── Bookings: Read ──────────────────────────────────────────────────────────

  async getBookings(organizationId: string) {
    return prisma.booking.findMany({
      where: { organizationId },
      include: { contact: true },
      orderBy: { startTime: 'asc' },
    });
  }

  /** Find most recent active booking for a contact phone number (used by AI). */
  async getActiveBookingByPhone(organizationId: string, phoneNumber: string) {
    const contact = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber },
    });
    if (!contact) return null;

    return prisma.booking.findFirst({
      where: {
        organizationId,
        contactId: contact.id,
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { startTime: 'desc' },
    });
  }

  /** Find most recent active reservation for a contact phone number (used by AI). */
  async getActiveReservationByPhone(organizationId: string, phoneNumber: string) {
    const contact = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber },
    });
    if (!contact) return null;

    return prisma.reservation.findFirst({
      where: {
        organizationId,
        contactId: contact.id,
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { reservationTime: 'desc' },
    });
  }

  /** List all refund-request tickets for the org (REF-BK-* and REF-RS-* prefixes). */
  async getRefundRequests(organizationId: string) {
    return prisma.ticket.findMany({
      where: {
        organizationId,
        OR: [
          { ticketNumber: { startsWith: 'REF-BK-' } },
          { ticketNumber: { startsWith: 'REF-RS-' } },
        ],
      },
      include: { contact: true, assignedUser: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── Bookings: Create ─────────────────────────────────────────────────────────

  async createBooking(
    organizationId: string,
    data: {
      contactId: string;
      serviceName: string;
      staffName?: string;
      startTime: string;
      durationMinutes?: number;
      notes?: string;
    }
  ) {
    const start = new Date(data.startTime);
    if (isNaN(start.getTime())) {
      throw new BadRequestException('startTime must be a valid ISO 8601 date string');
    }
    if (start.getTime() < Date.now()) {
      throw new BadRequestException('Booking time cannot be in the past');
    }

    const end = new Date(start.getTime() + (data.durationMinutes ?? 30) * 60 * 1000);

    // The contact must belong to this organization — otherwise an authenticated user
    // could attach a booking to another tenant's customer record just by id.
    const contact = await prisma.contact.findFirst({
      where: { id: data.contactId, organizationId },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    // Check the slot is free before promising it.
    //
    // This check did not exist: any number of bookings could be written over the same
    // half hour with the same staff member, and every one of them received a
    // "confirmed" email. Two customers turning up for the same slot is a failure the
    // customer discovers in the waiting room.
    const conflict = await this.findConflictingBooking(organizationId, start, end, data.staffName);
    if (conflict) {
      throw new ConflictException(
        `That slot is already taken by ${conflict.serviceName} ` +
        `(${conflict.startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })})` +
        (data.staffName ? ` for ${data.staffName}` : '') +
        '. Please choose another time.'
      );
    }

    // The check above is a read-then-write race — under concurrency every in-flight
    // request passes it before any commits (measured: 8 simultaneous requests all
    // created a booking in the same slot). The database exclusion constraint
    // `bookings_no_staff_overlap` is what actually guarantees exclusivity; this
    // translates its violation into a 409 instead of a 500.
    let booking;
    try {
      booking = await prisma.booking.create({
        data: {
          organizationId,
          contactId: data.contactId,
          serviceName: data.serviceName,
          staffName: data.staffName,
          startTime: start,
          endTime: end,
          notes: data.notes,
          status: BookingStatus.CONFIRMED,
        },
        include: { contact: true },
      });
    } catch (err: any) {
      if (isOverlapViolation(err)) {
        throw new ConflictException(
          'That slot was just taken by another booking. Please choose another time.'
        );
      }
      throw err;
    }

    if (booking.contact?.email) {
      this.reminderService.sendBookingConfirmationAndReceiptEmail(booking.id).catch(() => {});
    }

    return booking;
  }

  /**
   * Returns an overlapping CONFIRMED/RESCHEDULED booking, if any.
   *
   * Overlap test is the standard half-open interval comparison
   * (existing.start < new.end AND existing.end > new.start), which correctly treats
   * back-to-back bookings as non-conflicting.
   */
  private async findConflictingBooking(
    organizationId: string,
    start: Date,
    end: Date,
    staffName?: string,
    excludeBookingId?: string
  ) {
    return prisma.booking.findFirst({
      where: {
        organizationId,
        ...(staffName ? { staffName } : {}),
        ...(excludeBookingId ? { NOT: { id: excludeBookingId } } : {}),
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.RESCHEDULED] },
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { id: true, serviceName: true, startTime: true },
    });
  }

  // ─── Bookings: Cancel ─────────────────────────────────────────────────────────

  async cancelBooking(organizationId: string, bookingId: string, reason?: string) {
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, organizationId },
      include: { contact: true },
    });
    if (!booking) throw new NotFoundException(`Booking ${bookingId} not found`);
    if (booking.status === 'CANCELLED') {
      throw new BadRequestException('This booking is already cancelled');
    }
    if (booking.status === 'COMPLETED') {
      throw new BadRequestException('Completed bookings cannot be cancelled — request a refund instead');
    }

    // Append rather than overwrite. Replacing `notes` wholesale destroyed whatever
    // the operator had written there AND the [REMINDED_72H]/[REMINDED_48H] markers
    // that AppointmentReminderService uses for idempotency.
    const cancellationNote = reason ? `Cancelled by customer: ${reason}` : 'Cancelled by customer';

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CANCELLED,
        notes: [booking.notes, cancellationNote].filter(Boolean).join('\n'),
        updatedAt: new Date(),
      },
      include: { contact: true },
    });
  }

  // ─── Bookings: Reschedule ─────────────────────────────────────────────────────

  async rescheduleBooking(
    organizationId: string,
    bookingId: string,
    newStartTime: string,
    durationMinutes = 30
  ) {
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, organizationId },
      include: { contact: true },
    });
    if (!booking) throw new NotFoundException(`Booking ${bookingId} not found`);
    if (booking.status === 'CANCELLED') {
      throw new BadRequestException('Cannot reschedule a cancelled booking — please create a new one');
    }
    if (booking.status === 'COMPLETED') {
      throw new BadRequestException('Cannot reschedule a completed booking');
    }

    const start = new Date(newStartTime);
    if (isNaN(start.getTime())) {
      throw new BadRequestException('Invalid newStartTime — must be a valid ISO 8601 date string');
    }
    if (start < new Date()) {
      throw new BadRequestException('New booking time cannot be in the past');
    }

    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const conflict = await this.findConflictingBooking(
      organizationId, start, end, booking.staffName ?? undefined, bookingId
    );
    if (conflict) {
      throw new ConflictException(
        `That slot is already taken by ${conflict.serviceName} ` +
        `(${conflict.startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}). ` +
        'Please choose another time.'
      );
    }

    try {
      return await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.RESCHEDULED,
          startTime: start,
          endTime: end,
          updatedAt: new Date(),
        },
        include: { contact: true },
      });
    } catch (err: any) {
      if (isOverlapViolation(err)) {
        throw new ConflictException(
          'That slot was just taken by another booking. Please choose another time.'
        );
      }
      throw err;
    }
  }

  // ─── Bookings: Refund Request ─────────────────────────────────────────────────

  async requestBookingRefund(organizationId: string, bookingId: string, reason: string) {
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, organizationId },
      include: { contact: true },
    });
    if (!booking) throw new NotFoundException(`Booking ${bookingId} not found`);

    const ticketNumber = `REF-BK-${Date.now().toString().slice(-6)}`;
    const ticket = await prisma.ticket.create({
      data: {
        organizationId,
        contactId: booking.contactId,
        ticketNumber,
        subject: `Refund Request — Booking #${bookingId.slice(-8).toUpperCase()} (${booking.serviceName})`,
        description:
          `Customer requested a refund for booking of "${booking.serviceName}" ` +
          `scheduled on ${booking.startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}.\n\n` +
          `Booking ID: ${bookingId}\n` +
          `Contact: ${booking.contact.fullName} (${booking.contact.phoneNumber})\n\n` +
          `Reason: ${reason}`,
        status: 'OPEN',
        priority: 'HIGH',
        updatedAt: new Date(),
      },
    });

    // Automatically cancel the booking so slot is freed
    if (!['CANCELLED', 'COMPLETED'].includes(booking.status)) {
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.CANCELLED,
          notes: [booking.notes, `Refund requested (${ticketNumber}): ${reason}`].filter(Boolean).join('\n'),
          updatedAt: new Date(),
        },
      });
    }

    return { ticketId: ticket.id, ticketNumber, bookingId, status: 'REFUND_REQUESTED' };
  }

  // ─── Bookings: Legacy status update ──────────────────────────────────────────

  async updateBookingStatus(bookingId: string, status: BookingStatus, organizationId: string) {
    const booking = await prisma.booking.findFirst({ where: { id: bookingId, organizationId } });
    if (!booking) throw new NotFoundException('Booking not found');
    return prisma.booking.update({
      where: { id: bookingId },
      data: { status, updatedAt: new Date() },
    });
  }

  // ─── Reservations: Read ───────────────────────────────────────────────────────

  async getReservations(organizationId: string) {
    return prisma.reservation.findMany({
      where: { organizationId },
      include: { contact: true },
      orderBy: { reservationTime: 'asc' },
    });
  }

  // ─── Reservations: Create ─────────────────────────────────────────────────────

  async createReservation(
    organizationId: string,
    data: {
      contactId: string;
      partySize: number;
      reservationTime: string;
      tableOrRoomNumber?: string;
      specialRequests?: string;
    }
  ) {
    const contact = await prisma.contact.findFirst({
      where: { id: data.contactId, organizationId },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const reservationTime = new Date(data.reservationTime);
    if (isNaN(reservationTime.getTime())) {
      throw new BadRequestException('reservationTime must be a valid ISO 8601 date string');
    }
    if (!Number.isInteger(data.partySize) || data.partySize < 1 || data.partySize > 100) {
      throw new BadRequestException('partySize must be a whole number between 1 and 100');
    }

    return prisma.reservation.create({
      data: {
        organizationId,
        contactId: data.contactId,
        partySize: data.partySize,
        reservationTime,
        tableOrRoomNumber: data.tableOrRoomNumber,
        specialRequests: data.specialRequests,
        status: BookingStatus.CONFIRMED,
        updatedAt: new Date(),
      },
      include: { contact: true },
    });
  }

  // ─── Reservations: Cancel ─────────────────────────────────────────────────────

  async cancelReservation(organizationId: string, reservationId: string, reason?: string) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, organizationId },
      include: { contact: true },
    });
    if (!reservation) throw new NotFoundException(`Reservation ${reservationId} not found`);
    if (reservation.status === 'CANCELLED') {
      throw new BadRequestException('This reservation is already cancelled');
    }
    if (reservation.status === 'COMPLETED') {
      throw new BadRequestException('Completed reservations cannot be cancelled — request a refund instead');
    }

    const cancellationNote = reason ? `Cancelled by customer: ${reason}` : 'Cancelled by customer';

    return prisma.reservation.update({
      where: { id: reservationId },
      data: {
        status: BookingStatus.CANCELLED,
        specialRequests: [reservation.specialRequests, cancellationNote].filter(Boolean).join('\n'),
        updatedAt: new Date(),
      },
      include: { contact: true },
    });
  }

  // ─── Reservations: Reschedule ─────────────────────────────────────────────────

  async rescheduleReservation(organizationId: string, reservationId: string, newReservationTime: string) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, organizationId },
      include: { contact: true },
    });
    if (!reservation) throw new NotFoundException(`Reservation ${reservationId} not found`);
    if (reservation.status === 'CANCELLED') {
      throw new BadRequestException('Cannot reschedule a cancelled reservation');
    }
    if (reservation.status === 'COMPLETED') {
      throw new BadRequestException('Cannot reschedule a completed reservation');
    }

    const newTime = new Date(newReservationTime);
    if (isNaN(newTime.getTime())) {
      throw new BadRequestException('Invalid newReservationTime — must be a valid ISO 8601 date string');
    }
    if (newTime < new Date()) {
      throw new BadRequestException('New reservation time cannot be in the past');
    }

    return prisma.reservation.update({
      where: { id: reservationId },
      data: {
        status: BookingStatus.RESCHEDULED,
        reservationTime: newTime,
        updatedAt: new Date(),
      },
      include: { contact: true },
    });
  }

  // ─── Reservations: Refund Request ─────────────────────────────────────────────

  async requestReservationRefund(organizationId: string, reservationId: string, reason: string) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, organizationId },
      include: { contact: true },
    });
    if (!reservation) throw new NotFoundException(`Reservation ${reservationId} not found`);

    const ticketNumber = `REF-RS-${Date.now().toString().slice(-6)}`;
    const ticket = await prisma.ticket.create({
      data: {
        organizationId,
        contactId: reservation.contactId,
        ticketNumber,
        subject: `Refund Request — Reservation #${reservationId.slice(-8).toUpperCase()} (Party of ${reservation.partySize})`,
        description:
          `Customer requested a refund for a reservation for *${reservation.partySize} guest(s)* ` +
          `at ${reservation.reservationTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}.\n\n` +
          `Reservation ID: ${reservationId}\n` +
          `Table/Room: ${reservation.tableOrRoomNumber ?? 'Unassigned'}\n` +
          `Contact: ${reservation.contact.fullName} (${reservation.contact.phoneNumber})\n\n` +
          `Reason: ${reason}`,
        status: 'OPEN',
        priority: 'HIGH',
        updatedAt: new Date(),
      },
    });

    // Automatically cancel the reservation
    if (!['CANCELLED', 'COMPLETED'].includes(reservation.status)) {
      await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: BookingStatus.CANCELLED,
          specialRequests: [reservation.specialRequests, `Refund requested (${ticketNumber}): ${reason}`].filter(Boolean).join('\n'),
          updatedAt: new Date(),
        },
      });
    }

    return { ticketId: ticket.id, ticketNumber, reservationId, status: 'REFUND_REQUESTED' };
  }
}
