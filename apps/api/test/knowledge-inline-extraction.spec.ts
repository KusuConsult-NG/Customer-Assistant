/**
 * A Word or PDF document is readable without Redis.
 *
 * With the Upstash quota spent, REDIS_URL was removed and every DOCX upload
 * failed — "No text could be extracted … PDF and DOCX extraction requires the
 * background worker" — though the parsers (mammoth, pdf-parse) were installed
 * and the worker runs in this same process: Redis carries its QUEUE, not the
 * reading of a file. The agency's December Tourism Month lineup, a .docx, was
 * the document that failed. The inline path now uses the worker's own
 * extractor, so these build a real .docx and index it with no queue at all.
 */
import { randomBytes } from 'crypto';
import JSZip from 'jszip';
import { prisma } from '@ace/database';
import { KnowledgeService } from '../src/knowledge/knowledge.service';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The smallest .docx Word and mammoth both read: one paragraph per line given. */
async function docx(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${DOCX}.main+xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${l}</w:t></w:r></w:p>`).join('') +
      '</w:body></w:document>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Indexing a Word document without the background worker', () => {
  jest.setTimeout(30000);
  let orgId: string;
  const service = new KnowledgeService();

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Inline Extraction Agency', slug: `inline-extract-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    await prisma.documentChunk.deleteMany({ where: { organizationId: orgId } });
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  const newDoc = (fileName: string) =>
    prisma.knowledgeDocument.create({
      data: {
        organizationId: orgId, title: fileName, fileName, fileSize: 1, mimeType: DOCX,
        storageUrl: `test/${fileName}`, status: 'PROCESSING',
      },
    });

  it('reads the words out of a .docx and stores them as searchable chunks', async () => {
    const doc = await newDoc('December_Tourism_Month_2026_Events_Lineup.docx');
    const body = await docx([
      'DECEMBER TOURISM MONTH 2026',
      '31 Dec–1 Jan: New Year Crossover and Fireworks Countdown, Secretariat Flyover Bridge and roundabout, Jos. Government (PSTC).',
      '22–27 Dec: Urban Fest: graffiti, music, basketball and gaming arena, Azi Nyako Youth Centre, Jos.',
    ]);

    const result = await (service as any).indexDocumentInline(orgId, doc.id, body, DOCX, doc.fileName);

    expect(result.chunkCount).toBeGreaterThan(0);
    const text = (await prisma.documentChunk.findMany({ where: { documentId: doc.id } })).map((c) => c.content).join('\n');
    expect(text).toContain('New Year Crossover and Fireworks Countdown');
    expect(text).toContain('Azi Nyako Youth Centre');
    // Words, not the zip container decoded as text.
    expect(text).not.toMatch(/PK\u0003\u0004|word\/document\.xml/);
  });

  it('refuses a file that is not really a Word document, saying why', async () => {
    const doc = await newDoc('not-really.docx');
    await expect(
      (service as any).indexDocumentInline(orgId, doc.id, Buffer.from('this is not a zip archive'), DOCX, doc.fileName)
    ).rejects.toThrow(/No text could be extracted/);
    expect(await prisma.documentChunk.count({ where: { documentId: doc.id } })).toBe(0);
  });
});
