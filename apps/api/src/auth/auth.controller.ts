import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthUser } from '@ace/shared-types';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import {
  RegisterDto,
  LoginDto,
  VerifyEmailDto,
  ResendVerificationDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SetupAccountDto,
  ChangePasswordDto,
} from './auth.dto';

/**
 * Auth rate limiting is TIERED BY RISK, not applied uniformly.
 *
 * A flat 10/min across every auth route is worse than useless in production:
 *
 *  - It is per-IP. An office, campus or mobile carrier behind one NAT address
 *    shares a single budget, so the eleventh person to arrive at 9am cannot log in.
 *    Meanwhile real credential-stuffing rotates IPs and never touches the limit.
 *  - It covered /refresh. A user with a few tabs open silently burns the login
 *    budget on background token refreshes and locks themselves out of their own
 *    session.
 *
 * So: the expensive, abuse-prone endpoints stay tight; endpoints that already
 * require possession of a secret (a refresh token, a reset token, an access token)
 * get a normal budget. The actual anti-brute-force control is PER-ACCOUNT lockout
 * in AuthService.login, which is what stops a distributed attack on one account.
 *
 * The override targets the 'default' tier by name because that is the only tier
 * registered in ThrottlerModule.forRoot() — see the comment in app.module.ts.
 */
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // Account creation writes two rows and sends an email — abuse is costly.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Body() body: RegisterDto) {
    return this.authService.registerOrganization(body);
  }

  @Post('verify-email')
  async verifyEmail(@Body() body: VerifyEmailDto) {
    return this.authService.verifyEmail(body.token);
  }

  /**
   * GET variant so a verification link can be opened directly from an email client
   * without JavaScript. The dashboard uses the POST form.
   */
  @Get('verify-email')
  async verifyEmailByLink(@Req() req: { query: { token?: string } }) {
    return this.authService.verifyEmail(req.query.token ?? '');
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('resend-verification')
  async resendVerification(@Body() body: ResendVerificationDto) {
    return this.authService.resendVerification(body.email);
  }

  // Per-IP ceiling only, and deliberately generous.
  //
  // Brute force against a single account is stopped by the per-account lockout in
  // AuthService.login (5 failures → escalating 1min/5min/15min/1hr), which is the
  // control that actually matches the threat. This limit exists solely to stop one
  // host flooding the endpoint. Setting it tight instead just locks out shared-NAT
  // offices, campuses and mobile carriers — many legitimate users behind one address.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.authService.login(body.email, body.password);
  }

  @Post('refresh')
  async refresh(@Body() body: RefreshTokenDto) {
    return this.authService.refreshToken(body.refreshToken);
  }

  // Sends an email; rate limited to prevent using it as a mail bomb.
  // 10/min: a legitimate user can request, wait, and re-request without being
  // blocked, while still preventing automated enumeration at scale.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  async resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body.token, body.newPassword, body.email);
  }

  /**
   * Completes an invited team member's account setup.
   * The invite email links to /setup-account?token=… — without this endpoint
   * invited users had no way to ever set a password and log in.
   */
  @Post('setup-account')
  async setupAccount(@Body() body: SetupAccountDto) {
    return this.authService.setupAccount(body.token, body.password);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Req() req: { user: AuthUser }) {
    return this.authService.logout(req.user.userId);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(@Req() req: { user: AuthUser }, @Body() body: ChangePasswordDto) {
    return this.authService.changePassword(req.user.userId, body.currentPassword, body.newPassword);
  }
}
