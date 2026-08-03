import { Controller, Get, Post, Patch, Body, Param, UseGuards, Req, Res } from '@nestjs/common';
import { CrmService } from './crm.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, LeadStatus, DealStage, TicketPriority, TicketStatus } from '@ace/shared-types';


@Controller('api/crm')
@UseGuards(JwtAuthGuard)
export class CrmController {
  constructor(private crmService: CrmService) {}

  @Get('contacts')
  async getContacts(@Req() req: { user: AuthUser }) {
    return this.crmService.getContacts(req.user.organizationId);
  }

  @Post('contacts')
  async createContact(
    @Req() req: { user: AuthUser },
    @Body() body: { fullName: string; phoneNumber: string; email?: string; tags?: string[] }
  ) {
    return this.crmService.createContact(req.user.organizationId, body);
  }

  @Get('leads')
  async getLeads(@Req() req: { user: AuthUser }) {
    return this.crmService.getLeads(req.user.organizationId);
  }

  @Post('leads')
  async createLead(@Req() req: { user: AuthUser }, @Body() body: { contactId: string; notes?: string }) {
    return this.crmService.createLead(req.user.organizationId, body.contactId, body.notes);
  }

  @Patch('leads/:id/status')
  async updateLeadStatus(@Param('id') id: string, @Body() body: { status: LeadStatus }) {
    return this.crmService.updateLeadStatus(id, body.status);
  }

  @Get('deals')
  async getDeals(@Req() req: { user: AuthUser }) {
    return this.crmService.getDeals(req.user.organizationId);
  }

  @Post('deals')
  async createDeal(
    @Req() req: { user: AuthUser },
    @Body() body: { contactId: string; title: string; amount: number; stage?: DealStage }
  ) {
    return this.crmService.createDeal(req.user.organizationId, body);
  }

  @Get('tickets')
  async getTickets(@Req() req: { user: AuthUser }) {
    return this.crmService.getTickets(req.user.organizationId);
  }

  @Post('tickets')
  async createTicket(
    @Req() req: { user: AuthUser },
    @Body() body: { contactId: string; subject: string; description: string; priority?: TicketPriority }
  ) {
    return this.crmService.createTicket(req.user.organizationId, body);
  }

  @Patch('tickets/:id/status')
  async updateTicketStatus(@Param('id') id: string, @Body() body: { status: TicketStatus }) {
    return this.crmService.updateTicketStatus(id, body.status);
  }

  @Patch('deals/:id/stage')
  async updateDealStage(@Param('id') id: string, @Body() body: { stage: DealStage }) {
    return this.crmService.updateDealStage(id, body.stage);
  }

  @Patch('contacts/:id')
  async updateContact(@Param('id') id: string, @Body() body: { fullName?: string; phoneNumber?: string; email?: string; tags?: string[] }) {
    return this.crmService.updateContact(id, body);
  }

  @Get('export/contacts')
  async exportContacts(@Req() req: { user: AuthUser }, @Res() res: any) {
    const contacts = await this.crmService.getContacts(req.user.organizationId);
    let csv = 'ID,Full Name,Phone Number,Email,Tags\n';
    contacts.forEach((c: any) => {
      csv += `"${c.id}","${c.fullName}","${c.phoneNumber}","${c.email || ''}","${(c.tags || []).join(';')}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
    res.send(csv);
  }
}

