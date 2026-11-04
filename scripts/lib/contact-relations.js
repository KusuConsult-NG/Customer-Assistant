/**
 * Every model that hangs off a contact, read from the schema itself.
 *
 * ── Why this is not a list ──────────────────────────────────────────────────
 *
 * It WAS a list — lead, deal, ticket, callLog, booking, reservation, note,
 * selfieRequest — written by hand and then left behind when `CallbackRequest`
 * was added. Every one of these relations is `onDelete: Cascade`, so a model
 * missing from the list is not merged but DELETED along with the loser. The
 * merge therefore destroyed the promised callbacks of any citizen recorded
 * twice: the queue simply lost them, the dispatcher never rang, and nothing
 * anywhere said so.
 *
 * Deriving it from Prisma's own metadata means the next relation somebody adds
 * is carried automatically. `conversation` is excluded because it is handled
 * separately above — its unique constraint on [organizationId, contactId,
 * channel] means a straight reassign can collide.
 */
function contactRelationModels() {
  const { Prisma } = require('@prisma/client');
  const models = Prisma?.dmmf?.datamodel?.models;
  if (!models?.length) {
    throw new Error(
      'Could not read the Prisma datamodel, so the set of records to move cannot be ' +
      'derived. Refusing to merge: a relation missed here is DELETED by the cascade, ' +
      'not left behind. Run `npm run db:generate` and try again.'
    );
  }
  return models
    .filter((m) => m.fields.some((f) => f.name === 'contactId'))
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1))
    .filter((name) => name !== 'conversation');
}

module.exports = { contactRelationModels };
