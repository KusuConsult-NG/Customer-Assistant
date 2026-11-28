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

  // The waiting room ([queue]). Proven on a real Asterisk by
  // voice-local-queue-asterisk.spec.ts (not run in CI: it needs Asterisk);
  // these keep its rules from being edited away unnoticed.
  describe('the waiting room', () => {
    const render = fs.readFileSync(path.join(__dirname, '../../../infra/sip-bridge/render.sh'), 'utf8');

    it('keeps the 30-call ceiling, and sends callers beyond it (or behind others waiting) to the waiting room', () => {
      expect(code).toContain('same => n,GotoIf($[${GROUP_COUNT(inbound)} > ${MAX_CONCURRENT_CALLS} | ${GROUP_COUNT(waiting)} > 0]?queue,s,1)');
      expect(render).toContain('MAX_CONCURRENT_CALLS="${MAX_CONCURRENT_CALLS:-30}"');
    });

    it('normalises the caller\'s number BEFORE the waiting room, so the callback rings +234…', () => {
      expect(code.indexOf('Set(CALLERID(num)=+234${CN:1})')).toBeLessThan(code.indexOf('?queue,s,1)'));
    });

    it('defaults: 60 may wait, for 3 minutes; 0 means the busy tone, as before', () => {
      expect(render).toContain('QUEUE_MAX_CALLS="${QUEUE_MAX_CALLS:-60}"');
      expect(render).toContain('QUEUE_MAX_WAIT="${QUEUE_MAX_WAIT:-180}"');
      for (const v of ['QUEUE_MAX_CALLS', 'QUEUE_MAX_WAIT', 'QUEUE_SOUNDS']) expect(render).toMatch(new RegExp(`VARS='[^']*\\$\\{${v}\\}`));
      expect(code).toContain('GotoIf($[${QUEUE_MAX_CALLS} <= 0]?bridge,s,ceiling)');
      expect(code).toMatch(/n\(ceiling\),NoOp\(.*\)\n same => n,Busy\(5\)/);
    });

    it('never resets the tickets on a dialplan reload (no [globals] counters)', () => {
      expect(code).not.toMatch(/^\[globals\]/m);
      expect(code).not.toMatch(/^QNEXT=|^QSERVE=/m);
      expect(code).toContain('ExecIf($["${GLOBAL(QNEXT)}" = ""]?Set(GLOBAL(QNEXT)=0))');
    });

    it('takes tickets and lets callers in under one lock, in ticket order', () => {
      const q = code.slice(code.indexOf('[queue]'), code.indexOf('[queue-gone]'));
      expect(q.match(/\$\{LOCK\(ace-queue\)\}/g)!.length).toBe(2);
      expect(q.match(/\$\{UNLOCK\(ace-queue\)\}/g)!.length).toBe(3); // entry; and each way out of the check: admitted, not yet
      expect(q).toContain('GotoIf($[${MYT} > $[${GLOBAL(QSERVE)} + 1] | ${GROUP_COUNT(inbound)} >= ${MAX_CONCURRENT_CALLS}]?notyet)');
      expect(q).toContain('Goto(bridge,s,admitted)');
    });

    it('a caller who hangs up while waiting is marked gone, and a timed-out caller is offered the callback', () => {
      expect(code).toContain('Set(CHANNEL(hangup_handler_push)=queue-gone,s,1)');
      expect(code).toMatch(/\[queue-gone\]\nexten => s,1,Set\(GLOBAL\(QGONE_\$\{MYT\}\)=1\)/);
      expect(code).toContain('GotoIf($[${EPOCH} - ${QSTART} >= ${QUEUE_MAX_WAIT}]?timeout)');
      expect(code).toContain('/api/voice-local/queue-callback,secret=${LOCAL_VOICE_SECRET}&from=${URIENCODE(${CALLERID(num)})}');
      // Promised only when the API booked it.
      expect(code).toContain('GotoIf($["${QCB:0:3}" = "ok "]?promised)');
    });

    it('every recording has a stock Asterisk prompt to fall back on', () => {
      for (const s of ['queue-hold', 'queue-still', 'queue-later', 'queue-callback']) {
        expect(code).toMatch(new RegExp(`Playback\\(\\$\\{QUEUE_SOUNDS\\}/${s}\\)\\n same => n,ExecIf\\(\\$\\["\\$\\{PLAYBACKSTATUS\\}" != "SUCCESS"\\]\\?Playback\\(`));
      }
    });
  });
});
