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
