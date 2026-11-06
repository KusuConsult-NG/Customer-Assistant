// Roles & Access Control
export enum UserRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  AGENT = 'AGENT',
  VIEWER = 'VIEWER',
}

export enum IndustryType {
  HOSPITAL = 'HOSPITAL',
  CLINIC = 'CLINIC',
  HOTEL = 'HOTEL',
  RESTAURANT = 'RESTAURANT',
  SCHOOL = 'SCHOOL',
  UNIVERSITY = 'UNIVERSITY',
  CHURCH = 'CHURCH',
  LAW_FIRM = 'LAW_FIRM',
  REAL_ESTATE = 'REAL_ESTATE',
  LOGISTICS = 'LOGISTICS',
  BANK = 'BANK',
  INSURANCE = 'INSURANCE',
  GOVERNMENT = 'GOVERNMENT',
  SALON_SPA = 'SALON_SPA',
  SME = 'SME',
  ENTERPRISE = 'ENTERPRISE',
  OTHER = 'OTHER',
}

export enum ChannelType {
  VOICE = 'VOICE',
  WHATSAPP = 'WHATSAPP',
  WEBCHAT = 'WEBCHAT',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
  INSTAGRAM = 'INSTAGRAM',
  TELEGRAM = 'TELEGRAM',
  MESSENGER = 'MESSENGER',
}

export enum CallDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum CallStatus {
  QUEUED = 'QUEUED',
  RINGING = 'RINGING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  BUSY = 'BUSY',
  NO_ANSWER = 'NO_ANSWER',
}

export enum MessageSender {
  CUSTOMER = 'CUSTOMER',
  AI = 'AI',
  HUMAN_AGENT = 'HUMAN_AGENT',
  SYSTEM = 'SYSTEM',
}

export enum HandoffReason {
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  CUSTOMER_REQUEST = 'CUSTOMER_REQUEST',
  TOOL_FAILURE = 'TOOL_FAILURE',
  COMPLEX_QUERY = 'COMPLEX_QUERY',
  URGENT_ESCALATION = 'URGENT_ESCALATION',
}

export enum BookingStatus {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  RESCHEDULED = 'RESCHEDULED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW',
}

export enum LeadStatus {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  QUALIFIED = 'QUALIFIED',
  UNQUALIFIED = 'UNQUALIFIED',
  CONVERTED = 'CONVERTED',
}

export enum DealStage {
  DISCOVERY = 'DISCOVERY',
  PROPOSAL = 'PROPOSAL',
  NEGOTIATION = 'NEGOTIATION',
  CLOSED_WON = 'CLOSED_WON',
  CLOSED_LOST = 'CLOSED_LOST',
}

export enum TicketStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  PENDING_CUSTOMER = 'PENDING_CUSTOMER',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export enum TicketPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum TelephonyProviderType {
  TWILIO = 'TWILIO',
  PLIVO = 'PLIVO',
  TELNYX = 'TELNYX',
  AFRICAS_TALKING = 'AFRICAS_TALKING',
  NIGERIA_CARRIER_FORWARD = 'NIGERIA_CARRIER_FORWARD',
  /**
   * A generic SIP trunk from any carrier.
   *
   * ElevenLabs sells no numbers — it answers one brought from Twilio, Exotel
   * or a SIP trunk. This is the option that removes the Twilio dependency
   * entirely, which for a State deployment means a local carrier: local
   * numbers, local termination, and no overseas intermediary on citizen calls.
   */
  SIP_TRUNK = 'SIP_TRUNK',
  MTN_ENTERPRISE_SIP = 'MTN_ENTERPRISE_SIP',
  AIRTEL_BUSINESS_SIP = 'AIRTEL_BUSINESS_SIP',
}


// Telephony Interfaces
export interface CallInitiateOptions {
  organizationId: string;
  fromNumber: string;
  toNumber: string;
  provider: TelephonyProviderType;
  customMetadata?: Record<string, any>;
}

export interface CallTransferOptions {
  callId: string;
  targetPhoneNumber: string;
  agentId?: string;
  announceMessage?: string;
}

export interface CallRecord {
  callId: string;
  organizationId: string;
  from: string;
  to: string;
  direction: CallDirection;
  status: CallStatus;
  startTime: Date;
  endTime?: Date;
  durationSeconds?: number;
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  provider: TelephonyProviderType;
}

// WhatsApp Interfaces
export interface WhatsAppMessagePayload {
  messageId: string;
  fromNumber: string;
  organizationId: string;
  messageType: 'text' | 'image' | 'audio' | 'document' | 'interactive' | 'location';
  textContent?: string;
  mediaUrl?: string;
  mediaMimeType?: string;
  timestamp: number;
}

// RAG / Knowledge Base Interfaces
export interface KnowledgeDocumentDTO {
  id: string;
  organizationId: string;
  title: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  status: 'PENDING' | 'PROCESSING' | 'INDEXED' | 'FAILED';
  chunkCount: number;
  createdAt: Date;
}

export interface SearchResultChunk {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, any>;
}

// Orchestrator Interfaces
export interface ConversationContext {
  conversationId: string;
  organizationId: string;
  customerPhoneNumber?: string;
  channel: ChannelType;
  history: Array<{
    sender: MessageSender;
    content: string;
    timestamp: Date;
    metadata?: Record<string, any>;
  }>;
  slots: Record<string, any>;
  currentIntent?: string;
  isHumanHandoffActive: boolean;
  assignedAgentId?: string;
}

export interface OrchestrationResult {
  replyText: string;
  audioUrl?: string;
  intentDetected?: string;
  confidenceScore: number;
  shouldHandoff: boolean;
  handoffReason?: HandoffReason;
  toolCallsExecuted?: Array<{ toolName: string; result: any }>;
}

/**
 * The booking an orchestration created, if it created one.
 *
 * The orchestrator writes a booking through its own `prisma.booking.create`,
 * not through `SchedulingService`, so the only thing telling the Nest layer a
 * citizen was just booked in is this entry in `toolCallsExecuted`. Both channel
 * handlers that run the orchestrator — the WhatsApp service and the voice
 * media-stream handler — read it to dispatch `appointment.booked`, and they
 * read it through here so the two cannot disagree about what counts as booked.
 *
 * Narrow on all three of the tool name, `booked` and a string `bookingId`,
 * because `result` is typed `any` and a near-miss here books a webhook for
 * something that is not an appointment:
 *
 *  - The RESERVATION flow also reports `booked: true`, under `manage_reservation`
 *    and with a `reservationId` rather than a `bookingId`. A reservation is not
 *    an appointment and `appointment.booked` must not fire for one, so the tool
 *    name is what separates them and the id check is the second line.
 *  - A slot taken between the offer and the reply returns the booking flow's
 *    next question and no `book_appointment` entry at all, so it is excluded by
 *    carrying nothing rather than by `booked` being false.
 */
export function bookedAppointmentId(result: OrchestrationResult | null | undefined): string | null {
  for (const call of result?.toolCallsExecuted ?? []) {
    if (call?.toolName !== 'book_appointment') continue;
    const outcome = call.result as { booked?: unknown; bookingId?: unknown } | undefined;
    if (outcome?.booked === true && typeof outcome.bookingId === 'string' && outcome.bookingId) {
      return outcome.bookingId;
    }
  }
  return null;
}

// CRM Interfaces
export interface CustomerDTO {
  id: string;
  organizationId: string;
  fullName: string;
  email?: string;
  phoneNumber: string;
  companyName?: string;
  tags: string[];
  createdAt: Date;
}

export interface AppointmentDTO {
  id: string;
  organizationId: string;
  customerId: string;
  serviceName: string;
  startTime: Date;
  endTime: Date;
  status: 'CONFIRMED' | 'CANCELLED' | 'RESCHEDULED' | 'COMPLETED';
  notes?: string;
  staffName?: string;
}

export interface ReservationDTO {
  id: string;
  organizationId: string;
  customerId: string;
  partySize: number;
  reservationTime: Date;
  tableOrRoomNumber?: string;
  specialRequests?: string;
  status: 'CONFIRMED' | 'CANCELLED' | 'SEATED' | 'COMPLETED' | 'NO_SHOW';
}

// API User Session
export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  fullName: string;
  role: UserRole;
  /**
   * Operator of the whole platform, not a role within an agency. Deliberately
   * separate from `role`: see the note on `User.isPlatformAdmin` in the schema.
   * Only `PlatformAdminGuard` reads this; no tenant route may branch on it.
   */
  isPlatformAdmin: boolean;
}

// ── Outbound webhook events ─────────────────────────────────────────────────
//
// The ONE list of what this platform POSTs to a tenant's webhook URL, shared
// by the dispatcher that sends them and the screen that offers them.
//
// It is here, and shared, because the two drifted. The dashboard offered
// "Call Ended" (`call.ended`) while the API dispatched `call.completed`, and
// `WebhookDispatcherService` filters on an exact string match against the
// tenant's `enabledWebhookEvents` — so a tenant ticked Call Ended, saw it
// saved, and never received one. Nothing failed and nothing logged: the
// dispatch returned at the filter. Meanwhile `contact.created` was dispatched
// and offered nowhere, so it could only be received by a tenant who had
// `'*'` stored, which the dashboard cannot set.
//
// A list duplicated in two apps is a list that drifts again, so both import
// this one and `webhook-events.spec.ts` checks it against what the API
// actually dispatches.

export interface WebhookEventDefinition {
  /** The canonical `event` value in the body and the `X-ACE-Event` header. */
  key: string;
  label: string;
  description: string;
  /**
   * Names this event has been dispatched or stored under before.
   *
   * The write path for `enabledWebhookEvents` validates nothing, so any string
   * a tenant ever sent is still in their row. Renaming the dispatch alone would
   * therefore have silently switched off the subscription of every tenant
   * holding the old name — the same failure in the opposite direction. The
   * dispatcher matches a stored alias to its canonical event, so both spellings
   * keep working and nobody has to re-tick anything.
   */
  aliases?: string[];
  /**
   * Whether the platform actually sends this event today.
   *
   * `false` is not a placeholder to be filled in later by the UI: it is what
   * stops the screen offering a subscription that can never fire. An operator
   * who ticks an event and waits for it has no way to tell "never happened"
   * from "never implemented", and this platform does not advertise what it
   * cannot do.
   */
  delivered: boolean;
}

export const WEBHOOK_EVENTS: WebhookEventDefinition[] = [
  {
    key: 'call.started',
    label: 'Call Started',
    description: 'A voice call begins',
    delivered: true,
  },
  {
    key: 'call.ended',
    label: 'Call Ended',
    description: 'A voice or WhatsApp call concludes, with its final status',
    // Dispatched as `call.completed` until the two lists were reconciled.
    aliases: ['call.completed'],
    delivered: true,
  },
  {
    key: 'message.received',
    label: 'Message Received',
    description: 'A citizen sends a WhatsApp message',
    delivered: true,
  },
  {
    key: 'contact.created',
    label: 'Contact Created',
    description: 'A new citizen record is created',
    delivered: true,
  },
  {
    key: 'lead.captured',
    label: 'Lead Captured',
    description: 'A new lead is recorded from a conversation',
    delivered: true,
  },
  {
    key: 'ticket.created',
    label: 'Support Ticket Created',
    description: 'An escalation ticket is opened',
    delivered: true,
  },
  {
    key: 'appointment.booked',
    label: 'Appointment Booked',
    description: 'A citizen books a slot, from any channel',
    // Dispatched from `WebhookDispatcherService.appointmentBooked`, which every
    // booking path calls with an id so the payload has one definition. Two
    // different writers create a booking — `SchedulingService.createBooking`
    // and the orchestrator's own `prisma.booking.create` — so a single dispatch
    // in the service would have covered staff bookings and silently skipped the
    // channel serving every citizen today.
    delivered: true,
  },
  {
    key: 'handover.requested',
    label: 'Human Handover',
    description: 'A conversation is handed to a person, by an officer or by the assistant',
    // Dispatched from `WebhookDispatcherService.handoverRequested` on the
    // false→true TRANSITION only, by all five writes that activate a handoff:
    // an officer replying (one site per channel), the toggle route, the
    // orchestrator returning shouldHandoff, and the SET_HANDOFF workflow
    // action. Releasing a handoff is not this event and has no name here.
    delivered: true,
  },
];

/**
 * Every alias, mapped to the canonical key it stands for.
 *
 * Null-prototype, because the names looked up in it are tenant-supplied: the
 * write path for `enabledWebhookEvents` validates nothing, so a row can hold
 * `constructor` or `__proto__`. On an ordinary object those resolve to
 * INHERITED values — `canonicalWebhookEvent('constructor')` would hand back the
 * `Object` function instead of the string it was given.
 */
export const WEBHOOK_EVENT_ALIASES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(
    WEBHOOK_EVENTS.flatMap((event) => (event.aliases ?? []).map((alias) => [alias, event.key]))
  )
);

/** The canonical name for an event, whatever spelling it arrived in. */
export function canonicalWebhookEvent(name: string): string {
  return WEBHOOK_EVENT_ALIASES[name] ?? name;
}

/**
 * Is a tenant subscribed to this event?
 *
 * Compared on canonical names in BOTH directions, so a row holding
 * `call.completed` and a dispatch of `call.ended` are the same subscription.
 * `'*'` keeps meaning everything, including events added after it was stored.
 */
export function isWebhookEventEnabled(enabled: string[], eventType: string): boolean {
  if (enabled.includes('*')) return true;
  const wanted = canonicalWebhookEvent(eventType);
  return enabled.some((stored) => canonicalWebhookEvent(stored) === wanted);
}
