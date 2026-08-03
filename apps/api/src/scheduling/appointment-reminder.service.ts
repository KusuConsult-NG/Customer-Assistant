import { Injectable, OnModuleInit } from '@nestjs/common';
import { prisma } from '@ace/database';
import { Resend } from 'resend';
import { AceLogger } from '../config/logger';

const log = new AceLogger('AppointmentReminderService');

/**
 * AppointmentReminderService
 *
 * Runs two polling loops:
 *   - Every 5 minutes: send 24-hour-before reminders
 *   - Every 5 minutes: send 1-hour-before reminders
 *
 * Uses a simple "already reminded" approach by storing a reminder flag in booking notes.
 * In production this should use a dedicated ReminderLog table.
 */
@Injectable()
export class AppointmentReminderService implements OnModuleInit {
  private resend: Resend;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
  }

  onModuleInit() {
    // Run immediately then every 5 minutes
    this.checkAndSendReminders().catch((err) =>
      log.error('Initial reminder check failed', err),
    );
    setInterval(
      () =>
        this.checkAndSendReminders().catch((err) =>
          log.error('Reminder check failed', err),
        ),
      5 * 60 * 1000, // every 5 minutes
    );
  }

  async checkAndSendReminders() {
    const now = new Date();

    // ── 24-hour reminders ──────────────────────────────────────────────────────
    const in24hStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const in24hEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const bookings24h = await prisma.booking.findMany({
      where: {
        startTime: { gte: in24hStart, lte: in24hEnd },
        status: 'CONFIRMED',
        NOT: { notes: { contains: '[REMINDED_24H]' } },
      },
      include: {
        contact: true,
        organization: true,
      },
    });

    for (const booking of bookings24h) {
      await this.sendBookingReminder(booking, '24 hours');
      // Mark as reminded
      await prisma.booking.update({
        where: { id: booking.id },
        data: { notes: `${booking.notes ?? ''} [REMINDED_24H]` },
      });
    }

    const reservations24h = await prisma.reservation.findMany({
      where: {
        reservationTime: { gte: in24hStart, lte: in24hEnd },
        status: 'CONFIRMED',
        NOT: { specialRequests: { contains: '[REMINDED_24H]' } },
      },
      include: {
        contact: true,
        organization: true,
      },
    });

    for (const reservation of reservations24h) {
      await this.sendReservationReminder(reservation, '24 hours');
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { specialRequests: `${reservation.specialRequests ?? ''} [REMINDED_24H]` },
      });
    }

    // ── 1-hour reminders ───────────────────────────────────────────────────────
    const in1hStart = new Date(now.getTime() + 50 * 60 * 1000);
    const in1hEnd = new Date(now.getTime() + 70 * 60 * 1000);

    const bookings1h = await prisma.booking.findMany({
      where: {
        startTime: { gte: in1hStart, lte: in1hEnd },
        status: 'CONFIRMED',
        NOT: { notes: { contains: '[REMINDED_1H]' } },
      },
      include: {
        contact: true,
        organization: true,
      },
    });

    for (const booking of bookings1h) {
      await this.sendBookingReminder(booking, '1 hour');
      await prisma.booking.update({
        where: { id: booking.id },
        data: { notes: `${booking.notes ?? ''} [REMINDED_1H]` },
      });
    }

    const reservations1h = await prisma.reservation.findMany({
      where: {
        reservationTime: { gte: in1hStart, lte: in1hEnd },
        status: 'CONFIRMED',
        NOT: { specialRequests: { contains: '[REMINDED_1H]' } },
      },
      include: {
        contact: true,
        organization: true,
      },
    });

    for (const reservation of reservations1h) {
      await this.sendReservationReminder(reservation, '1 hour');
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { specialRequests: `${reservation.specialRequests ?? ''} [REMINDED_1H]` },
      });
    }

    const totalSent = bookings24h.length + reservations24h.length + bookings1h.length + reservations1h.length;
    if (totalSent > 0) {
      log.info('appointment_reminders_sent', { totalSent, bookings24h: bookings24h.length, reservations24h: reservations24h.length, bookings1h: bookings1h.length, reservations1h: reservations1h.length });
    }
  }

  private async sendBookingReminder(booking: any, timeUntil: string) {
    const email = booking.contact?.email;
    if (!email) return;

    const dateStr = new Date(booking.startTime).toLocaleString('en-NG', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Africa/Lagos',
    });

    try {
      await this.resend.emails.send({
        from: process.env.EMAIL_FROM || 'ACE Platform <noreply@kusuconsult.com>',
        to: email,
        subject: `Reminder: Your appointment in ${timeUntil} — ${booking.organization.name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #1e40af;">Appointment Reminder 📅</h2>
            <p>Hi ${booking.contact?.fullName || 'there'},</p>
            <p>This is a friendly reminder that you have an upcoming appointment in <strong>${timeUntil}</strong>.</p>
            <div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 4px; margin: 16px 0;">
              <p style="margin: 0;"><strong>Service:</strong> ${booking.serviceName}</p>
              <p style="margin: 8px 0 0;"><strong>Date & Time:</strong> ${dateStr} (WAT)</p>
              ${booking.staffName ? `<p style="margin: 8px 0 0;"><strong>Staff:</strong> ${booking.staffName}</p>` : ''}
            </div>
            <p>If you need to reschedule or cancel, please reply to this email or contact us via WhatsApp.</p>
            <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">— ${booking.organization.name} Team</p>
          </div>
        `,
      });
      log.info('booking_reminder_sent', { bookingId: booking.id, email, timeUntil });
    } catch (err: any) {
      log.error('booking_reminder_failed', err, { bookingId: booking.id });
    }
  }

  private async sendReservationReminder(reservation: any, timeUntil: string) {
    const email = reservation.contact?.email;
    if (!email) return;

    const dateStr = new Date(reservation.reservationTime).toLocaleString('en-NG', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Africa/Lagos',
    });

    try {
      await this.resend.emails.send({
        from: process.env.EMAIL_FROM || 'ACE Platform <noreply@kusuconsult.com>',
        to: email,
        subject: `Reminder: Your reservation in ${timeUntil} — ${reservation.organization.name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #1e40af;">Reservation Reminder 🍽️</h2>
            <p>Hi ${reservation.contact?.fullName || 'there'},</p>
            <p>This is a friendly reminder that you have a reservation in <strong>${timeUntil}</strong>.</p>
            <div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 16px; border-radius: 4px; margin: 16px 0;">
              <p style="margin: 0;"><strong>Date & Time:</strong> ${dateStr} (WAT)</p>
              <p style="margin: 8px 0 0;"><strong>Party Size:</strong> ${reservation.partySize} guests</p>
              ${reservation.tableOrRoomNumber ? `<p style="margin: 8px 0 0;"><strong>Table/Room:</strong> ${reservation.tableOrRoomNumber}</p>` : ''}
              ${reservation.specialRequests && !reservation.specialRequests.includes('[REMINDED') ? `<p style="margin: 8px 0 0;"><strong>Special Requests:</strong> ${reservation.specialRequests}</p>` : ''}
            </div>
            <p>If you need to change your reservation, please reply to this email or contact us.</p>
            <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">— ${reservation.organization.name} Team</p>
          </div>
        `,
      });
      log.info('reservation_reminder_sent', { reservationId: reservation.id, email, timeUntil });
    } catch (err: any) {
      log.error('reservation_reminder_failed', err, { reservationId: reservation.id });
    }
  }
}
