/**
 * Setting a contact's preferred language from the dashboard — and the field
 * whitelist that guards the write.
 *
 * The language field is the reason this endpoint was touched; the whitelist is
 * the reason it needed a test. `updateContact` used to pass the request body
 * straight into `prisma.contact.update`, with only the controller's TypeScript
 * parameter type standing in front of it — and types are erased before any of
 * this runs. A body carrying `organizationId` therefore rewrote the row's
 * tenancy and moved a customer into another organization's CRM.
 *
 * That case is pinned here rather than in a comment because it is silent when
 * it regresses: the request succeeds, the response looks ordinary, and the
 * contact is simply gone from the tenant that owned it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';

describe('PATCH /api/crm/contacts/:id — preferredLanguage and the field whitelist', () => {
  let app: INestApplication;
  let orgId: string;
  let otherOrgId: string;
  let contactId: string;
  let token: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    // Seeded directly: POST /auth/register is throttled 5/min per IP and the
    // whole CI suite shares one address.
    const email = `clang.${randomBytes(4).toString('hex')}@clang.test`;
    const password = 'ContactLangPassw0rd!';
    const org = await prisma.organization.create({
      data: { name: 'Contact Lang Ltd', slug: `clang-${randomBytes(4).toString('hex')}`, industry: 'CLINIC' },
    });
    orgId = org.id;
    const other = await prisma.organization.create({
      data: { name: 'Other Tenant', slug: `clang-other-${randomBytes(4).toString('hex')}`, industry: 'OTHER' },
    });
    otherOrgId = other.id;

    await prisma.user.create({
      data: {
        organizationId: orgId, email, fullName: 'Lang Tester', role: 'OWNER',
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
    token = login.body.accessToken;
    expect(token).toBeTruthy();

    const contact = await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber: '+2348030001111', fullName: 'Language Customer' },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => {});
    await app?.close();
  });

  const patch = (body: any) =>
    request(app.getHttpServer())
      .patch(`/api/crm/contacts/${contactId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('stores a supported language', async () => {
    await patch({ preferredLanguage: 'ha' }).expect(200);
    const row = await prisma.contact.findUnique({ where: { id: contactId }, select: { preferredLanguage: true } });
    expect(row?.preferredLanguage).toBe('ha');
  });

  it('clears the language back to "not yet known" on an empty value', async () => {
    await patch({ preferredLanguage: '' }).expect(200);
    const row = await prisma.contact.findUnique({ where: { id: contactId }, select: { preferredLanguage: true } });
    // null, not the empty string: absence of a detection is its own state, and
    // the resolver treats anything unrecognised as English.
    expect(row?.preferredLanguage).toBeNull();
  });

  it('refuses a language the platform cannot speak or write', async () => {
    await patch({ preferredLanguage: 'ha' }).expect(200);
    const res = await patch({ preferredLanguage: 'fr' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/preferredLanguage must be one of/);

    const row = await prisma.contact.findUnique({ where: { id: contactId }, select: { preferredLanguage: true } });
    expect(row?.preferredLanguage).toBe('ha'); // the rejected write changed nothing
  });

  it('ignores organizationId in the body — a contact cannot be moved between tenants', async () => {
    const res = await patch({ fullName: 'Renamed Customer', organizationId: otherOrgId });
    expect(res.status).toBeLessThan(400);

    const row = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { organizationId: true, fullName: true },
    });
    // The legitimate field was written...
    expect(row?.fullName).toBe('Renamed Customer');
    // ...and the tenancy was not.
    expect(row?.organizationId).toBe(orgId);
  });

  it('ignores an id in the body — the primary key is not writable', async () => {
    const strayId = randomBytes(12).toString('hex');
    await patch({ id: strayId, city: 'Jos' });

    const moved = await prisma.contact.findUnique({ where: { id: strayId } });
    expect(moved).toBeNull();
    const original = await prisma.contact.findUnique({ where: { id: contactId }, select: { city: true } });
    expect(original?.city).toBe('Jos');
  });

  it('refuses to touch a contact belonging to another organization', async () => {
    const stranger = await prisma.contact.create({
      data: { organizationId: otherOrgId, phoneNumber: '+2348030009999', fullName: 'Stranger' },
    });
    await request(app.getHttpServer())
      .patch(`/api/crm/contacts/${stranger.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ preferredLanguage: 'ig' })
      .expect(404);
  });
});
