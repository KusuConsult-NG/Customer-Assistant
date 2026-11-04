const { SchedulingEngine } = require('../dist/index.js');
const assert = require('assert');

async function testSchedulingEngine() {
  console.log('Testing iCal Calendar Invitation Builder...');

  // There must be NO availability search in this package. It had one, it was a
  // second implementation of what @ace/database's findAvailableSlots already
  // decides, and it disagreed with it (UTC-only hours, agency serviceDays
  // ignored, a booking contained inside a slot not counted as a conflict).
  // Two answers to "what is free" is how both paths confirm the same slot.
  assert.strictEqual(
    typeof SchedulingEngine.generateAvailableSlots,
    'undefined',
    'availability search belongs to findAvailableSlots in @ace/database, not here'
  );
  const exported = Object.getOwnPropertyNames(SchedulingEngine).filter(
    (k) => typeof SchedulingEngine[k] === 'function'
  );
  assert.deepStrictEqual(
    exported,
    ['generateIcalEvent'],
    `this package builds calendar invitations only; found ${exported.join(', ')}`
  );

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
