// Appointment SEARCH does not live here.
//
// `SchedulingEngine.generateAvailableSlots` used to, and it was a SECOND
// implementation of "what is free" — the one thing this repo keeps shared on
// purpose, because two of them drift into a double booking that both paths
// believed was legitimate. It was also wrong in three ways no caller ever hit
// only because nothing imported it:
//   - it read opening hours from a rule argument, so the AGENCY's configured
//     openingHour/closingHour/serviceDays were ignored;
//   - it set those hours with setUTCHours, so 09:00 meant 10:00 in Lagos;
//   - its conflict test compared only the slot's edges, so a booking lying
//     wholly INSIDE a slot (09:50-10:00 inside 09:40-10:10) left the slot
//     marked available.
// The real search is `findAvailableSlots` in @ace/database (availability.ts),
// which takes a BusyLoader and the agency's own ServiceHours. Call that.

export class SchedulingEngine {
  /**
   * Generates standard iCal (.ics) string for calendar syncing (Google, Outlook, Apple Calendar).
   *
   * `organizerName` is the BUSINESS the customer booked with, not this platform.
   * It is what their calendar app shows them next to the invitation, so a
   * GateKipa customer must see "GateKipa" there — the platform is white-label
   * and has no business appearing in a tenant's customer's calendar.
   */
  static generateIcalEvent(event: {
    title: string;
    description: string;
    location: string;
    startTime: string;
    endTime: string;
    organizerEmail: string;
    organizerName: string;
    uid?: string;
  }): string {
    const startFormatted = new Date(event.startTime).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endFormatted = new Date(event.endTime).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    // Calendar clients treat a repeated UID as the SAME event and overwrite it,
    // so a millisecond timestamp alone silently merges two bookings made in the
    // same millisecond. Callers should pass the booking id; the fallback stays
    // unique on its own.
    const uid =
      event.uid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Customer Care Agent//Scheduling Engine//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
UID:${uid}@customer-care-agent
DTSTAMP:${startFormatted}
DTSTART:${startFormatted}
DTEND:${endFormatted}
SUMMARY:${event.title}
DESCRIPTION:${event.description}
LOCATION:${event.location}
ORGANIZER;CN=${event.organizerName}:mailto:${event.organizerEmail}
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;
  }
}
