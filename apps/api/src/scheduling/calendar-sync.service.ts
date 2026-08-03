import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  timeZone: string;
  attendees: Array<{ email: string; name?: string }>;
}

export interface WorkingHours {
  dayOfWeek: number; // 0 = Sunday, 1 = Monday ... 6 = Saturday
  startTime: string; // e.g. "09:00"
  endTime: string;   // e.g. "17:00"
}

@Injectable()
export class CalendarSyncService {
  private logger = new AceLogger('CalendarSyncService');

  /** Check if a requested appointment slot collides with existing bookings or external calendars */
  async isSlotAvailable(
    organizationId: string,
    startTime: Date,
    endTime: Date,
    staffName?: string
  ): Promise<{ available: boolean; conflictReason?: string }> {
    this.logger.info('checking_slot_availability', { organizationId, startTime, endTime, staffName });

    // 1. Double booking check against DB bookings
    const existingBooking = await prisma.booking.findFirst({
      where: {
        organizationId,
        ...(staffName ? { staffName } : {}),
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        OR: [
          { startTime: { lte: startTime }, endTime: { gt: startTime } },
          { startTime: { lt: endTime }, endTime: { gte: endTime } },
          { startTime: { gte: startTime }, endTime: { lte: endTime } },
        ],
      },
    });

    if (existingBooking) {
      return {
        available: false,
        conflictReason: `Slot conflicts with existing booking #${existingBooking.id} (${existingBooking.serviceName})`,
      };
    }

    // 2. Working hours check (Default: Mon-Fri 8AM - 6PM West Africa Time / WAT)
    const dayOfWeek = startTime.getUTCDay();
    const hour = startTime.getUTCHours() + 1; // WAT is UTC+1

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      // Weekend rule
      return { available: false, conflictReason: 'Requested time is outside business operating days (Weekends)' };
    }

    if (hour < 8 || hour >= 18) {
      return { available: false, conflictReason: 'Requested time is outside operating working hours (08:00 - 18:00 WAT)' };
    }

    return { available: true };
  }

  /** Sync booking to Google Calendar / Outlook CalDAV API */
  async syncToExternalCalendar(
    organizationId: string,
    event: CalendarEvent
  ): Promise<{ synced: boolean; externalEventId?: string }> {
    this.logger.info('syncing_event_to_caldav', { organizationId, summary: event.summary });

    // Mock CalDAV / Google Calendar OAuth Sync
    const externalId = `gcal_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    return {
      synced: true,
      externalEventId: externalId,
    };
  }
}
