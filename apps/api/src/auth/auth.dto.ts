import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IndustryType } from '@ace/shared-types';

/**
 * Auth request DTOs.
 *
 * These are real classes rather than inline TypeScript object types on purpose:
 * the global ValidationPipe (main.ts) can only validate — and only strips unknown
 * keys from — a body whose declared type is a class with class-validator metadata.
 * With inline `@Body() body: { email: string; … }` types the pipe has no metatype to
 * work with and silently forwards whatever the client sent, so a mismatched field
 * name (the dashboard used to post `adminEmail`/`adminPassword`) reached the service
 * as `undefined` and blew up deep inside bcrypt/Prisma as a 500 instead of a 400.
 */

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  organizationName!: string;

  @IsEnum(IndustryType, {
    message: `industry must be one of: ${Object.values(IndustryType).join(', ')}`,
  })
  industry!: IndustryType;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters long' })
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class VerifyEmailDto {
  @IsString()
  @MinLength(1)
  token!: string;
}

export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}

export class RefreshTokenDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(8, { message: 'newPassword must be at least 8 characters long' })
  @MaxLength(128)
  newPassword!: string;

  /**
   * Optional. The reset token is already a 256-bit single-use secret stored as a
   * SHA-256 hash, so it identifies the user on its own. Older reset links carried
   * an `email` query param; it is accepted and cross-checked when present.
   */
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class SetupAccountDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters long' })
  @MaxLength(128)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'newPassword must be at least 8 characters long' })
  @MaxLength(128)
  newPassword!: string;
}

export class UpdateMemberStatusDto {
  @IsBoolean()
  isActive!: boolean;
}
