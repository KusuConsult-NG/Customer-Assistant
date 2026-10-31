import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, Req } from '@nestjs/common';
import { FaqService } from './faq.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';

/**
 * An FAQ is an answer the assistant gives a citizen verbatim.
 *
 * ── Reading is open, writing is not ─────────────────────────────────────────
 *
 * Any member may read them: an officer on a call needs to know what the agency
 * has already committed to saying. Writing is OWNER/ADMIN for the same reason
 * the service catalogue is — these rows decide what the AI tells citizens, and
 * the order decides which of two matching answers they get.
 *
 * This controller had NO role metadata at all, so every write was open to any
 * signed-in member including a VIEWER, while its sibling KnowledgeController
 * restricted every write to OWNER/ADMIN. Documents were protected and the
 * verbatim answers were not.
 *
 * ── RolesGuard has to be listed here ───────────────────────────────────────
 *
 * It is deliberately NOT registered globally (see the note in app.module):
 * Nest runs guards global → controller → route, so a global RolesGuard would
 * execute before JwtAuthGuard had populated `request.user` and refuse
 * everything. The consequence for this file is that `@Roles()` WITHOUT
 * `RolesGuard` in `@UseGuards` is inert — the metadata is read by nothing, and
 * the restriction silently does not exist. The order below is load-bearing.
 */
@Controller('api/knowledge/faqs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FaqController {
  constructor(private faqService: FaqService) {}

  /** Open to every member: knowing the agreed answers is not a privilege. */
  @Get()
  async getFaqs(@Req() req: { user: AuthUser }) {
    return this.faqService.getFaqs(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post()
  async createFaq(
    @Req() req: { user: AuthUser },
    @Body() body: { question: string; answer: string; category?: string }
  ) {
    return this.faqService.createFaq(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('reorder')
  async reorderFaqs(
    @Req() req: { user: AuthUser },
    @Body() body: { ids: string[] }
  ) {
    return this.faqService.reorderFaqs(req.user.organizationId, body.ids);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch(':id')
  async updateFaq(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { question?: string; answer?: string; category?: string }
  ) {
    return this.faqService.updateFaq(req.user.organizationId, id, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete(':id')
  async deleteFaq(
    @Req() req: { user: AuthUser },
    @Param('id') id: string
  ) {
    return this.faqService.deleteFaq(req.user.organizationId, id);
  }
}
