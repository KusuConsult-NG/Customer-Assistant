/**
 * A reference is only useful if the citizen and the officer are saying the
 * same string. Both of these were derived in two places, differently.
 */
import { bookingReference, callbackReference } from '../src/callback';

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
