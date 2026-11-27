/**
 * The bridge's dialplan, read as written (infra/sip-bridge/templates).
 *
 * A jitter buffer on the voice line's path (Set(JITTERBUFFER(adaptive)=300,60,40),
 * added 27 Nov 2026) stopped the caller's audio reaching the line: a 52 s call
 * delivered 0.4 s of it, and with the line removed from the running bridge the
 * next call delivered 37.5 s of 38. The real-Asterisk suites never caught it,
 * because test RTP arrives perfectly timed. This pins the line's absence.
 */
import * as fs from 'fs';
import * as path from 'path';

const template = fs.readFileSync(path.join(__dirname, '../../../infra/sip-bridge/templates/extensions.conf.template'), 'utf8');
/** Dialplan lines only, comments dropped. */
const code = template
  .split('\n')
  .filter((l) => !/^\s*;/.test(l))
  .join('\n');

describe('the bridge dialplan', () => {
  it('puts no jitter buffer between the caller and the voice line', () => {
    const from = code.indexOf('/api/voice-local/register');
    const to = code.indexOf('Dial(AudioSocket/');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(code.slice(from, to)).not.toMatch(/JITTERBUFFER/);
  });

  it('keeps the jitter buffer on the ElevenLabs path, where it was added for skipped words', () => {
    const dial = code.indexOf('Dial(PJSIP/elevenlabs/');
    expect(dial).toBeGreaterThan(-1);
    const before = code.slice(0, dial).split('\n').slice(-3).join('\n');
    expect(before).toMatch(/JITTERBUFFER\(adaptive\)/);
  });
});
