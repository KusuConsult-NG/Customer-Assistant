import {
  Controller, Post, Get, Body, Query, Req, Res,
  Headers, UseGuards, HttpCode,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { TelephonyService } from './telephony.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionGuard } from '../common/guards/subscription.guard';
import { TelephonyProviderType, AuthUser, CallStatus } from '@ace/shared-types';

@Controller('api/telephony')
export class TelephonyController {
  constructor(private telephonyService: TelephonyService) {}

  // ─── Inbound Webhooks (public — verified via HMAC inside service) ─────────────

  @Post('inbound/twilio')
  async twilioInbound(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers() headers: Record<string, string>
  ) {
    const xmlResponse = await this.telephonyService.handleInboundCall(
      TelephonyProviderType.TWILIO,
      req.body,
      req.query,
      headers,
      req.rawBody
    );
    res.setHeader('Content-Type', 'text/xml');
    res.send(xmlResponse);
  }

  @Post('inbound/nigeria-carrier')
  async nigeriaCarrierInbound(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers() headers: Record<string, string>
  ) {
    const xmlResponse = await this.telephonyService.handleInboundCall(
      TelephonyProviderType.NIGERIA_CARRIER_FORWARD,
      req.body,
      req.query,
      headers,
      req.rawBody
    );
    res.setHeader('Content-Type', 'text/xml');
    res.send(xmlResponse);
  }

  @Post('inbound/africa-talking')
  async africasTalkingInbound(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers() headers: Record<string, string>
  ) {
    const xmlResponse = await this.telephonyService.handleInboundCall(
      TelephonyProviderType.AFRICAS_TALKING,
      req.body,
      req.query,
      headers,
      req.rawBody
    );
    res.setHeader('Content-Type', 'text/xml');
    res.send(xmlResponse);
  }

  /**
   * POST /api/telephony/status/twilio
   * Twilio calls this when a call's status changes (ringing → in-progress → completed).
   * We use it to update the CallLog with duration and final status.
   * Must return 204 to prevent Twilio from logging warnings.
   */
  @Post('status/twilio')
  @HttpCode(204)
  async twilioStatusCallback(@Body() body: any) {
    const callSid = body.CallSid;
    const callStatus = body.CallStatus;
    const duration = body.CallDuration ? parseInt(body.CallDuration, 10) : undefined;

    const statusMap: Record<string, CallStatus> = {
      completed:   CallStatus.COMPLETED,
      failed:      CallStatus.FAILED,
      busy:        CallStatus.FAILED,
      'no-answer': CallStatus.FAILED,
      canceled:    CallStatus.FAILED,
      'in-progress': CallStatus.IN_PROGRESS,
    };

    const mappedStatus = statusMap[callStatus];
    if (callSid && mappedStatus) {
      await this.telephonyService.updateCallStatus(callSid, mappedStatus, duration);
    }
  }

  // ─── Outbound & Admin (JWT protected) ────────────────────────────────────────

  @UseGuards(JwtAuthGuard, SubscriptionGuard)
  @Post('outbound')
  async placeOutboundCall(
    @Req() req: { user: AuthUser },
    @Body() body: { toNumber: string; provider?: TelephonyProviderType }
  ) {
    return this.telephonyService.initiateOutboundCall(
      req.user.organizationId,
      body.toNumber,
      body.provider
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('calls')
  async getCallLogs(@Req() req: { user: AuthUser }) {
    return this.telephonyService.getCallLogs(req.user.organizationId);
  }
}
