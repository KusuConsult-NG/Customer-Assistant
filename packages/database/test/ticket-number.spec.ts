/**
 * The reference a customer is given for a ticket.
 *
 * Imported from the source file rather than the package entrypoint: that
 * entrypoint constructs a PrismaClient at import time, and nothing here needs a
 * database. The generator is pure and the retry takes a closure precisely so it
 * can be tested without one.
 *
 * What is being guarded is not the format. It is that a ticket a customer was
 * promised actually exists — `Ticket.ticketNumber` is unique across the WHOLE
 * table, so two tenants compete for the same string, and a collision means the
 * customer who just described a fault is told "I ran into a technical problem"
 * with nothing recorded.
 */
import { generateTicketNumber, createTicketWithUniqueNumber } from '../src/ticket-number';

describe('generateTicketNumber', () => {
  it('is FIVE digits a caller can remember, never starting with 0', () => {
    // The previous form ("TCK-MI3K2Q1A-9F3C2B71D4") was read to callers on the
    // phone and nobody could keep it.
    for (let i = 0; i < 2000; i++) expect(generateTicketNumber()).toMatch(/^[1-9]\d{4}$/);
  });

  it('keeps the prefix, which is how staff tell a refund from a complaint', () => {
    expect(generateTicketNumber('REF-BK')).toMatch(/^REF-BK-[1-9]\d{4}$/);
    expect(generateTicketNumber('REF-RS')).toMatch(/^REF-RS-[1-9]\d{4}$/);
  });

  it('spreads across the whole five-digit range', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateTicketNumber()));
    // Random, not sequential: a guessable number lets anyone ask about
    // somebody else's case.
    expect(seen.size).toBeGreaterThan(1950);
  });

  it('can still give the long form, used only when the short numbers are taken', () => {
    expect(generateTicketNumber('', 6)).toMatch(/^[1-9]\d{5}$/);
    expect(generateTicketNumber('', 0)).toMatch(/^[0-9A-Z]+-[0-9A-F]{10}$/);
  });
});

describe('createTicketWithUniqueNumber', () => {
  const p2002 = (target: string[] = ['ticketNumber']) =>
    Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

  it('allocates a NEW number on collision rather than retrying the same one', async () => {
    const seen: string[] = [];
    let calls = 0;

    const result = await createTicketWithUniqueNumber(async (ticketNumber) => {
      seen.push(ticketNumber);
      if (++calls < 3) throw p2002();
      return { ticketNumber };
    });

    expect(calls).toBe(3);
    expect(result.ticketNumber).toBe(seen[2]);
    // Retrying the same number would collide forever.
    expect(new Set(seen).size).toBe(3);
  });

  it('gives up after a bounded number of attempts instead of looping', async () => {
    let calls = 0;
    await expect(
      createTicketWithUniqueNumber(async () => {
        calls++;
        throw p2002();
      }, '', 5)
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(calls).toBe(5);
  });

  it('grows the number rather than failing when five digits keep colliding', async () => {
    // 90,000 five-digit numbers are shared by every agency. A full range must
    // cost the citizen a longer reference, never a complaint that is not filed.
    const seen: string[] = [];
    const result = await createTicketWithUniqueNumber(async (ticketNumber) => {
      seen.push(ticketNumber);
      if (/^\d{5}$/.test(ticketNumber)) throw p2002();
      return { ticketNumber };
    });
    expect(result.ticketNumber).toMatch(/^[1-9]\d{5}$/);
    expect(seen.filter((n) => /^\d{5}$/.test(n)).length).toBe(12);
  });

  it('tries five digits first', async () => {
    const result = await createTicketWithUniqueNumber(async (ticketNumber) => ({ ticketNumber }));
    expect(result.ticketNumber).toMatch(/^[1-9]\d{4}$/);
  });

  it('rethrows a unique violation on a DIFFERENT field untouched', async () => {
    let calls = 0;
    // Retrying a duplicate contact would burn four more attempts and then
    // report the wrong reason for the failure.
    await expect(
      createTicketWithUniqueNumber(async () => {
        calls++;
        throw p2002(['organizationId', 'phoneNumber']);
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(calls).toBe(1);
  });

  it('rethrows a non-P2002 error immediately', async () => {
    let calls = 0;
    await expect(
      createTicketWithUniqueNumber(async () => {
        calls++;
        throw Object.assign(new Error('Contact not found'), { code: 'P2003' });
      })
    ).rejects.toMatchObject({ code: 'P2003' });

    expect(calls).toBe(1);
  });

  it('passes the prefix through to every attempt', async () => {
    const seen: string[] = [];
    let calls = 0;
    await createTicketWithUniqueNumber(
      async (ticketNumber) => {
        seen.push(ticketNumber);
        if (++calls < 2) throw p2002();
        return { ticketNumber };
      },
      'REF-BK'
    );

    expect(seen).toHaveLength(2);
    for (const n of seen) expect(n).toMatch(/^REF-BK-[1-9]\d{4}$/);
  });
});
