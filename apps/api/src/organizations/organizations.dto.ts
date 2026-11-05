import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Organization request DTOs.
 *
 * Same reason as `auth.dto.ts`: the global ValidationPipe can only validate a
 * body whose declared type is a CLASS carrying class-validator metadata. An
 * inline `@Body() body: { phoneNumberId: string; … }` type is erased at
 * runtime, so the pipe has no metatype, forwards whatever arrived, and a
 * missing required field reaches Prisma as `undefined`.
 *
 * That is not a theoretical gap — it is how connecting a WhatsApp line failed.
 * `webhookVerifyToken` was declared required on the inline type and enforced
 * nowhere, so a request without it answered:
 *
 *     {"statusCode":500,"error":"Internal Server Error",
 *      "message":"An unexpected error occurred."}
 *
 * on an endpoint whose whole job is to tell an operator whether their line
 * saved. Nothing in that response names the field, nothing distinguishes it
 * from a database outage or a bad credential, and the operator's next move is
 * to go looking for a fault in Meta. With a class it is a 400 that says
 * `webhookVerifyToken should not be empty`.
 */
export class UpdateWhatsAppConfigDto {
  /**
   * The line being edited. An agency may hold SEVERAL WhatsApp lines — inbound
   * is resolved by Meta's phoneNumberId — and without this the save overwrote
   * whichever row came back first, not necessarily the one on screen.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  phoneNumberId!: string;

  /**
   * Omitted on an UPDATE means unchanged; required to create a line.
   *
   * It was required on every save, so changing which number a line points at
   * — a test number to the real one, the most likely edit this form will ever
   * see — meant fetching the Meta token out of Business Manager again. The
   * form's own placeholder said "enter new to replace", so it read as
   * optional and refused as required.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  accessToken?: string;

  /**
   * Answers Meta's GET verification handshake for this line, and is stored
   * encrypted with the access token. Required because `WhatsAppConfig` cannot
   * hold a null here, and because a line saved without one cannot complete
   * Meta's handshake.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  webhookVerifyToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  whatsappBusinessId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayPhoneNumber?: string;

  /**
   * Accepted and ignored. The service activates the row it saves, and callers
   * (the settings form, and every curl written against this endpoint) send it.
   * Declaring it keeps the ValidationPipe's `whitelist` from stripping it into
   * a confusing 400 about an unexpected property.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
