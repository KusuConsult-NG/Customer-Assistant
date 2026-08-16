const { SchedulingEngine } = require('../dist/index.js');
const assert = require('assert');

async function testSchedulingEngine() {
  console.log('Testing Dedicated Scheduling & iCal Calendar Engine...');

  // Test 1: Availability Slots Generator
  const rule = {
    dayOfWeek: 1,
    startHour: 9, // 9 AM
    endHour: 12, // 12 PM (3 hours)
    slotDurationMinutes: 30,
    bufferDurationMinutes: 10,
  };

  const existingBookings = [
    { startTime: new Date('2026-08-03T09:00:00Z').toISOString(), endTime: new Date('2026-08-03T09:30:00Z').toISOString() },
  ];

  const slots = SchedulingEngine.generateAvailableSlots('2026-08-03T00:00:00Z', rule, existingBookings);
  assert.ok(slots.length > 0, 'Should generate available time slots');
  assert.strictEqual(slots[0].isAvailable, false, 'First slot (9:00 AM) should be booked/unavailable');
  assert.strictEqual(slots[1].isAvailable, true, 'Second slot (9:40 AM after 10m buffer) should be available');

  // Test 2: iCal Event Generation
  const icalArgs = {
    title: 'Medical Checkup with Dr. Adebayo',
    description: 'General Cardiology Assessment at ApexCare Hospital',
    location: 'ApexCare Hospital, Victoria Island, Lagos',
    startTime: '2026-08-03T10:00:00Z',
    endTime: '2026-08-03T10:30:00Z',
    organizerEmail: 'appointments@apexcare.ng',
    organizerName: 'ApexCare Hospital',
  };
  const ical = SchedulingEngine.generateIcalEvent(icalArgs);

  assert.ok(ical.includes('BEGIN:VCALENDAR'), 'iCal string should contain VCALENDAR header');
  assert.ok(ical.includes('SUMMARY:Medical Checkup with Dr. Adebayo'), 'iCal string should contain title');

  // The customer's calendar must name the BUSINESS they booked with. This file
  // is white-label output: naming the platform here would tell every tenant's
  // customers who their software vendor is.
  assert.ok(
    ical.includes('ORGANIZER;CN=ApexCare Hospital:mailto:appointments@apexcare.ng'),
    'ORGANIZER must carry the tenant business name, not the platform'
  );
  assert.ok(!/CN=undefined/.test(ical), 'ORGANIZER name must not be undefined');
  assert.ok(
    !/ACE Platform|Customer Care Agent/.test(ical.split('\n').find((l) => l.startsWith('ORGANIZER')) ?? ''),
    'the platform name must never appear as the organizer'
  );

  // Calendar clients treat a repeated UID as the same event and overwrite it,
  // so two bookings generated in the same millisecond must not collide.
  const uidOf = (s) => (s.split('\n').find((l) => l.startsWith('UID:')) ?? '').trim();
  assert.notStrictEqual(
    uidOf(SchedulingEngine.generateIcalEvent(icalArgs)),
    uidOf(SchedulingEngine.generateIcalEvent(icalArgs)),
    'two events generated back to back must not share a UID'
  );
  assert.strictEqual(
    uidOf(SchedulingEngine.generateIcalEvent({ ...icalArgs, uid: 'booking_123' })),
    'UID:booking_123@customer-care-agent',
    'an explicit uid should be used verbatim'
  );

  console.log('✅ ALL SCHEDULING ENGINE TESTS PASSED SUCCESSFULLY!');
}

testSchedulingEngine().catch((err) => {
  console.error('❌ Scheduling Engine Test Failed:', err);
  process.exit(1);
});
