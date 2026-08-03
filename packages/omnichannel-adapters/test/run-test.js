const { InstagramDMAdapter, TelegramBotAdapter, EmailAIAssistantAdapter } = require('../dist/index.js');
const assert = require('assert');

async function testOmnichannelAdapters() {
  console.log('Testing Omnichannel Channel Adapters (Instagram, Telegram, Email)...');

  // Test 1: Instagram DM Adapter
  const igAdapter = new InstagramDMAdapter();
  const igPayload = {
    entry: [{ messaging: [{ message: { mid: 'mid.123', text: 'Hi, what are your store hours?' }, sender: { id: 'user_ig_99' }, timestamp: 1700000000 }] }],
  };
  const igMsg = igAdapter.parseWebhookPayload(igPayload);
  assert.strictEqual(igMsg.senderId, 'user_ig_99');
  assert.strictEqual(igMsg.text, 'Hi, what are your store hours?');

  // Test 2: Telegram Bot Adapter
  const tgAdapter = new TelegramBotAdapter();
  const tgPayload = {
    message: { message_id: 456, from: { id: 7788, first_name: 'Kofi', last_name: 'Mensah' }, text: 'Book hotel room', date: 1700000000 },
  };
  const tgMsg = tgAdapter.parseWebhookPayload(tgPayload);
  assert.strictEqual(tgMsg.senderId, '7788');
  assert.strictEqual(tgMsg.senderName, 'Kofi Mensah');
  assert.strictEqual(tgMsg.text, 'Book hotel room');

  // Test 3: Email AI Adapter
  const emailAdapter = new EmailAIAssistantAdapter();
  const emailPayload = { from: 'client@company.com', fromName: 'Client', subject: 'Inquiry', bodyText: 'Need pricing info' };
  const emailMsg = emailAdapter.parseWebhookPayload(emailPayload);
  assert.strictEqual(emailMsg.senderId, 'client@company.com');
  assert.ok(emailMsg.text.includes('Subject: Inquiry'));

  console.log('✅ ALL OMNICHANNEL ADAPTER TESTS PASSED SUCCESSFULLY!');
}

testOmnichannelAdapters().catch((err) => {
  console.error('❌ Omnichannel Adapter Test Failed:', err);
  process.exit(1);
});
