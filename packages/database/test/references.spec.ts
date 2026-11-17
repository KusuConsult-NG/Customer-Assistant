/**
 * A reference is only useful if the citizen and the officer are saying the
 * same string. Both of these were derived in two places, differently.
 */
import { bookingReference, callbackReference, allocateReference, newReference } from '../src/callback';

describe('references read aloud', () => {
  const id = '3f2b91cd-7a44-4e11-9b2e-aaaaaaaaaaaa';

  it('derives one booking reference, whichever engine is speaking', () => {
    // The orchestrator said "#AAAAAAAA" (last 8, upper) and the agent's tools
    // said "3f2b91cd" (first 8, lower) for THIS booking.
    expect(bookingReference(id)).toBe('AP-3F2B91CD');
  });

  it('is stable, so quoting it back finds the same booking', () => {
    expect(bookingReference(id)).toBe(bookingReference(id));
  });

  it('keeps appointments and callbacks visibly different', () => {
    // An officer reading a queue must be able to tell which kind of promise a
    // citizen is quoting before they go looking for it.
    expect(bookingReference(id).startsWith('AP-')).toBe(true);
    expect(callbackReference(id).startsWith('CB-')).toBe(true);
    expect(bookingReference(id)).not.toBe(callbackReference(id));
  });

  it('survives an id with no dashes', () => {
    expect(bookingReference('3f2b91cd7a444e119b2eaaaaaaaaaaaa')).toBe('AP-3F2B91CD');
  });
});

describe('five-digit references for callbacks and appointments', () => {
  // "CB-3F2B91CD" and "AP-3F2B91CD" could not be remembered over the phone.
  const id = '3f2b91cd-7a44-4e11-9b2e-aaaaaaaaaaaa';

  it('quotes the stored five digits, and the old form only for an older row', () => {
    expect(callbackReference({ id, reference: '48213' })).toBe('48213');
    expect(bookingReference({ id, reference: '50917' })).toBe('50917');
    // Rows made before references were stored keep what the citizen was told.
    expect(callbackReference({ id, reference: null })).toBe('CB-3F2B91CD');
    expect(bookingReference({ id })).toBe('AP-3F2B91CD');
  });

  it('allocates five digits, never starting with 0, skipping ones the agency already uses', async () => {
    const used = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const ref = await allocateReference(async (r) => used.has(r));
      expect(ref).toMatch(/^[1-9]\d{4}$/);
      expect(used.has(ref)).toBe(false);
      used.add(ref);
    }
  });

  it('grows to six digits rather than refusing when five keep colliding', async () => {
    const ref = await allocateReference(async (r) => r.length === 5);
    expect(ref).toMatch(/^[1-9]\d{5}$/);
  });

  it('checks within THIS agency, and never refuses a booking because the check failed', async () => {
    const asked: any[] = [];
    const ref = await newReference({ findFirst: async (args: any) => { asked.push(args.where); return null; } }, 'org_1');
    expect(ref).toMatch(/^[1-9]\d{4}$/);
    expect(asked[0]).toEqual({ organizationId: 'org_1', reference: ref });
    await expect(newReference({ findFirst: async () => { throw new Error('db down'); } }, 'org_1')).resolves.toMatch(/^\d{5}$/);
    await expect(newReference(undefined, 'org_1')).resolves.toMatch(/^\d{5}$/);
  });
});
