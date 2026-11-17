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

  it('gives WhatsApp the WHOLE lineup and asks for the complete answer, not a third of it', async () => {
    // One chunk matched the question; the model used to be given that chunk
    // alone, and a 400-token reply budget, and answered with part of the list.
    const { ConversationOrchestrator } = require('@ace/orchestrator');
    const priorFetch = global.fetch;
    process.env.OPENAI_API_KEY = 'sk-test-whole-document';
    const synthesis: any[] = [];
    global.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/embeddings')) return { ok: false, status: 503, text: async () => 'unavailable' } as any;
      const body = JSON.parse(String(init?.body ?? '{}'));
      const isSynthesis = (body.messages ?? []).some((m: any) => String(m.content).includes('knowledge base may be relevant'));
      if (isSynthesis) synthesis.push(body);
      const content = isSynthesis ? 'Here is the full lineup.' : '{"intent":"NONE","confidence":0.9}';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' } as any;
    }) as any;
    try {
      await new ConversationOrchestrator().processIncomingMessage(
        {
          conversationId: `whole-doc-${randomBytes(3).toString('hex')}`,
          organizationId: orgId,
          customerPhoneNumber: '+2348000000099',
          channel: 'WHATSAPP',
          history: [],
          slots: {},
          isHumanHandoffActive: false,
        },
        // Only the SECOND chunk mentions this venue, so the first event can
        // reach the model only if the whole document is given.
        'Where is the Azi Nyako Youth Centre?'
      );
    } finally {
      global.fetch = priorFetch;
      delete process.env.OPENAI_API_KEY;
    }
    expect(synthesis).toHaveLength(1);
    const prompt = synthesis[0].messages.map((m: any) => m.content).join('\n');
    // Every part of the lineup reached the model: the first event and the last.
    expect(prompt).toContain('2nd Plateau Youth Tourism Roundtable');
    expect(prompt).toContain('Azi Nyako Youth Centre');
    expect(prompt).toContain('PLAFEST');
    // As ONE excerpt: chunk by chunk, the overlap between chunks was read twice.
    expect(prompt.split(`From "${LINEUP_TITLE}"`).length - 1).toBe(1);
    expect(prompt).toContain('GIVE THE COMPLETE ANSWER');
    expect(synthesis[0].max_tokens).toBeGreaterThanOrEqual(1500);
  });

  it('on WhatsApp, gives the model the FAQ answer FIRST and the knowledge base details with it', async () => {
    const { ConversationOrchestrator } = require('@ace/orchestrator');
    const faq = await prisma.faqEntry.create({
      data: { organizationId: orgId, question: 'When is December Tourism Month?', answer: 'December is Tourism Month in Plateau State.', sortOrder: 0, isActive: true },
    });
    const priorFetch = global.fetch;
    process.env.OPENAI_API_KEY = 'sk-test-faq-and-kb';
    const synthesis: any[] = [];
    global.fetch = (async (url: any, init: any) => {
      if (String(url).includes('/embeddings')) return { ok: false, status: 503, text: async () => 'unavailable' } as any;
      const body = JSON.parse(String(init?.body ?? '{}'));
      const isSynthesis = (body.messages ?? []).some((m: any) => String(m.content).includes('knowledge base may be relevant'));
      if (isSynthesis) synthesis.push(body);
      const content = isSynthesis ? 'Both.' : '{"intent":"NONE","confidence":0.9}';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' } as any;
    }) as any;
    try {
      const res = await new ConversationOrchestrator().processIncomingMessage(
        { conversationId: `faq-kb-${randomBytes(3).toString('hex')}`, organizationId: orgId, customerPhoneNumber: '+2348000000098', channel: 'WHATSAPP', history: [], slots: {}, isHumanHandoffActive: false },
        'When is December Tourism Month?'
      );
      expect(res.intentDetected).toBe('FAQ_KB_ANSWER');
    } finally {
      global.fetch = priorFetch;
      delete process.env.OPENAI_API_KEY;
      await prisma.faqEntry.delete({ where: { id: faq.id } });
    }
    const prompt = synthesis[0].messages.map((m: any) => m.content).join('\n');
    expect(prompt).toContain("The agency's own approved answer to this question — give it FIRST");
    expect(prompt).toContain('December is Tourism Month in Plateau State.');
    expect(prompt).toContain('Urban Fest');
  });

  it('still answers a question about an agency by its own title', async () => {
    const results = await new QdrantRAGService().searchKnowledgeBase(orgId, 'urban planning approvals', 5);
    expect(results[0]?.title).toMatch(/Housing and Urban Development/);
  });
  it('searches the text when the vector index holds nothing for the question', async () => {
    // Documents loaded by the scripts/ have no vectors until Knowledge ->
    // Reindex is run. Vector search then came back EMPTY — not failing — and
    // an empty answer was returned as if the knowledge base had nothing, so
    // the lineup was never found on a deployment with OpenAI configured.
    process.env.OPENAI_API_KEY = 'sk-test-vectors-configured';
    try {
      const rag: any = new QdrantRAGService();
      rag.vectorSearch = async () => [];
      const results = await rag.searchKnowledgeBase(orgId, 'What events are happening in December?', 6);
      expect(results[0]?.title).toBe(LINEUP_TITLE);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});
