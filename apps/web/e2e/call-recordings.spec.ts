import { test, expect, Page } from '@playwright/test';
import { randomBytes } from 'crypto';

/**
 * Playing a call back, on the call list and on the case it opened.
 *
 * Every call on the telephony screen used to show a disabled "Play Audio":
 * the audio existed (ElevenLabs keeps it) and nothing recorded where. The
 * audio is fetched with the agency's ElevenLabs key, which the browser never
 * holds, so the player must ask OUR API with the officer's session — these
 * assert on that request, not only on what is drawn, because a player that
 * opened a bare link would look the same and play nothing.
 *
 * The audio bytes are stubbed (no sandbox holds a recorded call). Everything
 * else — the call list, the case, the "Call record" section, and a refusal —
 * comes from the real API.
 */

const createdOrgIds: string[] = [];
const FAKE_MP3 = Buffer.from('ID3\u0004fake-mp3-for-e2e');

type Seeded = { token: string; playableCallId: string; unrecordedCallId: string; ticketNumber: string };

async function seed(): Promise<Seeded> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set for the call-recordings e2e.');

  const tag = `e2erec-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `${tag} Agency`, slug: tag, industry: 'GOVERNMENT' } });
  createdOrgIds.push(org.id);
  await prisma.hostedAgentConfig.create({ data: { organizationId: org.id, agentId: `agent_${tag}` } });
  const user = await prisma.user.create({
    data: { organizationId: org.id, email: `${tag}@mda.test`, passwordHash: 'x', fullName: 'Amina Officer', role: 'OWNER' },
  });
  const digits = String(randomBytes(3).readUIntBE(0, 3)).padStart(8, '0').slice(0, 8);
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, phoneNumber: `+23481${digits}`, fullName: 'Ngozi Pam' },
  });
  const played = await prisma.callLog.create({
    data: {
      organizationId: org.id, contactId: contact.id, callSid: `CA${tag}a`, fromNumber: contact.phoneNumber,
      toNumber: '+2348000000001', status: 'COMPLETED', durationSeconds: 95, recordingUrl: `elevenlabs:conv_${tag}`,
      transcript: 'agent: Good morning.\nuser: The culvert at Vom Junction has collapsed.',
      summary: 'Caller reported a collapsed culvert.',
    },
  });
  // Answered by the agent, but stored before references were kept: Play is
  // offered and the REAL API decides (here: this agency has no workspace key).
  const unrecorded = await prisma.callLog.create({
    data: {
      organizationId: org.id, contactId: contact.id, callSid: `CA${tag}b`, fromNumber: contact.phoneNumber,
      toNumber: '+2348000000001', status: 'COMPLETED', durationSeconds: 30,
    },
  });
  const ticket = await prisma.ticket.create({
    data: {
      organizationId: org.id, contactId: contact.id, ticketNumber: `TCK-${tag}`, subject: 'Collapsed culvert',
      description: 'The culvert has collapsed.', summary: 'A collapsed culvert at Vom Junction.', caseStage: 'CLASSIFIED',
      category: 'roads', channel: 'VOICE',
      events: {
        create: [
          { organizationId: org.id, type: 'CREATED', actorLabel: 'system:voice-agent', body: `Opened from a phone call. Call reference: conv_${tag}.` },
          { organizationId: org.id, type: 'CALL_RECORDED', actorLabel: 'system:voice-agent', body: `Call recorded: ${played.id} (1m 35s). The transcript and recording are on the call record.` },
        ],
      },
    },
  });
  const token = jwt.sign(
    { userId: user.id, email: user.email, fullName: user.fullName, organizationId: org.id, role: 'OWNER', tokenVersion: user.tokenVersion ?? 0 },
    secret,
    { expiresIn: '1h' }
  );
  return { token, playableCallId: played.id, unrecordedCallId: unrecorded.id, ticketNumber: ticket.ticketNumber };
}

test.afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  for (const id of createdOrgIds) {
    await prisma.callLog.deleteMany({ where: { organizationId: id } }).catch(() => {});
    await prisma.organization.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

async function signIn(page: Page, token: string) {
  await page.addInitScript((t) => {
    window.localStorage.setItem('ace_token', t as string);
    window.localStorage.setItem('ace_user', JSON.stringify({ fullName: 'Amina Officer', email: 'amina@mda.test', role: 'OWNER', organizationName: 'E2E' }));
  }, token);
}

/** Answer the audio request for one call, recording what was asked. */
async function stubAudio(page: Page, callId: string) {
  const asked: Array<{ url: string; auth: string | undefined }> = [];
  await page.route(`**/api/calls/${callId}/recording`, (route) => {
    asked.push({ url: route.request().url(), auth: route.request().headers()['authorization'] });
    return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: FAKE_MP3 });
  });
  return asked;
}

test.describe('Playing call recordings', () => {
  test('the call list plays a call through the API, with the officer’s session', async ({ page }) => {
    const s = await seed();
    const asked = await stubAudio(page, s.playableCallId);
    await signIn(page, s.token);
    await page.goto('/telephony');

    // 95 seconds is 1m 35s (it used to read 2m 35s), and the call has a time
    // (it used to read "—" for every call).
    const row = page.locator('tr', { hasText: '1m 35s' });
    await expect(row).toBeVisible({ timeout: 20000 });
    await expect(row).toContainText(String(new Date().getFullYear()));
    await row.getByRole('button', { name: /Play Audio/ }).click();

    await expect(row.locator('audio[aria-label="Call recording"]')).toBeVisible();
    expect(asked).toHaveLength(1);
    expect(asked[0].auth).toBe(`Bearer ${s.token}`);
  });

  test('shows the API’s own reason when there is nothing it can play', async ({ page }) => {
    const s = await seed();
    await signIn(page, s.token);
    await page.goto('/telephony');

    const row = page.locator('tr', { hasText: '0m 30s' });
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.getByRole('button', { name: /Play Audio/ }).click();

    // Real API: this agency has an agent but no ElevenLabs key of its own.
    const alert = row.getByRole('alert');
    await expect(alert).toContainText('Agent Provisioning → Credentials');
    await expect(row.locator('audio')).toHaveCount(0);
  });

  test('the case keeps the call it was opened on: transcript and recording', async ({ page }) => {
    const s = await seed();
    const asked = await stubAudio(page, s.playableCallId);
    await signIn(page, s.token);
    await page.goto('/cases');

    await page.getByRole('button', { name: new RegExp(s.ticketNumber) }).click();
    const section = page.locator('article', { has: page.getByRole('heading', { name: 'Call record' }) });
    await expect(section).toBeVisible({ timeout: 20000 });
    await expect(section).toContainText('Caller reported a collapsed culvert.');
    await section.getByText('Transcript').click();
    await expect(section).toContainText('The culvert at Vom Junction has collapsed.');

    await section.getByRole('button', { name: /Play Audio/ }).click();
    await expect(section.locator('audio[aria-label="Call recording"]')).toBeVisible();
    expect(asked).toHaveLength(1);
  });
});
