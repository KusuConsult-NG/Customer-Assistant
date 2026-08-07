import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Req, Res } from '@nestjs/common';
import { CrmService } from './crm.service';
import { CrmTimelineService } from './crm-timeline.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, LeadStatus, DealStage, TicketPriority, TicketStatus } from '@ace/shared-types';


@Controller('api/crm')
@UseGuards(JwtAuthGuard)
export class CrmController {
  constructor(
    private crmService: CrmService,
    private crmTimelineService: CrmTimelineService
  ) {}

  @Get('contacts')
  async getContacts(@Req() req: { user: AuthUser }, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.crmService.getContacts(req.user.organizationId, page, limit);
  }

  @Post('contacts')
  async createContact(
    @Req() req: { user: AuthUser },
    @Body() body: { fullName: string; phoneNumber: string; email?: string; tags?: string[] }
  ) {
    return this.crmService.createContact(req.user.organizationId, body);
  }

  @Get('leads')
  async getLeads(@Req() req: { user: AuthUser }, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.crmService.getLeads(req.user.organizationId, page, limit);
  }

  @Post('leads')
  async createLead(@Req() req: { user: AuthUser }, @Body() body: { contactId: string; notes?: string }) {
    return this.crmService.createLead(req.user.organizationId, body.contactId, body.notes);
  }

  @Patch('leads/:id/status')
  async updateLeadStatus(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { status: LeadStatus }) {
    return this.crmService.updateLeadStatus(id, body.status, req.user.organizationId);
  }

  @Get('deals')
  async getDeals(@Req() req: { user: AuthUser }, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.crmService.getDeals(req.user.organizationId, page, limit);
  }

  @Post('deals')
  async createDeal(
    @Req() req: { user: AuthUser },
    @Body() body: { contactId: string; title: string; amount: number; stage?: DealStage }
  ) {
    return this.crmService.createDeal(req.user.organizationId, body);
  }

  @Get('tickets')
  async getTickets(@Req() req: { user: AuthUser }, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.crmService.getTickets(req.user.organizationId, page, limit);
  }

  @Post('tickets')
  async createTicket(
    @Req() req: { user: AuthUser },
    @Body() body: { contactId: string; subject: string; description: string; priority?: TicketPriority }
  ) {
    return this.crmService.createTicket(req.user.organizationId, body);
  }

  @Patch('tickets/:id/status')
  async updateTicketStatus(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { status: TicketStatus }) {
    return this.crmService.updateTicketStatus(id, body.status, req.user.organizationId);
  }

  @Patch('deals/:id/stage')
  async updateDealStage(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { stage: DealStage }) {
    return this.crmService.updateDealStage(id, body.stage, req.user.organizationId);
  }

  @Patch('contacts/:id')
  async updateContact(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { fullName?: string; phoneNumber?: string; email?: string; tags?: string[] }) {
    return this.crmService.updateContact(id, body, req.user.organizationId);
  }

  @Delete('contacts/:id')
  async deleteContact(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.crmService.deleteContact(id, req.user.organizationId);
  }

  @Delete('leads/:id')
  async deleteLead(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.crmService.deleteLead(id, req.user.organizationId);
  }

  @Delete('deals/:id')
  async deleteDeal(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.crmService.deleteDeal(id, req.user.organizationId);
  }

  @Delete('tickets/:id')
  async deleteTicket(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.crmService.deleteTicket(id, req.user.organizationId);
  }

  @Get('contacts/search')
  async searchContacts(@Req() req: { user: AuthUser }, @Query('q') q: string) {
    if (!q) return this.crmService.getContacts(req.user.organizationId, 1, 50);
    return this.crmService.searchContacts(req.user.organizationId, q);
  }

  /**
   * Unified activity timeline (calls, bookings, deals, tickets) plus a health score.
   * Declared before `contacts/:id` so the literal segment wins the route match.
   */
  @Get('contacts/:id/timeline')
  async getContactTimeline(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.crmTimelineService.getCustomerTimeline(id, req.user.organizationId);
  }

  @Get('contacts/:id')
  async getContact(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.crmService.getContactById(id, req.user.organizationId);
  }

  @Get('deals/:id/quotation')
  async getQuotation(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.crmService.getQuotationData(id, req.user.organizationId);
  }

  @Get('export/contacts')
  async exportContacts(@Req() req: { user: AuthUser }, @Res() res: any) {
    const contacts = await this.crmService.getAllContactsForExport(req.user.organizationId);
    // RFC 4180: a double quote inside a quoted field is escaped by doubling it.
    // Without this a contact named `Ade "Sunny" Bello` — or one whose name begins
    // with '=' — corrupts the export or injects a formula into the operator's
    // spreadsheet.
    const cell = (value: unknown) => {
      const str = String(value ?? '');
      const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
      return `"${safe.replace(/"/g, '""')}"`;
    };

    let csv = 'ID,Full Name,Phone Number,Email,Tags\n';
    contacts.data.forEach((c: any) => {
      csv += [cell(c.id), cell(c.fullName), cell(c.phoneNumber), cell(c.email), cell((c.tags || []).join(';'))].join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
    res.send(csv);
  }
}

