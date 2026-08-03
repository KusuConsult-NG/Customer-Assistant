import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { BookingStatus } from '@ace/shared-types';

@Injectable()
export class SchedulingService {
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
      notes?: string;
    }
  ) {
    const start = new Date(data.startTime);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    return prisma.booking.create({
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

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CANCELLED,
        notes: reason ? `Cancelled by customer: ${reason}` : (booking.notes ?? 'Cancelled by customer'),
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

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.RESCHEDULED,
        startTime: start,
        endTime: end,
        updatedAt: new Date(),
      },
      include: { contact: true },
    });
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
          notes: `Refund requested (${ticketNumber}): ${reason}`,
          updatedAt: new Date(),
        },
      });
    }

    return { ticketId: ticket.id, ticketNumber, bookingId, status: 'REFUND_REQUESTED' };
  }

  // ─── Bookings: Legacy status update ──────────────────────────────────────────

  async updateBookingStatus(bookingId: string, status: BookingStatus) {
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
    return prisma.reservation.create({
      data: {
        organizationId,
        contactId: data.contactId,
        partySize: data.partySize,
        reservationTime: new Date(data.reservationTime),
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

    return prisma.reservation.update({
      where: { id: reservationId },
      data: {
        status: BookingStatus.CANCELLED,
        specialRequests: reason
          ? `Cancelled by customer: ${reason}`
          : (reservation.specialRequests ?? 'Cancelled by customer'),
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
          specialRequests: `Refund requested (${ticketNumber}): ${reason}`,
          updatedAt: new Date(),
        },
      });
    }

    return { ticketId: ticket.id, ticketNumber, reservationId, status: 'REFUND_REQUESTED' };
  }
}
