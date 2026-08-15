import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Req, Res } from '@nestjs/common';
import { CrmService } from './crm.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, LeadStatus, DealStage, TicketPriority, TicketStatus } from '@ace/shared-types';


@Controller('api/crm')
@UseGuards(JwtAuthGuard)
export class CrmController {
  constructor(private crmService: CrmService) {}

  @Get('contacts')
  async getContacts(@Req() req: { user: AuthUser }, @Query('page') page: string, @Query('limit') limit: string) {
    return this.crmService.getContacts(req.user.organizationId, parseInt(page) || 1, parseInt(limit) || 50);
  }

  @Post('contacts')
  async createContact(
    @Req() req: { user: AuthUser },
    @Body() body: { fullName: string; phoneNumber: string; email?: string; tags?: string[]; address?: string; city?: string; state?: string }
  ) {
    return this.crmService.createContact(req.user.organizationId, body);
  }

  @Get('leads')
  async getLeads(@Req() req: { user: AuthUser }, @Query('page') page: string, @Query('limit') limit: string) {
    return this.crmService.getLeads(req.user.organizationId, parseInt(page) || 1, parseInt(limit) || 50);
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
  async getDeals(@Req() req: { user: AuthUser }, @Query('page') page: string, @Query('limit') limit: string) {
    return this.crmService.getDeals(req.user.organizationId, parseInt(page) || 1, parseInt(limit) || 50);
  }

  @Post('deals')
  async createDeal(
    @Req() req: { user: AuthUser },
    @Body() body: { contactId: string; title: string; amount: number; stage?: DealStage }
  ) {
    return this.crmService.createDeal(req.user.organizationId, body);
  }

  @Get('tickets')
  async getTickets(@Req() req: { user: AuthUser }, @Query('page') page: string, @Query('limit') limit: string) {
    return this.crmService.getTickets(req.user.organizationId, parseInt(page) || 1, parseInt(limit) || 50);
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
  async updateContact(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { fullName?: string; phoneNumber?: string; email?: string; tags?: string[]; address?: string; city?: string; state?: string }) {
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
    const contacts = await this.crmService.getContacts(req.user.organizationId, 1, 99999);
    // Proper CSV quoting: a name containing a double-quote used to break the
    // row (values were interpolated unescaped). Doubling quotes is the CSV
    // escape rule; the leading-character guard blocks spreadsheet formula
    // injection (=, +, -, @) when the file is opened in Excel.
    const q = (v: any) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    let csv = 'ID,Full Name,Phone Number,Email,Address,City,State,Tags\n';
    contacts.data.forEach((c: any) => {
      csv += [c.id, c.fullName, c.phoneNumber, c.email || '', c.address || '', c.city || '', c.state || '', (c.tags || []).join(';')].map(q).join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
    res.send(csv);
  }
}

