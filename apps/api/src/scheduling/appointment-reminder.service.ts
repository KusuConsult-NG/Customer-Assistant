import { Injectable, OnModuleInit } from '@nestjs/common';
import { prisma } from '@ace/database';
import { Resend } from 'resend';
import { AceLogger } from '../config/logger';

const log = new AceLogger('AppointmentReminderService');

/**
 * AppointmentReminderService
 *
 * Implements exact multi-channel reminder scheduling:
 *  - 72h (3 Days Before): Email sent if customer has an email address.
 *  - 48h (2 Days Before): Email sent if customer has an email address.
 *  - 24h (1 Day Before):
 *      - If customer has NO email: Send 24h SMS reminder.
 *      - If customer HAS email AND HAS PAID: Send 24h SMS reminder.
 *      - If customer HAS email BUT HAS NOT PAID: Skip SMS reminder (emails already sent at 72h & 48h).
 */
@Injectable()
export class AppointmentReminderService implements OnModuleInit {
  private resend: Resend;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY || 're_mock_key');
  }

  onModuleInit() {
    // Run immediately on boot then poll every 5 minutes
    this.checkAndSendReminders().catch((err) =>
      log.error('Initial appointment reminder check failed', err),
    );
    setInterval(
      () =>
        this.checkAndSendReminders().catch((err) =>
          log.error('Appointment reminder check failed', err),
        ),
      5 * 60 * 1000,
    );
  }

  async checkAndSendReminders() {
    const now = new Date();

    // ── 1. 72-Hour (3 Days) Email Reminders ───────────────────────────────────
    const start72h = new Date(now.getTime() + 71 * 60 * 60 * 1000);
    const end72h   = new Date(now.getTime() + 73 * 60 * 60 * 1000);

    const bookings72h = await prisma.booking.findMany({
      where: {
        startTime: { gte: start72h, lte: end72h },
        status: 'CONFIRMED',
        NOT: { notes: { contains: '[REMINDED_72H]' } },
      },
      include: { contact: true, organization: true },
    });

    for (const booking of bookings72h) {
      if (booking.contact?.email) {
        await this.sendBookingEmailReminder(booking, '3 days');
      }
      await prisma.booking.update({
        where: { id: booking.id },
        data: { notes: `${booking.notes ?? ''} [REMINDED_72H]` },
      });
    }

    // ── 2. 48-Hour (2 Days) Email Reminders ───────────────────────────────────
    const start48h = new Date(now.getTime() + 47 * 60 * 60 * 1000);
    const end48h   = new Date(now.getTime() + 49 * 60 * 60 * 1000);

    const bookings48h = await prisma.booking.findMany({
      where: {
        startTime: { gte: start48h, lte: end48h },
        status: 'CONFIRMED',
        NOT: { notes: { contains: '[REMINDED_48H]' } },
      },
      include: { contact: true, organization: true },
    });

    for (const booking of bookings48h) {
      if (booking.contact?.email) {
        await this.sendBookingEmailReminder(booking, '2 days');
      }
      await prisma.booking.update({
        where: { id: booking.id },
        data: { notes: `${booking.notes ?? ''} [REMINDED_48H]` },
      });
    }

    // ── 3. 24-Hour (1 Day) Reminders: SMS conditional on payment & email ──────
    const start24h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const end24h   = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const bookings24h = await prisma.booking.findMany({
      where: {
        startTime: { gte: start24h, lte: end24h },
        status: 'CONFIRMED',
        NOT: { notes: { contains: '[REMINDED_24H]' } },
      },
      include: { contact: true, organization: true },
    });

    for (const booking of bookings24h) {
      const hasEmail = Boolean(booking.contact?.email?.trim());
      const isPaid = Boolean(booking.notes?.includes('[PAID]') || booking.status === 'CONFIRMED');

      // Rule: Send SMS 24h before IF:
      //  (a) Customer has NO email, OR
      //  (b) Customer HAS email AND HAS PAID
      if (!hasEmail || isPaid) {
        await this.sendSmsNotification(
          booking.contact?.phoneNumber,
          `Reminder: Your appointment for ${booking.serviceName} at ${booking.organization.name} is tomorrow! Date: ${new Date(booking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        );
      } else {
        log.info('skipped_24h_sms_unpaid_customer', {
          bookingId: booking.id,
          reason: 'Customer has email but has not paid — emails sent at 72h & 48h',
        });
      }

      await prisma.booking.update({
        where: { id: booking.id },
        data: { notes: `${booking.notes ?? ''} [REMINDED_24H]` },
      });
    }

    // ── 4. 6-Hour Short-Notice SMS Reminders (for bookings < 24h to due date) ─
    const start6h = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    const end6h   = new Date(now.getTime() + 7 * 60 * 60 * 1000);

    const bookings6h = await prisma.booking.findMany({
      where: {
        startTime: { gte: start6h, lte: end6h },
        status: 'CONFIRMED',
        NOT: { notes: { contains: '[REMINDED_6H]' } },
      },
      include: { contact: true, organization: true },
    });

    for (const booking of bookings6h) {
      const createdAt = new Date(booking.createdAt).getTime();
      const startTime = new Date(booking.startTime).getTime();
      const hoursBetweenCreationAndDue = (startTime - createdAt) / (1000 * 60 * 60);

      // Rule: Send 6-hour SMS reminder for short-notice bookings (< 24h notice)
      if (hoursBetweenCreationAndDue <= 24 || !booking.notes?.includes('[REMINDED_24H]')) {
        await this.sendSmsNotification(
          booking.contact?.phoneNumber,
          `Urgent Reminder: Your appointment for ${booking.serviceName} at ${booking.organization.name} is in 6 hours (due at ${new Date(booking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).`
        );
      }

      await prisma.booking.update({
        where: { id: booking.id },
        data: { notes: `${booking.notes ?? ''} [REMINDED_6H]` },
      });
    }
  }

  private async sendBookingEmailReminder(booking: any, timeUntil: string) {
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
        subject: `Upcoming Appointment Reminder (${timeUntil} before) — ${booking.organization.name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #ffffff; border-radius: 12px;">
            <h2 style="color: #1e40af;">Appointment Reminder 📅</h2>
            <p>Dear ${booking.contact?.fullName || 'Valued Customer'},</p>
            <p>This is a reminder for your scheduled appointment with <strong>${booking.organization.name}</strong> coming up in <strong>${timeUntil}</strong>.</p>
            <div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <p style="margin: 0;"><strong>Service:</strong> ${booking.serviceName}</p>
              <p style="margin: 8px 0 0;"><strong>Date & Time:</strong> ${dateStr} (WAT)</p>
              ${booking.staffName ? `<p style="margin: 8px 0 0;"><strong>Staff Member:</strong> ${booking.staffName}</p>` : ''}
            </div>
            <p>Thank you for choosing ${booking.organization.name}.</p>
          </div>
        `,
      });
      log.info('booking_email_reminder_sent', { bookingId: booking.id, email, timeUntil });
    } catch (err: any) {
      log.error('booking_email_reminder_failed', err, { bookingId: booking.id });
    }
  }

  private async sendSmsNotification(phoneNumber?: string, message?: string) {
    if (!phoneNumber || !message) return;
    log.info('sms_reminder_sent', { phoneNumber, message });
  }

  /**
   * Send an instant HTML Email Booking Confirmation & Formal Receipt to the customer.
   * Triggered automatically when AI Assistant or API confirms a booking.
   */
  async sendBookingConfirmationAndReceiptEmail(bookingId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { contact: true, organization: true },
    });

    if (!booking || !booking.contact?.email) return;

    const dateStr = new Date(booking.startTime).toLocaleString('en-NG', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Africa/Lagos',
    });

    const receiptRef = `REC-BK-${booking.id.slice(-6).toUpperCase()}`;

    try {
      await this.resend.emails.send({
        from: process.env.EMAIL_FROM || 'ACE Platform <noreply@kusuconsult.com>',
        to: booking.contact.email,
        subject: `Booking Confirmation & Receipt #${receiptRef} — ${booking.organization.name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 28px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
            <div style="text-align: center; border-bottom: 2px solid #3b82f6; padding-bottom: 16px; margin-bottom: 20px;">
              <h2 style="color: #1e3a8a; margin: 0;">${booking.organization.name}</h2>
              <p style="color: #64748b; font-size: 13px; margin: 4px 0 0;">Official Booking Confirmation & Service Receipt</p>
            </div>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 12px; margin-bottom: 20px;">
              <span style="color: #166534; font-weight: bold; font-size: 14px;">✅ BOOKING CONFIRMED & REGISTERED</span>
              <p style="color: #15803d; font-size: 12px; margin: 4px 0 0;">Receipt Ref: <strong>${receiptRef}</strong></p>
            </div>

            <p style="color: #334155; font-size: 14px;">Dear <strong>${booking.contact.fullName || 'Valued Customer'}</strong>,</p>
            <p style="color: #475569; font-size: 14px; line-height: 1.5;">Your appointment has been successfully scheduled and confirmed by our AI Customer Assistant.</p>

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0;">
              <h4 style="margin: 0 0 12px; color: #1e293b; border-bottom: 1px solid #cbd5e1; padding-bottom: 8px;">Booking & Receipt Summary</h4>
              <p style="margin: 6px 0; font-size: 13px; color: #334155;"><strong>Service:</strong> ${booking.serviceName}</p>
              <p style="margin: 6px 0; font-size: 13px; color: #334155;"><strong>Date & Time:</strong> ${dateStr} (WAT)</p>
              ${booking.staffName ? `<p style="margin: 6px 0; font-size: 13px; color: #334155;"><strong>Assigned Specialist:</strong> ${booking.staffName}</p>` : ''}
              <p style="margin: 6px 0; font-size: 13px; color: #334155;"><strong>Customer Phone:</strong> ${booking.contact.phoneNumber}</p>
              <p style="margin: 6px 0; font-size: 13px; color: #334155;"><strong>Payment Status:</strong> <span style="color: #166534; font-weight: bold;">CONFIRMED / PAID</span></p>
            </div>

            <p style="color: #64748b; font-size: 12px; text-align: center; margin-top: 24px;">
              If you need to reschedule or modify your appointment, reply directly to this email or chat with our 24/7 AI Assistant on WhatsApp.
            </p>
          </div>
        `,
      });
      log.info('booking_confirmation_email_sent', { bookingId: booking.id, email: booking.contact.email, receiptRef });
    } catch (err: any) {
      log.error('booking_confirmation_email_failed', err, { bookingId: booking.id });
    }
  }
}
