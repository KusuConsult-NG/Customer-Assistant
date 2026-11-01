import {
  Controller, Post, Get, Body, Query, Req, Res,
  Headers, UseGuards, HttpCode,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { TelephonyService } from './telephony.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
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

  @Post('inbound/telnyx')
  async telnyxInbound(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers() headers: Record<string, string>
  ) {
    const xmlResponse = await this.telephonyService.handleInboundCall(
      TelephonyProviderType.TELNYX,
      req.body,
      req.query,
      headers,
      req.rawBody
    );
    res.setHeader('Content-Type', 'text/xml');
    res.send(xmlResponse);
  }

  @Post('status/telnyx')
  @HttpCode(204)
  async telnyxStatus(@Body() body: any) {
    const data = body.data?.payload || body;
    const callSid = data.call_control_id || data.call_leg_id || data.call_session_id;
    const eventType = body.data?.event_type || body.event_type;
    const duration = data.duration_seconds || data.duration;
    
    let status = CallStatus.IN_PROGRESS;
    if (eventType === 'call.hangup' || eventType === 'call.ended') status = CallStatus.COMPLETED;

    if (callSid) {
      await this.telephonyService.updateCallStatus(callSid, status, duration ? parseInt(duration, 10) : undefined);
    }
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

  /**
   * Place a real call, billed to the agency's own carrier account.
   *
   * This was `JwtAuthGuard` alone, so EVERY member could dial any number at the
   * agency's expense — a VIEWER, the lowest-privileged role in the product,
   * could run up a telephony bill and call whoever they liked from the
   * agency's number. The guard list is the only thing standing between a
   * read-only account and that.
   *
   * AGENT is included for the same reason it is on scheduling: ringing a
   * citizen back is front-desk work. VIEWER is not.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN', 'AGENT')
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
  async getCallLogs(@Req() req: { user: AuthUser }, @Query('page') page: string, @Query('limit') limit: string) {
    return this.telephonyService.getCallLogs(req.user.organizationId, parseInt(page) || 1, parseInt(limit) || 50);
  }
}
