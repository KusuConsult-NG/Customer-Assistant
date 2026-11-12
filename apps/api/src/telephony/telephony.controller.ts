import {
  Controller, Post, Get, Body, Query, Req, Res,
  Headers, UseGuards, HttpCode,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { InfobipVoiceService } from './infobip/infobip-voice.service';
import { InfobipCallsService, InfobipEvent } from './infobip/infobip-calls.service';
import { BrowserCallingService, RING_SECONDS } from './browser-calling.service';
import { TelephonyService } from './telephony.service';
import { isPlatformOperator, voiceReadinessForAgency } from '../common/agency-audience';
import { VoiceReadinessService } from './voice-readiness.service';
import { CallbackDispatcherService } from './callback-dispatcher.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { TelephonyProviderType, AuthUser, CallStatus } from '@ace/shared-types';

@Controller('api/telephony')
export class TelephonyController {
  constructor(
    private telephonyService: TelephonyService,
    // A carrier's call-status callback is the only thing that knows whether a
    // promised callback was actually answered, so it is settled here, where
    // that callback lands. The dispatcher depends on TelephonyService, so the
    // reconciliation cannot live inside TelephonyService without a cycle.
    private callbacks: CallbackDispatcherService,
    private voiceReadiness: VoiceReadinessService,
    private browserCalling: BrowserCallingService,
    private infobip: InfobipVoiceService,
    private infobipCalls: InfobipCallsService
  ) {}

  /**
   * Can this agency complete a phone call right now, and if not, why not.
   *
   * OWNER/ADMIN: it returns the public webhook URLs and names which provider
   * credentials and which platform keys are present. It returns no credential
   * VALUE — the stored token is reported as a length and its last four
   * characters, which is what an operator can compare against the Twilio
   * console, and the env-held keys are reported only as present or absent.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Get('voice-readiness')
  async voiceReadinessReport(@Req() req: { user: AuthUser }) {
    const report = await this.voiceReadiness.forOrganization(req.user.organizationId);
    // Server variable names, internal URLs and log event names are for the
    // people who run the platform, not for every agency admin.
    return isPlatformOperator(req.user) ? report : voiceReadinessForAgency(report);
  }

  /**
   * Make the deployment's own Twilio number answer as this agency.
   *
   * For a single-agency deployment that already holds TWILIO_ACCOUNT_SID,
   * TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER, this is the step that was
   * missing: nothing wrote those into a `TelephonyConfig`, so every caller was
   * told the number was not configured while the server held the credentials
   * all along. Every guard is in the service, and the confirmation flag is
   * required — see the note there.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('adopt-deployment-line')
  async adoptDeploymentLine(
    @Req() req: { user: AuthUser },
    @Body() body: { confirmAdoptsDeploymentNumber?: boolean }
  ) {
    return this.voiceReadiness.adoptDeploymentLine(req.user.organizationId, body);
  }

  /**
   * Ask Twilio to send this number's calls here.
   *
   * The last step that was manual only because nothing had been written to do
   * it: everything can be configured on our side and the number still rings to
   * whatever its Voice webhook pointed at. We already hold the tenant's
   * credentials and already use them to redirect live calls, so this is the
   * same authority on the same number. Confirmation required — it changes
   * where a citizen's call goes, in the tenant's own Twilio account — and the
   * outcome is read back from Twilio's response, never assumed.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Post('point-number-at-platform')
  async pointNumberAtPlatform(
    @Req() req: { user: AuthUser },
    @Body() body: { phoneNumber?: string; confirmRepointsCarrierWebhook?: boolean }
  ) {
    return this.voiceReadiness.pointNumberAtPlatform(req.user.organizationId, body);
  }

  // ─── Inbound Webhooks (public — verified via HMAC inside service) ─────────────

  // ─── Answering in the dashboard ──────────────────────────────────────────

  /**
   * A Twilio Voice token for the signed-in officer, so their browser can ring.
   *
   * Scoped to `req.user.userId` and nothing else — an officer cannot mint a
   * token for a colleague, and the identity is derived from the id rather
   * than taken from the request. A token that named its own identity would be
   * a way to receive another officer's calls.
   *
   * OWNER/ADMIN/AGENT, matching who may speak to a citizen elsewhere in this
   * controller. A VIEWER answering a call is a role boundary crossed by a
   * telephone.
   */
  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Post('browser/token')
  async browserToken(@Req() req: { user: AuthUser }) {
    const readiness = this.browserCalling.readiness();
    if (!readiness.enabled) {
      // Not an error: a deployment that has not switched this on is a normal
      // deployment, and the dashboard needs to know that rather than to
      // retry. It renders nothing instead of a broken phone.
      return { enabled: false, blocked: readiness.blocked, detail: readiness.detail };
    }

    const minted = this.browserCalling.accessTokenFor((req.user as any).userId ?? (req.user as any).id);
    if (!minted) {
      return { enabled: false, blocked: readiness.blocked, detail: readiness.detail };
    }
    return { enabled: true, ...minted, ringSeconds: RING_SECONDS };
  }

  /**
   * Where a call goes when the officers' browsers did not answer it.
   *
   * Twilio POSTs here when the `<Dial>` ends for ANY reason — nobody picked
   * up, everybody declined, no client was registered, the call failed. What
   * this returns becomes the rest of the call, so it returns exactly the AI
   * TwiML the inbound webhook would have returned if browser answering had
   * never been switched on.
   *
   * PUBLIC, like every other carrier callback on this controller, and for the
   * same reason: Twilio cannot present a JWT. It is reached only with a
   * `CallSid` Twilio generated and parameters this platform put in the URL
   * itself.
   *
   * If `DialCallStatus` is `completed`, an officer DID speak to the citizen
   * and the call is over — handing it to the AI then would make a citizen who
   * has already been helped listen to a greeting.
   */
  @Post('inbound/twilio/after-officers')
  async twilioAfterOfficers(
    @Req() req: Request,
    @Res() res: Response,
    @Query('orgId') orgId: string,
    @Query('callSid') callSid: string,
    @Query('from') from: string,
    @Query('to') to: string
  ) {
    const dialStatus = String((req.body as any)?.DialCallStatus ?? '').toLowerCase();
    res.setHeader('Content-Type', 'text/xml');

    if (dialStatus === 'completed') {
      // An officer took it. Hang up rather than start a second conversation.
      res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      return;
    }

    const xml = await this.telephonyService.aiStreamTwiml(
      TelephonyProviderType.TWILIO,
      await this.telephonyService.inboundConfigFor(orgId),
      orgId,
      callSid,
      from,
      to
    );
    res.send(xml);
  }

  /**
   * Infobip call events — CALL_RECEIVED, CALL_FINISHED, CALL_FAILED and any
   * others the subscription sends.
   *
   * VERIFY, THEN ACK, THEN WORK — the order every carrier route here keeps.
   * Basic authentication is the scheme Infobip documents for a notification
   * profile, and it is checked before a byte of the event is trusted. With no
   * credentials configured every event is REFUSED rather than accepted: an
   * unauthenticated CALL_RECEIVED would let anybody create contacts and call
   * records in an agency's CRM.
   *
   * 500 for "not configured" — our fault, worth Infobip retrying once it is
   * fixed — and 401 for wrong or missing credentials, which no retry fixes.
   * Then 200 at once and the work afterwards: a citizen is ringing, and the
   * dialog that answers them must not wait on Infobip's own webhook timeout.
   */
  @Post('inbound/infobip')
  async infobipEvent(@Req() req: Request, @Res() res: Response, @Headers('authorization') authorization?: string) {
    const verdict = this.infobip.verifyWebhook(authorization);
    if (verdict === 'unconfigured') {
      res.status(500).send('Server misconfiguration');
      return;
    }
    if (verdict !== 'ok') {
      res.status(401).send('Unauthorized');
      return;
    }
    res.status(200).send();
    void this.infobipCalls.handle((req.body ?? {}) as InfobipEvent);
  }

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
  async telnyxStatus(
    @Body() body: any,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string>,
    @Res() res: Response
  ) {
    const data = body.data?.payload || body;
    const callSid = data.call_control_id || data.call_leg_id || data.call_session_id;
    const eventType = body.data?.event_type || body.event_type;
    const duration = data.duration_seconds || data.duration;

    // A hangup is not an answer.
    //
    // Every hangup used to map to COMPLETED, whatever the cause. COMPLETED is
    // what settles a promised callback as KEPT, so a citizen whose line was
    // engaged or who never picked up had their callback closed as though we
    // had spoken to them — and `hangup_cause` was sitting in the same payload
    // saying otherwise.
    const cause = String(data.hangup_cause || '').toLowerCase();
    let status = CallStatus.IN_PROGRESS;
    if (eventType === 'call.hangup' || eventType === 'call.ended') {
      status =
        cause === 'busy' || cause === 'user_busy'
          ? CallStatus.BUSY
          : cause === 'timeout' || cause === 'no_answer' || cause === 'no_user_response'
            ? CallStatus.NO_ANSWER
            : cause === 'call_rejected' || cause === 'unspecified' || cause === 'originator_cancel'
              ? CallStatus.FAILED
              : CallStatus.COMPLETED;
    }

    if (!callSid) {
      res.status(204).send();
      return;
    }

    // Verified BEFORE anything is written — see `verifyStatusCallback`.
    const verdict = await this.telephonyService.verifyStatusCallback({
      callSid,
      provider: 'TELNYX',
      headers,
      params: {},
      rawBody: req.rawBody,
      path: '/api/telephony/status/telnyx',
    });
    if (verdict !== 'ok') {
      res.status(verdict === 'unknown_call' ? 404 : 403).send();
      return;
    }

    const seconds = duration ? parseInt(duration, 10) : undefined;
    await this.telephonyService.updateCallStatus(callSid, status, seconds);
    await this.callbacks.reconcileFromCall(callSid, status, seconds);
    res.status(204).send();
  }

  /**
   * POST /api/telephony/status/twilio
   * Twilio calls this when a call's status changes (ringing → in-progress → completed).
   * We use it to update the CallLog with duration and final status.
   * Must return 204 to prevent Twilio from logging warnings.
   */
  @Post('status/twilio')
  @HttpCode(204)
  async twilioStatusCallback(
    @Body() body: any,
    @Headers() headers: Record<string, string>,
    @Res() res: Response
  ) {
    const callSid = body.CallSid;
    const callStatus = body.CallStatus;
    const duration = body.CallDuration ? parseInt(body.CallDuration, 10) : undefined;

    // `busy` and `no-answer` used to be flattened into FAILED, throwing away
    // the only two reasons an officer can actually explain to a citizen — and
    // CallStatus has had both values all along. "We tried" is not an answer;
    // "your line was engaged" is.
    const statusMap: Record<string, CallStatus> = {
      completed:   CallStatus.COMPLETED,
      failed:      CallStatus.FAILED,
      busy:        CallStatus.BUSY,
      'no-answer': CallStatus.NO_ANSWER,
      canceled:    CallStatus.FAILED,
      'in-progress': CallStatus.IN_PROGRESS,
    };

    const mappedStatus = statusMap[callStatus];
    if (!callSid || !mappedStatus) {
      res.status(204).send();
      return;
    }

    // Verified BEFORE anything is written — see `verifyStatusCallback`. An
    // unsigned POST used to be able to rewrite the call history and, once
    // these callbacks began settling promises, to record a citizen as reached.
    const verdict = await this.telephonyService.verifyStatusCallback({
      callSid,
      provider: 'TWILIO',
      headers,
      params: body as Record<string, string>,
      path: '/api/telephony/status/twilio',
    });
    if (verdict !== 'ok') {
      res.status(verdict === 'unknown_call' ? 404 : 403).send();
      return;
    }

    await this.telephonyService.updateCallStatus(callSid, mappedStatus, duration);
    // Whether a promised callback was kept is decided here and nowhere else.
    await this.callbacks.reconcileFromCall(callSid, mappedStatus, duration);
    res.status(204).send();
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
