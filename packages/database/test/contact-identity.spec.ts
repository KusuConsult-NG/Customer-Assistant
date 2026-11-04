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
