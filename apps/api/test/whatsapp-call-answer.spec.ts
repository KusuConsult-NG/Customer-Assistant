import { WhatsAppCallAnswerService } from '../src/whatsapp/whatsapp-call-answer.service';

/**
 * Answering a WhatsApp call — the signalling half.
 *
 * What is proven here: the gate that decides whether answering is available,
 * the SDP answer a real WebRTC stack produces from Meta's offer, the request
 * sent to Meta, and every refusal. What is NOT proven anywhere is the media:
 * a sandbox cannot allocate a TURN relay, place a WhatsApp call, or carry
 * audio, so the end-to-end path has never run. That is stated in the service's
 * own header and the first real call is the test.
 *
 * The property that matters most is the one these tests exist to defend:
 * **answering must never happen unless media can actually reach us.** An
 * answered call with no route consumes the citizen's call, reports completed
 * at the carrier, and suppresses the message fallback — strictly worse than
 * not answering. So every path that cannot carry audio has to decline.
 */
describe('Answering a WhatsApp call', () => {
  // The real-stack tests wait out the bounded ICE gathering (4s each) because
  // no relay answers in a sandbox — that wait IS the behaviour under test.
  jest.setTimeout(60000);

  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const realFetch = globalThis.fetch;

  /** An audio-only Opus offer of the shape Meta sends on `connect`. */
  const OFFER = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:aBcD',
    'a=ice-pwd:0123456789abcdef0123456789',
    'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    '',
  ].join('\r\n');

  const CALL = {
    callId: 'wacid.TEST123',
    phoneNumberId: 'pn_test',
    sdp: OFFER,
    organizationId: 'org_test',
    citizenNumber: '+2348012345678',
  };

  /** Records what the media bridge was asked to carry. */
  let attached: any[];
  const fakeMedia: any = {
    attach: async (p: any) => {
      attached.push(p);
      return { stop: async () => {} };
    },
  };
  /** Stands in for the live werift connection the bridge would receive. */
  const fakePc = { __live: true, close: async () => {} };

  const turnOn = () => {
    setEnv('WHATSAPP_CALL_ANSWER', '1');
    setEnv('TURN_URL', 'turn:relay.example.test:3478');
    setEnv('TURN_USERNAME', 'relay-user');
    setEnv('TURN_CREDENTIAL', 'relay-secret');
  };

  /**
   * A service whose negotiation is stubbed, so the branches AFTER it are
   * reachable. Without this the only outcome a sandbox can produce is "no
   * relay allocated", and Meta's refusals would be untested.
   */
  class StubbedNegotiation extends WhatsAppCallAnswerService {
    constructor(
      private readonly result: { sdp: string; pc?: any } | { error: string },
      media: any = fakeMedia
    ) {
      super(media);
    }
    protected async negotiate(): Promise<{ sdp: string; pc?: any } | { error: string }> {
      return this.result;
    }
  }

  /** An answer SDP carrying a relay candidate — what a working TURN gives. */
  const withRelay = [
    'v=0',
    'm=audio 54321 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=candidate:1 1 UDP 2130706431 10.0.0.5 54321 typ host',
    'a=candidate:2 1 UDP 1685987071 203.0.113.9 54321 typ relay raddr 10.0.0.5 rport 54321',
    '',
  ].join('\r\n');

  /** The same, but TURN never allocated: host only. */
  const hostOnly = [
    'v=0',
    'm=audio 54321 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=candidate:1 1 UDP 2130706431 10.0.0.5 54321 typ host',
    '',
  ].join('\r\n');

  let posted: Array<{ url: string; body: any }>;

  beforeEach(() => {
    posted = [];
    attached = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      posted.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response('{}', { status: 200 });
    }) as any;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('whether answering is available at all', () => {
    it('is OFF when the flag is unset, however good the relay', () => {
      setEnv('WHATSAPP_CALL_ANSWER', undefined);
      setEnv('TURN_URL', 'turn:relay.example.test:3478');
      setEnv('TURN_USERNAME', 'u');
      setEnv('TURN_CREDENTIAL', 'p');

      const r = new WhatsAppCallAnswerService(fakeMedia).readiness();
      expect(r.enabled).toBe(false);
      expect(r.blocked.join(' ')).toMatch(/WHATSAPP_CALL_ANSWER/);
    });

    it('is OFF without a TURN relay, even with the flag set', () => {
      setEnv('WHATSAPP_CALL_ANSWER', '1');
      setEnv('TURN_URL', undefined);
      setEnv('TURN_USERNAME', undefined);
      setEnv('TURN_CREDENTIAL', undefined);

      const r = new WhatsAppCallAnswerService(fakeMedia).readiness();
      // The flag alone must not switch this on. WebRTC media is UDP and this
      // deployment has no inbound UDP, so answering without a relay produces a
      // connected call with no audio.
      expect(r.enabled).toBe(false);
      expect(r.blocked.join(' ')).toMatch(/TURN/);
      expect(r.blocked.join(' ')).toMatch(/worse than not answering/i);
    });

    it('treats a half-specified relay as none', () => {
      setEnv('WHATSAPP_CALL_ANSWER', '1');
      setEnv('TURN_URL', 'turn:relay.example.test:3478');
      setEnv('TURN_USERNAME', 'u');
      setEnv('TURN_CREDENTIAL', undefined);

      // A relay URL with no credential fails the allocation at call time,
      // which reads as a media bug rather than a missing secret.
      expect(new WhatsAppCallAnswerService(fakeMedia).readiness().enabled).toBe(false);
    });

    it('is ON with both, and says the path is unproven', () => {
      turnOn();
      const r = new WhatsAppCallAnswerService(fakeMedia).readiness();
      expect(r.enabled).toBe(true);
      expect(r.blocked).toEqual([]);
      // No real call has gone through this. The report must not imply it has.
      expect(r.detail).toMatch(/no real call has proven this path/i);
    });
  });

  /**
   * Minting a relay from Twilio's Network Traversal Service, so a deployment
   * does not have to run coturn to switch this on. Ephemeral by design: the
   * tokens expire, which is exactly why static env vars could not express them.
   */
  describe('ephemeral relay credentials', () => {
    const NTS = {
      username: 'ntsuser',
      password: 'ntspass',
      ttl: '86400',
      ice_servers: [
        // Bare STUN: no credential, and it cannot relay.
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: 'turn:global.turn.twilio.com:3478?transport=udp', username: 'ntsuser', credential: 'ntspass' },
        { urls: 'turn:global.turn.twilio.com:443?transport=tcp', username: 'ntsuser', credential: 'ntspass' },
      ],
    };

    const twilioMode = () => {
      setEnv('WHATSAPP_CALL_ANSWER', '1');
      setEnv('TURN_URL', undefined);
      setEnv('TURN_USERNAME', undefined);
      setEnv('TURN_CREDENTIAL', undefined);
      setEnv('TURN_PROVIDER', 'twilio');
      setEnv('TWILIO_ACCOUNT_SID', 'ACtest');
      setEnv('TWILIO_AUTH_TOKEN', 'tok');
    };

    afterEach(() => setEnv('TURN_PROVIDER', undefined));

    it('is enabled by TURN_PROVIDER alone, with no TURN_URL', () => {
      twilioMode();
      const r = new WhatsAppCallAnswerService(fakeMedia).readiness();
      expect(r.enabled).toBe(true);
      expect(r.detail).toMatch(/Network Traversal Service/);
    });

    it('is blocked when the Twilio account credentials are missing', () => {
      twilioMode();
      setEnv('TWILIO_AUTH_TOKEN', undefined);
      const r = new WhatsAppCallAnswerService(fakeMedia).readiness();
      expect(r.enabled).toBe(false);
      expect(r.blocked.join(' ')).toMatch(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
    });

    it('mints a token and offers every TURN url, dropping bare STUN', async () => {
      twilioMode();
      const seen: any[] = [];
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes('/Tokens.json')) {
          seen.push({ url, auth: String((init?.headers ?? {}).Authorization ?? '') });
          return new Response(JSON.stringify(NTS), { status: 200 });
        }
        posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response('{}', { status: 200 });
      }) as any;

      const svc = new WhatsAppCallAnswerService(fakeMedia);
      const ice = await (svc as any).iceServers();

      expect(seen).toHaveLength(1);
      expect(seen[0].url).toContain('/Accounts/ACtest/Tokens.json');
      expect(seen[0].auth).toMatch(/^Basic /);
      // Both TURN urls — the TCP/443 one is what gets through a network that
      // blocks UDP egress, which is a phone on a restrictive mobile network.
      expect(ice.map((s: any) => s.urls)).toEqual([
        'turn:global.turn.twilio.com:3478?transport=udp',
        'turn:global.turn.twilio.com:443?transport=tcp',
      ]);
      // STUN discovers an address; it does not relay. Keeping it would let ICE
      // "succeed" with a srflx candidate Meta still cannot reach.
      expect(ice.some((s: any) => String(s.urls).startsWith('stun:'))).toBe(false);
    });

    it('caches the token rather than minting one per call', async () => {
      twilioMode();
      let mints = 0;
      globalThis.fetch = (async (input: any) => {
        if (String(input).includes('/Tokens.json')) {
          mints++;
          return new Response(JSON.stringify(NTS), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }) as any;

      const svc = new WhatsAppCallAnswerService(fakeMedia);
      await (svc as any).iceServers();
      await (svc as any).iceServers();
      await (svc as any).iceServers();
      // Meta drops an unanswered call quickly, so a round trip per call is
      // latency on the one path that cannot afford it.
      expect(mints).toBe(1);
    });

    it('declines rather than answering when Twilio refuses the token', async () => {
      twilioMode();
      globalThis.fetch = (async (input: any) => {
        if (String(input).includes('/Tokens.json')) {
          return new Response('{"message":"Authenticate"}', { status: 401 });
        }
        return new Response('{}', { status: 200 });
      }) as any;

      const out = await new WhatsAppCallAnswerService(fakeMedia).answer(CALL, 'TOKEN', 'cid');
      expect(out.answered).toBe(false);
      if (!out.answered) {
        // An attempt that failed, not "switched off" — the distinction the
        // thread note shows staff.
        expect(out.blocked).toBe(false);
        expect(out.reason).toMatch(/could not be obtained/i);
      }
      expect(posted).toEqual([]);
    });

    it('declines when Twilio returns only STUN', async () => {
      twilioMode();
      globalThis.fetch = (async (input: any) => {
        if (String(input).includes('/Tokens.json')) {
          return new Response(
            JSON.stringify({ ttl: '3600', ice_servers: [{ urls: 'stun:global.stun.twilio.com:3478' }] }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }) as any;

      const out = await new WhatsAppCallAnswerService(fakeMedia).answer(CALL, 'TOKEN', 'cid');
      // A token with no relay in it is not a relay, however healthy the 200.
      expect(out.answered).toBe(false);
      expect(posted).toEqual([]);
    });
  });

  describe('declining, so the message fallback still runs', () => {
    it('does not touch Meta when answering is switched off', async () => {
      setEnv('WHATSAPP_CALL_ANSWER', undefined);
      const out = await new WhatsAppCallAnswerService(fakeMedia).answer(CALL, 'TOKEN', 'cid');

      expect(out.answered).toBe(false);
      expect(out).toHaveProperty('blocked', true);
      // `blocked` is what lets the caller say "not configured" rather than
      // "we tried and failed".
      expect(posted).toEqual([]);
    });

    it('declines when the connect event carried no offer', async () => {
      turnOn();
      const out = await new WhatsAppCallAnswerService(fakeMedia).answer({ ...CALL, sdp: '' }, 'TOKEN', 'cid');

      expect(out.answered).toBe(false);
      expect(out).toHaveProperty('blocked', false);
      if (!out.answered) expect(out.reason).toMatch(/no SDP offer/i);
      // Accepting with a made-up answer would take a call we cannot carry.
      expect(posted).toEqual([]);
    });

    it('DECLINES when TURN did not allocate, rather than answering into silence', async () => {
      turnOn();
      const out = await new StubbedNegotiation({ sdp: hostOnly }).answer(CALL, 'TOKEN', 'cid');

      expect(out.answered).toBe(false);
      if (!out.answered) {
        expect(out.reason).toMatch(/TURN relay did not allocate/i);
        expect(out.reason).toMatch(/host candidate/i);
        expect(out.reason).toMatch(/still gets a reply/i);
      }
      // This is the whole point: a host candidate is this pod's private
      // address, useless to Meta. Answering on it would consume the call and
      // suppress the fallback.
      expect(posted).toEqual([]);
    });

    it('reports a negotiation failure in its own words', async () => {
      turnOn();
      const out = await new StubbedNegotiation({ error: 'DTLS role could not be agreed' }).answer(
        CALL,
        'TOKEN',
        'cid'
      );
      expect(out.answered).toBe(false);
      if (!out.answered) expect(out.reason).toMatch(/DTLS role/);
      expect(posted).toEqual([]);
    });

    it("quotes Meta's refusal rather than paraphrasing it", async () => {
      turnOn();
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'Calling is not enabled for this number' } }), {
          status: 400,
        })) as any;

      const out = await new StubbedNegotiation({ sdp: withRelay, pc: fakePc }).answer(CALL, 'TOKEN', 'cid');
      expect(out.answered).toBe(false);
      if (!out.answered) {
        expect(out.reason).toMatch(/Meta refused the answer \(HTTP 400\)/);
        expect(out.reason).toMatch(/Calling is not enabled for this number/);
      }
    });

    it('reports a network failure as unreachable, not as a refusal', async () => {
      turnOn();
      globalThis.fetch = (async () => {
        throw new Error('ECONNRESET');
      }) as any;

      const out = await new StubbedNegotiation({ sdp: withRelay, pc: fakePc }).answer(CALL, 'TOKEN', 'cid');
      expect(out.answered).toBe(false);
      // "Could not reach" and "refused" send an operator to different places.
      if (!out.answered) expect(out.reason).toMatch(/Could not reach Meta/i);
    });
  });

  describe('accepting the call', () => {
    it('sends Meta an accept carrying the SDP answer', async () => {
      turnOn();
      const out = await new StubbedNegotiation({ sdp: withRelay, pc: fakePc }).answer(CALL, 'TOKEN', 'cid');

      expect(out.answered).toBe(true);
      expect(posted).toHaveLength(1);
      expect(posted[0].url).toContain('/pn_test/calls');
      expect(posted[0].body).toMatchObject({
        messaging_product: 'whatsapp',
        call_id: 'wacid.TEST123',
        action: 'accept',
        session: { sdp_type: 'answer', sdp: withRelay },
      });
    });

    it('hands the live connection to the media bridge', async () => {
      turnOn();
      const out = await new StubbedNegotiation({ sdp: withRelay, pc: fakePc }).answer(CALL, 'TOKEN', 'cid');

      expect(out.answered).toBe(true);
      // Audio only exists if this happened, and it must get the tenant and the
      // caller — the orchestrator runs against both.
      expect(attached).toHaveLength(1);
      expect(attached[0].pc).toBe(fakePc);
      expect(attached[0].organizationId).toBe('org_test');
      expect(attached[0].citizenNumber).toBe('+2348012345678');
      expect(attached[0].callId).toBe('wacid.TEST123');
    });

    it('does NOT report answered when no media bridge is wired', async () => {
      turnOn();
      // Meta would already have been told to accept, so claiming success here
      // leaves a connected call with nobody speaking. That is a wiring fault
      // and it is reported as a failure rather than shrugged off.
      // `null`, not `undefined`: a default parameter still applies to
      // undefined, so passing that would quietly hand it the working fake and
      // the test would assert nothing.
      const out = await new StubbedNegotiation({ sdp: withRelay, pc: fakePc }, null).answer(
        CALL,
        'TOKEN',
        'cid'
      );
      expect(out.answered).toBe(false);
      if (!out.answered) expect(out.reason).toMatch(/no media bridge/i);
    });

    it('closes the connection on every path that does not answer', async () => {
      turnOn();
      let closed = 0;
      const pc = { close: async () => { closed++; } };

      // Relay missing.
      await new StubbedNegotiation({ sdp: hostOnly, pc }).answer(CALL, 'TOKEN', 'cid');
      expect(closed).toBe(1);

      // Meta refuses.
      globalThis.fetch = (async () => new Response('nope', { status: 400 })) as any;
      await new StubbedNegotiation({ sdp: withRelay, pc }).answer(CALL, 'TOKEN', 'cid');
      // A declined call must not leak a live WebRTC session and its sockets.
      expect(closed).toBe(2);
    });

    it('terminates best-effort without throwing', async () => {
      turnOn();
      const svc = new WhatsAppCallAnswerService(fakeMedia);
      await expect(svc.terminate({ callId: 'wacid.X', phoneNumberId: 'pn_test' }, 'TOKEN')).resolves.toBe(true);
      expect(posted[0].body).toMatchObject({ call_id: 'wacid.X', action: 'terminate' });

      globalThis.fetch = (async () => {
        throw new Error('down');
      }) as any;
      // A failed hang-up leaves Meta to time the call out — untidy, but not a
      // lie, and not worth throwing into a webhook that already ACKed.
      await expect(svc.terminate({ callId: 'wacid.Y', phoneNumberId: 'pn_test' }, 'TOKEN')).resolves.toBe(false);
    });
  });

  /**
   * The real WebRTC stack, unstubbed. This is the one place the library itself
   * is exercised, and it is why `werift` is a dependency rather than a plan.
   */
  describe('the SDP answer a real stack produces', () => {
    it("answers Meta's Opus offer with a usable answer", async () => {
      turnOn();
      const svc = new WhatsAppCallAnswerService(fakeMedia);
      // A LIST, because Twilio hands back TURN over UDP 3478 and over TCP 443
      // and the second is what gets through a network blocking UDP egress.
      const negotiated = await (svc as any).negotiate(OFFER, [
        { urls: 'turn:relay.example.test:3478', username: 'u', credential: 'p' },
      ]);

      expect(negotiated).toHaveProperty('sdp');
      const sdp: string = (negotiated as any).sdp;
      // Opus comes back from the REMOTE description, so the answer tracks
      // whatever Meta asked for instead of a hard-coded payload type.
      expect(sdp).toMatch(/opus\/48000/);
      // DTLS is what makes SRTP possible; without a fingerprint there is no
      // handshake and no media.
      expect(sdp).toMatch(/a=fingerprint:sha-256/);
      expect(sdp).toMatch(/a=setup:(active|passive)/);
    });

    it('gathers no relay in a sandbox, which is exactly why answering declines here', async () => {
      turnOn();
      const svc = new WhatsAppCallAnswerService(fakeMedia);
      const negotiated: any = await (svc as any).negotiate(OFFER, [
        { urls: 'turn:relay.example.test:3478', username: 'u', credential: 'p' },
      ]);

      // No reachable relay exists for this test, so the answer carries no
      // `typ relay`. Pinning it documents why the end-to-end path is unproven
      // and proves the decline above is reached by the real stack too, not
      // only by the stub.
      expect(/typ relay/.test(negotiated.sdp ?? '')).toBe(false);

      const out = await svc.answer(CALL, 'TOKEN', 'cid');
      expect(out.answered).toBe(false);
      expect(posted).toEqual([]);
    });
  });
});
