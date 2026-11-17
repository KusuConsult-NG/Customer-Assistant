import { WhatsAppCloudClient } from '../src/index';

describe('WhatsApp Cloud SDK Tests', () => {
  const client = new WhatsAppCloudClient({
    phoneNumberId: '1092837465',
    accessToken: 'test_access_token',
    verifyToken: 'ace_whatsapp_verify_token_2026',
  });

  it('should verify webhook challenge correctly', () => {
    const challenge = client.verifyWebhook('subscribe', 'ace_whatsapp_verify_token_2026', 'challenge_code_123');
    expect(challenge).toBe('challenge_code_123');
  });

  it('should return null for invalid verify token', () => {
    const challenge = client.verifyWebhook('subscribe', 'invalid_token', 'challenge_code_123');
    expect(challenge).toBeNull();
  });

  it('should parse text message webhook payload', () => {
    const mockPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.12345',
                    from: '2348023456789',
                    type: 'text',
                    text: { body: 'Hello ACE Platform' },
                    timestamp: '1700000000',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const parsed = client.parseWebhookPayload(mockPayload, 'org-test-id');
    expect(parsed).not.toBeNull();
    expect(parsed?.fromNumber).toBe('2348023456789');
    expect(parsed?.textContent).toBe('Hello ACE Platform');
  });
});

describe('Sending a complete answer that is longer than one WhatsApp message', () => {
  // Meta refuses a text body over 4096 characters, so a full answer (every
  // event of a lineup) was refused outright and the citizen got nothing.
  const { splitWhatsAppText, WHATSAPP_TEXT_LIMIT } = require('../src/index');

  const longAnswer = Array.from({ length: 60 }, (_, i) =>
    `${i + 1}. Event number ${i + 1} — 18 to 28 December 2026, Christmas Village, Jonah Jang Way, Jos. Organised by the Government.`
  ).join('\n');

  it('splits at line boundaries, keeps every word, and keeps each part under the limit', () => {
    const parts: string[] = splitWhatsAppText(longAnswer);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT);
    // Nothing lost, nothing cut mid-line.
    expect(parts.join('\n')).toBe(longAnswer);
  });

  it('leaves a short reply as one message', () => {
    expect(splitWhatsAppText('Hello there.')).toEqual(['Hello there.']);
  });

  it('sends every part, in order, and returns the last part\'s receipt', async () => {
    const client = new WhatsAppCloudClient({ phoneNumberId: 'pn_1', accessToken: 'token_x', businessAccountId: 'b' } as any);
    const sent: string[] = [];
    (client as any).postRequest = async (_url: string, body: any) => {
      sent.push(body.text.body);
      return { messages: [{ id: `wamid_${sent.length}` }] };
    };
    const res = await client.sendTextMessage('+2348000000000', longAnswer);
    expect(sent.join('\n')).toBe(longAnswer);
    expect(res.messages[0].id).toBe(`wamid_${sent.length}`);
  });
});
