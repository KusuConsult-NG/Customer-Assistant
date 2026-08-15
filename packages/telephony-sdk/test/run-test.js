const { TelephonyFactory, TwilioProvider, NigeriaCarrierForwardProvider } = require('../dist/index.js');
const assert = require('assert');

async function testTelephonySDK() {
  console.log('Testing Telephony SDK Abstraction Layer...');

  // Test 1: Nigeria Carrier Forwarding Provider
  const ngProvider = TelephonyFactory.createProvider('NIGERIA_CARRIER_FORWARD');
  assert.strictEqual(ngProvider.type, 'NIGERIA_CARRIER_FORWARD');

  const validMTN = await ngProvider.verifyCallerId('+2348031234567');
  assert.strictEqual(validMTN, true, 'Should validate MTN number (+234803)');

  const validAirtel = await ngProvider.verifyCallerId('08129876543');
  assert.strictEqual(validAirtel, true, 'Should validate Airtel number (0812)');

  const invalidNum = await ngProvider.verifyCallerId('1234');
  assert.strictEqual(invalidNum, false, 'Should reject invalid short number');

  // Test 2: Twilio TwiML Generation
  //
  // CONTRACT (updated): the TwiML deliberately contains NO <Say> — the welcome
  // message is played through ElevenLabs over the media stream so the entire
  // call uses one consistent voice (see twilio-media-stream.handler.ts, Fix 4).
  // The old assertions checked for the prompt text in the TwiML, which is the
  // exact behavior that was removed on purpose.
  const twilio = new TwilioProvider('AC_mock', 'token_mock');
  const xml = twilio.generateInboundWebhookResponse('Hello ApexCare', 'wss://api.apexcare.ng/stream');
  assert.ok(!xml.includes('<Say>'), 'TwiML must NOT contain <Say> — welcome plays via ElevenLabs on the stream');
  assert.ok(xml.includes('<Connect>'), 'TwiML must open a <Connect> block');
  assert.ok(xml.includes('<Stream url="wss://api.apexcare.ng/stream"'), 'TwiML must contain the WebSocket Stream URL');
  assert.ok(xml.includes('track="both_tracks"'), 'Stream must request both audio tracks');

  console.log('✅ ALL TELEPHONY SDK TESTS PASSED SUCCESSFULLY!');
}

testTelephonySDK().catch((err) => {
  console.error('❌ Telephony SDK Test Failed:', err);
  process.exit(1);
});
