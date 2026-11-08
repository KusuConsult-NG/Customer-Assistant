/**
 * Answering a call in the dashboard, instead of on a telephone.
 *
 * ── What this adds, and what it deliberately does not change ────────────────
 *
 * An inbound call used to go one place: `<Connect><Stream/>` to the media
 * handler, where the AI answers. A human could only be reached by REDIRECTING
 * the call to a phone number (`forwardingNumber`), so an officer needed a
 * handset and a number somebody had configured.
 *
 * Now the call rings the agency's officers IN THEIR BROWSER first, and falls
 * through to exactly the same AI stream if none of them picks up.
 *
 * The fallback is the whole safety property. When nothing is configured, when
 * no officer is signed in, when every officer declines — the caller reaches
 * the AI precisely as before. Nothing about this file changes what happens on
 * a deployment that does not switch it on.
 *
 * ── Why there is no presence table ──────────────────────────────────────────
 *
 * The obvious design tracks which officers are "available" and dials those.
 * That needs storage that every pod agrees on: the TwiML webhook can land on a
 * different pod from the one an officer's browser is talking to, so an
 * in-memory map silently fails to ring people. Getting it wrong is invisible —
 * the call just goes to the AI and nobody knows a human was free.
 *
 * Twilio already solves this. A `<Client>` leg to an identity with no
 * registered device fails FAST, and `<Dial>` rings every listed client at
 * once. So registration in the browser IS the availability signal, held by
 * Twilio, correct across any number of pods, with no schema change and nothing
 * to go stale. An explicit "available" toggle is a refinement on top, not a
 * prerequisite.
 *
 * ── Why the credentials are env vars and not TelephonyConfig ────────────────
 *
 * `TelephonyConfig.apiKey` and `.apiSecret` ALREADY MEAN something else: they
 * verify other carriers' webhook signatures (see `telephony.service.ts`).
 * Reusing those columns for Twilio Voice API keys would make one column mean
 * two incompatible things depending on the provider, and the failure would be
 * a carrier's webhooks silently failing verification.
 *
 * A Voice API Key is also not the Account SID and Auth Token — it is a
 * separate credential pair created in the Twilio console, and the Account SID
 * is still needed alongside it.
 */
import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { UserRole } from '@prisma/client';
import { escapeXml } from '@ace/telephony-sdk';
import { AceLogger } from '../config/logger';

const log = new AceLogger('BrowserCalling');

/**
 * How long a browser token is good for.
 *
 * Short enough that a token taken from a browser is not a lasting capability,
 * long enough that an officer is not re-registering mid-shift. The dashboard
 * refreshes it before expiry.
 */
const TOKEN_TTL_SECONDS = 60 * 60;

/**
 * How long the officers' phones ring before the AI takes the call.
 *
 * A caller hearing ringing for 30 seconds and then a greeting has been made to
 * wait twice. 20 seconds is about four rings.
 */
export const RING_SECONDS = 20;

/**
 * Twilio's simultaneous-dial ceiling, and a sane one anyway: ringing forty
 * desks for one citizen's call is not a feature.
 */
const MAX_SIMULTANEOUS_CLIENTS = 10;

/** Roles whose holders may answer a citizen's call. */
const ANSWERING_ROLES: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT];

export interface BrowserCallingReadiness {
  enabled: boolean;
  blocked: string[];
  detail: string;
}

/**
 * A Twilio Client identity for an officer.
 *
 * Derived from the user id, not the email: an email can change, contains
 * characters Twilio's identity rules dislike, and would put a staff address
 * into TwiML that Twilio logs.
 */
export function clientIdentityFor(userId: string): string {
  return `officer_${userId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** The user id back out of an identity, or null if it is not one of ours. */
export function userIdFromIdentity(identity: string | null | undefined): string | null {
  const m = /^officer_([A-Za-z0-9_-]+)$/.exec(String(identity ?? ''));
  return m ? m[1] : null;
}

@Injectable()
export class BrowserCallingService {
  /**
   * Is browser answering switched on AND actually possible?
   *
   * Reported together, because "configured" is not an answer in this codebase.
   * Every one of these is a credential the operator creates in the Twilio
   * console, and missing any of them means tokens Twilio refuses — which in
   * the browser looks like a dashboard that simply never rings.
   */
  readiness(): BrowserCallingReadiness {
    const blocked: string[] = [];
    if (!process.env.TWILIO_ACCOUNT_SID?.trim()) {
      blocked.push('TWILIO_ACCOUNT_SID is not set.');
    }
    if (!process.env.TWILIO_API_KEY_SID?.trim()) {
      blocked.push(
        'TWILIO_API_KEY_SID is not set. This is an API Key SID (starts SK…) created in the Twilio ' +
          'console, NOT the Account SID and NOT the Auth Token.'
      );
    }
    if (!process.env.TWILIO_API_KEY_SECRET?.trim()) {
      blocked.push('TWILIO_API_KEY_SECRET is not set — it is shown once, when the API Key is created.');
    }
    if (!process.env.TWILIO_TWIML_APP_SID?.trim()) {
      blocked.push(
        'TWILIO_TWIML_APP_SID is not set. A TwiML App (starts AP…) is what a browser client dials ' +
          'OUT through; without it officers can answer but not place calls.'
      );
    }

    return {
      enabled: blocked.length === 0,
      blocked,
      detail:
        blocked.length === 0
          ? `Inbound calls ring signed-in officers for ${RING_SECONDS}s before the AI answers. No real ` +
            'call has proven this path yet — treat the first one as the test.'
          : blocked.join(' '),
    };
  }

  /**
   * A Voice Access Token for one officer.
   *
   * Minted with Twilio's OWN SDK rather than hand-rolling the JWT. The claim
   * structure is documented, but a token this process cannot test against
   * Twilio is one that either works or silently never rings — and there is no
   * way to tell which from here. Using the vendor's implementation removes the
   * guess.
   *
   * Returns null when not configured, never a token that cannot work.
   */
  accessTokenFor(userId: string): { token: string; identity: string; expiresInSeconds: number } | null {
    if (!this.readiness().enabled) return null;

    // Required lazily: the SDK is only needed by deployments that switch this
    // on, and it should not be constructed in every process that imports the
    // telephony module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    const { AccessToken } = twilio.jwt;
    const { VoiceGrant } = AccessToken;

    const identity = clientIdentityFor(userId);
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID!.trim(),
      process.env.TWILIO_API_KEY_SID!.trim(),
      process.env.TWILIO_API_KEY_SECRET!.trim(),
      { identity, ttl: TOKEN_TTL_SECONDS }
    );

    token.addGrant(
      new VoiceGrant({
        // Answering calls. This is the half this feature exists for.
        incomingAllow: true,
        // Placing them. Harmless to grant and needed for an officer to call a
        // citizen back from the same console.
        outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID!.trim(),
      })
    );

    return { token: token.toJwt(), identity, expiresInSeconds: TOKEN_TTL_SECONDS };
  }

  /**
   * The officers this agency's calls should ring.
   *
   * Only ACTIVE users, and only roles that may speak to a citizen. A VIEWER
   * answering a call would be a role boundary crossed by a telephone.
   *
   * Ordered and capped so the TwiML is deterministic: an unordered query means
   * a different `<Dial>` on every call, which makes a report of "it rang
   * Musa but not Amina" impossible to reproduce.
   */
  async answeringIdentities(organizationId: string): Promise<string[]> {
    const users = await prisma.user
      .findMany({
        where: { organizationId, isActive: true, role: { in: ANSWERING_ROLES } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: MAX_SIMULTANEOUS_CLIENTS,
      })
      .catch((err) => {
        // A failed lookup must not take the CALL down — it falls through to
        // the AI, which is what would have answered before this existed.
        log.error('browser_calling_identity_lookup_failed', err as Error, { organizationId });
        return [] as Array<{ id: string }>;
      });

    return users.map((u) => clientIdentityFor(u.id));
  }

  /**
   * TwiML that rings the officers, then hands the call to `actionUrl`.
   *
   * `answerOnBridge` matters: without it Twilio answers the inbound call
   * immediately and the citizen hears silence while the officers' browsers
   * ring. With it they hear ringing, which is what a telephone has always
   * done.
   *
   * `action` is what makes the fallback work at all. Twilio POSTs there when
   * the dial ends for ANY reason — nobody answered, everybody declined, the
   * client was not registered — and whatever that route returns becomes the
   * rest of the call. That is where the AI takes over.
   */
  dialOfficersTwiml(identities: string[], actionUrl: string, callerId?: string): string {
    const clients = identities.map((id) => `<Client>${escapeXml(id)}</Client>`).join('');
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Dial timeout="${RING_SECONDS}" answerOnBridge="true"` +
      `${callerId ? ` callerId="${escapeXml(callerId)}"` : ''}` +
      ` action="${escapeXml(actionUrl)}" method="POST">` +
      clients +
      `</Dial>` +
      `</Response>`
    );
  }
}
