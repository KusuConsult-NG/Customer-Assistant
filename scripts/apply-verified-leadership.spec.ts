/**
 * Every leader the platform names is in the verified table, with a date and a
 * source; every other head is shown as not confirmed. The records named a
 * Permanent Secretary "Dr. Cletus Bako / Dr. Agabus" and most of a cabinet two
 * months out of date.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { leadershipLines, NOT_CONFIRMED } = require('./apply-verified-leadership.js');

const ROOT = join(__dirname, '..');
const verified = JSON.parse(readFileSync(join(ROOT, 'data', 'verified-leadership.json'), 'utf8'));
const catalog: any[] = JSON.parse(readFileSync(join(ROOT, 'data', 'plateau-mdas-knowledge-base.json'), 'utf8'));
const MD = join(ROOT, 'data', 'mda-knowledge');

describe('verified leadership', () => {
  it('dates and sources every name it confirms', () => {
    for (const [abbr, v] of Object.entries<any>(verified.leaders)) {
      expect({ abbr, asOf: Boolean(v.asOf), source: Boolean(v.source) }).toEqual({ abbr, asOf: true, source: true });
      expect(catalog.some((a) => a.abbreviation === abbr)).toBe(true);
    }
  });

  it('is what the agency records now say — and nothing else', () => {
    for (const a of catalog) {
      const v = verified.leaders[a.abbreviation];
      if (v) {
        expect(a.currentLeadership).toMatchObject({ name: v.name, position: v.position, asOf: v.asOf });
      } else {
        expect(a.currentLeadership).toMatchObject({ name: null, unconfirmed: true });
      }
      // Only a confirmed Permanent Secretary is named.
      if (a.currentLeadership.permanentSecretary) expect(v?.permanentSecretary).toBeTruthy();
    }
  });

  it('never names two people for one post', () => {
    for (const a of catalog) expect(String(a.currentLeadership.name ?? '')).not.toMatch(/\s\/\s/);
  });

  it('writes the same thing into every agency document', () => {
    for (const a of catalog) {
      const file = readdirSync(MD).find((f) => f.startsWith(`${a.abbreviation.replace(/[&\s]/g, '-')}-`));
      if (!file) continue;
      const doc = readFileSync(join(MD, file), 'utf8');
      expect(doc).toContain(leadershipLines(a.currentLeadership).slice(0, 2).join('\n'));
    }
  });

  it('says plainly when a name is not confirmed', () => {
    expect(leadershipLines({ position: 'Director General', name: null, unconfirmed: true }).join('\n')).toContain(NOT_CONFIRMED);
  });

  it('gives the assistant only confirmed names, and tells it never to guess', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { STATE_PERSONA_PROMPT } = require('./update-state-info-center.js');
    expect(STATE_PERSONA_PROMPT).toContain('Commissioner for Works: Dr. Cletus Shurkuk (as of August 2026)');
    expect(STATE_PERSONA_PROMPT).toMatch(/NEVER guess or recall a name from memory/);
    for (const stale of ['Satmark', 'Sunday Alex', 'Doeyok', 'Agabus', 'Timothy Dantong', 'Julie Sanda', 'Datong Dominic Gwaman']) {
      expect(STATE_PERSONA_PROMPT).not.toContain(stale);
    }
  });
});
