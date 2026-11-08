/**
 * What happened to the last few inbound WhatsApp deliveries.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A citizen messages the agency and gets no reply. There are at least six
 * reasons that produce exactly that symptom, and every one of them is
 * currently a line in a log file on a hosting dashboard:
 *
 *   - Meta never delivered it (no subscription, wrong callback URL)
 *   - the signature failed (WHATSAPP_APP_SECRET belongs to another app)
 *   - the `phoneNumberId` matched no stored line
 *   - two agencies claim the line
 *   - the stored credentials could not be decrypted
 *   - the reply was composed and the send was refused
 *
 * From the outside they are indistinguishable: silence. So every attempt to
 * diagnose it has been "go and read the logs", which asks an operator to find
 * a hosting console, pick the right service, and know which of twenty
 * `whatsapp_*` strings matters. That is not a diagnosis anybody can be
 * expected to perform while citizens are unanswered.
 *
 * This records the OUTCOME of each delivery, in memory, and the settings
 * screen shows it. It is not a replacement for the logs — it is the first
 * question answered on the screen where the problem is visible.
 *
 * ── In memory, deliberately ─────────────────────────────────────────────────
 *
 * No table, no migration. A schema change has to be pushed to production
 * BEFORE the code that uses it deploys, and this is being added while a live
 * line is down — exactly the wrong moment to add a step that can fail. The
 * cost is that the list empties on restart, which is acceptable: the question
 * it answers is "what happened to the message I just sent", asked seconds
 * later.
 *
 * Bounded, because an unbounded buffer on a busy line is a memory leak that
 * takes the API down — which would be a worse failure than the one it is
 * here to explain.
 */
/** How many to keep. Enough to see a pattern, small enough to never matter. */
const MAX_ENTRIES = 50;

export type DeliveryOutcome =
  | 'signature_rejected'
  | 'no_config_found'
  | 'ambiguous_line'
  | 'credentials_unreadable'
  | 'duplicate_ignored'
  | 'handed_to_human'
  | 'replied'
  | 'reply_send_failed'
  | 'processing_failed'
  | 'status_receipt'
  | 'call_event';

export interface DeliveryRecord {
  at: string;
  outcome: DeliveryOutcome;
  /** Meta's id for the line the delivery named. Not a secret. */
  phoneNumberId?: string;
  organizationId?: string;
  /** Last four digits only — enough to recognise a test, not a contact list. */
  fromSuffix?: string;
  detail?: string;
}

/** Plain English for an operator, not a log string for an engineer. */
const EXPLANATIONS: Record<DeliveryOutcome, string> = {
  signature_rejected:
    'Meta delivered it but the signature did not verify. WHATSAPP_APP_SECRET belongs to a different ' +
    'Meta app than the one sending — check which app is subscribed.',
  no_config_found:
    'Meta delivered it for a Phone Number ID that matches no line stored here. The ID saved in ' +
    'Settings is not the one Meta is sending. Use the Show this account\u2019s lines button to find it.',
  ambiguous_line:
    'More than one agency has this line stored. It was answered by the first of them — remove it ' +
    'from the agency that should not have it.',
  credentials_unreadable:
    'The stored credentials for this line could not be decrypted, so no reply could be sent. ' +
    'ENCRYPTION_KEY is not the key that wrote them.',
  duplicate_ignored: 'Meta redelivered a message already handled. Nothing was sent twice — this is normal.',
  handed_to_human: 'An officer holds this conversation, so the AI did not reply.',
  replied: 'Answered.',
  reply_send_failed:
    'A reply was composed and Meta refused to send it. The usual causes are an expired token or a ' +
    'closed 24-hour service window.',
  processing_failed: 'The delivery was accepted and then failed while being processed.',
  status_receipt: 'A delivery receipt, not a message. Normal.',
  call_event: 'A call event, not a message.',
};

class WhatsAppDeliveryLog {
  private entries: DeliveryRecord[] = [];

  record(entry: Omit<DeliveryRecord, 'at'>): void {
    this.entries.unshift({ at: new Date().toISOString(), ...entry });
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
  }

  /**
   * The recent deliveries for one agency, plus the ones we could not attribute.
   *
   * An UNATTRIBUTED delivery is the most diagnostic entry there is — a
   * rejected signature or an unmatched Phone Number ID never reaches an
   * organization, so scoping strictly by org would hide precisely the
   * failures somebody is looking for. They carry no organization and no
   * message content, so showing them crosses no tenant boundary.
   */
  recent(organizationId: string): Array<DeliveryRecord & { explanation: string }> {
    return this.entries
      .filter((e) => !e.organizationId || e.organizationId === organizationId)
      .map((e) => ({ ...e, explanation: EXPLANATIONS[e.outcome] ?? e.outcome }));
  }

  /** For the tests, and for a deployment that wants a clean slate. */
  clear(): void {
    this.entries = [];
  }
}

/**
 * ONE instance, shared across modules — a module singleton rather than a Nest
 * provider.
 *
 * The WhatsApp module records the outcomes and the organizations module reads
 * them, and wiring a provider between the two means one importing the other.
 * `socketRevalidator` is a singleton in this codebase for exactly this
 * reason, and the alternative here is worse than a cycle: two separate
 * instances would compile, inject and run, and the settings screen would show
 * an empty list for ever while deliveries were being recorded into the other
 * one. A diagnostic that silently reports nothing is worse than no
 * diagnostic, because it answers the question wrongly.
 */
export const whatsAppDeliveryLog = new WhatsAppDeliveryLog();
export type { DeliveryRecord as WhatsAppDeliveryRecord };
