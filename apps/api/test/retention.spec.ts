/**
 * `npm run retention:apply` (PRD §18). Pinned: report-only by default; with
 * --apply it removes old message text and transcripts for agencies that set a
 * period, keeps the rows, leaves recent content and other agencies alone, and
 * writes an audit entry. Also: the settings route refuses a period under 30 days.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Retention', () => {
  let app: INestApplication;
  let keep: TestTenant;
  let trim: TestTenant;
  const ids: Record<string, string> = {};
  jest.setTimeout(90000);
  const run = (...args: string[]) =>
    execFileSync('node', [join(__dirname, '..', '..', '..', 'scripts', 'apply-retention.js'), ...args], { encoding: 'utf8', env: process.env });

  const seed = async (t: TestTenant, key: string) => {
    const c = await prisma.contact.create({ data: { organizationId: t.orgId, fullName: 'C', phoneNumber: `+23480${randomBytes(4).readUInt32BE(0).toString().slice(0, 8).padStart(8, '3')}` } });
    const conv = await prisma.conversation.create({ data: { organizationId: t.orgId, contactId: c.id, channel: 'WHATSAPP' } });
    ids[`${key}Old`] = (await prisma.message.create({ data: { conversationId: conv.id, sender: 'CUSTOMER', content: 'my NIN is 12345678901', sentAt: new Date(Date.now() - 200 * 86_400_000) } })).id;
    ids[`${key}New`] = (await prisma.message.create({ data: { conversationId: conv.id, sender: 'CUSTOMER', content: 'recent question' } })).id;
    ids[`${key}Call`] = (await prisma.callLog.create({ data: { organizationId: t.orgId, contactId: c.id, callSid: `CA${randomBytes(8).toString('hex')}`, fromNumber: '+1', toNumber: '+2', transcript: 'old transcript', startedAt: new Date(Date.now() - 200 * 86_400_000) } })).id;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    app = await createTestApp();
    keep = await createTenant(app, 'retain-keep', { role: 'OWNER' });
    trim = await createTenant(app, 'retain-trim', { role: 'OWNER' });
    await seed(keep, 'keep');
    await seed(trim, 'trim');
  });

  afterAll(async () => {
    for (const t of [keep, trim]) {
      await prisma.message.deleteMany({ where: { conversation: { organizationId: t.orgId } } });
      await prisma.conversation.deleteMany({ where: { organizationId: t.orgId } });
      await prisma.callLog.deleteMany({ where: { organizationId: t.orgId } });
      await prisma.contact.deleteMany({ where: { organizationId: t.orgId } });
      await dropTenant(t.orgId);
    }
    await app?.close();
  });

  it('refuses a period under 30 days', async () => {
    await request(app.getHttpServer()).patch('/api/organizations/settings').set('Authorization', `Bearer ${trim.token}`).send({ retentionDays: 7 }).expect(400);
    await request(app.getHttpServer()).patch('/api/organizations/settings').set('Authorization', `Bearer ${trim.token}`).send({ retentionDays: 90 }).expect(200);
  });

  it('reports first, then removes only old content for agencies with a period', async () => {
    const report = run();
    expect(report).toMatch(/retain-trim .*keep 90 days.*1 message\(s\), 1 call/);
    expect((await prisma.message.findUnique({ where: { id: ids.trimOld } }))!.content).toContain('NIN');

    run('--apply');
    expect((await prisma.message.findUnique({ where: { id: ids.trimOld } }))!.content).toMatch(/removed under/);
    expect((await prisma.message.findUnique({ where: { id: ids.trimNew } }))!.content).toBe('recent question');
    expect((await prisma.callLog.findUnique({ where: { id: ids.trimCall } }))!.transcript).toBeNull();
    // An agency with no period keeps everything.
    expect((await prisma.message.findUnique({ where: { id: ids.keepOld } }))!.content).toContain('NIN');
    expect((await prisma.callLog.findUnique({ where: { id: ids.keepCall } }))!.transcript).toBe('old transcript');
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: trim.orgId, action: 'retention.applied' } });
    expect(audit!.newValue).toMatchObject({ messages: 1, calls: 1 });
  });
});
