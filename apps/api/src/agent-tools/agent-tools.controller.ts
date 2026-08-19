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
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AgentKeyGuard, AgentRequestContext } from './agent-key.guard';
import { AgentToolsService, ToolResult } from './agent-tools.service';

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

  @Post('lookup-customer')
  lookupCustomer(
    @Req() req: AgentRequest,
    @Body() body: { phoneNumber: string }
  ): Promise<ToolResult> {
    return this.tools.lookupCustomer(this.org(req), body?.phoneNumber ?? '');
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
    @Body() body: { phoneNumber: string; reason?: string }
  ): Promise<ToolResult> {
    return this.tools.cancelBooking(this.org(req), body?.phoneNumber ?? '', body?.reason);
  }

  @Post('reschedule-booking')
  rescheduleBooking(
    @Req() req: AgentRequest,
    @Body() body: { phoneNumber: string; newStartTime: string }
  ): Promise<ToolResult> {
    return this.tools.rescheduleBooking(
      this.org(req),
      body?.phoneNumber ?? '',
      body?.newStartTime ?? ''
    );
  }

  @Post('create-ticket')
  createTicket(
    @Req() req: AgentRequest,
    @Body()
    body: { phoneNumber: string; fullName?: string; subject: string; description: string }
  ): Promise<ToolResult> {
    return this.tools.createTicket(this.org(req), body);
  }

  @Post('payment-details')
  paymentDetails(@Req() req: AgentRequest): Promise<ToolResult> {
    return this.tools.paymentDetails(this.org(req));
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
