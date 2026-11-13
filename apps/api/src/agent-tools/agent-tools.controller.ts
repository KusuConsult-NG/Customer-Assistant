/**
 * HTTP surface for hosted agent tools (ElevenLabs webhook tools, or any
 * equivalent). One endpoint per customer-care task.
 *
 * Deliberately flat POST endpoints with small JSON bodies: a hosted agent
 * declares each tool separately with its own parameter schema, so one endpoint
 * per action maps to that directly and keeps each tool's contract readable in
 * both systems.
 *
 * Every endpoint is authenticated by AgentKeyGuard, which resolves the tenant
 * from the key. No endpoint here accepts an organizationId.
 */
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AgentKeyGuard, AgentRequestContext } from './agent-key.guard';
import { AgentToolsService, ConversationStartReply, ToolResult } from './agent-tools.service';

interface AgentRequest {
  agent: AgentRequestContext;
}

// A live call makes several tool calls per minute, and a busy tenant runs many
// calls at once. High enough not to interrupt real conversations, low enough
// that a leaked key cannot be used to enumerate a tenant's customer base.
@Throttle({ default: { limit: 240, ttl: 60_000 } })
@UseGuards(AgentKeyGuard)
@Controller('api/agent-tools')
export class AgentToolsController {
  constructor(private tools: AgentToolsService) {}

  private org(req: AgentRequest): string {
    return req.agent.organizationId;
  }

  /**
   * ElevenLabs' conversation-start webhook: who is calling, asked as the call
   * connects. See `AgentToolsService.conversationStart`.
   *
   * 200, not Nest's default 201: this is a read, and its reply is the data the
   * conversation starts with. Its own rate limit, higher than the tools': a 429
   * here would stop a call from starting at all, while it still needs the agent
   * key, so it is no more of an enumeration route than lookup-customer.
   */
  @Post('conversation-start')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  conversationStart(
    @Req() req: AgentRequest,
    @Body()
    body: { caller_id?: string; called_number?: string; agent_id?: string; call_sid?: string; conversation_id?: string }
  ): Promise<ConversationStartReply> {
    return this.tools.conversationStart(this.org(req), body ?? {});
  }

  @Post('lookup-customer')
  lookupCustomer(
    @Req() req: AgentRequest,
    @Body() body: { phoneNumber: string }
  ): Promise<ToolResult> {
    return this.tools.lookupCustomer(this.org(req), body?.phoneNumber ?? '');
  }

  @Post('update-caller-profile')
  updateCallerProfile(
    @Req() req: AgentRequest,
    @Body()
    body: {
      phoneNumber: string;
      fullName?: string;
      lga?: string;
      ward?: string;
      community?: string;
      /** true ONLY after alternativePhone was read back and the caller said yes. */
      alternativePhoneConfirmed?: boolean | string;
      homeAddress?: string;
      occupation?: string;
      preferredLanguage?: string;
      alternativePhone?: string;
      phoneConfirmedForFollowUp?: boolean | string;
      notes?: string;
    }
  ): Promise<ToolResult> {
    return this.tools.updateCallerProfile(this.org(req), body);
  }

  @Post('book-appointment')
  bookAppointment(
    @Req() req: AgentRequest,
    @Body()
    body: {
      phoneNumber: string;
      fullName?: string;
      serviceName: string;
      startTime: string;
      durationMinutes?: number;
      staffName?: string;
      notes?: string;
    }
  ): Promise<ToolResult> {
    return this.tools.bookAppointment(this.org(req), body);
  }

  @Post('check-booking')
  checkBooking(
    @Req() req: AgentRequest,
    @Body() body: { phoneNumber: string }
  ): Promise<ToolResult> {
    return this.tools.checkBooking(this.org(req), body?.phoneNumber ?? '');
  }

  @Post('cancel-booking')
  cancelBooking(
    @Req() req: AgentRequest,
    @Body() body: { phoneNumber: string; reason?: string; reference?: string }
  ): Promise<ToolResult> {
    return this.tools.cancelBooking(
      this.org(req),
      body?.phoneNumber ?? '',
      body?.reason,
      body?.reference
    );
  }

  @Post('reschedule-booking')
  rescheduleBooking(
    @Req() req: AgentRequest,
    @Body() body: { phoneNumber: string; newStartTime: string; reference?: string }
  ): Promise<ToolResult> {
    return this.tools.rescheduleBooking(
      this.org(req),
      body?.phoneNumber ?? '',
      body?.newStartTime ?? '',
      body?.reference
    );
  }

  @Post('create-ticket')
  createTicket(
    @Req() req: AgentRequest,
    @Body()
    body: {
      phoneNumber: string;
      fullName?: string;
      subject: string;
      description: string;
      category?: string;
      lga?: string;
      ward?: string;
      community?: string;
      location?: string;
      targetMda?: string;
      occurredAt?: string;
      institution?: string;
      impact?: string;
      previouslyReported?: string;
      urgentMedicalAttention?: boolean | string;
      isOngoing?: boolean | string;
      victimsOrInjuries?: string;
      additionalEvidence?: string;
      anonymous?: boolean | string;
      summary?: string;
      summaryConfirmed?: boolean | string;
      alternativePhone?: string;
      alternativePhoneConfirmed?: boolean | string;
      conversationId?: string;
    }
  ): Promise<ToolResult> {
    return this.tools.createTicket(this.org(req), body);
  }

  @Post('request-callback')
  requestCallback(
    @Req() req: AgentRequest,
    @Body()
    body: {
      phoneNumber: string;
      reason: string;
      whenMinutes?: number;
      fullName?: string;
      callbackNumber?: string;
      numberConfirmed?: boolean | string;
    }
  ): Promise<ToolResult> {
    return this.tools.requestCallback(this.org(req), body);
  }

  @Post('payment-details')
  paymentDetails(@Req() req: AgentRequest): Promise<ToolResult> {
    return this.tools.paymentDetails(this.org(req));
  }

  @Post('check-availability')
  checkAvailability(
    @Req() req: AgentRequest,
    @Body() body: { durationMinutes?: number; limit?: number }
  ): Promise<ToolResult> {
    return this.tools.checkAvailability(this.org(req), body ?? {});
  }

  @Post('search-knowledge')
  searchKnowledge(
    @Req() req: AgentRequest,
    @Body() body: { query: string }
  ): Promise<ToolResult> {
    return this.tools.searchKnowledge(this.org(req), body?.query ?? '');
  }

  @Post('register-enrollee')
  registerEnrollee(
    @Req() req: AgentRequest,
    @Body()
    body: {
      phoneNumber: string;
      fullName: string;
      residentialAddress?: string;
      lga: string;
      ageOrDob?: string;
      nin?: string;
      planType: string;
      preferredHospital?: string;
      notes?: string;
    }
  ): Promise<ToolResult> {
    return this.tools.registerEnrollee(this.org(req), body);
  }

  /**
   * Every field is optional and the tool is correct without any of them. The
   * conversation id is what lets the transfer actually be attempted; absent, a
   * callback ticket is filed and nothing is promised. See handoffTarget.
   */
  @Post('handoff')
  handoff(
    @Req() req: AgentRequest,
    @Body() body: { phoneNumber?: string; conversationId?: string; reason?: string } = {}
  ): Promise<ToolResult> {
    return this.tools.handoffTarget(this.org(req), body ?? {});
  }
}
