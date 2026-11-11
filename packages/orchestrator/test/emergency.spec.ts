/**
 * Emergency recognition (PRD §11).
 *
 * Two properties matter and both are pinned:
 *  - incidents described the way citizens actually describe them are caught,
 *    in English, Pidgin and Hausa;
 *  - topics that merely mention fire, accidents or floods are NOT, or the
 *    script becomes noise people learn to ignore.
 * And the reply must give 112 and must never claim help was dispatched.
 */
import { detectEmergency, emergencyReply } from '../src/emergency';

describe('detectEmergency', () => {
  it.each([
    ['There is a fire outbreak at Terminus market', 'fire'],
    ['our house is burning please', 'fire'],
    ['gunmen attacked our village last night and are still here', 'violence'],
    ['dem dey shoot for Bokkos now', 'violence'],
    ['my father is not breathing', 'medical'],
    ['he had a heart attack', 'medical'],
    ['there was a serious accident on the Jos-Bauchi road, people are trapped', 'accident'],
    ['a building has collapsed in Angwan Rukuba', 'collapse'],
    ['flood has carried away houses in Shendam', 'flood'],
    ['ana gobara a kasuwa', 'fire'],
    ["'yan bindiga sun shigo", 'violence'],
    ['this is an emergency', 'general'],
  ])('catches %p', (text, kind) => {
    expect(detectEmergency(text)).toBe(kind);
  });

  it.each([
    'How much is the fire service certificate fee?',
    'Where do I renew accident insurance for my vehicle?',
    'What is the budget for flood control in 2025?',
    'I was fired from my job, can the ministry help?',
    'When does the Ministry of Health open?',
    '',
  ])('does not fire on %p', (text) => {
    expect(detectEmergency(text)).toBeNull();
  });
});

describe('emergencyReply', () => {
  it('gives 112, the agency contacts verbatim, and never claims dispatch', () => {
    const reply = emergencyReply('en', 'Fire Service, Jos: 0800 000 0000\n\nState Emergency Management Agency: 0800 111 1111');
    expect(reply).toMatch(/112/);
    expect(reply).toContain('• Fire Service, Jos: 0800 000 0000');
    expect(reply).toContain('• State Emergency Management Agency: 0800 111 1111');
    expect(reply).not.toMatch(/dispatched|on (their|the) way|help is coming/i);
  });

  it('states no local number it was not given', () => {
    const reply = emergencyReply('en', null);
    const numbers = reply.match(/\d{3,}/g) ?? [];
    expect(numbers).toEqual(['112', '112']);
  });

  it('answers in the citizen language', () => {
    expect(emergencyReply('ha', null)).toMatch(/gaggawa/);
    expect(emergencyReply('pcm', null)).toMatch(/abeg call 112/);
  });
});
