/**
 * The keyword search finds the document that answers the question, not the
 * one whose TITLE shares a word with it.
 *
 * The December events lineup was loaded and WhatsApp still could not answer
 * about it. Retrieval without vectors ranks chunks by keyword, and:
 *  - "Plateau" is in nearly every agency's title, so "When is the Plateau
 *    Cultural Carnival?" ranked the Agricultural Development Programme first;
 *  - "Tell me about Urban Fest" returned Housing and URBAN Development on a
 *    title hit, and an express company on "manifest";
 *  - "What is ONE PLATEAU FEST?" read ONE, PLATEAU and FEST as acronyms.
 * The model is only given what retrieval returns, so the citizen was told
 * about the wrong agency or that there was no information.
 */
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '@ace/database';
import { QdrantRAGService } from '@ace/orchestrator';

const LINEUP_TITLE = 'December Tourism Month 2026 — Plateau State Events Lineup';
const LINEUP = readFileSync(
  join(__dirname, '..', '..', '..', 'data', 'mda-knowledge', 'December-Tourism-Month-2026-Events.md'),
  'utf8'
);

// What the State's real corpus looks like to keyword search: most titles say
// "Plateau", one says "Urban", one body says "festival", one says "manifest".
const OTHERS: Array<[string, string]> = [
  ['MHUD — Ministry of Housing and Urban Development', 'Urban renewal, housing estates and urban planning approvals across Jos and Bukuru.'],
  ['PRTVC — Plateau Radio Television Corporation', 'State broadcaster. Covers cultural festivals, news and public service announcements across Plateau.'],
  ['PESGL — Plateau Express Services Group LTD', 'Urban courier and logistics; every parcel is recorded on a manifest before dispatch.'],
  ['PADP — Plateau Agricultural Development Programme', 'Extension services, cultural practices for crops, and farmer support in Plateau.'],
  ...Array.from({ length: 10 }, (_, i): [string, string] => [
    `Plateau State Agency ${i}`,
    `Agency ${i} of Plateau State serves residents of Plateau with public services, one office per LGA.`,
  ]),
];

describe('Keyword retrieval picks the document that answers', () => {
  jest.setTimeout(30000);
  let orgId: string;
  const priorKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    // No vectors: the keyword path is the one under test.
    delete process.env.OPENAI_API_KEY;
    const org = await prisma.organization.create({
      data: { name: 'Ranking Agency', slug: `ranking-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
    const docs: Array<[string, string[]]> = [
      [LINEUP_TITLE, [LINEUP.slice(0, 1800), LINEUP.slice(1800, 3600), LINEUP.slice(3600)].filter(Boolean)],
      ...OTHERS.map(([t, b]): [string, string[]] => [t, [b]]),
    ];
    for (const [title, chunks] of docs) {
      const doc = await prisma.knowledgeDocument.create({
        data: {
          organizationId: orgId, title, fileName: `${title}.md`, fileSize: 1, mimeType: 'text/markdown',
          storageUrl: `test/${randomBytes(4).toString('hex')}`, status: 'INDEXED',
        },
      });
      await prisma.documentChunk.createMany({
        data: chunks.map((content, chunkIndex) => ({ organizationId: orgId, documentId: doc.id, content, chunkIndex })),
      });
    }
  });

  afterAll(async () => {
    if (priorKey !== undefined) process.env.OPENAI_API_KEY = priorKey;
    await prisma.documentChunk.deleteMany({ where: { organizationId: orgId } });
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  it.each([
    'Tell me about Urban Fest',
    'What is ONE PLATEAU FEST?',
    'When is the Plateau Cultural Carnival?',
    'Where is the Jos Food Festival?',
    'What events are happening in December?',
  ])('%s', async (question) => {
    const results = await new QdrantRAGService().searchKnowledgeBase(orgId, question, 5);
    expect(results[0]?.title).toBe(LINEUP_TITLE);
  });

  it('still answers a question about an agency by its own title', async () => {
    const results = await new QdrantRAGService().searchKnowledgeBase(orgId, 'urban planning approvals', 5);
    expect(results[0]?.title).toMatch(/Housing and Urban Development/);
  });
});
