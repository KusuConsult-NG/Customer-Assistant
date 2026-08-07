import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class WidgetChatDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  apiKey?: string;

  /** Accepted as an alias for apiKey — the embed snippet supports `data-org-id`. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  orgId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  sessionId!: string;

  /**
   * Capped so a single request cannot push an enormous prompt into the LLM.
   * These endpoints are unauthenticated.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerPhone?: string;
}
