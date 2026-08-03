export interface TimeSlot {
  startTime: string; // ISO String
  endTime: string;   // ISO String
  isAvailable: boolean;
  staffId?: string;
  staffName?: string;
}

export interface AvailabilityRule {
  dayOfWeek: number; // 0 (Sun) to 6 (Sat)
  startHour: number; // e.g. 9 for 9 AM
  endHour: number;   // e.g. 17 for 5 PM
  slotDurationMinutes: number; // e.g. 30
  bufferDurationMinutes: number; // e.g. 10
}

export class SchedulingEngine {
  /**
   * Generates valid open availability slots for a given date based on working hours & buffer rules.
   */
  static generateAvailableSlots(
    dateIso: string,
    rule: AvailabilityRule,
    existingBookings: Array<{ startTime: string; endTime: string }>
  ): TimeSlot[] {
    const targetDate = new Date(dateIso);
    const slots: TimeSlot[] = [];

    const start = new Date(dateIso);
    start.setUTCHours(rule.startHour, 0, 0, 0);

    const end = new Date(dateIso);
    end.setUTCHours(rule.endHour, 0, 0, 0);

    let current = new Date(start);

    while (current.getTime() + rule.slotDurationMinutes * 60 * 1000 <= end.getTime()) {
      const slotStart = new Date(current);
      const slotEnd = new Date(current.getTime() + rule.slotDurationMinutes * 60 * 1000);

      // Check collision with existing bookings
      const isConflicting = existingBookings.some((b) => {
        const bStart = new Date(b.startTime).getTime();
        const bEnd = new Date(b.endTime).getTime();
        return (
          (slotStart.getTime() >= bStart && slotStart.getTime() < bEnd) ||
          (slotEnd.getTime() > bStart && slotEnd.getTime() <= bEnd)
        );
      });

      slots.push({
        startTime: slotStart.toISOString(),
        endTime: slotEnd.toISOString(),
        isAvailable: !isConflicting,
      });

      // Increment current time by slot duration + buffer duration
      current = new Date(slotEnd.getTime() + rule.bufferDurationMinutes * 60 * 1000);
    }

    return slots;
  }

  /**
   * Generates standard iCal (.ics) string for calendar syncing (Google, Outlook, Apple Calendar).
   */
  static generateIcalEvent(event: {
    title: string;
    description: string;
    location: string;
    startTime: string;
    endTime: string;
    organizerEmail: string;
  }): string {
    const startFormatted = new Date(event.startTime).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endFormatted = new Date(event.endTime).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ACE Platform//Scheduling Engine//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
UID:uid_${Date.now()}@aceplatform.ng
DTSTAMP:${startFormatted}
DTSTART:${startFormatted}
DTEND:${endFormatted}
SUMMARY:${event.title}
DESCRIPTION:${event.description}
LOCATION:${event.location}
ORGANIZER;CN=ACE Platform:mailto:${event.organizerEmail}
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;
  }
}
