import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';

/**
 * Removing a voice line an agency no longer holds.
 *
 * There was no way to do this at all, so a number the carrier does not route
 * stayed on the settings screen and kept `voice-readiness` reporting BLOCKED.
 * A blocker nobody can clear teaches an operator to read the whole report as
 * noise, which is the one thing that report cannot afford.
 */
describe('DELETE /api/organizations/telephony-config/:id', () => {
  let app: INestApplication;
  let orgId: string;
  let otherOrgId: string;
  let ownerToken: string;
  let viewerToken: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    app = await createTestApp();

    const mkOrg = async (slug: string) =>
      (await prisma.organization.create({
        data: { name: slug, slug: `${slug}-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
      })).id;
    orgId = await mkOrg('line-del');
    otherOrgId = await mkOrg('line-del-other');

    const mk = async (role: 'OWNER' | 'VIEWER') => {
      const email = `line.${role.toLowerCase()}.${randomBytes(4).toString('hex')}@line.test`;
      const password = 'LinePassw0rd!';
      await prisma.user.create({
        data: {
          organizationId: orgId, email, fullName: role, role,
          passwordHash: await bcrypt.hash(password, 10), emailVerifiedAt: new Date(),
        },
      });
      return (await request(app.getHttpServer()).post('/api/auth/login').send({ email, password }))
        .body.accessToken as string;
    };
    ownerToken = await mk('OWNER');
    viewerToken = await mk('VIEWER');
  });

  afterAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await prisma.callLog.deleteMany({ where: { organizationId: id } });
      await prisma.telephonyConfig.deleteMany({ where: { organizationId: id } });
      await prisma.user.deleteMany({ where: { organizationId: id } });
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  const makeLine = (organizationId: string) =>
    prisma.telephonyConfig.create({
      data: {
        organizationId,
        provider: 'TWILIO',
        phoneNumber: `+1737${randomBytes(3).readUIntBE(0, 3).toString().padStart(7, '0').slice(0, 7)}`,
        isDefault: true,
      },
    });

  const del = (id: string, token = ownerToken) =>
    request(app.getHttpServer())
      .delete(`/api/organizations/telephony-config/${id}`)
      .set('Authorization', `Bearer ${token}`);

  it('removes the line and says so', async () => {
    const line = await makeLine(orgId);
    const res = await del(line.id);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.phoneNumber).toBe(line.phoneNumber);
    expect(await prisma.telephonyConfig.findUnique({ where: { id: line.id } })).toBeNull();
  });

  it('KEEPS the call history, and says how much', async () => {
    const line = await makeLine(orgId);
    const call = await prisma.callLog.create({
      data: {
        organizationId: orgId,
        telephonyConfigId: line.id,
        callSid: `CA${randomBytes(8).toString('hex')}`,
        fromNumber: '+2348031111111',
        toNumber: line.phoneNumber,
        status: 'COMPLETED' as any,
      },
    });

    const res = await del(line.id);
    expect(res.body.callsKept).toBe(1);
    expect(res.body.note).toMatch(/call record/i);

    // The record of what a citizen was told survives losing the line that
    // carried it; only the link goes.
    const after = await prisma.callLog.findUnique({ where: { id: call.id } });
    expect(after).not.toBeNull();
    expect(after!.telephonyConfigId).toBeNull();
    expect(after!.fromNumber).toBe('+2348031111111');
  });

  it('warns when that was the agency\'s last line', async () => {
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    const line = await makeLine(orgId);
    const res = await del(line.id);
    expect(res.body.remainingLines).toBe(0);
    expect(res.body.note).toMatch(/no voice line/i);
  });

  it("cannot reach another agency's line", async () => {
    const theirs = await makeLine(otherOrgId);
    const res = await del(theirs.id);
    // A 404, not a silent no-op and not a success: scoping the delete in the
    // WHERE clause is what makes a mistyped id a refusal.
    expect(res.status).toBe(404);
    expect(await prisma.telephonyConfig.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });

  it('is refused to a VIEWER', async () => {
    const line = await makeLine(orgId);
    expect((await del(line.id, viewerToken)).status).toBe(403);
    expect(await prisma.telephonyConfig.findUnique({ where: { id: line.id } })).not.toBeNull();
  });

  it('records who removed it', async () => {
    const line = await makeLine(orgId);
    await del(line.id);
    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: orgId, action: 'agency.telephony_line.deleted', targetId: line.id },
    });
    // The one action with no undo on this screen; "who removed our number"
    // must always have an answer.
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.previousValue)).toContain(line.phoneNumber);
  });

  it('is a 404 for a line that does not exist', async () => {
    expect((await del('00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });
});
