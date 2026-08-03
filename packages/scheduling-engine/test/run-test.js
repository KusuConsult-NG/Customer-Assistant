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
  const ical = SchedulingEngine.generateIcalEvent({
    title: 'Medical Checkup with Dr. Adebayo',
    description: 'General Cardiology Assessment at ApexCare Hospital',
    location: 'ApexCare Hospital, Victoria Island, Lagos',
    startTime: '2026-08-03T10:00:00Z',
    endTime: '2026-08-03T10:30:00Z',
    organizerEmail: 'appointments@apexcare.ng',
  });

  assert.ok(ical.includes('BEGIN:VCALENDAR'), 'iCal string should contain VCALENDAR header');
  assert.ok(ical.includes('SUMMARY:Medical Checkup with Dr. Adebayo'), 'iCal string should contain title');

  console.log('✅ ALL SCHEDULING ENGINE TESTS PASSED SUCCESSFULLY!');
}

testSchedulingEngine().catch((err) => {
  console.error('❌ Scheduling Engine Test Failed:', err);
  process.exit(1);
});
