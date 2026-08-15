const { WhatsAppCloudClient } = require('../dist/index.js');
const assert = require('assert');

async function testWhatsAppSDK() {
  console.log('Testing Meta WhatsApp Business Cloud API SDK...');

  const client = new WhatsAppCloudClient({
    phoneNumberId: '1092837465',
    accessToken: 'sk-proj-placeholder',
    verifyToken: 'ace_whatsapp_verify_token_2026',
  });

  // Test 1: Webhook Verification
  const challenge = client.verifyWebhook('subscribe', 'ace_whatsapp_verify_token_2026', 'challenge_999');
  assert.strictEqual(challenge, 'challenge_999', 'Should return challenge code on valid token');

  const invalid = client.verifyWebhook('subscribe', 'wrong_token', 'challenge_999');
  assert.strictEqual(invalid, null, 'Should return null on wrong verify token');

  // Test 1b: HMAC SHA256 Signature Verification
  const crypto = require('crypto');
  const payloadStr = JSON.stringify({ test: 'data' });
  const appSecret = 'meta_secret_key_123';
  const hmac = crypto.createHmac('sha256', appSecret).update(payloadStr).digest('hex');
  const isValidSig = client.verifySignature(payloadStr, `sha256=${hmac}`, appSecret);
  assert.strictEqual(isValidSig, true, 'HMAC signature verification should succeed for valid signature');

  // Test 2: Payload Parser
  const mockPayload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: 'wamid.123456',
                  from: '2348023456789',
                  type: 'text',
                  text: { body: 'Schedule appointment with doctor' },
                  timestamp: '1700000000',
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const parsed = client.parseWebhookPayload(mockPayload, 'org-uuid-1');
  assert.ok(parsed !== null, 'Parsed payload should not be null');
  assert.strictEqual(parsed.fromNumber, '2348023456789');
  assert.strictEqual(parsed.textContent, 'Schedule appointment with doctor');

  // Test 3: Delivery failures must surface — never a synthetic wamid.
  //
  // CONTRACT (updated): the placeholder-token "demo mode" that returned a
  // mock `wamid.mock.*` id was removed on purpose. Callers treated that
  // synthetic id as proof of delivery (reply_delivered logs, broadcast sent
  // counts), so a misconfigured tenant saw a green dashboard while no
  // customer ever received a message. Without real Meta credentials this
  // call MUST reject (auth or network error) — resolving would mean the SDK
  // fabricated a delivery.
  let sendFailed = false;
  try {
    await client.sendTextMessage('2348023456789', 'Your appointment is confirmed!');
  } catch (err) {
    sendFailed = true;
  }
  assert.strictEqual(sendFailed, true, 'sendTextMessage without real credentials must throw, not return a mock wamid');

  console.log('✅ ALL WHATSAPP SDK TESTS PASSED SUCCESSFULLY!');
}

testWhatsAppSDK().catch((err) => {
  console.error('❌ WhatsApp SDK Test Failed:', err);
  process.exit(1);
});
