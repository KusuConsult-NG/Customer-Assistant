import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_ALIASES,
  canonicalWebhookEvent,
  isWebhookEventEnabled,
} from '@ace/shared-types';
import { WebhookDispatcherService } from '../src/webhooks/webhook-dispatcher.service';

/**
 * Outbound webhook events are a contract between two lists, and the lists had
 * drifted in three directions at once.
 *
 *  - The dashboard offered `call.ended`. The API dispatched `call.completed`.
 *    `WebhookDispatcherService` filtered on an exact string match, so a tenant
 *    ticked Call Ended, saw it saved, and never received one. Nothing failed
 *    and nothing logged — the dispatch returned at the filter, which is the
 *    same shape as an event that simply had not happened yet.
 *  - `contact.created` was dispatched and offered nowhere, so only a tenant
 *    holding `'*'` could receive it, and the dashboard cannot store `'*'`.
 *  - `appointment.booked` and `handover.requested` were offered and dispatched
 *    by nothing at all.
 *
 * Both sides now read one catalogue in `@ace/shared-types`. This spec is what
 * keeps that catalogue honest: a dispatch with no entry fails, an entry
 * claiming delivery that nothing dispatches fails, and the alias table is
 * exercised against the real dispatcher rather than asserted about.
 */
describe('Outbound webhook events', () => {
  const API_SRC = join(__dirname, '..', 'src');

  /** Every `webhookDispatcher.dispatch(org, '<event>', …)` in the API source. */
  const dispatchedEvents = (() => {
    const found = new Map<string, string[]>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf8');
        // The call is written across two lines in one place
        // (`this.webhookDispatcher\n  .dispatch(...)`), so this reads the whole
        // file rather than line by line. Requiring an identifier and then a
        // quoted literal keeps `mailer.ts`'s unrelated `dispatch(provider, {…})`
        // out of the result.
        const pattern = /\.dispatch\(\s*[A-Za-z_$][\w$.?]*\s*,\s*'([^']+)'/g;
        for (const match of source.matchAll(pattern)) {
          const list = found.get(match[1]) ?? [];
          list.push(full.slice(API_SRC.length + 1));
          found.set(match[1], list);
        }
      }
    };
    walk(API_SRC);
    return found;
  })();

  describe('the catalogue matches what the API actually sends', () => {
    it('finds the dispatches at all', () => {
      // A scan that silently matches nothing would make every test below pass
      // against an API that dispatches no webhooks whatsoever — which is how
      // the hand audit this replaces kept producing a different answer.
      expect(dispatchedEvents.size).toBeGreaterThanOrEqual(5);
    });

    it('dispatches nothing that has no catalogue entry', () => {
      const known = new Set(WEBHOOK_EVENTS.map((e) => e.key));
      const orphans = [...dispatchedEvents.entries()]
        .filter(([key]) => !known.has(key))
        .map(([key, files]) => `${key} (${files.join(', ')})`);
      // An event the dashboard cannot offer is receivable only by a tenant
      // holding '*', which no screen can set — so it may as well not be sent.
      expect(orphans).toEqual([]);
    });

    it('sends every event it claims to deliver', () => {
      const missing = WEBHOOK_EVENTS.filter((e) => e.delivered && !dispatchedEvents.has(e.key)).map(
        (e) => e.key
      );
      // The other direction: an entry marked delivered that nothing dispatches
      // is a subscription that waits forever, and an operator cannot tell that
      // from an event that has not occurred.
      expect(missing).toEqual([]);
    });

    it('does not dispatch an event it marks as not delivered', () => {
      const lying = WEBHOOK_EVENTS.filter((e) => !e.delivered && dispatchedEvents.has(e.key)).map(
        (e) => e.key
      );
      expect(lying).toEqual([]);
    });

    it('dispatches canonical names, never an alias', () => {
      const aliasesSent = [...dispatchedEvents.keys()].filter((key) => key in WEBHOOK_EVENT_ALIASES);
      // Aliases exist to keep STORED subscriptions working. Dispatching one
      // would start the drift over again from the other end.
      expect(aliasesSent).toEqual([]);
    });

    it('keeps `call.ended` the canonical name and `call.completed` an alias of it', () => {
      // The specific regression: these two must never be separate events again.
      expect(canonicalWebhookEvent('call.completed')).toBe('call.ended');
      expect(dispatchedEvents.has('call.ended')).toBe(true);
      expect(dispatchedEvents.has('call.completed')).toBe(false);
      // Both the carrier path and the WhatsApp call path send it.
      expect(dispatchedEvents.get('call.ended')!.length).toBeGreaterThanOrEqual(2);
    });

    it('has no duplicate keys and no alias that collides with a key', () => {
      const keys = WEBHOOK_EVENTS.map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
      const collisions = Object.keys(WEBHOOK_EVENT_ALIASES).filter((a) => keys.includes(a));
      // An alias that is also a key would make canonicalisation depend on
      // which lookup ran first.
      expect(collisions).toEqual([]);
    });
  });

  /**
   * The two events that go out through a HELPER rather than a bare `dispatch`.
   *
   * `appointmentBooked` and `handoverRequested` build their payload inside
   * `WebhookDispatcherService` so that every firing site shares one definition.
   * That puts their `dispatch(...)` call inside the dispatcher's own file, which
   * means the scan above finds the event whether or not a single piece of domain
   * code ever calls the helper — the dispatcher would be dispatching to itself.
   * These tests are what close that hole: the helper has to be reached from the
   * paths that actually book an appointment or hand a thread over.
   */
  describe('the helper-dispatched events are reached from domain code', () => {
    const HELPERS: Record<string, string> = {
      'appointment.booked': 'appointmentBooked',
      'handover.requested': 'handoverRequested',
    };

    /** Files outside `webhooks/` that call this helper. */
    const callersOf = (helper: string) => {
      const callers: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.endsWith('.ts')) continue;
          const rel = full.slice(API_SRC.length + 1);
          if (rel.startsWith('webhooks/')) continue;
          if (readFileSync(full, 'utf8').includes(`${helper}(`)) callers.push(rel);
        }
      };
      walk(API_SRC);
      return callers.sort();
    };

    it('routes exactly the events it dispatches internally through a known helper', () => {
      // A third helper added without an entry here would reintroduce the hole.
      const internal = [...dispatchedEvents.entries()]
        .filter(([, files]) => files.every((f) => f.startsWith('webhooks/')))
        .map(([key]) => key)
        .sort();
      expect(internal).toEqual(Object.keys(HELPERS).sort());
    });

    it('calls every helper from somewhere that is not the dispatcher', () => {
      for (const [event, helper] of Object.entries(HELPERS)) {
        expect(callersOf(helper).length).toBeGreaterThan(0);
        expect(WEBHOOK_EVENTS.find((e) => e.key === event)!.delivered).toBe(true);
      }
    });

    it('dispatches appointment.booked from BOTH booking writers', () => {
      const callers = callersOf('appointmentBooked');
      // Two different code paths create a booking: the service the dashboard
      // and the hosted agent use, and the orchestrator's own write, whose result
      // each channel handler reads. Covering only the service is how this event
      // fires for staff bookings and silently not for citizens.
      expect(callers).toContain('scheduling/scheduling.service.ts');
      expect(callers).toContain('whatsapp/whatsapp.service.ts');
      expect(callers).toContain('telephony/twilio-media-stream.handler.ts');
    });

    it('dispatches handover.requested from every write that activates a handoff', () => {
      const callers = callersOf('handoverRequested');
      expect(callers).toContain('events/conversations.controller.ts');
      expect(callers).toContain('whatsapp/whatsapp.service.ts');
      expect(callers).toContain('workflows/workflow-actions.service.ts');
    });

    /**
     * The check that catches a SIXTH handoff site added later.
     *
     * Any file that turns `isHumanHandoffActive` on has to dispatch, or the
     * automated handover it performs tells nobody — which is the gap this event
     * was added to close.
     */
    it('leaves no handoff-activating file without a dispatch', () => {
      /**
       * Does this `isHumanHandoffActive:` set the flag, or merely ask about it?
       *
       * The first version of this check matched the assignment anywhere and
       * reported `analytics.service.ts`, `analytics-insights.service.ts` and
       * `platform.service.ts` — all three of which read it in a `where` clause
       * to COUNT handed-over conversations. A checker that invents violations
       * trains you to ignore it, so the sentinel nearest before the match
       * decides: only `data:` is a write. `emit(` is listed because the console
       * gateway broadcasts the flag in a socket payload and persists nothing,
       * which is a claim its own comment makes and this encodes.
       */
      const isActivatingWrite = (source: string): boolean => {
        const SENTINEL = /\b(data|where|select|include)\s*:|\bemit\(/g;
        for (const hit of source.matchAll(/isHumanHandoffActive:\s*(true|handoff|body\.handoff)\b/g)) {
          const before = source.slice(0, hit.index);
          const sentinels = [...before.matchAll(SENTINEL)];
          const nearest = sentinels[sentinels.length - 1];
          if (nearest && /^data\s*:/.test(nearest[0])) return true;
        }
        return false;
      };

      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.endsWith('.ts')) continue;
          const rel = full.slice(API_SRC.length + 1);
          const source = readFileSync(full, 'utf8');
          if (!isActivatingWrite(source)) continue;
          if (!source.includes('handoverRequested(')) offenders.push(rel);
        }
      };
      walk(API_SRC);
      // A sixth handoff site added later, with no dispatch, lands here — which
      // is the regression this event exists to prevent.
      expect(offenders).toEqual([]);
    });

    it('recognises the real handoff writers, so the check above is not vacuous', () => {
      // If the write/read discrimination above drifted to matching nothing,
      // `offenders` would be empty for the wrong reason and a missing dispatch
      // would pass. These three files really do activate a handoff.
      const activating = (rel: string) => {
        const source = readFileSync(join(API_SRC, rel), 'utf8');
        const SENTINEL = /\b(data|where|select|include)\s*:|\bemit\(/g;
        return [...source.matchAll(/isHumanHandoffActive:\s*(true|handoff|body\.handoff)\b/g)].some(
          (hit) => {
            const sentinels = [...source.slice(0, hit.index).matchAll(SENTINEL)];
            const nearest = sentinels[sentinels.length - 1];
            return Boolean(nearest && /^data\s*:/.test(nearest[0]));
          }
        );
      };
      expect(activating('events/conversations.controller.ts')).toBe(true);
      expect(activating('whatsapp/whatsapp.service.ts')).toBe(true);
      expect(activating('workflows/workflow-actions.service.ts')).toBe(true);
      // And a pure reader is not mistaken for one.
      expect(activating('analytics/analytics.service.ts')).toBe(false);
    });
  });

  describe('a stored subscription is matched on canonical names', () => {
    it('matches the old spelling to the new event', () => {
      // The write path for enabledWebhookEvents validates nothing, so a row can
      // hold either string. Renaming the dispatch alone would have silently
      // unsubscribed every tenant holding the old one.
      expect(isWebhookEventEnabled(['call.completed'], 'call.ended')).toBe(true);
      expect(isWebhookEventEnabled(['call.ended'], 'call.ended')).toBe(true);
    });

    it('still means everything when `*` is stored', () => {
      expect(isWebhookEventEnabled(['*'], 'call.ended')).toBe(true);
      expect(isWebhookEventEnabled(['*'], 'anything.at.all')).toBe(true);
    });

    it('does not match an event the tenant did not subscribe to', () => {
      expect(isWebhookEventEnabled(['message.received'], 'call.ended')).toBe(false);
      expect(isWebhookEventEnabled([], 'call.ended')).toBe(false);
    });

    it('is not confused by a stored name that is an Object property', () => {
      // enabledWebhookEvents is written unvalidated, so a row can hold these.
      // On an ordinary object they resolve to INHERITED values, and
      // canonicalWebhookEvent would return the `Object` function rather than
      // the string it was handed.
      for (const hostile of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        expect(canonicalWebhookEvent(hostile)).toBe(hostile);
        expect(isWebhookEventEnabled([hostile], 'call.ended')).toBe(false);
      }
      // And a real subscription alongside one still works.
      expect(isWebhookEventEnabled(['constructor', 'call.completed'], 'call.ended')).toBe(true);
    });
  });

  /**
   * Through the real dispatcher, because the bug was in the filter rather than
   * in anything a helper would have reported.
   */
  describe('the dispatcher delivers to a tenant holding the old name', () => {
    const dispatcher = new WebhookDispatcherService();
    // A public IP literal: assertPublicHttpUrl skips DNS for one, so the SSRF
    // guard is exercised without the test needing to resolve a name.
    const TARGET = 'https://93.184.216.34/hook';
    const orgIds: string[] = [];
    let realFetch: typeof globalThis.fetch;
    let posted: Array<{ url: string; event: string; body: any }>;
    const savedSecret = process.env.WEBHOOK_SECRET;

    jest.setTimeout(60000);

    const orgWith = async (enabledWebhookEvents: string[]) => {
      const org = await prisma.organization.create({
        data: {
          name: 'Webhook Agency',
          slug: `wh-${randomBytes(5).toString('hex')}`,
          industry: 'GOVERNMENT',
          webhookUrl: TARGET,
          enabledWebhookEvents,
        },
      });
      orgIds.push(org.id);
      return org.id;
    };

    beforeAll(() => {
      process.env.WEBHOOK_SECRET = 'webhook_secret_for_event_name_tests';
      realFetch = globalThis.fetch;
    });

    beforeEach(() => {
      posted = [];
      globalThis.fetch = (async (input: any, init?: any) => {
        posted.push({
          url: String(input),
          event: String((init?.headers ?? {})['X-ACE-Event'] ?? ''),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response('{}', { status: 200 });
      }) as any;
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      if (savedSecret === undefined) delete process.env.WEBHOOK_SECRET;
      else process.env.WEBHOOK_SECRET = savedSecret;
      await prisma.webhookLog.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    });

    it('delivers call.ended to a tenant whose row says call.completed', async () => {
      const orgId = await orgWith(['call.completed']);
      await dispatcher.dispatch(orgId, 'call.ended', { callSid: 'CA123' });

      expect(posted).toHaveLength(1);
      expect(posted[0].url).toBe(TARGET);
      // The canonical name goes on the wire, whatever the row says — a receiver
      // should not have to handle both spellings.
      expect(posted[0].event).toBe('call.ended');
      expect(posted[0].body.event).toBe('call.ended');
      expect(posted[0].body.data.callSid).toBe('CA123');
    });

    it('delivers call.ended to a tenant whose row says call.ended', async () => {
      const orgId = await orgWith(['call.ended']);
      await dispatcher.dispatch(orgId, 'call.ended', {});
      expect(posted).toHaveLength(1);
    });

    it('still delivers everything to a tenant holding `*`', async () => {
      const orgId = await orgWith(['*']);
      await dispatcher.dispatch(orgId, 'call.ended', {});
      expect(posted).toHaveLength(1);
    });

    it('sends nothing to a tenant subscribed to other events', async () => {
      const orgId = await orgWith(['message.received', 'ticket.created']);
      await dispatcher.dispatch(orgId, 'call.ended', {});
      expect(posted).toEqual([]);
    });

    it('records the delivery under the canonical name', async () => {
      const orgId = await orgWith(['call.completed']);
      await dispatcher.dispatch(orgId, 'call.ended', {});

      const logs = await prisma.webhookLog.findMany({ where: { organizationId: orgId } });
      expect(logs).toHaveLength(1);
      // The log is what an operator reads when a receiver says it got nothing.
      // Under the stored alias it would not match the event their code handles.
      expect(logs[0].eventType).toBe('call.ended');
      expect(logs[0].success).toBe(true);
    });
  });
});
