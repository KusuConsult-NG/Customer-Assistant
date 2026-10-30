/**
 * The catalogue editor.
 *
 * These rows decide what the AI offers a citizen and where it sends them, so
 * the tests that matter are the refusals:
 *
 *   - one agency cannot read or edit another's services and locations;
 *   - an AGENT cannot change what the AI offers mid-conversation;
 *   - an LGA the State does not have is rejected, because a location filed
 *     under a misspelling exists in the dashboard and nowhere a citizen can
 *     actually be sent.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Service catalogue', () => {
  let app: INestApplication;
  let a: TestTenant;      // agency A, OWNER
  let b: TestTenant;      // agency B, OWNER
  let agent: TestTenant;  // an AGENT inside agency A

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    a = await createTenant(app, 'catalogue-a', { role: 'OWNER' });
    b = await createTenant(app, 'catalogue-b', { role: 'OWNER' });
    agent = await createTenant(app, 'catalogue-agent', { role: 'AGENT' });
  });

  afterAll(async () => {
    await dropTenant(a?.orgId);
    await dropTenant(b?.orgId);
    await dropTenant(agent?.orgId);
    await app?.close();
  });

  const as = (t: TestTenant, m: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    (request(app.getHttpServer()) as any)[m](path).set('Authorization', `Bearer ${t.token}`);

  describe('tenant isolation', () => {
    let aServiceId: string;
    let aLocationId: string;

    beforeAll(async () => {
      const svc = await as(a, 'post', '/api/catalogue/services')
        .send({ name: 'Vehicle Licence Renewal', matchPhrases: ['vehicle', 'licence'] })
        .expect(201);
      aServiceId = svc.body.id;

      const loc = await as(a, 'post', '/api/catalogue/locations')
        .send({ name: 'Jos North Area Office', lga: 'Jos North' })
        .expect(201);
      aLocationId = loc.body.id;
    });

    it('lists only its own services', async () => {
      const mine = await as(a, 'get', '/api/catalogue/services').expect(200);
      const theirs = await as(b, 'get', '/api/catalogue/services').expect(200);

      expect(mine.body.map((s: any) => s.name)).toContain('Vehicle Licence Renewal');
      expect(theirs.body.map((s: any) => s.name)).not.toContain('Vehicle Licence Renewal');
    });

    it('refuses to edit another agency’s service', async () => {
      await as(b, 'patch', `/api/catalogue/services/${aServiceId}`)
        .send({ name: 'Hijacked' })
        .expect(404);

      const row = await prisma.serviceOption.findUnique({ where: { id: aServiceId } });
      expect(row?.name).toBe('Vehicle Licence Renewal');
    });

    it('refuses to delete another agency’s location', async () => {
      await as(b, 'delete', `/api/catalogue/locations/${aLocationId}`).expect(404);
      expect(await prisma.serviceLocation.findUnique({ where: { id: aLocationId } })).toBeTruthy();
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/catalogue/services').expect(401);
    });
  });

  describe('who may change what the AI offers', () => {
    it('lets an AGENT read the catalogue', async () => {
      await as(agent, 'get', '/api/catalogue/services').expect(200);
    });

    it('refuses an AGENT creating a service', async () => {
      await as(agent, 'post', '/api/catalogue/services')
        .send({ name: 'Something An Agent Invented' })
        .expect(403);
      expect(
        await prisma.serviceOption.count({ where: { organizationId: agent.orgId } })
      ).toBe(0);
    });
  });

  describe('locations must be somewhere citizens can be sent', () => {
    it('rejects an LGA the State does not have', async () => {
      const res = await as(a, 'post', '/api/catalogue/locations')
        .send({ name: 'Nowhere Office', lga: 'Ikeja' })
        .expect(400);
      expect(res.body.message).toMatch(/not a Plateau State LGA/i);
    });

    it('normalises a near miss rather than rejecting it', async () => {
      // "Jos Northe" is a typo, not a different place. Rejecting it would be
      // pedantry; storing it verbatim would be worse, because the flow matches
      // against the State's spelling and would never find the office. It is
      // resolved and stored as "Jos North", which is reachable.
      const res = await as(a, 'post', '/api/catalogue/locations')
        .send({ name: `Typo Office ${randomBytes(3).toString('hex')}`, lga: 'Jos Northe' })
        .expect(201);
      expect(res.body.lga).toBe('Jos North');
    });

    it('stores the State’s own spelling, so the flow can match it', async () => {
      const res = await as(a, 'post', '/api/catalogue/locations')
        .send({ name: `Casual Spelling Office ${randomBytes(2).toString('hex')}`, lga: 'jos south' })
        .expect(201);
      expect(res.body.lga).toBe('Jos South');
    });

    it('allows the same name in two different LGAs', async () => {
      const name = `Referral Centre ${randomBytes(3).toString('hex')}`;
      await as(a, 'post', '/api/catalogue/locations').send({ name, lga: 'Shendam' }).expect(201);
      // A referral site serving two LGAs is two rows, not a clash.
      await as(a, 'post', '/api/catalogue/locations').send({ name, lga: 'Kanam' }).expect(201);
    });

    it('refuses the same name twice in ONE LGA', async () => {
      const name = `Duplicate Office ${randomBytes(3).toString('hex')}`;
      await as(a, 'post', '/api/catalogue/locations').send({ name, lga: 'Mangu' }).expect(201);
      await as(a, 'post', '/api/catalogue/locations').send({ name, lga: 'Mangu' }).expect(409);
    });

    it('offers the State’s LGAs rather than taking free text', async () => {
      const res = await as(a, 'get', '/api/catalogue/lgas').expect(200);
      expect(res.body.lgas).toHaveLength(17);
      expect(res.body.lgas).toContain('Jos North');
    });
  });

  describe('services', () => {
    it('normalises match phrases to what is actually compared', async () => {
      const res = await as(a, 'post', '/api/catalogue/services')
        .send({
          name: `Phrase Test ${randomBytes(3).toString('hex')}`,
          matchPhrases: ['  Trader ', 'TRADER', 'farmer', '  '],
        })
        .expect(201);
      // Lowercased, trimmed, de-duplicated and blanks dropped, so the editor
      // shows exactly what a citizen's words are matched against.
      expect(res.body.matchPhrases).toEqual(['trader', 'farmer']);
    });

    it('refuses a service with no usable name', async () => {
      await as(a, 'post', '/api/catalogue/services').send({ name: ' ' }).expect(400);
    });

    it('refuses two services with the same name', async () => {
      const name = `Clash ${randomBytes(3).toString('hex')}`;
      await as(a, 'post', '/api/catalogue/services').send({ name }).expect(201);
      await as(a, 'post', '/api/catalogue/services').send({ name }).expect(409);
    });

    it('records cost from the row, not from the name', async () => {
      // A paid service whose name reads "free". The old regex over the label
      // would have waived it.
      const res = await as(a, 'post', '/api/catalogue/services')
        .send({ name: `Freehold Title ${randomBytes(3).toString('hex')}`, isNoCost: false })
        .expect(201);
      expect(res.body.isNoCost).toBe(false);
    });

    it('deactivates without deleting, so the flow stops offering it', async () => {
      const created = await as(a, 'post', '/api/catalogue/services')
        .send({ name: `Retired Service ${randomBytes(3).toString('hex')}` })
        .expect(201);

      await as(a, 'patch', `/api/catalogue/services/${created.body.id}`)
        .send({ isActive: false })
        .expect(200);

      const row = await prisma.serviceOption.findUnique({ where: { id: created.body.id } });
      expect(row?.isActive).toBe(false);
    });
  });
});
