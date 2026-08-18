/**
 * Phone number normalisation.
 *
 * The bug this fixes: the same customer was up to three different contacts
 * depending on how they reached the business — `+2348012345678` from Twilio,
 * `2348012345678` from Meta, `08012345678` typed by a staff member. Every
 * lookup was an exact string match, so a booking made over WhatsApp was
 * invisible to the same person calling in.
 *
 * Two properties carry the fix, and they pull in opposite directions:
 *
 *   COLLAPSE  — every shape of one number must resolve to one canonical form,
 *               or the duplicates keep appearing.
 *   DO NO HARM — a number the rules do not recognise must come back unchanged.
 *               Mangling it turns one findable contact into an unfindable one,
 *               which is worse than the duplicate this exists to prevent.
 */

import {
  DEFAULT_COUNTRY_CODE,
  normalizePhoneNumber,
  phoneNumberVariants,
  samePhoneNumber,
} from '@ace/database';

describe('phone number normalisation', () => {
  describe('collapsing the shapes one customer arrives in', () => {
    it.each([
      ['Twilio, already canonical', '+2348012345678'],
      ['Meta, no leading plus', '2348012345678'],
      ['the local form a Nigerian types', '08012345678'],
      ['spaced out', '0801 234 5678'],
      ['punctuated', '+234 (801) 234-5678'],
      ['dialled internationally the old way', '002348012345678'],
    ])('reads %s as the same number', (_label, input) => {
      expect(normalizePhoneNumber(input)).toBe('+2348012345678');
    });

    it('treats all of them as the same subscriber', () => {
      expect(samePhoneNumber('+2348012345678', '2348012345678')).toBe(true);
      expect(samePhoneNumber('+2348012345678', '08012345678')).toBe(true);
      expect(samePhoneNumber('0801 234 5678', '+234-801-234-5678')).toBe(true);
    });

    it('does not merge two different people', () => {
      expect(samePhoneNumber('+2348012345678', '+2348012345679')).toBe(false);
      // Same digits, different country. The local-form rule must not reach
      // across a country code it was never given.
      expect(samePhoneNumber('+2348012345678', '+15551234567')).toBe(false);
    });
  });

  describe('leaving alone what it does not understand', () => {
    it.each([
      ['an extension', '1234'],
      ['a fragment', '0801'],
      ['not a number at all', 'unknown'],
    ])('returns %s unchanged rather than guessing', (_label, input) => {
      // Guessing here would rewrite a contact's only identifier into something
      // no lookup will ever match again.
      expect(normalizePhoneNumber(input)).toBe(input);
    });

    it('handles an empty value without inventing one', () => {
      expect(normalizePhoneNumber('')).toBe('');
      expect(samePhoneNumber('', '+2348012345678')).toBe(false);
    });

    it('leaves a foreign number in its own country code', () => {
      expect(normalizePhoneNumber('+15551234567')).toBe('+15551234567');
      expect(normalizePhoneNumber('15551234567')).toBe('+15551234567');
    });
  });

  describe('the country assumption', () => {
    it('applies the tenant country code to a local number', () => {
      // 0801… is Nigerian only because this platform's tenants are. The rule is
      // a parameter so a tenant elsewhere is not silently given +234.
      expect(normalizePhoneNumber('08012345678', '44')).toBe('+448012345678');
      expect(DEFAULT_COUNTRY_CODE).toBe('234');
    });
  });

  describe('finding rows written before any of this existed', () => {
    it('offers every shape the same number might be stored under', () => {
      const variants = phoneNumberVariants('+2348012345678');
      // Lookups match on this list, so a contact created by WhatsApp before
      // normalisation is still found by a caller dialling in.
      expect(variants).toContain('+2348012345678');
      expect(variants).toContain('2348012345678');
      expect(variants).toContain('08012345678');
    });

    it('produces the same set whichever shape it is given', () => {
      const fromCanonical = [...phoneNumberVariants('+2348012345678')].sort();
      const fromMeta = [...phoneNumberVariants('2348012345678')].sort();
      const fromLocal = [...phoneNumberVariants('08012345678')].sort();
      expect(fromMeta).toEqual(fromCanonical);
      expect(fromLocal).toEqual(fromCanonical);
    });

    it('includes the caller original string for shapes nobody predicted', () => {
      expect(phoneNumberVariants('  +234 801 234 5678  ')).toContain('+2348012345678');
    });

    it('never returns an empty entry, which would match every blank row', () => {
      for (const input of ['', '   ', 'unknown']) {
        expect(phoneNumberVariants(input).every(Boolean)).toBe(true);
      }
    });
  });
});
