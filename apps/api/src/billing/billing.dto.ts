import { IsEnum, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { SubscriptionPlan } from './billing.service';

export class CheckoutDto {
  @IsEnum(SubscriptionPlan, {
    message: `plan must be one of: ${Object.values(SubscriptionPlan).join(', ')}`,
  })
  plan!: SubscriptionPlan;
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
