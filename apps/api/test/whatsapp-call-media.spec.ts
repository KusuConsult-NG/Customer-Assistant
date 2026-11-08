import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { DEFAULT_WELCOME_MESSAGE } from '../src/common/welcome-message';
import {
  WhatsAppCallMediaService,
  downmixToMono,
  upsample2x,
  frameMono,
  monoToStereo,
} from '../src/whatsapp/whatsapp-call-media.service';

/**
 * The audio bridge for an answered WhatsApp call.
 *
 * The transport cannot be tested here — a sandbox allocates no TURN relay and
 * places no WhatsApp call, so no packet has ever crossed this path. What CAN be
 * tested is everything that turns a packet into words and back, and those are
 * the parts where a quiet mistake is heard as a robotic voice or a caller who
 * is never transcribed rather than reported as an error:
 *
 *   - the sample arithmetic, asserted on exact values;
 *   - a real Opus round trip through the real codec at WebRTC's frame size;
 *   - the chain actually running: audio in → transcript → orchestrator → TTS →
 *     frames out, with the far ends faked.
 */
describe('WhatsApp call media', () => {
  jest.setTimeout(60000);

  /** PCM16 mono from a list of sample values. */
  const mono = (...samples: number[]) => {
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => b.writeInt16LE(v, i * 2));
    return b;
  };
  /** Interleaved stereo PCM16 from [left, right] pairs. */
  const stereo = (...pairs: Array<[number, number]>) => {
    const b = Buffer.alloc(pairs.length * 4);
    pairs.forEach(([l, r], i) => {
      b.writeInt16LE(l, i * 4);
      b.writeInt16LE(r, i * 4 + 2);
    });
    return b;
  };
  const read = (b: Buffer) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
    return out;
  };

  describe('the sample arithmetic', () => {
    it('averages the two channels rather than taking one', () => {
      // Taking the left channel only would work on most speech and lose a
      // caller whose audio lands on the right.
      expect(read(downmixToMono(stereo([100, 200], [-100, -200], [0, 0])))).toEqual([150, -150, 0]);
    });

    it('cannot overflow on two loud channels', () => {
      // Both channels near full scale. Summing into an int16 before halving
      // would wrap to a large negative value — heard as a loud click.
      const out = read(downmixToMono(stereo([32767, 32767], [-32768, -32768])));
      expect(out).toEqual([32767, -32768]);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(-32768);
        expect(v).toBeLessThanOrEqual(32767);
      }
    });

    it('doubles the rate by interpolating, not by repeating', () => {
      // Repeating each sample mirrors the spectrum around 12 kHz and sounds
      // harsh on sibilants; the midpoint is the cheapest thing that does not.
      expect(read(upsample2x(mono(0, 100, 200)))).toEqual([0, 50, 100, 150, 200, 200]);
    });

    it('holds the final sample, which has no neighbour to interpolate toward', () => {
      expect(read(upsample2x(mono(500)))).toEqual([500, 500]);
      expect(upsample2x(Buffer.alloc(0)).length).toBe(0);
    });

    it('produces exactly twice the samples, so timing cannot drift', () => {
      // The ratio is exactly 2, which is why there is no fractional
      // accumulator. A drift of even a few samples per buffer accumulates into
      // audible desync over a call.
      for (const n of [1, 2, 7, 240, 960]) {
        expect(read(upsample2x(Buffer.alloc(n * 2))).length).toBe(n * 2);
      }
    });

    it('frames into whole 20 ms blocks and drops the short tail', () => {
      // Opus rejects a partial frame, and padding one with silence inserts a
      // click between utterances.
      expect(frameMono(Buffer.alloc(960 * 2 * 3)).length).toBe(3);
      expect(frameMono(Buffer.alloc(960 * 2 * 2 + 100)).length).toBe(2);
      expect(frameMono(Buffer.alloc(100)).length).toBe(0);
      for (const f of frameMono(Buffer.alloc(960 * 2 * 2))) expect(f.length).toBe(960 * 2);
    });

    it('duplicates mono into both channels for the stereo encoder', () => {
      expect(read(monoToStereo(mono(10, -10)))).toEqual([10, 10, -10, -10]);
    });
  });

  /**
   * The real codec. This is why `opusscript` is a dependency rather than a
   * plan, and why Opus is decoded instead of forwarded to Deepgram as raw opus
   * — that shortcut is documented for Deepgram's Flux model and unestablished
   * for the nova-2 streaming model this platform uses.
   */
  describe('a real Opus round trip at WebRTC frame size', () => {
    it('survives encode and decode with the signal intact', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const OpusScript = require('opusscript');
      const RATE = 48000;
      const FRAME = 960; // 20 ms, what WebRTC sends

      // A 440 Hz tone at 24 kHz mono, as TTS would deliver it.
      const src = Buffer.alloc(FRAME * 2);
      for (let i = 0; i < FRAME; i++) {
        src.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000), i * 2);
      }

      // The outbound chain exactly as the service runs it.
      const upsampled = upsample2x(src);
      const frames = frameMono(upsampled);
      expect(frames.length).toBeGreaterThan(0);

      const enc = new OpusScript(RATE, 2, OpusScript.Application.VOIP);
      const dec = new OpusScript(RATE, 2, OpusScript.Application.VOIP);
      try {
        const packet = enc.encode(monoToStereo(frames[0]), FRAME);
        // A real Opus packet, not a passthrough of the PCM.
        expect(packet.length).toBeGreaterThan(0);
        expect(packet.length).toBeLessThan(FRAME * 2 * 2);

        const decoded = Buffer.from(dec.decode(packet));
        expect(decoded.length).toBe(FRAME * 2 * 2);

        // And it is audio, not silence. A codec misconfigured on channels or
        // rate decodes to near-zero rather than erroring, so the peak is the
        // assertion that matters.
        const back = downmixToMono(decoded);
        let peak = 0;
        for (const v of read(back)) peak = Math.max(peak, Math.abs(v));
        expect(peak).toBeGreaterThan(2000);
      } finally {
        enc.delete();
        dec.delete();
      }
    });
  });

  describe('the chain, end to end with the far ends faked', () => {
    const OFFER_PT = 96;

    /** A werift-shaped connection whose RTP we can drive and observe. */
    const makePc = () => {
      const listeners: Array<(t: any) => void> = [];
      const written: any[] = [];
      let rtpSink: ((rtp: any) => void) | null = null;
      const transceiver = {
        kind: 'audio',
        onTrack: { subscribe: (fn: any) => listeners.push(fn) },
        sender: {
          getParameters: () => ({ codecs: [{ payloadType: OFFER_PT }] }),
          replaceTrack: async (t: any) => {
            t.writeRtp = (rtp: any) => written.push(rtp);
          },
        },
      };
      return {
        pc: { getTransceivers: () => [transceiver] },
        written,
        /** Simulate Meta sending us a packet. */
        deliver: (payload: Buffer) => {
          for (const fn of listeners) {
            fn({ onReceiveRtp: { subscribe: (cb: any) => (rtpSink = cb) } });
          }
          rtpSink?.({ payload });
        },
      };
    };

    /** A Deepgram stand-in whose messages we control. */
    const makeDeepgram = () => {
      const handlers: Record<string, any> = {};
      const sent: Buffer[] = [];
      return {
        ws: {
          readyState: 1,
          on: (ev: string, fn: any) => (handlers[ev] = fn),
          send: (b: Buffer) => sent.push(b),
          close: () => {},
        },
        sent,
        /** Simulate a final transcript arriving. */
        finalise: (transcript: string) =>
          handlers.message?.(
            JSON.stringify({ is_final: true, channel: { alternatives: [{ transcript }] } })
          ),
        interim: (transcript: string) =>
          handlers.message?.(
            JSON.stringify({ is_final: false, channel: { alternatives: [{ transcript }] } })
          ),
      };
    };

    const settle = () => new Promise((r) => setTimeout(r, 400));

    it('decodes inbound audio and feeds Deepgram mono PCM', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const OpusScript = require('opusscript');
      const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
      const tone = Buffer.alloc(960 * 4);
      for (let i = 0; i < 960; i++) {
        const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 11000);
        tone.writeInt16LE(v, i * 4);
        tone.writeInt16LE(v, i * 4 + 2);
      }
      const packet = Buffer.from(enc.encode(tone, 960));
      enc.delete();

      const dg = makeDeepgram();
      const svc = new WhatsAppCallMediaService({
        createDeepgramWsForOrg: async () => dg.ws,
        fetchTtsPcm24k: async () => null,
      } as any);

      const { pc, deliver } = makePc();
      await svc.attach({
        pc,
        organizationId: 'org',
        callId: 'wacid.1',
        citizenNumber: '+2348012345678',
        correlationId: 'cid',
      });
      deliver(packet);
      await settle();

      expect(dg.sent.length).toBe(1);
      // Mono, 960 samples: half the bytes of the stereo frame that arrived.
      expect(dg.sent[0].length).toBe(960 * 2);
      let peak = 0;
      for (const v of read(dg.sent[0])) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(2000);
    });

    it('opens Deepgram as linear16/48000/1, not Twilio mulaw', async () => {
      let opened: any = null;
      const dg = makeDeepgram();
      const svc = new WhatsAppCallMediaService({
        createDeepgramWsForOrg: async (_org: string, audio: any) => {
          opened = audio;
          return dg.ws;
        },
        fetchTtsPcm24k: async () => null,
      } as any);

      const { pc } = makePc();
      await svc.attach({ pc, organizationId: 'org', callId: 'c', citizenNumber: '+1', correlationId: 'cid' });

      // Telling Deepgram mulaw/8000 while sending it 48 kHz PCM transcribes
      // every word at the wrong speed and pitch — nonsense, not an error.
      expect(opened).toEqual({ encoding: 'linear16', sampleRate: 48000, channels: 1 });
    });

    it('answers a final transcript through the orchestrator and sends Opus back', async () => {
      const dg = makeDeepgram();
      const tts = Buffer.alloc(24000 * 2 * 0.1); // 100 ms of 24 kHz silence-shaped PCM
      for (let i = 0; i < tts.length / 2; i++) {
        tts.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);
      }
      const svc = new WhatsAppCallMediaService({
        createDeepgramWsForOrg: async () => dg.ws,
        fetchTtsPcm24k: async () => tts,
      } as any);
      (svc as any).orchestrator = {
        processIncomingMessage: async () => ({
          replyText: 'Your appointment is on Tuesday.',
          confidenceScore: 1,
          shouldHandoff: false,
        }),
      };

      const { pc, written } = makePc();
      await svc.attach({ pc, organizationId: 'org', callId: 'c', citizenNumber: '+1', correlationId: 'cid' });

      dg.finalise('when is my appointment');
      await new Promise((r) => setTimeout(r, 1500));

      expect(written.length).toBeGreaterThan(0);
      // The payload type Meta negotiated, not the 111 everyone assumes —
      // sending on the wrong one is discarded silently at the far end.
      expect(written[0].header.payloadType).toBe(OFFER_PT);
      // RTP timestamps must advance a whole frame per packet, or playback
      // stutters even with every byte correct.
      if (written.length > 1) {
        const step = (written[1].header.timestamp - written[0].header.timestamp) >>> 0;
        expect(step).toBe(960);
        expect(written[1].header.sequenceNumber).toBe((written[0].header.sequenceNumber + 1) & 0xffff);
      }
    });

    it('ignores interim transcripts, so it does not answer half a sentence', async () => {
      const dg = makeDeepgram();
      let called = 0;
      const svc = new WhatsAppCallMediaService({
        createDeepgramWsForOrg: async () => dg.ws,
        fetchTtsPcm24k: async () => null,
      } as any);
      (svc as any).orchestrator = {
        processIncomingMessage: async () => {
          called++;
          return { replyText: 'x', confidenceScore: 1, shouldHandoff: false };
        },
      };

      const { pc } = makePc();
      await svc.attach({ pc, organizationId: 'org', callId: 'c', citizenNumber: '+1', correlationId: 'cid' });
      dg.interim('when is my');
      dg.interim('when is my appoint');
      await settle();
      expect(called).toBe(0);

      dg.finalise('when is my appointment');
      await settle();
      expect(called).toBe(1);
    });

    it('survives a call with no STT configured rather than throwing', async () => {
      const svc = new WhatsAppCallMediaService({
        // DEEPGRAM_API_KEY unset returns null here.
        createDeepgramWsForOrg: async () => null,
        fetchTtsPcm24k: async () => null,
      } as any);
      const { pc } = makePc();
      // The call is already accepted by this point; throwing would leave a
      // connected call with no handler and nothing saying why.
      const session = await svc.attach({
        pc,
        organizationId: 'org',
        callId: 'c',
        citizenNumber: '+1',
        correlationId: 'cid',
      });
      await expect(session.stop()).resolves.toBeUndefined();
    });

    /**
     * THE CALLER MUST HEAR SOMETHING.
     *
     * `say()` was reachable only from a final Deepgram transcript, so a
     * citizen whose WhatsApp call was ACCEPTED heard nothing at all until
     * they spoke first. The Twilio handler has always greeted. This channel
     * did not, and nothing compared the two — so the first impression of the
     * whole product was dead air, with no error logged and a `CallLog`
     * recording the call as answered.
     */
    describe('greeting the caller', () => {
      it('speaks first, without waiting for the citizen to talk', async () => {
        const pc = makePc();
        const spoken: string[] = [];
        const svc = new WhatsAppCallMediaService({
          createDeepgramWsForOrg: async () => makeDeepgram().ws,
          fetchTtsPcm24k: async (text: string) => {
            spoken.push(text);
            // 24 kHz mono, a tenth of a second, so framing has something real.
            return Buffer.alloc(2400 * 2);
          },
        } as any);

        await svc.attach({
          pc: pc.pc,
          organizationId: `org_absent_${randomBytes(4).toString('hex')}`,
          callId: 'wacid.GREET',
          citizenNumber: '+2348012345678',
          correlationId: 'cid',
        });
        await settle();

        // Nothing was transcribed, and the caller was still spoken to.
        expect(spoken).toHaveLength(1);
        expect(spoken[0]).toBe(DEFAULT_WELCOME_MESSAGE);
        // And it actually went out as Opus, not merely synthesised.
        expect(pc.written.length).toBeGreaterThan(0);
      });

      it("uses the AGENCY's wording when it has configured one", async () => {
        const org = await prisma.organization.create({
          data: {
            name: 'Greeting Agency',
            slug: `greet-${randomBytes(4).toString('hex')}`,
            industry: 'GOVERNMENT',
            welcomeMessage: 'Plateau Customer Care, good afternoon. How may we help?',
          },
        });
        try {
          const spoken: string[] = [];
          const svc = new WhatsAppCallMediaService({
            createDeepgramWsForOrg: async () => makeDeepgram().ws,
            fetchTtsPcm24k: async (text: string) => {
              spoken.push(text);
              return Buffer.alloc(480 * 2);
            },
          } as any);

          await svc.attach({
            pc: makePc().pc,
            organizationId: org.id,
            callId: 'wacid.GREET2',
            citizenNumber: '+2348012345678',
            correlationId: 'cid',
          });
          await settle();

          expect(spoken).toEqual(['Plateau Customer Care, good afternoon. How may we help?']);
        } finally {
          await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
        }
      });

      it('still answers the citizen after greeting them', async () => {
        // The greeting sets `speaking` while it streams. If it were awaited,
        // or if it left the flag set, the citizen's first sentence would be
        // recorded and never answered.
        const dg = makeDeepgram();
        const spoken: string[] = [];
        const svc = new WhatsAppCallMediaService({
          createDeepgramWsForOrg: async () => dg.ws,
          fetchTtsPcm24k: async (text: string) => {
            spoken.push(text);
            return Buffer.alloc(240 * 2);
          },
        } as any);
        (svc as any).orchestrator = {
          processIncomingMessage: async () => ({ replyText: 'Your appointment is on Tuesday.' }),
        };

        await svc.attach({
          pc: makePc().pc,
          organizationId: `org_absent_${randomBytes(4).toString('hex')}`,
          callId: 'wacid.GREET3',
          citizenNumber: '+2348012345678',
          correlationId: 'cid',
        });
        await settle();
        dg.finalise('when is my appointment');
        await settle();

        expect(spoken[0]).toBe(DEFAULT_WELCOME_MESSAGE);
        expect(spoken).toContain('Your appointment is on Tuesday.');
      });
    });

    /**
     * EVERY ANSWERED CALL HELD A SOCKET AND TWO CODECS FOR EVER.
     *
     * `attach()` returns a session with `stop()`, and the call site discarded
     * it — so `stop()` was unreachable and nothing released a Deepgram
     * WebSocket or the Opus encoder and decoder. A service answering calls
     * all day accumulated them until the process restarted.
     */
    describe('releasing a finished call', () => {
      it('closes Deepgram and frees the codecs when stopped', async () => {
        let closed = 0;
        const dg = makeDeepgram();
        dg.ws.close = () => {
          closed += 1;
        };
        const svc = new WhatsAppCallMediaService({
          createDeepgramWsForOrg: async () => dg.ws,
          fetchTtsPcm24k: async () => null,
        } as any);

        const session = await svc.attach({
          pc: makePc().pc,
          organizationId: `org_absent_${randomBytes(4).toString('hex')}`,
          callId: 'wacid.REL',
          citizenNumber: '+2348012345678',
          correlationId: 'cid',
        });
        await settle();

        await session.stop();
        expect(closed).toBe(1);
      });

      it('is idempotent, because two things race to end a call', async () => {
        // The `terminate` webhook and the connection state both trigger
        // release, and either can arrive first or alone. Stopping twice must
        // not throw on a live call path that never throws.
        //
        // What PROVIDES this is the nulling of the handles, not the `if
        // (stopped) return` guard: mutation-testing showed this test still
        // passes with the guard removed, because `deepgram?.close?.()` on a
        // nulled handle is already a no-op. The guard is kept for clarity and
        // is deliberately not claimed here as the mechanism — a test is only
        // worth what it discriminates.
        let closed = 0;
        const dg = makeDeepgram();
        dg.ws.close = () => {
          closed += 1;
        };
        const svc = new WhatsAppCallMediaService({
          createDeepgramWsForOrg: async () => dg.ws,
          fetchTtsPcm24k: async () => null,
        } as any);

        const session = await svc.attach({
          pc: makePc().pc,
          organizationId: `org_absent_${randomBytes(4).toString('hex')}`,
          callId: 'wacid.REL2',
          citizenNumber: '+2348012345678',
          correlationId: 'cid',
        });
        await settle();

        await session.stop();
        await session.stop();
        await session.stop();
        expect(closed).toBe(1);
      });

      it('stops sending audio once released, rather than into a dead socket', async () => {
        const dg = makeDeepgram();
        const svc = new WhatsAppCallMediaService({
          createDeepgramWsForOrg: async () => dg.ws,
          fetchTtsPcm24k: async () => Buffer.alloc(24000 * 2),
        } as any);
        (svc as any).orchestrator = {
          processIncomingMessage: async () => ({ replyText: 'A long reply.' }),
        };
        const pc = makePc();

        const session = await svc.attach({
          pc: pc.pc,
          organizationId: `org_absent_${randomBytes(4).toString('hex')}`,
          callId: 'wacid.REL3',
          citizenNumber: '+2348012345678',
          correlationId: 'cid',
        });
        await new Promise((r) => setTimeout(r, 60));
        await session.stop();
        const atStop = pc.written.length;
        await new Promise((r) => setTimeout(r, 400));

        // Whatever was mid-flight stops, rather than pacing out a full second
        // of audio to a call that has hung up.
        expect(pc.written.length).toBe(atStop);
      });
    });

    it('survives a connection with no audio transceiver', async () => {
      const svc = new WhatsAppCallMediaService({
        createDeepgramWsForOrg: async () => makeDeepgram().ws,
        fetchTtsPcm24k: async () => null,
      } as any);
      const session = await svc.attach({
        pc: { getTransceivers: () => [] },
        organizationId: 'org',
        callId: 'c',
        citizenNumber: '+1',
        correlationId: 'cid',
      });
      await expect(session.stop()).resolves.toBeUndefined();
    });
  });
});
