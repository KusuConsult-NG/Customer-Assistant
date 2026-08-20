import { Global, Module } from '@nestjs/common';
import { OnboardingController, PublicSelfieController, PublicPaymentController, SelfieRedirectController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Global so the WhatsApp pipeline and the workflow engine can attach or request a
 * selfie without importing this module (and without a circular graph).
 */
@Global()
@Module({
  controllers: [OnboardingController, PublicSelfieController, PublicPaymentController, SelfieRedirectController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
