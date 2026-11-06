/**
 * A reminder marker must mean a reminder was SENT.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * Every tier claimed its marker and then decided whether to send:
 *
 *   if (!(await this.claimMarker(booking, '[REMINDED_72H]'))) continue;
 *   if (booking.contact?.email) { await this.sendBookingEmailReminder(...); }
 *
 * The claim MUST come first — it is an atomic `UPDATE ... WHERE notes NOT LIKE
 * marker` and only the caller whose update count is 1 proceeds, which is what
 * stops two pods reminding one citizen twice. What was missing is the other
 * half: a claim that is never released turns "we tried and could not" into
 * "we reminded them".
 *
 * On this platform that fired for every citizen. Contacts are created from a
 * phone number on WhatsApp and voice (`ensureContactForPhone` takes a number
 * and an optional name), and nothing anywhere writes an email address for
 * them — while 72h and 48h send email only, and `sendSmsNotification` is a
 * stub that logs and sends nothing. So all four markers were written to the
 * booking's notes and not one reminder went out. An officer opening that
 * booking read `[REMINDED_72H] [REMINDED_48H] [REMINDED_24H]` and concluded
 * the citizen had been told three times.
 *
 * These tests assert on the NOTES, because the notes are what an officer
 * reads and what every later pass filters on.
 */
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';

const sendMock = jest.fn();
jest.mock('../src/common/mailer', () => ({
  sendTransactionalEmail: (...args: any[]) => sendMock(...args),
  resolveEmailProvider: () => (process.env.__TEST_EMAIL_PROVIDER === '0' ? null : { name: 'test' }),
  emailProviderProblem: () => null,
}));

import { AppointmentReminderService } from '../src/scheduling/appointment-reminder.service';

describe('appointment reminders', () => {
  jest.setTimeout(60000);

  let orgId: string;
  const service = new AppointmentReminderService();

  /** Hours from now, inside the tier's ±1h window. */
  const at = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000);

  const makeBooking = async (opts: { email?: string | null; hours: number }) => {
    const contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        phoneNumber: `+23480${randomBytes(3).toString('hex').replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`,
        fullName: 'Amina Bello',
        ...(opts.email ? { email: opts.email } : {}),
      },
    });
    return prisma.booking.create({
      data: {
        organizationId: orgId,
        contactId: contact.id,
        serviceName: 'Land application',
        startTime: at(opts.hours),
        endTime: at(opts.hours + 1),
        status: 'CONFIRMED',
        // A DISTINCT staff name per booking, because `bookings_no_staff_overlap`
        // is an EXCLUDE over (organizationId, COALESCE(staffName,''), slot) and
        // it correctly refuses a second unstaffed booking in the same slot. Two
        // tests both wanting a 72h booking collide otherwise — the constraint
        // doing exactly its job, which is why unstaffed rows exclude each other
        // at all.
        staffName: `Officer ${randomBytes(4).toString('hex')}`,
      },
    });
  };

  const notesOf = async (id: string) =>
    (await prisma.booking.findUnique({ where: { id }, select: { notes: true } }))?.notes ?? '';

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: 'Reminder Test Agency',
        slug: `reminders-${randomBytes(4).toString('hex')}`,
        industry: 'GOVERNMENT',
      },
    });
    orgId = org.id;
  });

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ok: true });
    delete process.env.__TEST_EMAIL_PROVIDER;
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    delete process.env.__TEST_EMAIL_PROVIDER;
  });

  it('does NOT record a 72h reminder for a citizen it cannot email', async () => {
    // The citizen arrived on WhatsApp, so there is no email address. This is
    // not an edge case on this platform: it is every citizen.
    const booking = await makeBooking({ hours: 72 });

    await service.checkAndSendReminders();

    expect(sendMock).not.toHaveBeenCalled();
    expect(await notesOf(booking.id)).not.toContain('[REMINDED_72H]');
  });

  it('records it when the mail provider actually accepted the message', async () => {
    const booking = await makeBooking({ hours: 72, email: 'amina@example.test' });

    await service.checkAndSendReminders();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await notesOf(booking.id)).toContain('[REMINDED_72H]');
  });

  it('does NOT record it when the provider REFUSED the message', async () => {
    // A refusal is the case that reads as success in a log: the send returned,
    // and the only difference is a field nobody checked.
    sendMock.mockResolvedValue({ ok: false, error: 'domain not verified' });
    const booking = await makeBooking({ hours: 72, email: 'amina@example.test' });

    await service.checkAndSendReminders();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await notesOf(booking.id)).not.toContain('[REMINDED_72H]');
  });

  it('does NOT record it when no mail provider is configured at all', async () => {
    process.env.__TEST_EMAIL_PROVIDER = '0';
    const booking = await makeBooking({ hours: 72, email: 'amina@example.test' });

    await service.checkAndSendReminders();

    expect(sendMock).not.toHaveBeenCalled();
    expect(await notesOf(booking.id)).not.toContain('[REMINDED_72H]');
  });

  it('leaves an undeliverable booking retryable, rather than silently closed', async () => {
    // The consequence of releasing: the window has not passed, so a later
    // sweep tries again. Under the old code the first pass closed it forever.
    const booking = await makeBooking({ hours: 72, email: 'amina@example.test' });
    sendMock.mockResolvedValue({ ok: false, error: 'rate limited' });
    await service.checkAndSendReminders();
    expect(await notesOf(booking.id)).not.toContain('[REMINDED_72H]');

    sendMock.mockResolvedValue({ ok: true });
    await service.checkAndSendReminders();
    expect(await notesOf(booking.id)).toContain('[REMINDED_72H]');
  });

  it('still sends only once when two passes race, which is what the claim is for', async () => {
    // The claim stays BEFORE the send precisely so concurrent pods cannot both
    // send. Releasing on failure must not weaken that.
    const booking = await makeBooking({ hours: 72, email: 'amina@example.test' });

    await Promise.all([service.checkAndSendReminders(), service.checkAndSendReminders()]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await notesOf(booking.id)).toContain('[REMINDED_72H]');
  });

  it('does not record a 24h reminder, because the SMS sender is a stub', async () => {
    // `sendSmsNotification` logs and sends nothing — there is no gateway. The
    // tier used to claim anyway, so the booking recorded a reminder that no
    // integration existed to deliver.
    const booking = await makeBooking({ hours: 24 });

    await service.checkAndSendReminders();

    expect(await notesOf(booking.id)).not.toContain('[REMINDED_24H]');
  });
});
