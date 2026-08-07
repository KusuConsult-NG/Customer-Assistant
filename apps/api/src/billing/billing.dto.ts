import { IsEnum, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { SubscriptionPlan } from './billing.service';

export class CheckoutDto {
  @IsEnum(SubscriptionPlan, {
    message: `plan must be one of: ${Object.values(SubscriptionPlan).join(', ')}`,
  })
  plan!: SubscriptionPlan;
}

/**
 * Activating a plan requires proof that somebody paid.
 *
 * The reference is verified against Paystack directly — its existence in this request
 * proves nothing on its own.
 */
export class ActivatePlanDto {
  @IsEnum(SubscriptionPlan, {
    message: `plan must be one of: ${Object.values(SubscriptionPlan).join(', ')}`,
  })
  plan!: SubscriptionPlan;

  @IsString()
  @MinLength(6)
  @MaxLength(200)
  reference!: string;
}

export class ServicePaymentGuidanceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  serviceName!: string;

  /**
   * Amount in whole Naira. Integer and positive: a negative or fractional amount
   * would produce nonsense payment instructions and, with Paystack, a kobo amount
   * that does not match what the customer was told.
   */
  @IsInt()
  @Min(1)
  amountNgn!: number;
}
