/**
 * One citizen, one record, and a name that catches up with what they told us.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * FIVE places created "the contact for this phone number" with four different
 * placeholder names — `Caller (···1234)`, `Caller (1234)`, `Caller 1234` and
 * `WhatsApp Contact (···1234)` — and none of them ever replaced a placeholder
 * with the name the citizen actually gave.
 *
 * So the agent DID remember the caller's number and DID find the record, and
 * then greeted a woman who had given her name on the previous call as
 * "Welcome back, Caller (···5678)". Her name was sitting in the booking she
 * made; nothing wrote it to the record the greeting is read from.
 *
 * It is one function now, and it upgrades.
 */
import {
  ensureContactForPhone,
  isAgencyOwnNumber,
  isPlaceholderContactName,
  placeholderContactName,
} from '../src/contact-identity';

/** A Prisma stand-in: the real client needs a database, this needs the rules. */
function fakeDb(rows: any[] = []) {
  let id = rows.length;
  return {
    rows,
    contact: {
      findFirst: async ({ where }: any) => {
        const wanted: string[] = where.phoneNumber?.in ?? [where.phoneNumber];
        return (
          rows.find(
            (r) => r.organizationId === where.organizationId && wanted.includes(r.phoneNumber)
          ) ?? null
        );
      },
      create: async ({ data }: any) => {
        const row = { id: `c${++id}`, tags: [], ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

describe('recognising which names are ours and not the citizen\'s', () => {
  it('knows every placeholder this platform has ever written', () => {
    // All four shapes are in live data. A detector that only knew the current
    // one would leave every row written before it unfixable.
    for (const name of [
      'Caller (···5678)',
      'Caller (5678)',
      'Caller 5678',
      'WhatsApp Contact (···5678)',
      'Unknown Caller',
      'Valued Customer',
      '',
      '   ',
    ]) {
      expect(isPlaceholderContactName(name)).toBe(true);
    }
  });

  it('does not mistake a real citizen for a placeholder', () => {
    for (const name of [
      'Ada Bello',
      'Caller Musa',           // a surname, not our format
      'Mr Caller',
      'Chinedu W. Okonkwo',
      'Fatima',
    ]) {
      expect(isPlaceholderContactName(name)).toBe(false);
    }
  });

  it('writes one placeholder shape, so the CRM does not show four', () => {
    expect(placeholderContactName('+2348012345678')).toBe('Caller (···5678)');
  });
});

describe('the contact for a phone number', () => {
  it('creates one canonically and finds it again in any shape', async () => {
    const db = fakeDb();
    const made = await ensureContactForPhone(db as any, 'org1', '08012345678');
    expect(made!.phoneNumber).toBe('+2348012345678');

    // Meta sends no plus, a staff member types the local form.
    for (const shape of ['2348012345678', '+2348012345678', '08012345678']) {
      const again = await ensureContactForPhone(db as any, 'org1', shape);
      expect(again!.id).toBe(made!.id);
    }
    expect(db.rows).toHaveLength(1);
  });

  it('refuses to key a record on a withheld number', async () => {
    const db = fakeDb();
    for (const withheld of ['', '  ', 'unknown', 'Anonymous', 'private', 'restricted', 'withheld']) {
      expect(await ensureContactForPhone(db as any, 'org1', withheld)).toBeNull();
    }
    // One row shared by every withheld caller in the State is worse than none.
    expect(db.rows).toHaveLength(0);
  });

  it('upgrades a placeholder to the name the citizen gave', async () => {
    const db = fakeDb();
    await ensureContactForPhone(db as any, 'org1', '+2348012345678');
    expect(db.rows[0].fullName).toBe('Caller (···5678)');

    const named = await ensureContactForPhone(db as any, 'org1', '08012345678', 'Ada Bello');
    expect(named!.fullName).toBe('Ada Bello');
    expect(db.rows).toHaveLength(1);
  });

  it('upgrades a placeholder written by ANOTHER channel', async () => {
    // The same person reached WhatsApp first. The voice agent must not greet
    // them as "WhatsApp Contact".
    const db = fakeDb([
      { id: 'c1', organizationId: 'org1', phoneNumber: '+2348012345678', fullName: 'WhatsApp Contact (···5678)' },
    ]);
    const named = await ensureContactForPhone(db as any, 'org1', '+2348012345678', 'Ada Bello');
    expect(named!.fullName).toBe('Ada Bello');
  });

  it('never overwrites a name a human already recorded', async () => {
    // A caller booking for a relative gives a different name. The CRM record
    // belongs to the number's owner, and an officer may have corrected it by
    // hand — neither is ours to replace.
    const db = fakeDb([
      { id: 'c1', organizationId: 'org1', phoneNumber: '+2348012345678', fullName: 'Ada Bello' },
    ]);
    const same = await ensureContactForPhone(db as any, 'org1', '+2348012345678', 'Her Brother Musa');
    expect(same!.fullName).toBe('Ada Bello');
  });

  it('never replaces a real name with a placeholder', async () => {
    const db = fakeDb([
      { id: 'c1', organizationId: 'org1', phoneNumber: '+2348012345678', fullName: 'Ada Bello' },
    ]);
    const same = await ensureContactForPhone(db as any, 'org1', '+2348012345678', '   ');
    expect(same!.fullName).toBe('Ada Bello');
  });

  it('does not write when the placeholder is already right', async () => {
    const db = fakeDb([
      { id: 'c1', organizationId: 'org1', phoneNumber: '+2348012345678', fullName: 'Caller (···5678)' },
    ]);
    let updates = 0;
    (db.contact as any).update = async () => { updates++; return db.rows[0]; };
    await ensureContactForPhone(db as any, 'org1', '+2348012345678');
    expect(updates).toBe(0);
  });

  it('lets the unique constraint settle two simultaneous first calls', async () => {
    const db = fakeDb();
    (db.contact as any).create = async () => {
      // The other pod won the race between our findFirst and our create.
      db.rows.push({ id: 'c1', organizationId: 'org1', phoneNumber: '+2348012345678', fullName: 'Caller (···5678)' });
      const err: any = new Error('Unique constraint failed');
      err.code = 'P2002';
      throw err;
    };
    const row = await ensureContactForPhone(db as any, 'org1', '+2348012345678');
    expect(row!.id).toBe('c1');
  });
});

/**
 * A forwarded call must not become one contact for every citizen.
 *
 * A Nigerian citizen will not dial an international number, so a local
 * toll-free line gets forwarded to whatever number the platform's carrier
 * gave us. Many carriers forward WITHOUT passing the original calling line
 * identity: what arrives as the caller is the dialled number, or the
 * forwarding trunk.
 *
 * Unguarded, every citizen on that line matches the same contact — and then
 * one citizen's appointments, cases and conversation history are filed under
 * another's name, across the whole helpline, with nothing in the data saying
 * so. A duplicate is recoverable; this is not.
 */
describe('a forwarded call is not attributed to a person', () => {
  const AGENCY_LINE = '+17372212163';
  const TOLL_FREE = '08001234567';
  const FORWARD_TO = '+2348031112222';

  it('refuses the agency line as a caller', async () => {
    const db = fakeDb();
    const made = await ensureContactForPhone(db as any, 'org1', AGENCY_LINE, undefined, [
      AGENCY_LINE,
      FORWARD_TO,
    ]);
    // Not created, and not matched to anything.
    expect(made).toBeNull();
    expect(db.rows).toHaveLength(0);
  });

  it('refuses the toll-free number citizens dialled, in any format', async () => {
    const db = fakeDb();
    // The carrier presents the dialled number in E.164 while the agency saved
    // it in the local form, or the other way round. A string comparison misses
    // exactly the match that matters.
    for (const presented of ['+2348001234567', '08001234567', '2348001234567']) {
      expect(
        await ensureContactForPhone(db as any, 'org1', presented, undefined, [TOLL_FREE])
      ).toBeNull();
    }
    expect(db.rows).toHaveLength(0);
  });

  it('refuses the forwarding target too', async () => {
    const db = fakeDb();
    expect(
      await ensureContactForPhone(db as any, 'org1', FORWARD_TO, undefined, [AGENCY_LINE, FORWARD_TO])
    ).toBeNull();
    expect(db.rows).toHaveLength(0);
  });

  it('still creates a contact for a real citizen on the same line', async () => {
    const db = fakeDb();
    const citizen = await ensureContactForPhone(db as any, 'org1', '+2348039998888', 'Amina Yusuf', [
      AGENCY_LINE,
      TOLL_FREE,
      FORWARD_TO,
    ]);
    // The guard must not swallow the case it exists to protect: when the
    // carrier DOES pass the citizen's own number through, that citizen is
    // recorded exactly as before.
    expect(citizen).not.toBeNull();
    expect(citizen!.fullName).toBe('Amina Yusuf');
    expect(db.rows).toHaveLength(1);
  });

  it('behaves exactly as before when no agency numbers are given', async () => {
    const db = fakeDb();
    // Every existing caller passes four arguments. They must keep working.
    const made = await ensureContactForPhone(db as any, 'org1', AGENCY_LINE);
    expect(made).not.toBeNull();
    expect(db.rows).toHaveLength(1);
  });
});

describe('isAgencyOwnNumber', () => {
  it('is false with nothing to compare against', () => {
    expect(isAgencyOwnNumber('+2348031112222', [])).toBe(false);
    expect(isAgencyOwnNumber('+2348031112222', undefined)).toBe(false);
    expect(isAgencyOwnNumber(null, ['+2348031112222'])).toBe(false);
  });

  it('ignores blanks in the agency list rather than matching them', () => {
    // A null forwardingNumber is the common case, and it must not make every
    // caller look like the agency.
    expect(isAgencyOwnNumber('+2348039998888', [null, undefined, ''])).toBe(false);
  });
});
