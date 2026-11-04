/**
 * Everything that hangs off a citizen's record — derived, never listed.
 *
 * ── Why derived ─────────────────────────────────────────────────────────────
 *
 * Every relation on `Contact` is `onDelete: Cascade`. That makes a hand-written
 * list dangerous in a specific way: a model missing from it is not skipped, it
 * is DESTROYED. The contact-merge script learned this when `CallbackRequest`
 * was added to the schema and not to its list, so merging a duplicate citizen
 * silently deleted the callbacks promised to them.
 *
 * Reading the datamodel means the next relation somebody adds is covered by
 * everything that uses this, without anybody remembering to come back.
 */
import { Prisma } from '@prisma/client';

/** A model name in the shape Prisma's client uses: `callbackRequest`. */
export type ContactRelationModel = string;

/**
 * Models carrying a `contactId`, as client-style names.
 *
 * `conversation` is EXCLUDED by default: its unique constraint on
 * [organizationId, contactId, channel] means a straight reassign can collide
 * with a thread the survivor already has, so anything moving records has to
 * handle it specially. Counting is different — pass `includeConversation` for
 * that.
 */
export function contactRelationModels(options: { includeConversation?: boolean } = {}): ContactRelationModel[] {
  const models = (Prisma as any)?.dmmf?.datamodel?.models;
  if (!models?.length) {
    throw new Error(
      'Could not read the Prisma datamodel, so the records attached to a contact cannot be ' +
      'derived. Refusing to guess: every one of these relations cascades on delete, so a ' +
      'relation missed here is destroyed rather than skipped. Run `npm run db:generate`.'
    );
  }

  return models
    .filter((m: any) => m.fields.some((f: any) => f.name === 'contactId'))
    .map((m: any) => m.name[0].toLowerCase() + m.name.slice(1))
    .filter((name: string) => options.includeConversation || name !== 'conversation');
}

/** What an officer would call each of these, for a sentence they can act on. */
const HUMAN_NAMES: Record<string, { one: string; many: string }> = {
  booking: { one: 'appointment', many: 'appointments' },
  reservation: { one: 'reservation', many: 'reservations' },
  callbackRequest: { one: 'promised callback', many: 'promised callbacks' },
  ticket: { one: 'case', many: 'cases' },
  conversation: { one: 'conversation', many: 'conversations' },
  callLog: { one: 'call record', many: 'call records' },
  note: { one: 'note', many: 'notes' },
  lead: { one: 'enquiry', many: 'enquiries' },
  deal: { one: 'application', many: 'applications' },
  selfieRequest: { one: 'photo request', many: 'photo requests' },
};

export function describeContactRelation(model: string, count: number): string {
  const name = HUMAN_NAMES[model] ?? { one: model, many: `${model} records` };
  return `${count} ${count === 1 ? name.one : name.many}`;
}

type Counter = { count: (args: any) => Promise<number> };

/**
 * How much of a citizen's record would go with them.
 *
 * Only non-zero counts are returned, because a sentence listing six kinds of
 * nothing is one an officer stops reading.
 */
export async function countContactRelations(
  db: Record<string, Counter>,
  contactId: string
): Promise<Array<{ model: string; count: number }>> {
  const models = contactRelationModels({ includeConversation: true });
  const counted = await Promise.all(
    models.map(async (model) => ({
      model,
      count: await db[model].count({ where: { contactId } }),
    }))
  );
  return counted.filter((c) => c.count > 0);
}
