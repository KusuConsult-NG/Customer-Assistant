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
  it('does not repeat across a burst in the same millisecond', () => {
    // The old scheme was the last six digits of Date.now(). Every number in a
    // burst like this one was identical, and all but the first insert failed.
    const numbers = new Set(Array.from({ length: 5000 }, () => generateTicketNumber()));
    expect(numbers.size).toBe(5000);
  });

  it('sorts chronologically, which is what makes a reference readable', async () => {
    const first = generateTicketNumber();
    await new Promise((r) => setTimeout(r, 2));
    const second = generateTicketNumber();

    // Base-36 milliseconds, so lexical order is time order within a fixed width.
    expect(second > first).toBe(true);
  });

  it('keeps the prefix, which is how staff tell a refund from a complaint', () => {
    expect(generateTicketNumber('REF-BK')).toMatch(/^REF-BK-/);
    expect(generateTicketNumber()).toMatch(/^TCK-/);
  });

  it('carries entropy beyond the timestamp', () => {
    // Same millisecond, different numbers — the property the old scheme lacked.
    const a = generateTicketNumber();
    const b = generateTicketNumber();
    expect(a).not.toBe(b);
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
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(calls).toBe(5);
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
    for (const n of seen) expect(n).toMatch(/^REF-BK-/);
  });
});
