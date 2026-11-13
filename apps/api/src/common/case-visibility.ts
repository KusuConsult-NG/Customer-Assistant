/**
 * Who may see a case, who may know who reported it, and who may read or hear
 * the call it came from — ONE definition, used by every list that shows any
 * of them.
 *
 * ── Why one module ──────────────────────────────────────────────────────────
 *
 * The rules were written twice (the Cases screen and the CRM ticket list) and
 * honoured nowhere else. So every OTHER way to a case or a call went round
 * them: the call list showed every call's transcript, number and caller to
 * every member, the dashboard's "recent calls" did the same, and a contact's
 * page and timeline listed every case that contact had filed — so a viewer who
 * could not see an anonymous report's reporter on the Cases screen could open
 * the reporter's own contact page and find the report there, under their name.
 * A rule that has to be re-applied correctly at each new list is a rule that
 * will be missed at the next one; this is the one place it lives.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 *  - OWNER/ADMIN see every case, every reporter and every call.
 *  - Other State staff see every case except a SENSITIVE one not assigned to
 *    them, and never the reporter of an ANONYMOUS one.
 *  - An MDA liaison sees only cases referred to their MDA and never an
 *    anonymous reporter.
 *  - A CALL attached to a case (see call-case-link.ts) is that case's record:
 *    its transcript, summary, caller and recording are shown only to those who
 *    may know the case's reporter and may see the case. A liaison never reads
 *    or hears the State's record of a call.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@ace/database';
import { CALL_RECORDED_EVENT, callLogIdFrom, conversationIdFrom } from './call-case-link';

export interface Viewer {
  userId: string;
  organizationId: string;
  role: string;
  mdaName?: string | null;
}

export interface CaseFlags {
  isAnonymous: boolean;
  isSensitive: boolean;
  assignedUserId: string | null;
}

export const isPrivileged = (v: Pick<Viewer, 'role'>) => v.role === 'OWNER' || v.role === 'ADMIN';
export const isLiaison = (v: Pick<Viewer, 'mdaName'>) => !!v.mdaName;

/** The cases this viewer may see at all — applied in the query, never in the dashboard. */
export function visibleCasesWhere(v: Viewer): Prisma.TicketWhereInput {
  const base: Prisma.TicketWhereInput = { organizationId: v.organizationId };
  if (isLiaison(v)) return { ...base, referrals: { some: { mdaName: v.mdaName! } } };
  if (!isPrivileged(v)) return { ...base, OR: [{ isSensitive: false }, { assignedUserId: v.userId }] };
  return base;
}

/** Whether this viewer may know WHO reported this case. */
export function mayIdentifyReporter(v: Viewer, c: Pick<CaseFlags, 'isAnonymous'>): boolean {
  return !(c.isAnonymous && (isLiaison(v) || !isPrivileged(v)));
}

/** Whether this viewer may read or hear the record of a call attached to this case. */
export function mayHearCall(v: Viewer, c: CaseFlags): boolean {
  if (isLiaison(v)) return false;
  if (!mayIdentifyReporter(v, c)) return false;
  return !c.isSensitive || isPrivileged(v) || c.assignedUserId === v.userId;
}

/** The cases of ONE contact this viewer may see listed under that contact. */
export function visibleCasesOfContactWhere(v: Viewer, contactId: string): Prisma.TicketWhereInput {
  // On a contact's own page, the contact IS the reporter: listing an anonymous
  // case there names its reporter as surely as showing the contact on the case.
  const where: Prisma.TicketWhereInput = { AND: [visibleCasesWhere(v), { contactId }] };
  return mayIdentifyReporter(v, { isAnonymous: true }) ? where : { AND: [where, { isAnonymous: false }] };
}

/** Which calls' records this viewer may not see. */
export interface CallWithholding {
  /** Every call (a liaison). */
  all: boolean;
  callLogIds: Set<string>;
  /** ElevenLabs conversation ids — the call transcripts mirrored into VOICE threads. */
  conversationIds: Set<string>;
}

export async function callWithholding(v: Viewer): Promise<CallWithholding> {
  const out: CallWithholding = { all: isLiaison(v), callLogIds: new Set(), conversationIds: new Set() };
  if (out.all || isPrivileged(v)) return out;
  // Only confidential cases can withhold anything, so only their events are read.
  const events = await prisma.caseEvent.findMany({
    where: {
      organizationId: v.organizationId,
      type: { in: ['CREATED', CALL_RECORDED_EVENT] },
      ticket: { OR: [{ isAnonymous: true }, { isSensitive: true }] },
    },
    select: { type: true, body: true, ticket: { select: { isAnonymous: true, isSensitive: true, assignedUserId: true } } },
  });
  for (const e of events) {
    if (!e.ticket || mayHearCall(v, e.ticket)) continue;
    if (e.type === CALL_RECORDED_EVENT) {
      const id = callLogIdFrom(e.body);
      if (id) out.callLogIds.add(id);
    } else {
      const conv = conversationIdFrom(e.body);
      if (conv) out.conversationIds.add(conv);
    }
  }
  return out;
}

export const isCallWithheld = (w: CallWithholding, callLogId: string) => w.all || w.callLogIds.has(callLogId);

/** A message mirrored from a call's transcript (externalId `<conversation id>:<turn>`) the viewer may not read. */
export function isTranscriptTurnWithheld(w: CallWithholding, channel: string, externalId: string | null | undefined): boolean {
  if (channel !== 'VOICE') return false;
  if (w.all) return true;
  const conv = externalId?.split(':')[0];
  return !!conv && w.conversationIds.has(conv);
}

export const WITHHELD_TEXT = '[Withheld: part of a confidential report]';

/**
 * A call as a viewer who may not see its record receives it: when it happened,
 * how long, how it ended — counts a supervisor needs — and nothing that says
 * who called or what was said. The citizen's end of the line is blanked; the
 * agency's own line is not a secret.
 */
export function redactCall<T extends Record<string, any>>(row: T): T & { confidential: true } {
  const outbound = row.direction === 'OUTBOUND';
  return {
    ...row,
    transcript: null,
    summary: null,
    sentiment: null,
    recordingUrl: null,
    recordingPlayable: false,
    contactId: null,
    contact: null,
    fromNumber: outbound ? row.fromNumber : null,
    toNumber: outbound ? null : row.toNumber,
    confidential: true,
  };
}
