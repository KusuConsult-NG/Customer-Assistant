/**
 * Merging two records of one citizen must not destroy what they were promised.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The merge moved a hand-written list of relations — lead, deal, ticket,
 * callLog, booking, reservation, note, selfieRequest — and then deleted the
 * duplicate. `CallbackRequest` was added to the schema later and never added
 * to that list.
 *
 * Every one of these relations is `onDelete: Cascade`, so a model missing from
 * the list is not left behind, it is DELETED. Merging a citizen recorded twice
 * therefore destroyed any callback the agency had promised them: the queue
 * lost the row, the dispatcher never rang, and nothing anywhere said so. A
 * tidy-up that quietly breaks a promise to a citizen is worse than the
 * duplicate it was cleaning up.
 *
 * The list is derived from Prisma's own datamodel now. This checks the
 * derivation against the schema file, so the next relation somebody adds is
 * covered without anybody remembering to come here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const { contactRelationModels } = require('./lib/contact-relations');

/** Every model in schema.prisma that carries a contactId. */
function modelsWithAContact(): string[] {
  const schema = readFileSync(
    join(__dirname, '..', 'packages', 'database', 'prisma', 'schema.prisma'),
    'utf8'
  );
  const found: string[] = [];
  for (const match of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    if (/^\s*contactId\s/m.test(body)) found.push(name[0].toLowerCase() + name.slice(1));
  }
  return found;
}

describe('what a contact merge moves', () => {
  const derived = contactRelationModels();
  const inSchema = modelsWithAContact();

  it('is reading a real schema', () => {
    // A matcher that finds nothing passes forever.
    expect(inSchema.length).toBeGreaterThan(5);
    expect(inSchema).toContain('booking');
  });

  it('covers every relation that hangs off a contact', () => {
    // `conversation` is handled separately — its unique constraint on
    // [organizationId, contactId, channel] means a straight reassign can
    // collide with a thread the survivor already has.
    const expected = inSchema.filter((m) => m !== 'conversation').sort();
    expect([...derived].sort()).toEqual(expected);
  });

  it('carries the promised callbacks that used to be deleted', () => {
    expect(derived).toContain('callbackRequest');
  });

  it('leaves conversations to the code that knows about the constraint', () => {
    expect(derived).not.toContain('conversation');
  });
});
