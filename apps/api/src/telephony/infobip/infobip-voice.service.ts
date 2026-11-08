/**
 * A toll-free (or any) number carried by Infobip, answered by THIS platform's AI.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 *   citizen dials ─▶ carrier ─(SIP, bring-your-own-carrier)─▶ Infobip
 *     Infobip ─ CALL_RECEIVED ─▶ POST /api/telephony/inbound/infobip   (this)
 *     this    ─ POST /calls/1/dialogs {parent: call, child: WEBSOCKET} ─▶ Infobip
 *     Infobip ─ WebSocket ─▶ /telephony/infobip/stream/<token>          (the bridge)
 *     bridge  ◀─ 16-bit PCM ─▶ Deepgram · orchestrator · ElevenLabs
 *
 * The AI that answers is the platform's own — the same knowledge base, the
 * same name/address/callback intake and the same records as every other
 * channel. Infobip is the carrier and, later, the way an officer's browser
 * joins a call. That is the opposite of the `SIP_TRUNK` route, which hands the
 * call to the hosted agent where no person can ever take it over.
 *
 * ── What is established, and from where ─────────────────────────────────────
 *
 * Everything here that touches Infobip follows Infobip's OWN reference code,
 * not a search summary:
 *
 *   - `infobip-elevenlab-conversational-integration-tutorial`: CALL_RECEIVED
 *     carries `callId`; a dialog with a `WEBSOCKET` child attaches the AI; the
 *     media stream config is created with a `sampleRate`; `{"action":"clear"}`
 *     flushes playback; auth is `Authorization: App <key>`.
 *   - `infobip-calls-showcase`: the event shape — `properties.call.from`,
 *     `.to`, `.direction`; `CALL_FINISHED`/`CALL_FAILED` with `properties.callLog`;
 *     `/calls/1/calls/{id}/hangup`.
 *   - `infobip-media-stream-showcase`: the first WebSocket message is JSON
 *     `{callId, sampleRate, packetizationTime}`, then raw little-endian 16-bit
 *     PCM.
 *
 * ── What is NOT established, and how this copes ─────────────────────────────
 *
 * NO REAL CALL HAS RUN THROUGH THIS. Two things in particular are unconfirmed:
 *
 *   1. Whether the stream's `callId` is the CITIZEN's call or the AI leg's. The
 *      context is stored under the citizen's call id, and every id-shaped value
 *      in the create-dialog response and in later events is recorded as an
 *      alias for it. If a stream still arrives with an id nobody recognises it
 *      is REFUSED — routing one citizen's audio into another's conversation is
 *      worse than a dropped call — and the log says exactly what arrived, so
 *      the first real call tells us instead of failing silently.
 *   2. How Infobip signs webhooks. Its docs offer Basic, HMAC and OAuth on a
 *      notification profile, and only Basic is described in usable detail, so
 *      Basic is what this verifies. Fail CLOSED: with no credentials
 *      configured every event is refused, because an unauthenticated
 *      CALL_RECEIVED would let anyone create contacts and call records.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { createClient } from 'redis';
import { AceLogger } from '../../config/logger';

const log = new AceLogger('InfobipVoice');

/** How long a call's context is kept. Longer than any call this line serves. */
const CONTEXT_TTL_SECONDS = 2 * 60 * 60;

/**
 * Why a promised callback on an Infobip line is not dialled automatically.
 *
 * Shown to the officer pressing "Call now" and stored nowhere else: on an
 * Infobip line the officer IS the dialler, from the Callback Queue, and this
 * says so instead of a carrier error about credentials nobody is meant to set.
 */
export const INFOBIP_OUTBOUND_REASON =
  "This agency's line is on Infobip. Callbacks on it are placed by an officer from the " +
  'dashboard: use "Call from browser" on the Callback Queue. The automatic dialler does not ' +
  'place Infobip calls.';

/** What the bridge needs to know about the citizen's call. */
export interface InfobipCallContext {
  parentCallId: string;
  organizationId: string;
  /** Canonical E.164, or the raw value when it is not a recognisable number. */
  fromNumber: string;
  toNumber: string;
  callLogId?: string;
  contactId?: string | null;
  /**
   * Where a caller asking for a person is put through, read from the line at
   * CALL_RECEIVED and carried here.
   *
   * On the context rather than fetched when the handoff happens: the citizen
   * is mid-sentence at that point, and a database round trip that fails leaves
   * them in silence. Absent or null means the line has no officer to reach,
   * which is a reason to file a ticket — never a reason to say "connecting
   * you" and hope.
   */
  forwardingNumber?: string | null;
}

export interface InfobipReadiness {
  enabled: boolean;
  blocked: string[];
  detail: string;
}

/**
 * Every id-shaped string anywhere in a value, bounded.
 *
 * Used to record aliases from a create-dialog response and from events
 * WITHOUT knowing which field holds the AI leg's call id — that field name is
 * not documented anywhere this was built from, and guessing it wrong would be
 * a stream that can never find its call. Recording every id-shaped value is
 * harmless: each alias only ever points at the call that produced it.
 */
export function collectIds(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (out.size >= 40 || depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    // An id, not a state word: long enough, and carrying a digit or a dash.
    if (value.length >= 8 && value.length <= 120 && /[0-9-]/.test(value) && !/\s/.test(value)) {
      out.add(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectIds(v, out, depth + 1);
  }
  return out;
}

/** Constant-time string comparison that does not leak length through an exception. */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still compare something of the expected length, so a length mismatch is
    // not observably faster than a content mismatch.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

@Injectable()
export class InfobipVoiceService implements OnModuleDestroy {
  /** In-memory fallback for the context store, and the whole store without Redis. */
  private readonly memory = new Map<string, { value: string; expiresAt: number }>();
  private redis: ReturnType<typeof createClient> | null = null;
  private redisConnecting: Promise<boolean> | null = null;

  // ── Configuration ────────────────────────────────────────────────────────

  /** `https://<your-subdomain>.api.infobip.com`, no trailing slash. */
  baseUrl(): string | null {
    const raw = process.env.INFOBIP_BASE_URL?.trim().replace(/\/+$/, '');
    if (!raw) return null;
    // Accept the bare host Infobip shows on the portal, and insist on HTTPS:
    // the API key travels in a header on every request.
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(withScheme);
      if (u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }

  readiness(): InfobipReadiness {
    const blocked: string[] = [];
    if (!this.baseUrl()) {
      blocked.push(
        'INFOBIP_BASE_URL is not set to an https URL. It is your personal API base URL from the Infobip ' +
          'portal, e.g. https://xxxxx.api.infobip.com.'
      );
    }
    if (!process.env.INFOBIP_API_KEY?.trim()) {
      blocked.push('INFOBIP_API_KEY is not set. Create one in the Infobip portal with the calls:traffic:send scope.');
    }
    if (!process.env.INFOBIP_MEDIA_STREAM_CONFIG_ID?.trim()) {
      blocked.push(
        'INFOBIP_MEDIA_STREAM_CONFIG_ID is not set. It is the id Infobip returns when the WebSocket media ' +
          'stream configuration is created, pointing at this platform.'
      );
    }
    if (!this.webhookCredentials()) {
      blocked.push(
        'INFOBIP_WEBHOOK_USERNAME and INFOBIP_WEBHOOK_PASSWORD are not both set, so call events cannot be ' +
          'authenticated and every one is refused. Set the same pair as Basic authentication on the ' +
          'Infobip notification profile.'
      );
    }
    if (!this.streamToken()) {
      blocked.push(
        'INFOBIP_STREAM_TOKEN is not set (16+ characters), so the media stream cannot be authenticated and ' +
          'every connection is refused. It goes at the end of the WebSocket URL on the media stream config.'
      );
    }
    return {
      enabled: blocked.length === 0,
      blocked,
      detail:
        blocked.length === 0
          ? 'Inbound calls on Infobip numbers are answered by this platform’s AI. No real call has ' +
            'proven this path yet — treat the first one as the test.'
          : blocked.join(' '),
    };
  }

  private webhookCredentials(): { username: string; password: string } | null {
    const username = process.env.INFOBIP_WEBHOOK_USERNAME?.trim();
    const password = process.env.INFOBIP_WEBHOOK_PASSWORD?.trim();
    return username && password ? { username, password } : null;
  }

  /**
   * The secret that must end the media stream URL.
   *
   * Infobip documents no authentication for the media stream WebSocket, and
   * without one anybody who learned the URL could open a stream, claim a call
   * id and speak to — or listen to — the AI on a citizen's call. So the URL
   * configured on Infobip's side carries a token only this deployment and
   * Infobip know, and the connection must ALSO name a call that arrived
   * through the authenticated event webhook. Sixteen characters minimum: a
   * short token is a guessable one.
   */
  streamToken(): string | null {
    const token = process.env.INFOBIP_STREAM_TOKEN?.trim();
    return token && token.length >= 16 ? token : null;
  }

  /** The WebSocket path the media stream config should point at, token included. */
  streamPathForConfig(): string | null {
    const token = this.streamToken();
    return token ? `/telephony/infobip/stream/${encodeURIComponent(token)}` : null;
  }

  // ── Authentication ───────────────────────────────────────────────────────

  /**
   * Basic authentication on a call event.
   *
   * `unconfigured` is distinct from `invalid` so the route can tell an
   * operator which one they are looking at — a deployment with no credentials
   * set and an event with the wrong ones are fixed in different places.
   */
  verifyWebhook(authorization: string | undefined): 'ok' | 'missing' | 'invalid' | 'unconfigured' {
    const expected = this.webhookCredentials();
    if (!expected) return 'unconfigured';
    if (!authorization) return 'missing';
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization);
    if (!m) return 'invalid';
    let decoded: string;
    try {
      decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      return 'invalid';
    }
    const sep = decoded.indexOf(':');
    if (sep < 0) return 'invalid';
    // BOTH halves compared, always, so a right username is not observably
    // different from a wrong one.
    const userOk = sameSecret(decoded.slice(0, sep), expected.username);
    const passOk = sameSecret(decoded.slice(sep + 1), expected.password);
    return userOk && passOk ? 'ok' : 'invalid';
  }

  verifyStreamToken(given: string | undefined): boolean {
    const expected = this.streamToken();
    if (!expected || !given) return false;
    let decoded = given;
    try {
      decoded = decodeURIComponent(given);
    } catch {
      return false;
    }
    return sameSecret(decoded, expected);
  }

  // ── Calls API ────────────────────────────────────────────────────────────

  private async post(
    path: string,
    body: unknown
  ): Promise<{ ok: true; body: any } | { ok: false; status?: number; error: string }> {
    const base = this.baseUrl();
    const key = process.env.INFOBIP_API_KEY?.trim();
    if (!base || !key) return { ok: false, error: 'Infobip is not configured.' };
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `App ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        // A caller is ringing while this runs. A hung request must not hold
        // the call for longer than they will wait.
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text().catch(() => '');
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        // Infobip's own words, never "the request failed".
        // `||` at the end, not `??`: an empty body slices to '', which `??`
        // would keep — reporting a refusal with no reason at all.
        const reason =
          parsed?.requestError?.serviceException?.text ??
          parsed?.errorMessage ??
          parsed?.message ??
          (text.slice(0, 300) || `no body`);
        return { ok: false, status: res.status, error: `Infobip refused (HTTP ${res.status}): ${reason}` };
      }
      return { ok: true, body: parsed };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Infobip: ${err?.message ?? err}` };
    }
  }

  /**
   * A WebRTC token for one officer's browser, so it can ring a citizen.
   *
   * The request body is exactly the three fields Infobip's own generated API
   * client declares for `POST /webrtc/1/token` (`WebRtcTokenRequestModel`):
   * `identity` (3–64 characters; letters, digits, `-`, `_`, `.`), and the
   * optional `displayName` (5–50 characters) and `timeToLive` (seconds,
   * at most 24h, 8h when unset). Nothing is added that the model does not
   * name, because a field Infobip does not know is either ignored or a 400 —
   * and which one is not something this process can find out without an
   * account.
   *
   * The identity is derived from the user id by the caller, never taken from
   * the request: a token naming its own identity would let one officer act
   * as another.
   *
   * A name outside Infobip's length rule is left out rather than truncated
   * or padded. It is cosmetic; a refusal over it would stop the call.
   */
  async webrtcToken(
    identity: string,
    displayName: string | null | undefined,
    timeToLiveSeconds: number
  ): Promise<{ ok: true; token: string; expiresAt: string | null } | { ok: false; error: string }> {
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(identity)) {
      return { ok: false, error: `"${identity}" is not an identity Infobip accepts (3–64 of A-Z, 0-9, - _ .).` };
    }
    const name = displayName?.trim();
    const body: Record<string, unknown> = { identity, timeToLive: timeToLiveSeconds };
    if (name && name.length >= 5 && name.length <= 50) body.displayName = name;

    const result = await this.post('/webrtc/1/token', body);
    if (!result.ok) return { ok: false, error: result.error };
    const token = result.body?.token;
    if (typeof token !== 'string' || !token) {
      // A 200 with no token is not a token. Handing the browser `undefined`
      // produces an SDK error about the client, not about Infobip.
      return { ok: false, error: 'Infobip answered the token request without a token.' };
    }
    return {
      ok: true,
      token,
      expiresAt: typeof result.body?.expirationTime === 'string' ? result.body.expirationTime : null,
    };
  }

  /**
   * Connect the citizen's call to this platform's AI.
   *
   * Exactly the request in Infobip's own tutorial: a dialog whose parent is the
   * inbound call and whose child is the WebSocket endpoint named by the media
   * stream config. Creating the dialog is what answers the call.
   */
  async connectToAi(parentCallId: string) {
    return this.post('/calls/1/dialogs', {
      parentCallId,
      childCallRequest: {
        endpoint: {
          type: 'WEBSOCKET',
          websocketEndpointConfigId: process.env.INFOBIP_MEDIA_STREAM_CONFIG_ID?.trim(),
        },
      },
    });
  }

  /**
   * Put the citizen through to a person.
   *
   * Infobip's own "transfer" methods are NOT this: they change which
   * application owns a call, so its events go to a different webhook. The
   * caller hears nothing and nobody joins. Connecting a human means a second
   * leg — a dialog whose parent is the citizen's call and whose child is the
   * officer's number — which is the same request `connectToAi` already makes,
   * with a PHONE endpoint where that one names a WebSocket.
   *
   * `from` is the number the CITIZEN dialled, so the officer's phone shows the
   * agency's own line rather than an unrecognised one. An officer who does not
   * recognise the caller does not answer, and the transfer fails for a reason
   * no log would explain.
   *
   * Returns Infobip's verdict. The caller must not be told they are being
   * connected until this says `ok` — see the handoff branch in the media
   * stream handler, and `handoff-ticket.ts` for what is promised when it is
   * not.
   */
  async transferToHuman(parentCallId: string, phoneNumber: string, from?: string | null) {
    return this.post('/calls/1/dialogs', {
      parentCallId,
      childCallRequest: {
        endpoint: { type: 'PHONE', phoneNumber },
        ...(from ? { from } : {}),
      },
    });
  }

  async hangup(callId: string) {
    return this.post(`/calls/1/calls/${encodeURIComponent(callId)}/hangup`, {});
  }

  // ── The call-context store ───────────────────────────────────────────────
  //
  // The event webhook and the media stream are two separate inbound
  // connections, and on more than one instance they can land on DIFFERENT
  // ones. An in-memory map alone would then fail to find the call, the stream
  // would be refused, and the citizen would hear the line go dead — with
  // nothing wrong anywhere a person would look. So Redis is used when
  // REDIS_URL is set, with memory as the fallback for a single instance.

  private async redisClient(): Promise<ReturnType<typeof createClient> | null> {
    const url = process.env.REDIS_URL?.trim();
    if (!url) return null;
    if (this.redis?.isOpen) return this.redis;
    if (!this.redisConnecting) {
      this.redis = createClient({
        url,
        // Commands sent while the socket is down must fail, not queue: a
        // ringing call cannot wait on a reconnect.
        disableOfflineQueue: true,
        socket: { connectTimeout: 2000, reconnectStrategy: (r) => Math.min(100 * 2 ** r, 30_000) },
      });
      this.redis.on('error', (err: Error) => log.warn('infobip_store_redis_error', { error: err.message }));
      this.redisConnecting = Promise.race([
        this.redis.connect().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]).catch(() => false);
    }
    const ok = await this.redisConnecting;
    if (!ok) {
      this.redisConnecting = null;
      return null;
    }
    return this.redis;
  }

  private async setKey(key: string, value: string): Promise<void> {
    this.memory.set(key, { value, expiresAt: Date.now() + CONTEXT_TTL_SECONDS * 1000 });
    const r = await this.redisClient();
    if (r) await r.set(key, value, { EX: CONTEXT_TTL_SECONDS }).catch(() => undefined);
  }

  private async getKey(key: string): Promise<string | null> {
    const r = await this.redisClient();
    if (r) {
      const v = await r.get(key).catch(() => null);
      if (v) return v;
    }
    const m = this.memory.get(key);
    if (m && m.expiresAt > Date.now()) return m.value;
    if (m) this.memory.delete(key);
    return null;
  }

  private async delKey(key: string): Promise<void> {
    this.memory.delete(key);
    const r = await this.redisClient();
    if (r) await r.del(key).catch(() => undefined);
  }

  async remember(context: InfobipCallContext): Promise<void> {
    await this.setKey(`infobip:call:${context.parentCallId}`, JSON.stringify(context));
  }

  /** Record that `id` belongs to the citizen call `parentCallId`. */
  async alias(id: string, parentCallId: string): Promise<void> {
    if (!id || id === parentCallId) return;
    await this.setKey(`infobip:alias:${id}`, parentCallId);
  }

  /** Alias every id-shaped value in `source` to the citizen's call. */
  async aliasAll(source: unknown, parentCallId: string): Promise<number> {
    let n = 0;
    for (const id of collectIds(source)) {
      if (id === parentCallId) continue;
      await this.alias(id, parentCallId);
      n += 1;
    }
    return n;
  }

  /** The citizen's call for an id — its own, or any alias recorded for it. */
  async resolve(id: string): Promise<InfobipCallContext | null> {
    if (!id) return null;
    const direct = await this.getKey(`infobip:call:${id}`);
    if (direct) return JSON.parse(direct) as InfobipCallContext;
    const parent = await this.getKey(`infobip:alias:${id}`);
    if (!parent) return null;
    const viaAlias = await this.getKey(`infobip:call:${parent}`);
    return viaAlias ? (JSON.parse(viaAlias) as InfobipCallContext) : null;
  }

  /** True when `id` is a citizen call this deployment answered, not an alias. */
  async isParent(id: string): Promise<boolean> {
    return (await this.getKey(`infobip:call:${id}`)) !== null;
  }

  async forget(parentCallId: string): Promise<void> {
    await this.delKey(`infobip:call:${parentCallId}`);
  }

  /** For the tests. */
  clearMemory(): void {
    this.memory.clear();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis?.isOpen) await this.redis.quit();
    } catch {
      /* closing a connection that is already gone is not a failure */
    }
  }
}
