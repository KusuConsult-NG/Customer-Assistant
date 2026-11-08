/**
 * Infobip as the carrier — the parts that can be asserted exactly.
 *
 * No real call has run through this. What these tests pin is everything that
 * is decided HERE rather than by Infobip: that a forged event or stream is
 * refused, that the request attaching the AI is exactly the one in Infobip's
 * own tutorial, that a stream naming the AI leg instead of the citizen's call
 * still finds it, and that the audio arithmetic is right — because a wrong
 * sample rate is heard as nonsense and reported as nothing.
 */
import {
  InfobipVoiceService,
  collectIds,
} from '../src/telephony/infobip/infobip-voice.service';
import {
  ttsPlanFor,
  downsample2x,
  frameBytesFor,
  packetise,
} from '../src/telephony/infobip/infobip-media-stream.handler';

const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

const configure = () => {
  setEnv('INFOBIP_BASE_URL', 'https://abc123.api.infobip.com');
  setEnv('INFOBIP_API_KEY', 'ib_test_key_value');
  setEnv('INFOBIP_MEDIA_STREAM_CONFIG_ID', 'msc-0001');
  setEnv('INFOBIP_WEBHOOK_USERNAME', 'plateau');
  setEnv('INFOBIP_WEBHOOK_PASSWORD', 'a-long-shared-secret');
  setEnv('INFOBIP_STREAM_TOKEN', 'stream-token-0123456789');
  // The store must not depend on a Redis this test does not own.
  setEnv('REDIS_URL', undefined);
};

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('Infobip voice', () => {
  describe('webhook authentication', () => {
    it('REFUSES everything when no credentials are configured, rather than accepting', () => {
      // Fail closed. An unauthenticated CALL_RECEIVED would let anybody create
      // contacts and call records in an agency's CRM.
      setEnv('INFOBIP_WEBHOOK_USERNAME', undefined);
      setEnv('INFOBIP_WEBHOOK_PASSWORD', undefined);
      const svc = new InfobipVoiceService();
      expect(svc.verifyWebhook(basic('anyone', 'anything'))).toBe('unconfigured');
      expect(svc.verifyWebhook(undefined)).toBe('unconfigured');
    });

    it('accepts only the exact pair', () => {
      configure();
      const svc = new InfobipVoiceService();
      expect(svc.verifyWebhook(basic('plateau', 'a-long-shared-secret'))).toBe('ok');
      expect(svc.verifyWebhook(basic('plateau', 'wrong'))).toBe('invalid');
      expect(svc.verifyWebhook(basic('someone', 'a-long-shared-secret'))).toBe('invalid');
      expect(svc.verifyWebhook(undefined)).toBe('missing');
      expect(svc.verifyWebhook('Bearer abc')).toBe('invalid');
      expect(svc.verifyWebhook('Basic !!!')).toBe('invalid');
      // A password containing a colon is split at the FIRST one, as Basic
      // auth defines.
      setEnv('INFOBIP_WEBHOOK_PASSWORD', 'pa:ss');
      expect(new InfobipVoiceService().verifyWebhook(basic('plateau', 'pa:ss'))).toBe('ok');
    });
  });

  describe('the media stream token', () => {
    it('is refused when unset, short, missing or wrong', () => {
      setEnv('INFOBIP_STREAM_TOKEN', undefined);
      expect(new InfobipVoiceService().verifyStreamToken('anything')).toBe(false);

      // Shorter than 16 is treated as unset: a short token is a guessable one.
      setEnv('INFOBIP_STREAM_TOKEN', 'short');
      expect(new InfobipVoiceService().verifyStreamToken('short')).toBe(false);

      configure();
      const svc = new InfobipVoiceService();
      expect(svc.verifyStreamToken(undefined)).toBe(false);
      expect(svc.verifyStreamToken('stream-token-012345678X')).toBe(false);
      expect(svc.verifyStreamToken('stream-token-0123456789')).toBe(true);
    });

    it('builds the path the media stream config must point at', () => {
      configure();
      expect(new InfobipVoiceService().streamPathForConfig()).toBe(
        '/telephony/infobip/stream/stream-token-0123456789'
      );
    });
  });

  describe('configuration', () => {
    it('insists on HTTPS, because the API key travels on every request', () => {
      setEnv('INFOBIP_BASE_URL', 'http://abc123.api.infobip.com');
      expect(new InfobipVoiceService().baseUrl()).toBeNull();
      setEnv('INFOBIP_BASE_URL', 'abc123.api.infobip.com/');
      expect(new InfobipVoiceService().baseUrl()).toBe('https://abc123.api.infobip.com');
    });

    it('names every missing piece, and is ready only with all of them', () => {
      for (const k of [
        'INFOBIP_BASE_URL',
        'INFOBIP_API_KEY',
        'INFOBIP_MEDIA_STREAM_CONFIG_ID',
        'INFOBIP_WEBHOOK_USERNAME',
        'INFOBIP_WEBHOOK_PASSWORD',
        'INFOBIP_STREAM_TOKEN',
      ]) {
        setEnv(k, undefined);
      }
      const off = new InfobipVoiceService().readiness();
      expect(off.enabled).toBe(false);
      expect(off.blocked).toHaveLength(5);

      configure();
      const on = new InfobipVoiceService().readiness();
      expect(on.enabled).toBe(true);
      // And never claims a call has worked.
      expect(on.detail).toMatch(/no real call has proven/i);
    });
  });

  describe('attaching the AI', () => {
    it("sends EXACTLY the request in Infobip's own tutorial", async () => {
      configure();
      const sent: any[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: any, init: any) => {
        sent.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: 'dialog-1' }), { status: 200 });
      }) as any;
      try {
        const out = await new InfobipVoiceService().connectToAi('call-parent-1');
        expect(out.ok).toBe(true);
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe('https://abc123.api.infobip.com/calls/1/dialogs');
        expect(sent[0].init.headers.Authorization).toBe('App ib_test_key_value');
        expect(JSON.parse(sent[0].init.body)).toEqual({
          parentCallId: 'call-parent-1',
          childCallRequest: { endpoint: { type: 'WEBSOCKET', websocketEndpointConfigId: 'msc-0001' } },
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("quotes Infobip's refusal rather than saying it failed", async () => {
      configure();
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ requestError: { serviceException: { text: 'Invalid websocket endpoint config' } } }),
          { status: 400 }
        )) as any;
      try {
        const out = await new InfobipVoiceService().connectToAi('call-parent-1');
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.error).toMatch(/Invalid websocket endpoint config/);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('says the refusal had no body rather than reporting an empty reason', async () => {
      configure();
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response('', { status: 502 })) as any;
      try {
        const out = await new InfobipVoiceService().connectToAi('call-parent-1');
        if (!out.ok) expect(out.error).toMatch(/HTTP 502.*no body/);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  describe('finding the call a stream belongs to', () => {
    /**
     * Unconfirmed against a real call: whether the stream's `callId` is the
     * citizen's call or the AI leg's. So every id in the create-dialog
     * response is recorded as an alias — without needing to know which field
     * holds the AI leg's id, which nothing this was built from documents.
     */
    it('finds the call by its own id', async () => {
      configure();
      const svc = new InfobipVoiceService();
      await svc.remember({ parentCallId: 'parent-aaaa-1111', organizationId: 'org1', fromNumber: '+2348031111111', toNumber: '+2348000000000' });
      expect((await svc.resolve('parent-aaaa-1111'))?.organizationId).toBe('org1');
    });

    it('finds it by ANY id the dialog response carried, wherever that id sat', async () => {
      configure();
      const svc = new InfobipVoiceService();
      await svc.remember({ parentCallId: 'parent-bbbb-2222', organizationId: 'org2', fromNumber: '+2348031111111', toNumber: '+2348000000000' });
      const dialogResponse = {
        id: 'dialog-cccc-3333',
        state: 'CREATED',
        parentCall: { id: 'parent-bbbb-2222' },
        childCall: { id: 'child-dddd-4444', endpoint: { type: 'WEBSOCKET' } },
      };
      await svc.aliasAll(dialogResponse, 'parent-bbbb-2222');

      expect((await svc.resolve('child-dddd-4444'))?.parentCallId).toBe('parent-bbbb-2222');
      expect((await svc.resolve('dialog-cccc-3333'))?.parentCallId).toBe('parent-bbbb-2222');
      // A state word is not an id and is never aliased.
      expect(await svc.resolve('CREATED')).toBeNull();
    });

    it('refuses an id nobody recorded', async () => {
      configure();
      expect(await new InfobipVoiceService().resolve('nobody-knows-this-9999')).toBeNull();
    });

    it('stops resolving once the call is forgotten', async () => {
      configure();
      const svc = new InfobipVoiceService();
      await svc.remember({ parentCallId: 'parent-eeee-5555', organizationId: 'org3', fromNumber: '+2348031111111', toNumber: '+2348000000000' });
      await svc.forget('parent-eeee-5555');
      expect(await svc.resolve('parent-eeee-5555')).toBeNull();
    });

    it('collects ids but not words, and stays bounded', () => {
      const ids = collectIds({ a: 'abc-123-def', b: 'ESTABLISHED', c: ['x1y2z3w4v5'], d: 'has space 123' });
      expect([...ids].sort()).toEqual(['abc-123-def', 'x1y2z3w4v5']);
      const many = Array.from({ length: 200 }, (_, i) => `id-${i}-0000000`);
      expect(collectIds(many).size).toBeLessThanOrEqual(40);
    });
  });

  describe('the audio arithmetic', () => {
    it('reaches every supported rate from a rate ElevenLabs actually offers, by an exact factor', () => {
      expect(ttsPlanFor(8000)).toEqual({ ttsRate: 16000, resample: 'down2' });
      expect(ttsPlanFor(16000)).toEqual({ ttsRate: 16000, resample: 'none' });
      expect(ttsPlanFor(24000)).toEqual({ ttsRate: 24000, resample: 'none' });
      expect(ttsPlanFor(48000)).toEqual({ ttsRate: 24000, resample: 'up2' });
    });

    it('refuses a rate it cannot reach exactly, rather than guessing', () => {
      // A fractional resample done wrong is heard as a robotic voice and
      // reported as nothing.
      for (const r of [11025, 22050, 44100, 32000, 0, NaN]) expect(ttsPlanFor(r)).toBeNull();
    });

    it('halves the rate by averaging pairs, not by dropping every other sample', () => {
      const pcm = Buffer.alloc(8);
      [100, 300, -200, 400].forEach((v, i) => pcm.writeInt16LE(v, i * 2));
      const out = downsample2x(pcm);
      expect(out.length).toBe(4);
      expect(out.readInt16LE(0)).toBe(200);
      expect(out.readInt16LE(2)).toBe(100);
    });

    it('cannot overflow on two loud samples', () => {
      const pcm = Buffer.alloc(4);
      pcm.writeInt16LE(32767, 0);
      pcm.writeInt16LE(32767, 2);
      expect(downsample2x(pcm).readInt16LE(0)).toBe(32767);
    });

    it('frames to the packetization Infobip announced', () => {
      // 16 kHz × 20 ms = 320 samples = 640 bytes.
      expect(frameBytesFor(16000, 20)).toBe(640);
      expect(frameBytesFor(48000, 20)).toBe(1920);
      expect(frameBytesFor(8000, 20)).toBe(320);
    });

    it('pads the last packet with silence instead of clipping the last word', () => {
      const frames = packetise(Buffer.alloc(1000, 1), 640);
      expect(frames).toHaveLength(2);
      expect(frames[1].length).toBe(640);
      // The real audio, then zeros.
      expect(frames[1].readUInt8(359)).toBe(1);
      expect(frames[1].readUInt8(360)).toBe(0);
    });
  });
});
