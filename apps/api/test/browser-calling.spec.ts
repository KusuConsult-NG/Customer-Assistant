/**
 * Answering a citizen's call in the dashboard.
 *
 * ── The property that matters most ──────────────────────────────────────────
 *
 * NOT TAKING THIS PATH MUST BE IDENTICAL TO BEFORE IT EXISTED.
 *
 * Every deployment that has not switched browser answering on — which is all
 * of them until somebody sets four Twilio variables — must get exactly the AI
 * TwiML it got before. So must an agency with no officers, and so must a call
 * nobody picks up. A feature that quietly changes what happens to a call on a
 * deployment that did not ask for it is worse than one that does not work.
 */
import { BrowserCallingService, clientIdentityFor, userIdFromIdentity, RING_SECONDS } from '../src/telephony/browser-calling.service';

describe('browser calling', () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const configure = () => {
    setEnv('TWILIO_ACCOUNT_SID', 'AC' + '0'.repeat(32));
    setEnv('TWILIO_API_KEY_SID', 'SK' + '1'.repeat(32));
    setEnv('TWILIO_API_KEY_SECRET', 'a'.repeat(32));
    setEnv('TWILIO_TWIML_APP_SID', 'AP' + '2'.repeat(32));
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const service = () => new BrowserCallingService();

  describe('readiness', () => {
    it('is OFF with nothing configured, and that is not an error', () => {
      for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID']) {
        setEnv(k, undefined);
      }
      const r = service().readiness();
      expect(r.enabled).toBe(false);
      expect(r.blocked.length).toBeGreaterThan(0);
    });

    it('names the API KEY as distinct from the Account SID and Auth Token', () => {
      // The single most likely setup mistake: an API Key SID is created in
      // the Twilio console and is neither of the two credentials this
      // platform already stores.
      setEnv('TWILIO_ACCOUNT_SID', 'AC' + '0'.repeat(32));
      setEnv('TWILIO_API_KEY_SID', undefined);
      const detail = service().readiness().blocked.join(' ');
      expect(detail).toMatch(/SK/);
      expect(detail).toMatch(/NOT the Account SID/i);
    });

    it('is enabled only when every credential is present', () => {
      configure();
      const r = service().readiness();
      expect(r.enabled).toBe(true);
      expect(r.blocked).toEqual([]);
      // And it does not claim a call has ever worked.
      expect(r.detail).toMatch(/no real call has proven/i);
    });
  });

  describe('the access token', () => {
    it('is null when not configured, never a token that cannot work', () => {
      setEnv('TWILIO_API_KEY_SECRET', undefined);
      expect(service().accessTokenFor('user_1')).toBeNull();
    });

    it('carries the officer identity derived from their id', () => {
      configure();
      const minted = service().accessTokenFor('abc-123');
      expect(minted).toBeTruthy();
      expect(minted!.identity).toBe('officer_abc-123');

      // A real JWT with the grant Twilio needs to RING this browser.
      const [, payloadB64] = minted!.token.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
      expect(payload.grants?.voice?.incoming?.allow).toBe(true);
      expect(payload.grants?.identity).toBe('officer_abc-123');
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('puts no email or name in the identity', () => {
      // An identity travels into TwiML and Twilio's logs. A staff address
      // does not belong in either.
      expect(clientIdentityFor('user_1')).not.toMatch(/@/);
      expect(clientIdentityFor('a b/c@d')).toBe('officer_abcd');
    });

    it('round-trips an identity back to a user id', () => {
      expect(userIdFromIdentity(clientIdentityFor('abc-123'))).toBe('abc-123');
      expect(userIdFromIdentity('something_else')).toBeNull();
      expect(userIdFromIdentity(undefined)).toBeNull();
    });
  });

  describe('the dial TwiML', () => {
    it('rings every officer at once, and hands the call on when they do not answer', () => {
      const xml = service().dialOfficersTwiml(
        ['officer_a', 'officer_b'],
        'https://api.test/api/telephony/inbound/twilio/after-officers?orgId=o1',
        '+2348031111111'
      );

      expect(xml).toContain('<Client>officer_a</Client>');
      expect(xml).toContain('<Client>officer_b</Client>');
      expect(xml).toContain(`timeout="${RING_SECONDS}"`);
      // Without `action` there is no fallback and an unanswered call simply
      // ends — which is the whole feature failing silently.
      expect(xml).toContain('action="https://api.test/api/telephony/inbound/twilio/after-officers?orgId=o1"');
      // Without `answerOnBridge` Twilio answers immediately and the citizen
      // hears silence while the browsers ring.
      expect(xml).toContain('answerOnBridge="true"');
    });

    it("shows the citizen's number to the officer, not the agency's", () => {
      const xml = service().dialOfficersTwiml(['officer_a'], 'https://api.test/x', '+2348031111111');
      expect(xml).toContain('callerId="+2348031111111"');
    });

    it('escapes what it puts in the XML', () => {
      const xml = service().dialOfficersTwiml(['officer_a'], 'https://api.test/x?a=1&b=2');
      expect(xml).toContain('&amp;');
      expect(xml).not.toContain('?a=1&b=2"');
    });
  });
});
