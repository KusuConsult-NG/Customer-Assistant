/**
 * An agency cannot be named with a placeholder.
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * An agency was renamed to the literal string "NEW AGENCY NAME", copied from a
 * command whose placeholder had not been filled in. The settings endpoint
 * accepted it and it went live — so the assistant greeted every caller with
 * it, and it printed on the identity card citizens present as proof.
 *
 * ── Both halves matter ──────────────────────────────────────────────────────
 *
 * The placeholders must be refused, AND real names must get through. A
 * validator that blocks a legitimate rename is a worse failure than the one it
 * prevents: the agency is then stuck with whatever it is called today, and the
 * person fixing it has no way forward. So the real-name list below is as much
 * the point as the placeholder list.
 */
import { assertUsableAgencyName, isUsableAgencyName, AgencyNameError } from '../src/agency-name';

describe('agency names that are placeholders', () => {
  const PLACEHOLDERS = [
    'NEW AGENCY NAME',          // the one that actually shipped
    'New Agency Name',
    'new agency name',
    'Agency Name',
    'agency',
    'AGENCY',
    'Your Agency',
    'your organisation name',
    'The Company',
    'Put the real agency name here',
    'Enter agency name',
    'Replace with the real agency name',
    '<agency name>',
    '<prod>',
    'placeholder',
    'Placeholder Agency',
    'TBD',
    'test',
    'Demo',
    'example',
    'changeme',
    'change me',
    'N/A',
    'null',
    'undefined',
    'xxxx',
    'asdfasdf',
    '',
    '   ',
    'A',
    '12345',
    '---',
  ];

  it.each(PLACEHOLDERS)('refuses %p', (name) => {
    expect(() => assertUsableAgencyName(name)).toThrow(AgencyNameError);
    expect(isUsableAgencyName(name)).toBe(false);
  });

  it('says why, in words an operator can act on', () => {
    // "Invalid name" sends somebody to the character set. The reason it is
    // refused is what it will be used FOR.
    expect(() => assertUsableAgencyName('NEW AGENCY NAME')).toThrow(/looks like a placeholder/i);
    expect(() => assertUsableAgencyName('NEW AGENCY NAME')).toThrow(/spoken to every citizen|identity card/i);
  });
});

describe('agency names that are real', () => {
  // If any of these are refused, the validator is the bug.
  const REAL = [
    'PLASCHEMA',
    'Plateau State Contributory Healthcare Management Agency',
    'Ministry of Information',
    'Ministry of Information & Communication',
    "Ministry of Women's Affairs",
    'Plateau State Water Board',
    'Jos University Teaching Hospital',
    'Plateau State Internal Revenue Service',
    'Bureau for Lands, Survey and Town Planning',
    'Plateau State Universal Basic Education Board (PSUBEB)',
    'Office of the Head of Service',
    'Agency for Community and Social Development',   // starts with "Agency"
    'New Nigeria Development Company',               // starts with "New"
    'Plateau Express Services',
    'NSITF',
    'Ministère de la Santé',                         // accents
    'Hukumar Kiwon Lafiya ta Jihar Plateau',         // Hausa
  ];

  it.each(REAL)('accepts %p', (name) => {
    expect(() => assertUsableAgencyName(name)).not.toThrow();
    expect(isUsableAgencyName(name)).toBe(true);
  });
});

describe('what gets stored', () => {
  it('trims, because a trailing space is invisible in a form and audible in a greeting', () => {
    expect(assertUsableAgencyName('  Ministry of Information  ')).toBe('Ministry of Information');
  });

  it('collapses runs of whitespace', () => {
    expect(assertUsableAgencyName('Ministry   of    Information')).toBe('Ministry of Information');
  });

  it('leaves a good name exactly as given', () => {
    expect(assertUsableAgencyName('PLASCHEMA')).toBe('PLASCHEMA');
  });

  it('refuses a name too long to fit anywhere it is shown', () => {
    expect(() => assertUsableAgencyName('A'.repeat(121))).toThrow(/120 characters/);
    expect(() => assertUsableAgencyName('A'.repeat(120))).not.toThrow();
  });
});
