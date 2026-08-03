import { Controller, Post, Body } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { IndustryType } from '@ace/shared-types';

// All auth routes use the strict 'auth' tier: 5 requests / 60 seconds per IP.
// This prevents brute-force attacks on login, credential stuffing on register,
// and enumeration attacks on forgot-password.
@Throttle({ auth: {} })
@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(
    @Body()
    body: {
      organizationName: string;
      industry: IndustryType;
      email: string;
      password: string;
      fullName: string;
      phone?: string;
    }
  ) {
    return this.authService.registerOrganization(body);
  }

  @Post('login')
  async login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body.email, body.password);
  }

  @Post('refresh')
  async refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refreshToken(body.refreshToken);
  }

  @Post('forgot-password')
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  async resetPassword(@Body() body: { email: string; token: string; newPassword: string }) {
    return this.authService.resetPassword(body.email, body.token, body.newPassword);
  }
}
