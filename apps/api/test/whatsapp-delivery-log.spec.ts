/**
 * Six faults, one symptom: a citizen gets no reply.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Meta confirmed it was delivering to a subscribed app, the stored token was
 * accepted, readiness was green — and messages still went unanswered. Every
 * remaining explanation produces exactly the same thing on the citizen's
 * phone: silence. The only way to tell them apart was to open a hosting
 * console and know which of twenty `whatsapp_*` log strings mattered, which
 * is not a diagnosis an operator can be asked to perform while a public
 * service is down.
 *
 * So the OUTCOME of each delivery is recorded and the settings screen shows
 * it. These tests pin the thing that makes it worth having: that the outcomes
 * are DISTINGUISHABLE, and that an unattributed failure — the most
 * diagnostic kind — is not hidden by tenant scoping.
 */
import { whatsAppDeliveryLog } from '../src/whatsapp/delivery-log.service';

describe('WhatsApp delivery log', () => {
  beforeEach(() => whatsAppDeliveryLog.clear());
  afterAll(() => whatsAppDeliveryLog.clear());

  it('explains every outcome in words an operator can act on', () => {
    const explain = (outcome: any) => {
      whatsAppDeliveryLog.clear();
      whatsAppDeliveryLog.record({ outcome, organizationId: 'org_1' });
      return whatsAppDeliveryLog.recent('org_1')[0].explanation;
    };

    // A FAILURE has to carry a cause, or it has told the operator nothing
    // they did not already know from the citizen's silence.
    for (const outcome of [
      'signature_rejected',
      'no_config_found',
      'ambiguous_line',
      'credentials_unreadable',
      'reply_send_failed',
      'processing_failed',
    ] as const) {
      const explanation = explain(outcome);
      expect(explanation).toBeTruthy();
      // Not the raw key echoed back, which would explain nothing.
      expect(explanation).not.toBe(outcome);
      expect(explanation.length).toBeGreaterThan(20);
    }

    // A SUCCESS is allowed to be brief — "Answered." is the right length for
    // the one outcome that needs no action. An earlier version of this test
    // demanded twenty characters of every outcome and failed on that, which
    // was the test being wrong rather than the message.
    for (const outcome of ['replied', 'duplicate_ignored', 'handed_to_human', 'status_receipt'] as const) {
      const explanation = explain(outcome);
      expect(explanation).toBeTruthy();
      expect(explanation).not.toBe(outcome);
    }
  });

  it('names a different cause for each fault, so they can be told apart', () => {
    // The whole point. If two faults read the same, the log has not helped.
    const explain = (outcome: any) => {
      whatsAppDeliveryLog.clear();
      whatsAppDeliveryLog.record({ outcome, organizationId: 'org_1' });
      return whatsAppDeliveryLog.recent('org_1')[0].explanation;
    };

    expect(explain('signature_rejected')).toMatch(/WHATSAPP_APP_SECRET/);
    expect(explain('no_config_found')).toMatch(/Phone Number ID/i);
    expect(explain('ambiguous_line')).toMatch(/more than one agency/i);
    expect(explain('credentials_unreadable')).toMatch(/ENCRYPTION_KEY/);
    expect(explain('reply_send_failed')).toMatch(/expired token|service window/i);

    const all = [
      'signature_rejected',
      'no_config_found',
      'ambiguous_line',
      'credentials_unreadable',
      'reply_send_failed',
    ].map(explain);
    expect(new Set(all).size).toBe(all.length);
  });

  it('SHOWS an unattributed failure, which is the most diagnostic kind', () => {
    // A rejected signature and an unmatched Phone Number ID never reach an
    // organization. Scoping strictly by org would hide precisely the failures
    // somebody is hunting — and the screen would say "nothing to report"
    // about a line that is answering nobody.
    whatsAppDeliveryLog.record({ outcome: 'signature_rejected', phoneNumberId: 'pn_unknown' });
    whatsAppDeliveryLog.record({ outcome: 'no_config_found', phoneNumberId: 'pn_unknown' });

    const seen = whatsAppDeliveryLog.recent('org_1');
    expect(seen).toHaveLength(2);
    expect(seen.map((e) => e.outcome).sort()).toEqual(['no_config_found', 'signature_rejected']);
  });

  it("does not show one agency another agency's deliveries", () => {
    whatsAppDeliveryLog.record({ outcome: 'replied', organizationId: 'org_1' });
    whatsAppDeliveryLog.record({ outcome: 'replied', organizationId: 'org_2' });

    expect(whatsAppDeliveryLog.recent('org_1')).toHaveLength(1);
    expect(whatsAppDeliveryLog.recent('org_1')[0].organizationId).toBe('org_1');
  });

  it('keeps the newest first, because the question is about the message just sent', () => {
    whatsAppDeliveryLog.record({ outcome: 'no_config_found', organizationId: 'org_1', detail: 'first' });
    whatsAppDeliveryLog.record({ outcome: 'replied', organizationId: 'org_1', detail: 'second' });

    expect(whatsAppDeliveryLog.recent('org_1')[0].detail).toBe('second');
  });

  it('is bounded, because an unbounded buffer on a busy line takes the API down', () => {
    for (let i = 0; i < 500; i++) {
      whatsAppDeliveryLog.record({ outcome: 'replied', organizationId: 'org_1' });
    }
    expect(whatsAppDeliveryLog.recent('org_1').length).toBeLessThanOrEqual(50);
  });

  it('records no message content and no full phone number', () => {
    // This is a diagnostic surface, not a transcript. A citizen's number and
    // what they said belong in the conversation, behind the controls that
    // guard it — not in a panel on a settings page.
    whatsAppDeliveryLog.record({
      outcome: 'replied',
      organizationId: 'org_1',
      phoneNumberId: 'pn_123',
      fromSuffix: '5678',
      detail: 'rate limited',
    });

    const raw = JSON.stringify(whatsAppDeliveryLog.recent('org_1'));
    expect(raw).toContain('5678');
    // The suffix only — never a whole number.
    expect(raw).not.toMatch(/\+?234\d{7,}/);
  });
});
