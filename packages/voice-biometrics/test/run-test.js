const { VoiceBiometricsService } = require('../dist/index.js');
const assert = require('assert');

async function testVoiceBiometrics() {
  console.log('Testing Voice Biometrics Speaker Verification...');

  // Test 1: Enrollment
  const profile = await VoiceBiometricsService.enrollVoiceprint('contact_123', 'audio_sample_data_base64');
  assert.strictEqual(profile.contactId, 'contact_123');
  assert.ok(profile.voiceprintHash.includes('vp_contact_123'));

  // Test 2: Verification
  const verification = await VoiceBiometricsService.verifySpeaker('contact_123', 'incoming_live_audio_base64_sample');
  assert.strictEqual(verification.verified, true);
  assert.ok(verification.matchScore > 0.9);

  console.log('✅ ALL VOICE BIOMETRICS TESTS PASSED SUCCESSFULLY!');
}

testVoiceBiometrics().catch((err) => {
  console.error('❌ Voice Biometrics Test Failed:', err);
  process.exit(1);
});
