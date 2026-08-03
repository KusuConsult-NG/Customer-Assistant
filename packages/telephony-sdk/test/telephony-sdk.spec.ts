import { TelephonyFactory, NigeriaCarrierForwardProvider, TwilioProvider } from '../src/index';
import { TelephonyProviderType } from '@ace/shared-types';

describe('Telephony SDK Tests', () => {
  it('should instantiate NigeriaCarrierForwardProvider and validate Nigerian numbers', async () => {
    const provider = TelephonyFactory.createProvider(TelephonyProviderType.NIGERIA_CARRIER_FORWARD);
    expect(provider.type).toBe(TelephonyProviderType.NIGERIA_CARRIER_FORWARD);

    const isValidMTN = await provider.verifyCallerId('+2348031234567');
    expect(isValidMTN).toBe(true);

    const isValidAirtel = await provider.verifyCallerId('08129876543');
    expect(isValidAirtel).toBe(true);

    const isInvalid = await provider.verifyCallerId('12345');
    expect(isInvalid).toBe(false);
  });

  it('should generate TwiML XML response for Twilio provider', () => {
    const twilio = new TwilioProvider('AC_test', 'token_test');
    const xml = twilio.generateInboundWebhookResponse('Welcome to ApexCare', 'wss://api.apexcare.ng/stream');
    expect(xml).toContain('Welcome to ApexCare');
    expect(xml).toContain('<Stream url="wss://api.apexcare.ng/stream" />');
  });
});
